#!/usr/bin/env python3
"""Opt-in physical Garmin acceptance using generated audio and an isolated profile.

Requires a connected watch, ffmpeg and Node. --gui also needs an X display and
xdotool. This writes new synthetic playlist folders on the watch. It never reads
an existing Plex profile or stages exported audio on disk. Not an automated CI test.
"""
import argparse
import http.server
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_smoke', ROOT / 'scripts/native-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-watch', action='store_true', required=True)
    parser.add_argument('--gui', action='store_true')
    parser.add_argument('--screenshot', type=Path)
    args = parser.parse_args()
    # Keep the source MP3 in memory; the app receives it over HTTP like Plex audio.
    tone = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
        'sine=frequency=440:duration=3', '-filter:a', 'volume=0.1', '-codec:a',
        'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'])

    class Plex(smoke.Plex):
        def do_GET(self):
            if '/start.mp3' in self.path:
                assert self.headers.get('X-Plex-Token') == 'synthetic-server-token'
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                # No content length: direct transfer must handle chunked/unknown sizes.
                self.end_headers()
                self.wfile.write(tone)
            else:
                super().do_GET()

    with tempfile.TemporaryDirectory(prefix='syncandrun-watch-acceptance-') as directory:
        root = Path(directory)
        profile = root / 'profile'
        binary = ROOT / 'target/debug/syncandrun'
        def cli(*command):
            result = subprocess.run([str(binary), '--profile', str(profile), *command], capture_output=True, text=True, timeout=180)
            assert result.returncode == 0, result.stderr
            return result.stdout
        assert 'Not connected' in cli('status')
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
            assert len(json.loads(cli('playlists', '--json'))) == 2  # fixture readiness
            if not args.gui:
                print(cli('devices'), end='')
                print(cli('transfer', '--playlist', 'plex:playlist:10', '--playlist', 'plex:playlist:20'), end='')
                assert not list(root.rglob('*.mp3'))
                print('Physical CLI acceptance passed: direct transfer and full read-back verification, no local MP3 files.')
            else:
                (profile / 'desktop-preferences.json').write_text(json.dumps(dict(selected=['plex:playlist:10', 'plex:playlist:20'], bitrate=192, direct=True)))
                with (root / 'gui.log').open('w') as log:
                    app = subprocess.Popen([str(ROOT / 'target/debug/syncandrun-desktop'), '--profile', str(profile)], stdout=log, stderr=log)
                    try:
                        for _ in range(600):
                            result = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^SyncAndRun$'], capture_output=True, text=True)
                            if result.returncode == 0: break
                            assert app.poll() is None, 'GUI exited'
                            time.sleep(.1)
                        assert result.returncode == 0, "Native window did not appear within 60 seconds"
                        window = result.stdout.strip().splitlines()[0]
                        print(f'Physical acceptance GUI ready, window {window}.', flush=True)
                        time.sleep(6)
                        if args.screenshot:
                            subprocess.run(['import', '-window', window, str(args.screenshot)], check=True)
                        # Remain available for manual GUI interaction and visual inspection.
                        time.sleep(180)
                        assert not list(root.rglob('*.mp3'))
                    finally:
                        app.terminate()
                        app.wait(timeout=10)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
