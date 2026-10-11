#!/usr/bin/env python3
"""Run the shared data-pool service and Meilisearch on this machine with Docker.

install    build the service image, start Meilisearch and the service, render
           bindings into HOME/data-pool (mode 0700)
status     show containers, readiness and the binding files
upgrade    rebuild the service image from this checkout and replace only the
           service container; data, keys and bindings are kept
uninstall  remove containers, networks and images; keep data and bindings
           (--purge also deletes volumes and HOME/data-pool)

Meilisearch is reachable only on a private internal Docker network. The service
publishes 127.0.0.1:PORT and nothing else. Keys never appear in arguments or
output; every resource carries the label io.soot.data-pool=local.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

PREFIX = 'soot-data-pool-local'
LABEL = 'io.soot.data-pool=local'
MEILI_IMAGE = 'getmeili/meilisearch:v1.54.3'
INTERNAL, EGRESS = PREFIX, PREFIX + '-egress'
MEILI, SERVICE = PREFIX + '-meili', PREFIX + '-service'
MEILI_VOLUME, STATE_VOLUME = PREFIX + '-meili', PREFIX + '-state'
MARKER = '.soot-data-pool-local'
# The service backend key can touch only data-pool indexes, never other products'.
KEY_ACTIONS = ['search', 'documents.add', 'documents.get', 'documents.delete',
               'indexes.create', 'indexes.get', 'indexes.delete', 'tasks.get']
OPERATOR = Path(__file__).resolve().parent
RUNNER = OPERATOR.parent / 'runner'


def docker(*args, check=True, capture=True, stdin=None):
    r = subprocess.run(['docker', *args], input=stdin, text=True,
                       stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None)
    if check and r.returncode:
        sys.exit(f'docker {args[0]} failed: {(r.stderr or "").strip()[:400]}')
    return (r.stdout or '').strip()


def exists(kind, name):
    return subprocess.run(['docker', kind, 'inspect', name], capture_output=True).returncode == 0


def private_write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


def root_of(args):
    return Path(args.home).expanduser().resolve() / 'data-pool'


def meili_request(method, path, master, body=None):
    # curl inside the Meilisearch container reads the key from stdin, so it
    # never reaches a process argument or the host network.
    config = f'header = "Authorization: Bearer {master}"\nrequest = "{method}"\nurl = "http://127.0.0.1:7700{path}"\nsilent\nshow-error\n'
    if body is not None:
        config += 'header = "Content-Type: application/json"\ndata = ' + json.dumps(json.dumps(body)) + '\n'
    out = docker('exec', '-i', MEILI, 'curl', '-K', '-', '-w', '\n%{http_code}', stdin=config)
    payload, _, status = out.rpartition('\n')
    return int(status), json.loads(payload) if payload.strip() else None


def wait_ready(check, what, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if check():
            return
        time.sleep(1)
    sys.exit(f'{what} did not become ready in {seconds}s; see docker logs')


def service_ready(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/readyz', timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def build_image():
    rev = subprocess.run(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=RUNNER, capture_output=True, text=True).stdout.strip() or 'dev'
    tag = f'soot-data-pool:local-{rev}'
    print(f'Building {tag} from {RUNNER} ...')
    docker('build', '--quiet', '--label', LABEL, '-t', tag, '-f', str(OPERATOR.parent / 'service/Dockerfile'), str(RUNNER))
    return tag


def run_service(root, image, port):
    config = json.load(open(root / 'service/service.json'))
    with tempfile.TemporaryDirectory() as tmp:
        env = Path(tmp) / 'service.env'
        private_write(env, 'DATA_POOL_SERVICE_CONFIG=' + json.dumps(config, separators=(',', ':')) + '\n')
        docker('create', '--name', SERVICE, '--label', LABEL, '--restart', 'unless-stopped',
               '--network', INTERNAL, '--env-file', str(env), '-p', f'127.0.0.1:{port}:8091',
               '-v', f'{STATE_VOLUME}:/data', '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '0.5',
               '--pids-limit', '128', '--stop-timeout', '30', image)
    docker('network', 'connect', EGRESS, SERVICE)  # outbound HTTPS for URL imports
    docker('start', SERVICE)
    wait_ready(lambda: service_ready(port), 'data-pool service')


def install(args):
    root = root_of(args)
    soots = [s.strip() for s in args.soots.split(',') if s.strip()]
    if args.manager not in soots:
        sys.exit('--manager must be one of --soots')
    if exists('container', SERVICE) or exists('container', MEILI):
        sys.exit('Already installed; use status, upgrade or uninstall.')
    fresh = not (root / MARKER).exists()
    if fresh:
        if root.exists() and any(root.iterdir()):
            sys.exit(f'{root} exists and was not created by this tool; move it away first.')
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        private_write(root / MARKER, 'soot-data-pool-local\n')
        private_write(root / 'meili.env', 'MEILI_MASTER_KEY=' + secrets.token_urlsafe(48) + '\nMEILI_ENV=production\nMEILI_NO_ANALYTICS=true\n'
                      'MEILI_MAX_INDEXING_MEMORY=256 MiB\nMEILI_MAX_INDEXING_THREADS=1\n')
    image = build_image()
    for net, internal in ((INTERNAL, True), (EGRESS, False)):
        if not exists('network', net):
            docker('network', 'create', '--label', LABEL, *(['--internal'] if internal else []), net)
    for vol in (MEILI_VOLUME, STATE_VOLUME):
        if not exists('volume', vol):
            docker('volume', 'create', '--label', LABEL, vol)
    docker('run', '-d', '--name', MEILI, '--label', LABEL, '--restart', 'unless-stopped', '--network', INTERNAL,
           '--env-file', str(root / 'meili.env'), '-v', f'{MEILI_VOLUME}:/meili_data', '--cap-drop', 'ALL',
           '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '0.5', '--pids-limit', '128', MEILI_IMAGE)
    master = next(l.split('=', 1)[1] for l in open(root / 'meili.env').read().splitlines() if l.startswith('MEILI_MASTER_KEY='))
    wait_ready(lambda: meili_request('GET', '/health', master)[0] == 200, 'Meilisearch')
    if fresh:
        status, key = meili_request('POST', '/keys', master, {'name': 'soot-data-pool', 'description': 'Soot data-pool service backend',
                                                              'actions': KEY_ACTIONS, 'indexes': ['soot_*'], 'expiresAt': None})
        if status != 201:
            sys.exit(f'Could not create the restricted Meilisearch key (HTTP {status}).')
        backend = {'endpoint': f'http://{MEILI}:7700', 'api_key': key['key'], 'namespace': args.namespace,
                   'state_dir': '/data/state', 'soots': soots, 'managers': [args.manager]}
        private_write(root / 'backend.json', json.dumps(backend, indent=2) + '\n')
        cmd = [sys.executable, str(OPERATOR / 'configure-service.py'), '--backend-config', str(root / 'backend.json'),
               '--service-url', f'http://127.0.0.1:{args.port}', '--listen', '0.0.0.0:8091', '--private-network',
               '--host', f'{args.host_name}={",".join(soots)}', '--configurator', args.manager, '--output-dir', str(root / 'service')]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    run_service(root, image, args.port)
    print(f'Data pool ready at http://127.0.0.1:{args.port} (service image {image}).')
    print(f'Machine binding: {root}/service/bindings/host-{args.host_name}.json')
    print(f'Nest UI binding: {root}/service/bindings/{args.manager}.ui.json')


def status(args):
    root = root_of(args)
    print(docker('ps', '-a', '--filter', 'label=' + LABEL, '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}') or 'No containers.')
    port = docker('port', SERVICE, '8091', check=False).rpartition(':')[2]
    if port:
        print(f'readyz: {"ready" if service_ready(port) else "NOT ready"}')
    bindings = root / 'service/bindings'
    if bindings.exists():
        print('bindings:', ', '.join(sorted(p.name for p in bindings.iterdir())))


def upgrade(args):
    root = root_of(args)
    if not exists('container', SERVICE):
        sys.exit('Not installed.')
    port = docker('port', SERVICE, '8091').rpartition(':')[2]
    old = docker('inspect', '-f', '{{.Config.Image}}', SERVICE)
    image = build_image()
    docker('rm', '-f', SERVICE)
    try:
        run_service(root, image, port)
    except SystemExit:
        print(f'Upgrade failed; restoring {old}.', file=sys.stderr)
        docker('rm', '-f', SERVICE, check=False)
        run_service(root, old, port)
        raise
    if old != image:
        docker('image', 'rm', old, check=False)
    print(f'Upgraded to {image}; data and bindings unchanged.')


def uninstall(args):
    root = root_of(args)
    images = {docker('inspect', '-f', '{{.Config.Image}}', c, check=False) for c in (SERVICE,) if exists('container', c)}
    for c in (SERVICE, MEILI):
        docker('rm', '-f', c, check=False)
    for net in (INTERNAL, EGRESS):
        docker('network', 'rm', net, check=False)
    images |= set(docker('images', '--filter', 'label=' + LABEL, '--format', '{{.Repository}}:{{.Tag}}', check=False).split())
    for image in filter(None, images):
        docker('image', 'rm', image, check=False)
    if not args.purge:
        print(f'Removed containers, networks and images. Kept volumes and {root}; rerun install to resume, or uninstall --purge.')
        return
    for vol in (MEILI_VOLUME, STATE_VOLUME):
        docker('volume', 'rm', vol, check=False)
    if root.exists():
        if not (root / MARKER).exists():
            sys.exit(f'{root} was not created by this tool; left in place.')
        shutil.rmtree(root)
    left = docker('ps', '-a', '-q', '--filter', 'label=' + LABEL) + docker('volume', 'ls', '-q', '--filter', 'label=' + LABEL) + docker('network', 'ls', '-q', '--filter', 'label=' + LABEL)
    if left:
        sys.exit('Some labeled resources remain: ' + left.replace('\n', ' '))
    print('Purged: containers, networks, images, volumes, keys and bindings. Remove the data_pool block from each Soot host.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--home', default=os.environ.get('SOOT_HOME', '~/.soot'), help='Soot home; secrets go to HOME/data-pool')
    sub = ap.add_subparsers(dest='command', required=True)
    i = sub.add_parser('install')
    i.add_argument('--soots', required=True, help='comma-separated Soot ids bound to this pool')
    i.add_argument('--manager', required=True, help='namespace manager; also gets the Nest UI binding')
    i.add_argument('--namespace', default='local')
    i.add_argument('--host-name', default='local', help='machine credential name (bindings/host-NAME.json)')
    i.add_argument('--port', type=int, default=8091)
    sub.add_parser('status')
    sub.add_parser('upgrade')
    u = sub.add_parser('uninstall')
    u.add_argument('--purge', action='store_true', help='also delete data volumes, keys and bindings')
    args = ap.parse_args()
    {'install': install, 'status': status, 'upgrade': upgrade, 'uninstall': uninstall}[args.command](args)


if __name__ == '__main__':
    main()
