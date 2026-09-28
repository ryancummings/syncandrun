#!/usr/bin/env python3
"""Real Jellyfin integration with generated tones and disposable resources only.

Requires Docker, ffmpeg, ffprobe and a built target/debug/syncandrun. Use
--ssh HOST for an explicitly authorized Docker host; its server is exposed only
on remote loopback through an SSH tunnel. No existing server/profile is used.
The pinned official image remains cached; the container and all data are removed.
"""
import argparse
import io
import json
import os
import plistlib
import secrets
import shlex
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'jellyfin/jellyfin:10.11.6'


def run(args):
    name = 'syncandrun-jellyfin-smoke-' + secrets.token_hex(6)
    tunnel = None
    started = False
    if args.ready_file:
        ready = Path(args.ready_file).resolve()
        if ready.is_relative_to(ROOT):
            raise ValueError('Temporary credential file must be outside the repository')

    def docker(*command, data=None, timeout=180):
        cmd = ['docker', *command]
        if args.ssh:
            cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.ssh,
                   shlex.join(cmd)]
        result = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout)
        if result.returncode:
            # Container logs and inspect output may contain credentials: never dump them.
            raise RuntimeError('Docker operation failed: ' + command[0])
        return result.stdout.decode().strip()

    docker('info', '--format', '{{.ServerVersion}}')
    try:
        with tempfile.TemporaryDirectory(prefix='syncandrun-jellyfin-smoke-') as directory:
            root = Path(directory)
            media = root / 'media'
            media.mkdir()
            for index, frequency in enumerate((440, 660), 1):
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                                f'sine=frequency={frequency}:duration=3[t];anoisesrc=duration=3:amplitude=0.02[n];[t][n]amix=inputs=2:duration=first', '-ac', '2',
                                '-metadata', f'title=Synthetic tone {index}',
                                '-metadata', 'artist=Synthetic artist',
                                '-metadata', 'album=Synthetic album',
                                '-metadata', f'track={index}', str(media / f'{index}.flac')],
                               check=True, capture_output=True)
            docker('run', '-d', '--rm', '--name', name,
                   '--label', 'org.syncandrun.fixture=jellyfin-smoke',
                   '--tmpfs', '/config', '--tmpfs', '/cache',
                   '-p', '127.0.0.1::8096', IMAGE)
            started = True
            docker('exec', name, 'mkdir', '-p', '/media')
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                for file in media.iterdir():
                    tar.add(file, arcname=file.name)
            docker('cp', '-', name + ':/media', data=archive.getvalue())
            port = int(docker('port', name, '8096/tcp').rsplit(':', 1)[1])
            if args.ssh:
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    local_port = sock.getsockname()[1]
                tunnel = subprocess.Popen(['ssh', '-N', '-o', 'BatchMode=yes',
                                           '-o', 'ExitOnForwardFailure=yes', '-L',
                                           f'127.0.0.1:{local_port}:127.0.0.1:{port}', args.ssh],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                port = local_port
            base = f'http://127.0.0.1:{port}'
            token = None

            def api(path, body=None, method=None):
                headers = {'Content-Type': 'application/json', 'Authorization':
                           'MediaBrowser Client="SyncAndRun fixture", Device="Fixture", '
                           'DeviceId="synthetic-fixture", Version="1"'}
                if token:
                    headers['X-Emby-Token'] = token
                req = urllib.request.Request(base + path, headers=headers,
                                             data=None if body is None else json.dumps(body).encode(),
                                             method=method)
                with urllib.request.urlopen(req, timeout=30) as response:
                    data = response.read()
                    return json.loads(data) if data else None

            for _ in range(120):
                try:
                    info = api('/System/Info/Public')
                    api('/Startup/Configuration')
                    break
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    time.sleep(1)
            else:
                raise RuntimeError('Disposable Jellyfin did not become ready')
            assert not info.get('StartupWizardCompleted', False), 'Refusing a configured server'
            password = secrets.token_urlsafe(24)
            api('/Startup/Configuration', {'ServerName': 'Synthetic Jellyfin', 'UICulture': 'en-US',
                                          'MetadataCountryCode': 'US', 'PreferredMetadataLanguage': 'en'})
            api('/Startup/User')
            api('/Startup/User', {'Name': 'synthetic-owner', 'Password': password})
            api('/Startup/RemoteAccess', {'EnableRemoteAccess': True, 'EnableAutomaticPortMapping': False})
            api('/Startup/Complete', {}, 'POST')
            auth = api('/Users/AuthenticateByName', {'Username': 'synthetic-owner', 'Pw': password})
            token = auth['AccessToken']
            user = auth['User']['Id']
            api('/Library/VirtualFolders?name=Synthetic%20Music&collectionType=music&refreshLibrary=true',
                {'LibraryOptions': {'PathInfos': [{'Path': '/media'}], 'EnableRealtimeMonitor': False,
                                    'EnableInternetProviders': False, 'SaveLocalMetadata': False}})
            for _ in range(120):
                tracks = api(f'/Users/{user}/Items?Recursive=true&IncludeItemTypes=Audio')['Items']
                if len(tracks) == 2:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Generated audio was not scanned: ' + repr([item['Name'] for item in tracks]))
            time.sleep(3)
            tracks = api(f'/Users/{user}/Items?Recursive=true&IncludeItemTypes=Audio')['Items']
            for _ in range(120):
                scanning = [task for task in api('/ScheduledTasks') if task.get('Key') == 'RefreshLibrary' and task['State'] != 'Idle']
                if not scanning:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Synthetic library scan did not finish')
            tracks.sort(key=lambda item: item['Name'])
            # Jellyfin 10.11 rejects duplicate playlist entries through its API.
            # Core fake-server tests cover preserving repeats returned by other versions.
            expected = [['Synthetic tone 1', 'Synthetic tone 2'], ['Synthetic tone 2']]
            playlist_ids = []
            for index, sequence in enumerate(([0, 1], [1]), 1):
                created = api('/Playlists', {'Name': f'Synthetic playlist {index}',
                                             'Ids': [tracks[i]['Id'] for i in sequence],
                                             'UserId': user, 'MediaType': 'Audio', 'IsPublic': False})
                items = api('/Playlists/' + created['Id'] + '/Items?' + urllib.parse.urlencode({'userId': user}))['Items']
                assert [item['Name'] for item in items] == expected[index - 1], 'Server fixture order mismatch'
                playlist_ids.append('jellyfin:playlist:' + created['Id'])

            if args.serve_only:
                assert args.ready_file, '--serve-only requires --ready-file outside the repository'
                with open(args.ready_file, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as file:
                    json.dump({'server': base, 'username': 'synthetic-owner', 'password': password}, file)
                try:
                    time.sleep(600)
                finally:
                    Path(args.ready_file).unlink(missing_ok=True)
                return

            def cli(*command, stdin=None):
                result = subprocess.run([str(ROOT / 'target/debug/syncandrun'), '--profile',
                                         str(root / 'profile'), *map(str, command)], input=stdin,
                                        capture_output=True, text=True, timeout=120)
                assert result.returncode == 0, f'CLI {command[0]} failed: {result.stderr}'
                assert password not in result.stdout + result.stderr
                assert token not in result.stdout + result.stderr
                return result.stdout.strip()

            rejected = subprocess.run([str(ROOT / 'target/debug/syncandrun'), '--profile',
                                       str(root / 'profile'), 'login-jellyfin', '--server', base,
                                       '--username', 'synthetic-owner', '--password-stdin'],
                                      input='wrong-synthetic-password\n', capture_output=True,
                                      text=True, timeout=30)
            assert rejected.returncode != 0
            cli('login-jellyfin', '--server', base, '--username', 'synthetic-owner',
                '--password-stdin', stdin=password + '\n')
            assert 'Jellyfin' in cli('status')
            api('/Users/New', {'Name': 'synthetic-other-owner', 'Password': password})
            other = api('/Users/AuthenticateByName', {'Username': 'synthetic-other-owner', 'Pw': password})
            assert other['User']['Id'] != user
            rejected = subprocess.run([str(ROOT / 'target/debug/syncandrun'), '--profile',
                                       str(root / 'profile'), 'login-jellyfin', '--server', base,
                                       '--username', 'synthetic-other-owner', '--password-stdin'],
                                      input=password + '\n', capture_output=True, text=True, timeout=30)
            assert rejected.returncode != 0, 'A different owner was accepted'
            assert 'own this profile' in rejected.stderr, 'Second user failed before ownership validation'
            assert password not in rejected.stdout + rejected.stderr
            assert token not in rejected.stdout + rejected.stderr
            playlists = json.loads(cli('playlists', '--json'))
            assert len(playlists) == 2
            selection = [value for id_ in playlist_ids for value in ('--playlist', id_)]
            cli('refresh', *selection)
            assert json.loads(cli('estimate'))['tracks'] == 3, 'CLI estimate did not preserve all three entries'
            destination = root / 'exports'
            destination.mkdir()
            for bitrate in (64, 96, 128, 192, 256):
                output = Path(cli('export', '--destination', destination, '--route', 'mtp',
                                  '--bitrate', bitrate))
                assert len(list(output.rglob('*.mp3'))) == 3
                actual = []
                for playlist in sorted(output.rglob('*.m3u8')):
                    titles = []
                    for line in playlist.read_text().splitlines():
                        assert line and not line.startswith('#')
                        mp3 = playlist.parent / line
                        assert mp3.is_file()
                        probe = json.loads(subprocess.check_output([
                            'ffprobe', '-v', 'error', '-show_streams', '-show_format',
                            '-of', 'json', str(mp3)], text=True))
                        audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
                        assert audio['codec_name'] == 'mp3'
                        assert int(audio['bit_rate']) == bitrate * 1000, f'Requested {bitrate} kbps, got {audio["bit_rate"]} bps'
                        assert float(probe['format']['duration']) >= 3
                        titles.append(probe['format']['tags']['title'])
                    actual.append(titles)
                assert actual == expected, 'Export changed playlist order'
            before = sorted(destination.iterdir())
            rejected = subprocess.run([str(ROOT / 'target/debug/syncandrun'), '--profile',
                                       str(root / 'profile'), 'export', '--destination', str(destination),
                                       '--bitrate', '320'], capture_output=True, text=True, timeout=30)
            assert rejected.returncode != 0, 'Unsupported Jellyfin 320 kbps was accepted'
            assert '256' in rejected.stderr
            assert sorted(destination.iterdir()) == before, 'Rejected bitrate created export output'
            for route in ('express', 'music'):
                output = Path(cli('export', '--destination', destination, '--route', route,
                                  '--bitrate', 192))
                assert len(list(output.rglob('*.mp3'))) == 2
                if route == 'music':
                    library = plistlib.loads((output / 'Import playlists.xml').read_bytes())
                    actual = [[library['Tracks'][str(item['Track ID'])]['Name']
                               for item in playlist['Playlist Items']] for playlist in library['Playlists']]
                    assert actual == expected
            backup = Path(cli('backup', '--destination', root))
            restored = subprocess.run([str(ROOT / 'target/debug/syncandrun'), '--profile',
                                       str(backup), 'playlists', '--json'], capture_output=True,
                                      text=True, check=True, timeout=30)
            assert len(json.loads(restored.stdout)) == 2
            print(f'Jellyfin {info["Version"]} integration passed: real login, discovery, refresh, '
                  'five MP3 bitrates (64–256 kbps), 320 rejection, ordered/shared tracks, three layouts, backup restore.')
    finally:
        if tunnel:
            tunnel.terminate()
            tunnel.wait(timeout=10)
        if started:
            docker('rm', '-f', name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh', help='Explicitly authorized SSH Docker host (default: local Docker)')
    parser.add_argument('--serve-only', action='store_true', help='Keep synthetic fixture for GUI testing for ten minutes')
    parser.add_argument('--ready-file', help='New private file outside the repo for temporary synthetic GUI credentials')
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    run(parser.parse_args())
