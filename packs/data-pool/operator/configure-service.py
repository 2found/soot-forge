#!/usr/bin/env python3
"""Render private shared-pool configuration; no installation or network calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import urllib.parse

IDENTIFIER = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}')


def valid_id(value):
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def member_ids(ap, group, value):
    """Group rosters appear as {members: {id: {...}}}, {members: [...]}, or a bare list."""
    ids = []
    sources = [value] if isinstance(value, list) else [value.get('members', {}), value.get('entries', [])] if isinstance(value, dict) else None
    if sources is None:
        ap.error(f'group {group!r} must be an object or a list of Soot ids')
    for members in sources:
        if isinstance(members, dict):
            ids.extend(members.keys())
        elif isinstance(members, list):
            for m in members:
                ids.append(m.get('id', m.get('soot')) if isinstance(m, dict) else m)
        else:
            ap.error(f'group {group!r} members must be an object or a list')
    if not ids or not all(valid_id(i) for i in ids):
        ap.error(f'group {group!r} needs at least one valid Soot id')
    return sorted(set(ids))


def parse_host(ap, raw):
    # NAME=soot1,soot2: one machine credential per host, revocable alone.
    name, sep, members = raw.partition('=')
    soots = [s.strip() for s in members.split(',') if s.strip()]
    if not sep or not valid_id(name) or not soots or len(set(soots)) != len(soots):
        ap.error(f'--host expects NAME=soot1,soot2 with an identifier NAME and distinct Soots, got {raw!r}')
    return name, soots


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--backend-config', required=True, type=Path)
    ap.add_argument('--service-url', required=True)
    ap.add_argument('--output-dir', required=True, type=Path)
    ap.add_argument('--listen', default='127.0.0.1:8091')
    ap.add_argument('--tls-cert')
    ap.add_argument('--tls-key')
    ap.add_argument('--private-network', action='store_true', help='Container behind a TLS proxy: allow cleartext non-loopback listen and a private http:// backend')
    ap.add_argument('--host-config', type=Path, help='Soot deployment.json supplying bound soots and group rosters')
    ap.add_argument('--host', action='append', default=[], metavar='NAME=SOOT[,SOOT...]',
                    help='Issue a machine credential (bindings/host-NAME.json) that may act only as the listed Soots; repeat once per Soot host')
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
    if os.path.lexists(args.output_dir):
        ap.error('output directory already exists; it is never replaced')
    if not args.output_dir.parent.is_dir():
        ap.error('output directory parent must exist')
    if args.backend_config.stat().st_mode & 0o077:
        ap.error('backend config must have mode 0600')
    storage = json.loads(args.backend_config.read_text())
    if not isinstance(storage, dict):
        ap.error('backend config must be a JSON object')
    if args.host_config is not None:
        # The host's own configuration is the roster source of truth: bound
        # Soots mirror the host's Soot ids and group rosters mirror host
        # groups, so membership is never declared twice.
        host = json.loads(args.host_config.read_text())
        raw_soots = host.get('soot_ids')
        if raw_soots is None:
            # deployment.json lists Soot definition paths
            # (soots/<dir>/soot.json); the bound identity is the file's id,
            # never a path fragment — dir names and file stems differ from it.
            raw_soots = []
            for entry in host.get('soots', []):
                if not isinstance(entry, str):
                    raw_soots.append(entry.get('id') if isinstance(entry, dict) else None)
                    continue
                definition = args.host_config.parent / entry
                try:
                    raw_soots.append(json.loads(definition.read_text()).get('id'))
                except (OSError, json.JSONDecodeError, AttributeError):
                    ap.error(f'cannot read Soot identity from {entry}')
        if not all(valid_id(s) for s in raw_soots):
            ap.error('every host Soot needs a valid id')
        storage['soots'] = sorted(set(raw_soots))
        storage['groups'] = {g: member_ids(ap, g, v) for g, v in host.get('groups', {}).items()}
    soots = storage.get('soots', [])
    managers = storage.get('managers', [])
    storage['writers'] = sorted(set(storage.get('writers', [])) | set(args.writer))
    storage['pool_managers'] = sorted(set(storage.get('pool_managers', [])) | set(args.pool_manager))
    if (not isinstance(soots, list) or not isinstance(managers, list)
            or not 1 <= len(soots) <= 4096 or not 1 <= len(managers) <= 16 or len(set(soots)) != len(soots)
            or any(not valid_id(s) for s in soots)
            or any(s not in soots for s in managers + storage['writers'] + storage['pool_managers'])
            or any(s not in managers for s in args.configurator) or storage.get('service_url')):
        ap.error('backend config requires distinct Soot identities and bound managers/writers/pool managers')
    if not isinstance(storage.get('groups') or {}, dict):
        ap.error('groups must map group ids to member lists')
    for group, members in (storage.get('groups') or {}).items():
        if not isinstance(members, list) or any(m not in soots for m in members):
            ap.error(f'group {group!r} lists a member that is not a bound Soot')
    hosts = [parse_host(ap, raw) for raw in args.host]
    if len({name for name, _ in hosts}) != len(hosts):
        ap.error('--host names must be distinct')
    for name, members in hosts:
        if any(s not in soots for s in members):
            ap.error(f'--host {name} lists a Soot that is not bound')
    config = {'listen': args.listen, 'storage': storage, 'clients': []}
    if args.tls_cert:
        config.update(tls_cert=args.tls_cert, tls_key=args.tls_key)
    if args.private_network:
        config['private_network'] = True

    # Plan every file in memory first: name collisions (including a Soot id
    # that shadows a host binding, or case-only differences on macOS) fail
    # before anything is written.
    url = args.service_url.rstrip('/')
    files = {}

    def plan(path, obj):
        if path.lower() in {p.lower() for p in files}:
            ap.error(f'two credentials would share {path}; rename the Soot or host')
        files[path] = obj

    def issue(client, path):
        token = secrets.token_urlsafe(32)
        config['clients'].append({**client, 'token_sha256': hashlib.sha256(token.encode()).hexdigest()})
        plan(path, {'service_url': url, 'service_token': token})

    for name, members in hosts:
        # A machine credential: the host authenticates once, each envelope
        # names its own Soot, and the service accepts only these Soots.
        issue({'soot': '@host', 'name': name, 'soots': members}, f'bindings/host-{name}.json')
    for soot in soots:
        operations = ['pools', 'query', 'status']
        if soot in managers or soot in storage['writers'] or soot in storage['pool_managers']:
            operations += ['write']
        if soot in managers or soot in storage['pool_managers']:
            operations += ['manage']
        issue({'soot': soot, 'operations': operations}, f'bindings/{soot}.json')
        if soot in args.configurator:
            issue({'soot': soot, 'operations': ['view', 'action']}, f'bindings/{soot}.ui.json')
    plan('service.json', config)

    # All-or-nothing: render into a private sibling temp dir, then rename it
    # into place. Never replace an existing directory or credential. The
    # operator moves only each client's own binding to its host.
    staging = Path(tempfile.mkdtemp(prefix=f'.{args.output_dir.name}.', dir=args.output_dir.parent))
    try:
        os.chmod(staging, 0o700)
        (staging / 'bindings').mkdir(mode=0o700)
        for path, obj in files.items():
            fd = os.open(staging / path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                json.dump(obj, file, indent=2, ensure_ascii=False)
                file.write('\n')
        if os.path.lexists(args.output_dir):
            raise FileExistsError('output directory appeared while rendering')
        os.rename(staging, args.output_dir)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    names = ', '.join(sorted(p for p in files if p != 'service.json'))
    print(f'Created private service.json and {len(files) - 1} client bindings ({names}). No service installed or started.')


if __name__ == '__main__':
    main()
