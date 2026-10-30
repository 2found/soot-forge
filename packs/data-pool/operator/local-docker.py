#!/usr/bin/env python3
"""Run the shared data-pool service and PostgreSQL on this machine with Docker.

install    build the service image, start PostgreSQL 16 and the service, render
           bindings into HOME/data-pool (mode 0700)
status     show containers, readiness and the binding files
upgrade    rebuild the service image from this checkout and replace only the
           service container; PostgreSQL data and bindings are kept
uninstall  remove containers, networks and images; keep PostgreSQL data and
           bindings (--purge also deletes the pgdata volume and HOME/data-pool)

PostgreSQL is reachable only on a private internal Docker network. The service
publishes 127.0.0.1:PORT and nothing else. Generated passwords and DSNs never
appear in arguments or output; every resource carries the label
io.soot.data-pool=local.
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
# Postgres major 16 is the supported minimum. Pin a digest for reproducible
# pulls, for example postgres:16-alpine@sha256:<digest>.
POSTGRES_IMAGE = 'postgres:16-alpine'
INTERNAL, EGRESS = PREFIX, PREFIX + '-egress'
POSTGRES, SERVICE = PREFIX + '-postgres', PREFIX + '-service'
# A pre-PostgreSQL install owned these Meilisearch/state containers and volumes.
LEGACY_CONTAINERS = [PREFIX + '-meili']
LEGACY_VOLUMES = [PREFIX + '-meili', PREFIX + '-state']
PGDATA_VOLUME = PREFIX + '-postgres'
MARKER = '.soot-data-pool-local'
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


def postgres_ready():
    # pg_isready has no credential side effects and reads no secret from argv.
    return subprocess.run(['docker', 'exec', POSTGRES, 'pg_isready', '-U', 'soot', '-d', 'soot'],
                          capture_output=True).returncode == 0


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
               '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '0.5',
               '--pids-limit', '128', '--stop-timeout', '30', image)
    docker('network', 'connect', EGRESS, SERVICE)  # outbound HTTPS for URL imports
    docker('start', SERVICE)
    wait_ready(lambda: service_ready(port), 'data-pool service')


def legacy_install(root):
    config = root / 'service/service.json'
    if not config.exists():
        return False
    try:
        storage = json.load(open(config)).get('storage') or {}
    except (ValueError, OSError):
        return True
    return 'database_url' not in storage


def install(args):
    root = root_of(args)
    if legacy_install(root):
        sys.exit(f'{root} was created for the Meilisearch backend. Run uninstall --purge to discard that local pool state (read any documents you need first), or move {root} aside; then install again.')
    soots = [s.strip() for s in args.soots.split(',') if s.strip()]
    if args.manager not in soots:
        sys.exit('--manager must be one of --soots')
    if exists('container', SERVICE) or exists('container', POSTGRES):
        sys.exit('Already installed; use status, upgrade or uninstall.')
    fresh = not (root / MARKER).exists()
    password = None
    if fresh:
        if root.exists() and any(root.iterdir()):
            sys.exit(f'{root} exists and was not created by this tool; move it away first.')
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        private_write(root / MARKER, 'soot-data-pool-local\n')
        password = secrets.token_urlsafe(32)
        private_write(root / 'postgres.env', 'POSTGRES_USER=soot\nPOSTGRES_PASSWORD=' + password + '\nPOSTGRES_DB=soot\n')
    image = build_image()
    for net, internal in ((INTERNAL, True), (EGRESS, False)):
        if not exists('network', net):
            docker('network', 'create', '--label', LABEL, *(['--internal'] if internal else []), net)
    if not exists('volume', PGDATA_VOLUME):
        docker('volume', 'create', '--label', LABEL, PGDATA_VOLUME)
    docker('run', '-d', '--name', POSTGRES, '--label', LABEL, '--restart', 'unless-stopped', '--network', INTERNAL,
           '--env-file', str(root / 'postgres.env'), '-v', f'{PGDATA_VOLUME}:/var/lib/postgresql/data',
           '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '0.5', '--pids-limit', '128', POSTGRES_IMAGE)
    wait_ready(postgres_ready, 'PostgreSQL')
    if fresh:
        backend = {'database_url': f'postgres://soot:{password}@{POSTGRES}:5432/soot?sslmode=disable',
                   'namespace': args.namespace, 'soots': soots, 'managers': [args.manager]}
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
    if legacy_install(root):
        sys.exit(f'{root} was created for the Meilisearch backend and cannot be upgraded in place. Run uninstall --purge, then install with a PostgreSQL-backed binding.')
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
    print(f'Upgraded to {image}; PostgreSQL data and bindings unchanged.')


def uninstall(args):
    root = root_of(args)
    containers = [SERVICE, POSTGRES, *LEGACY_CONTAINERS]
    images = {docker('inspect', '-f', '{{.Config.Image}}', c, check=False) for c in containers if exists('container', c)}
    for c in containers:
        docker('rm', '-f', c, check=False)
    for net in (INTERNAL, EGRESS):
        docker('network', 'rm', net, check=False)
    images |= set(docker('images', '--filter', 'label=' + LABEL, '--format', '{{.Repository}}:{{.Tag}}', check=False).split())
    for image in filter(None, images):
        docker('image', 'rm', image, check=False)
    if not args.purge:
        print(f'Removed containers, networks and images. Kept the PostgreSQL volume and {root}; rerun install to resume, or uninstall --purge.')
        return
    for volume in [PGDATA_VOLUME, *LEGACY_VOLUMES]:
        docker('volume', 'rm', volume, check=False)
    if root.exists():
        if not (root / MARKER).exists():
            sys.exit(f'{root} was not created by this tool; left in place.')
        shutil.rmtree(root)
    left = docker('ps', '-a', '-q', '--filter', 'label=' + LABEL) + docker('volume', 'ls', '-q', '--filter', 'label=' + LABEL) + docker('network', 'ls', '-q', '--filter', 'label=' + LABEL)
    if left:
        sys.exit('Some labeled resources remain: ' + left.replace('\n', ' '))
    print('Purged: containers, networks, images, the PostgreSQL volume and bindings. Remove the data_pool block from each Soot host.')


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
    u.add_argument('--purge', action='store_true', help='also delete the PostgreSQL volume, generated credentials and bindings')
    args = ap.parse_args()
    {'install': install, 'status': status, 'upgrade': upgrade, 'uninstall': uninstall}[args.command](args)


if __name__ == '__main__':
    main()
