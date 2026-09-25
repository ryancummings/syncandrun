#!/usr/bin/env python3
"""Create a private Compose env file without exposing its generated secret."""
import argparse
import ipaddress
import os
import re
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', required=True, help='Canonical HTTPS origin, or private IPv4 HTTP origin with --allow-lan-http')
parser.add_argument('--allow-lan-http', action='store_true', help='Opt into unencrypted browser and watch traffic on a private LAN IP')
parser.add_argument('--project', default='syncandrun')
parser.add_argument('--port', type=int, default=3000)
parser.add_argument('--output', default='.env')
args = parser.parse_args()
url = urlsplit(args.origin)
def private_lan_ipv4(host):
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(address in network for network in (
        ipaddress.ip_network('10.0.0.0/8'), ipaddress.ip_network('172.16.0.0/12'),
        ipaddress.ip_network('192.168.0.0/16')))


valid_https = (url.scheme == 'https' and not args.allow_lan_http
               and re.fullmatch(r'[a-zA-Z0-9.-]+', url.hostname or ''))
valid_lan_http = (url.scheme == 'http' and args.allow_lan_http
                  and private_lan_ipv4(url.hostname or ''))
if (not (valid_https or valid_lan_http) or url.netloc != url.hostname
        or url.path not in ('', '/') or url.query or url.fragment):
    parser.error('--origin must be an HTTPS DNS origin, or a private IPv4 HTTP origin with --allow-lan-http; no port, credentials, path or query')
if not re.fullmatch(r'[a-z][a-z0-9_-]{0,48}', args.project):
    parser.error('--project must start with a lowercase letter and contain lowercase letters, digits, _ or -')
if not 1024 <= args.port <= 65535:
    parser.error('--port must be between 1024 and 65535')
content = f'''COMPOSE_PROJECT_NAME={args.project}
SYNCANDRUN_BASE_URL={url.scheme}://{url.hostname}
SYNCANDRUN_ALLOW_LAN_HTTP={'true' if args.allow_lan_http else 'false'}
SYNCANDRUN_SECRET={secrets.token_hex(32)}
SYNCANDRUN_PORT={args.port}
SYNCANDRUN_BIND_ADDRESS=127.0.0.1
SYNCANDRUN_LOG_LEVEL=info
SYNCANDRUN_TRUST_PROXY=false
SYNCANDRUN_ARTWORK_BASE_URL=
'''
try:
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    parser.error('output already exists; refusing to overwrite credentials')
with os.fdopen(fd, 'w') as file:
    file.write(content)
print(f'Created private configuration: {args.output}')
