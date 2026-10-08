"""Soot executable contract: check Codex, prepare, inspect and assemble pet art."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from codex_status import check_codex

PACK = Path(__file__).resolve().parents[1]
FORMAT = json.loads((PACK / 'assets/animation.json').read_text())
STATES = FORMAT['states']
ACTIONS = json.loads((PACK / 'assets/actions.json').read_text())
SLUG = re.compile(r'^[a-z][a-z0-9-]{0,47}$')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def bounded(root, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Expected a relative path inside SOOT_PET_STORE')
    result = root / path
    current = result
    while current != root:
        if current.is_symlink():
            raise ValueError('Symlinks are not supported in the pet store')
        current = current.parent
    if not result.resolve().is_relative_to(root):
        raise ValueError('Path escapes SOOT_PET_STORE')
    return result


def text_field(data, key, maximum, default=None):
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'{key}: expected non-empty text, at most {maximum} characters')
    return value.strip()


def read_call(command):
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Tool envelope exceeds 1 MiB')
    call = json.loads(raw)
    if not isinstance(call, dict) or call.get('api_version') != 'soot/v1' or call.get('hook') != 'tool.call':
        raise ValueError('Expected a soot/v1 tool.call envelope')
    if call.get('operation') != f'soot_pet_{command}':
        raise ValueError('Operation does not match executable action')
    data = call.get('input')
    allowed = ({'id', 'name', 'accessories', 'action', 'reference'} if command == 'prepare'
               else set() if command == 'preflight' else {'id'})
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError('Invalid input fields')
    if len(json.dumps(data).encode()) > 16384:
        raise ValueError('Tool input exceeds 16 KiB')
    if command != 'preflight' and (not isinstance(data.get('id'), str) or not SLUG.fullmatch(data['id'])):
        raise ValueError('id must start with a lowercase letter; use at most 48 lowercase letters, digits or hyphens')
    return data


def prompt(state, request):
    action = ACTIONS[state].replace('{action}', request['action'])
    eyes = ('Both eyes remain FULLY CLOSED in every frame. No blink sequence, visible pupils or cream eye disks.'
            if state == 'sleeping' else
            'Eye centers, pupils, highlights and forward gaze stay fixed. Frames 1–4 and 8–12 eyes fully open; '
            'frame 5 half closed, 6 fully closed, 7 half open. Dark furry UPPER lids cover stationary eyes; '
            'lower lids barely move. Closed eyes are narrow dark seams, never cream circles with smile lines. '
            'If wearing spectacles, COMPLETE rims, bridge and side pieces remain IN FRONT of eyelids throughout.')
    return f'''Create one animation exposure sheet for a new Soot pet: 12 chronological drawings, FOUR columns by THREE rows, transparent PNG 1536×1024. Equal slots, entire character and prop inside a 280×290 safe box per slot. No visible grid, text, background, shadows, haze or detached effects.
Input 1: character identity reference. Preserve its charcoal soft fur, curled forelock, warm cream eyes, two tiny connected mitten hands, rounded feet and proportions. REPLACE the reference's held object and worn accessories with exactly: {request['accessories']}. Do not retain the old teddy, brick or any second prop unless explicitly requested above.
Input 2: {'sleeping' if state == 'sleeping' else 'approved awake'} motion/layout guide only; do not copy its prop or accessories.
Use the same camera, foot contacts, body scale, fur tufts, eye spacing and prop geometry throughout. Exactly TWO connected hands. When one hand moves, its original grip disappears; the other hand supports the prop. No third hand, body wobble, zoom, smears or afterimages.
{eyes}
{action}
Draw successive articulated inbetweens with a smooth rise and return. Last pose joins first without teleporting. Retain genuinely transparent empty gutters. This is one coherent animation, not twelve unrelated expressions.
'''


def prepare(root, data):
    request = {'id': data['id'], 'name': text_field(data, 'name', 100),
               'accessories': text_field(data, 'accessories', 600),
               'action': text_field(data, 'action', 400)}
    reference = bounded(root, text_field(data, 'reference', 256)) if 'reference' in data else PACK / 'assets/soot-reference.png'
    if (reference.suffix.lower() not in ('.png', '.webp', '.jpg', '.jpeg') or
            not reference.is_file() or reference.stat().st_size > 16 * 1024 * 1024):
        raise ValueError('Identity reference must be an existing image of at most 16 MiB')
    from PIL import Image
    with Image.open(reference) as image:
        if image.format not in ('PNG', 'WEBP', 'JPEG') or image.width * image.height > 16_000_000:
            raise ValueError('Unsupported identity reference image')
        image.verify()
    request['referenceSha256'] = digest(reference)
    job = bounded(root, f'jobs/{data["id"]}')
    if job.exists():
        if not (job / 'request.json').is_file() or json.loads((job / 'request.json').read_text()) != request:
            raise ValueError('Pet id already exists with a different brief; choose a new id')
        return inspect(root, data)
    stage = Path(tempfile.mkdtemp(prefix='.prepare-', dir=job.parent))
    try:
        for folder in ('references', 'prompts', f'sources/{data["id"]}'):
            (stage / folder).mkdir(parents=True)
        # Copy exact image bytes; no new visual content is synthesized here.
        identity_name = 'identity' + reference.suffix.lower()
        shutil.copyfile(reference, stage / 'references' / identity_name)
        for guide in ('awake-motion.webp', 'sleeping-motion.webp'):
            shutil.copyfile(PACK / 'assets' / guide, stage / 'references' / guide)
        jobs = []
        for state in STATES:
            prompt_file = f'prompts/{state}.txt'
            (stage / prompt_file).write_text(prompt(state, request))
            jobs.append({'state': state, 'prompt': prompt_file,
                         'inputImages': [f'references/{identity_name}', f'references/{"sleeping" if state == "sleeping" else "awake"}-motion.webp'],
                         'output': f'sources/{data["id"]}/{state}.png'})
        write_json(stage / 'request.json', request)
        write_json(stage / 'jobs.json', {'generator': 'Codex imagegen handoff', 'jobs': jobs})
        stage.rename(job)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return inspect(root, data)


def inspect(root, data):
    job = bounded(root, f'jobs/{data["id"]}')
    if not job.is_dir():
        raise ValueError('Unknown pet id; prepare it first')
    request_file = bounded(root, f'jobs/{data["id"]}/request.json')
    request = json.loads(request_file.read_text())
    rows = []
    for state in STATES:
        path = bounded(root, f'jobs/{data["id"]}/sources/{data["id"]}/{state}.png')
        rows.append({'state': state, 'present': path.is_file(), 'path': str(path)})
    builds = bounded(root, f'jobs/{data["id"]}/builds')
    available = []
    if builds.is_dir():
        for entry in sorted(builds.iterdir(), key=lambda p: p.name):
            if re.fullmatch(r'[0-9a-f]{24}', entry.name):
                candidate = bounded(root, f'jobs/{data["id"]}/builds/{entry.name}')
                if candidate.is_dir():
                    available.append(str(candidate))
    return {'id': data['id'], 'name': request['name'], 'jobDirectory': str(job),
            'jobsFile': str(job / 'jobs.json'), 'sources': rows,
            'generation': 'external_codex_imagegen', 'missingStates': [r['state'] for r in rows if not r['present']],
            'builds': available[:16], 'buildCount': len(available), 'visualReviewRequired': True}


def assemble(root, data):
    from atlas import build
    status = inspect(root, data)
    if status['missingStates']:
        raise ValueError('Missing generated states: ' + ', '.join(status['missingStates']))
    job = bounded(root, f'jobs/{data["id"]}')
    request = json.loads((job / 'request.json').read_text())
    sources = {row['state']: bounded(root, f'jobs/{data["id"]}/sources/{data["id"]}/{row["state"]}.png') for row in status['sources']}
    for state, path in sources.items():
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError(f'{state}: source exceeds 16 MiB')
    orders_file = bounded(root, f'jobs/{data["id"]}/frame-order.json')
    orders = json.loads(orders_file.read_text()) if orders_file.exists() else {}
    if not isinstance(orders, dict) or set(orders) - {f'{data["id"]}-{s}' for s in STATES}:
        raise ValueError('frame-order.json has unknown row keys')
    source_hashes = {s: digest(p) for s, p in sources.items()}
    generation = json.loads(bounded(root, f'jobs/{data["id"]}/jobs.json').read_text())['jobs']
    if (not isinstance(generation, list) or len(generation) != len(STATES) or
            {j['state'] for j in generation} != set(STATES)):
        raise ValueError('jobs.json must contain exactly the seven state jobs')
    provenance = []
    for item in generation:
        if item['output'] != f'sources/{data["id"]}/{item["state"]}.png':
            raise ValueError('Keep generated outputs at the declared source paths')
        refs = item['inputImages']
        if not isinstance(refs, list) or not refs or len(refs) > 5:
            raise ValueError('Each generation job requires 1–5 grounded input images')
        provenance.append({'state': item['state'], 'prompt': item['prompt'],
                           'promptSha256': digest(bounded(root, f'jobs/{data["id"]}/{item["prompt"]}')),
                           'references': [{'file': ref, 'sha256': digest(bounded(root, f'jobs/{data["id"]}/{ref}'))} for ref in refs]})
    version = hashlib.sha256(json.dumps({'sources': source_hashes, 'orders': orders, 'request': request,
                                        'generation': provenance, 'format': FORMAT,
                                        'assembler': digest(PACK / 'tools/atlas.py')}, sort_keys=True).encode()).hexdigest()[:24]
    builds = bounded(root, f'jobs/{data["id"]}/builds')
    builds.mkdir(exist_ok=True)
    destination = bounded(root, f'jobs/{data["id"]}/builds/{version}')
    if destination.exists():
        return {'id': data['id'], 'output': str(destination), 'reused': True, 'visualReviewRequired': True}
    stage = Path(tempfile.mkdtemp(prefix='.assemble-', dir=builds))
    try:
        previews = stage / 'previews'
        previews.mkdir()
        report = build(job / 'sources', data['id'], STATES, FORMAT['durationsMs'], stage, previews, orders)
        variant = {'id': data['id'], 'label': request['name'], 'file': f'{data["id"]}/spritesheet.webp',
                   'files': {s: f'{data["id"]}/{s}.webp' for s in STATES}}
        manifest = {**FORMAT, 'variants': [variant]}
        write_json(stage / 'manifest.json', manifest)
        (stage / 'atlas.js').write_text('window.SootPetAtlas = ' + json.dumps(manifest, ensure_ascii=False) + ';\n')
        write_json(stage / 'validation.json', {'errors': [], 'visualReviewRequired': True, 'variants': [report]})
        if source_hashes != {s: digest(p) for s, p in sources.items()}:
            raise ValueError('Source images changed during assembly; finish copying them before retrying')
        write_json(stage / 'provenance.json', {'request': request, 'sourceSha256': source_hashes,
                                             'generation': provenance, 'frameOrders': orders})
        stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {'id': data['id'], 'output': str(destination), 'frames': 84, 'visualReviewRequired': True,
            'manifest': str(destination / 'manifest.json'), 'contact': str(destination / 'previews' / f'{data["id"]}-contact.png')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'prepare', 'inspect', 'assemble'])
    command = parser.parse_args().action
    try:
        data = read_call(command)
        if command in ('preflight', 'prepare'):
            readiness = check_codex()
            if command == 'preflight' or not readiness['canPrepare']:
                print(json.dumps(readiness, ensure_ascii=False))
                return 0
        configured = os.environ.get('SOOT_PET_STORE', '')
        if not configured or not Path(configured).is_absolute():
            raise ValueError('Host must bind an absolute SOOT_PET_STORE directory')
        root = Path(configured).resolve()
        if not root.is_dir():
            raise ValueError('SOOT_PET_STORE must already exist')
        if command == 'inspect':
            result = inspect(root, data)
        else:
            jobs = bounded(root, 'jobs')
            jobs.mkdir(mode=0o700, exist_ok=True)
            lock = bounded(root, f'jobs/.{data["id"]}.lock')
            with lock.open('a') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = {'prepare': prepare, 'assemble': assemble}[command](root, data)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError, ImportError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
