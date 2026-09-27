#!/usr/bin/env python3
"""Exercise native binaries with a fake Plex server and disposable profiles only.

Build with cargo build --workspace first. Requires Python 3 and Node for an
independent legacy encryption fixture. --gui additionally requires an X display,
xdotool and ImageMagick; an optional screenshot stays outside the repository.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]


class Plex(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        assert self.headers.get('X-Plex-Token') == 'synthetic-server-token'
        path = urllib.parse.urlsplit(self.path).path
        if path == '/playlists':
            items = [dict(ratingKey='10', playlistType='audio', title='Morning miles', leafCount=3, duration=540000),
                     dict(ratingKey='20', playlistType='audio', title='Easy pace', leafCount=1, duration=180000)]
        elif path.startswith('/playlists/'):
            track = dict(ratingKey='1', type='track', librarySectionID=1, title='Synthetic song', grandparentTitle='Test artist', parentTitle='Test album', duration=180000)
            items = [track] * (3 if '/10/' in path else 1)
        elif path.endswith('/start.mp3'):
            assert urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)['musicBitrate'][0] in ['64', '96', '128', '192', '256', '320']
            body = bytes([255, 251, 144, 0]) + bytes(1024)
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        else:
            self.send_error(404)
            return
        body = json.dumps(dict(MediaContainer=dict(offset=0, size=len(items), totalSize=len(items), Metadata=items))).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(args):
    binary = ROOT / 'target/debug/syncandrun'
    gui = ROOT / 'target/debug/syncandrun-desktop'
    with tempfile.TemporaryDirectory(prefix='syncandrun-synthetic-') as directory:
        root = Path(directory)
        profile = root / 'profile'
        destination = root / 'exports'
        destination.mkdir()

        def cli(*command):
            result = subprocess.run([str(binary), '--profile', str(profile), *map(str, command)], capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stderr
            return result.stdout.strip()

        assert 'Not connected' in cli('status')
        # Credentials are fake, passed over stdin, captured, and never logged.
        fixture = subprocess.run(['node', '-e', """
          const c=require('node:crypto'),fs=require('node:fs');
          const secret=fs.readFileSync(0,'utf8'),nonce=Buffer.alloc(12,9);
          const key=c.hkdfSync('sha256',Buffer.from(secret),Buffer.from('syncandrun-for-garmin/v1'),'plex-token-encryption',32);
          const cipher=c.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('plex-token'));
          const data=Buffer.concat([cipher.update('synthetic-server-token'),cipher.final(),cipher.getAuthTag()]);
          process.stdout.write(JSON.stringify({data:[...data],nonce:[...nonce]}));
        """], input=(profile / 'secret').read_text(), text=True, capture_output=True, check=True)
        fixture = json.loads(fixture.stdout)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Plex)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sqlite3.connect(profile / 'data/syncandrun.sqlite') as db:
                db.execute("INSERT INTO installation_owner VALUES(1,'synthetic-owner')")
                db.execute("INSERT INTO plex_connection(id,encrypted_token,token_nonce,server_machine_id,server_base_uri,library_section_id,created_at,updated_at) VALUES(1,?,?,'synthetic-server',?,'1','now','now')", (bytes(fixture['data']), bytes(fixture['nonce']), f'http://127.0.0.1:{server.server_port}/'))
            assert 'Connected' in cli('status')
            assert len(json.loads(cli('playlists', '--json'))) == 2
            cli('refresh', '--playlist', 'plex:playlist:10', '--playlist', 'plex:playlist:20')
            assert json.loads(cli('estimate'))['tracks'] == 4
            for route, expected in [('mtp', 4), ('express', 1), ('music', 1)]:
                output = Path(cli('export', '--destination', destination, '--route', route, '--bitrate', '320'))
                assert len(list(output.rglob('*.mp3'))) == expected
                if route == 'mtp':
                    assert all(not p.read_text().startswith('#') for p in output.rglob('*.m3u8'))
                if route == 'music':
                    assert '.incomplete' not in (output / 'Import playlists.xml').read_text()
            backup = Path(cli('backup', '--destination', root))
            result = subprocess.run([str(binary), '--profile', str(backup), 'status'], capture_output=True, text=True, check=True)
            assert 'Connected' in result.stdout
            print('Native CLI smoke passed: profile, playlists, refresh, estimates, three export routes, backup restore.')
            if args.gui:
                with (root / 'gui.log').open('w') as log:
                    app = subprocess.Popen([str(gui), '--profile', str(profile)], stdout=log, stderr=log)
                    try:
                        window = None
                        for _ in range(100):
                            assert app.poll() is None, 'Native app exited before window appeared'
                            result = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^SyncAndRun$'], capture_output=True, text=True)
                            if result.returncode == 0:
                                window = result.stdout.strip().splitlines()[0]
                                break
                            time.sleep(.1)
                        assert window, 'Native window did not appear'
                        time.sleep(5)
                        # Exercise a bitrate button and a playlist checkbox.
                        subprocess.run(['xdotool', 'mousemove', '--window', window, '55', '471', 'click', '1'], check=True)
                        subprocess.run(['xdotool', 'mousemove', '--window', window, '150', '200', 'click', '1'], check=True)
                        time.sleep(.5)
                        if args.gui_export:
                            gui_destination = root / 'gui-exports'
                            gui_destination.mkdir()
                            subprocess.run(['xdotool', 'mousemove', '--window', window, '100', '608', 'click', '1'], check=True)
                            time.sleep(2)
                            subprocess.run(['xdotool', 'key', 'alt+Home'], check=True)
                            time.sleep(.5)
                            subprocess.run(['xdotool', 'key', 'ctrl+l'], check=True)
                            subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '25', str(gui_destination)], check=True)
                            subprocess.run(['xdotool', 'key', 'Return'], check=True)
                            time.sleep(1)
                            result = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^Open Folder$'], text=True, capture_output=True)
                            if result.returncode == 0:
                                dialog = result.stdout.strip().splitlines()[0]
                                geometry = dict(line.split('=', 1) for line in subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', dialog], text=True).splitlines())
                                subprocess.run(['xdotool', 'mousemove', '--window', dialog, str(int(geometry['WIDTH']) - 90), str(int(geometry['HEIGHT']) - 25), 'click', '1'], check=True)
                            time.sleep(1)
                            subprocess.run(['xdotool', 'mousemove', '--window', window, '160', '665', 'click', '1'], check=True)
                            for _ in range(100):
                                outputs = [p for p in gui_destination.iterdir() if not p.name.endswith('.incomplete')]
                                if len(outputs) == 1:
                                    break
                                time.sleep(.1)
                            if len(outputs) != 1 and args.screenshot:
                                subprocess.run(['import', '-window', 'root', str(args.screenshot)], check=True)
                            assert len(outputs) == 1, 'Desktop export did not complete through the portal picker'
                            assert len(list(outputs[0].rglob('*.mp3'))) == 1, 'Desktop playlist selection did not affect export'
                            print('Native GPUI export passed through the GTK portal folder picker.')
                            time.sleep(.5)
                        if args.screenshot:
                            subprocess.run(['import', '-window', window, str(args.screenshot)], check=True)
                        assert app.poll() is None
                        print('Native GPUI window launched with synthetic playlists; inspect screenshot for rendering.')
                    finally:
                        app.terminate()
                        app.wait(timeout=10)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gui', action='store_true')
    parser.add_argument('--screenshot', type=Path)
    parser.add_argument('--gui-export', action='store_true', help='Also exercise the GTK portal folder picker and export (requires --gui and a session bus)')
    run(parser.parse_args())
