#!/usr/bin/env python3
"""Render private shared-pool configuration; no installation or network calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import urllib.parse


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--backend-config', required=True, type=Path)
    ap.add_argument('--service-url', required=True)
    ap.add_argument('--output-dir', required=True, type=Path)
    ap.add_argument('--listen', default='127.0.0.1:8091')
    ap.add_argument('--tls-cert')
    ap.add_argument('--tls-key')
    ap.add_argument('--writer', action='append', default=[])
    ap.add_argument('--pool-manager', action='append', default=[])
    ap.add_argument('--configurator', action='append', default=[], help='Namespace manager with a separate human-only Nest binding')
    args = ap.parse_args()
    endpoint = urllib.parse.urlsplit(args.service_url)
    if (endpoint.username is not None or endpoint.password is not None or endpoint.query or endpoint.fragment
            or endpoint.path not in ('', '/') or not endpoint.hostname
            or not (endpoint.scheme == 'https' or (endpoint.scheme == 'http' and endpoint.hostname in ('localhost', '127.0.0.1', '::1')))):
        ap.error('service URL must use HTTPS or loopback HTTP, with no path or credentials')
    if bool(args.tls_cert) != bool(args.tls_key):
        ap.error('supply both TLS certificate and key')
    if args.backend_config.stat().st_mode & 0o077:
        ap.error('backend config must have mode 0600')
    storage = json.loads(args.backend_config.read_text())
    soots = storage.get('soots', [])
    managers = storage.get('managers', [])
    if (not 1 <= len(soots) <= 128 or not 1 <= len(managers) <= 16 or len(set(soots)) != len(soots)
            or any(not isinstance(s, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', s) for s in soots)
            or any(s not in soots for s in managers + args.writer + args.pool_manager)
            or any(s not in managers for s in args.configurator) or storage.get('service_url')):
        ap.error('backend config requires distinct Soot identities and bound managers/writers/pool managers')
    config = {'listen': args.listen, 'storage': storage, 'clients': []}
    if args.tls_cert:
        config.update(tls_cert=args.tls_cert, tls_key=args.tls_key)
    # Never replace an existing directory or credential. The operator moves only
    # each client's own binding to its host, leaving backend credentials on VM.
    args.output_dir.mkdir(mode=0o700)
    os.chmod(args.output_dir, 0o700)
    bindings = args.output_dir / 'bindings'
    bindings.mkdir(mode=0o700)
    def private_json(path, obj):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(obj, file, indent=2, ensure_ascii=False)
            file.write('\n')
    for soot in soots:
        token = secrets.token_urlsafe(32)
        operations = ['pools', 'query', 'status']
        if soot in managers or soot in args.writer or soot in args.pool_manager:
            operations += ['write']
        if soot in managers or soot in args.pool_manager:
            operations += ['manage']
        config['clients'].append({'soot': soot, 'token_sha256': hashlib.sha256(token.encode()).hexdigest(), 'operations': operations})
        private_json(bindings / (soot + '.json'), {'service_url': args.service_url.rstrip('/'), 'service_token': token})
        if soot in args.configurator:
            ui_token = secrets.token_urlsafe(32)
            config['clients'].append({'soot': soot, 'token_sha256': hashlib.sha256(ui_token.encode()).hexdigest(), 'operations': ['view', 'action']})
            private_json(bindings / (soot + '.ui.json'), {'service_url': args.service_url.rstrip('/'), 'service_token': ui_token})
    private_json(args.output_dir / 'service.json', config)
    print(f'Created private config and {len(soots)} client bindings. No service installed or started.')


if __name__ == '__main__':
    main()
