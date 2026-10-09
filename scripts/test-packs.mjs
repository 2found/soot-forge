// Trusted-source runner checks. Never invoked by the pull_request catalog job:
// unlike manifest validation these lanes execute each pack's source code.
import {spawn} from 'node:child_process';
import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--python', '--report'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Usage: node scripts/test-packs.mjs [--python INTERPRETER --report FILE]');
  options[process.argv[i].slice(2)] = resolve(process.argv[i + 1]);
}
const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
const packs = catalog.packs.filter(p => p.source.kind === 'bundled');
const nodeTests = [], goModules = [];
async function discover(folder) {
  for (const entry of await readdir(folder, {withFileTypes:true})) {
    if (entry.name.startsWith('.') || ['node_modules', '__pycache__', 'vendor'].includes(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await discover(path);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) nodeTests.push(path);
    else if (entry.isFile() && entry.name === 'go.mod') goModules.push(folder);
  }
}
for (const pack of packs) await discover(join(root, pack.source.path));
const report = {catalog_entries:catalog.packs.length, bundled_packs:packs.length, lanes:[], external:'Pinned external source is validated separately; its code is not executed', python:options.python ? 'requested' : 'NOT RUN: pass --python with Office dependencies, FFmpeg and fonts installed'};
report.node_test_files = nodeTests.map(p=>p.slice(root.length+1)).sort();
report.go_modules = goModules.map(p=>p.slice(root.length+1)).sort();
report.opt_in_services = {
  meilisearch:process.env.DATA_POOL_TEST_MEILI ? 'requested; result is in data-pool Go lane' : 'NOT RUN: no explicitly supplied Meilisearch executable',
  public_web:process.env.DATA_POOL_TEST_PUBLIC_WEB === '1' ? 'requested; result is in data-pool Go lane' : 'NOT RUN: DATA_POOL_TEST_PUBLIC_WEB is not enabled',
};
async function lane(name, program, args, cwd=root) {
  console.log(`\nChecking ${name}`);
  const started = performance.now();
  const result = await new Promise((accept, reject) => {
    const child = spawn(program, args, {cwd, stdio:['ignore', 'pipe', 'pipe']});
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', (code, signal) => accept({exit_code:code, signal, seconds:Number(((performance.now()-started)/1000).toFixed(3)), output_tail:tail}));
  });
  report.lanes.push({name, ...result});
  if (result.exit_code !== 0) throw new Error(`Failed: ${name}`);
}
try {
  await lane('owner-support-copy-check', process.execPath, ['scripts/sync-owner-support.mjs', '--check']);
  if (!nodeTests.length || !goModules.length) throw new Error('Unexpected empty runner inventory');
  await lane('pack-node-tests', process.execPath, ['--test', ...nodeTests.sort()]);
  for (const folder of goModules.sort()) await lane(folder.slice(root.length+1), 'go', ['test', '-race', '-count=1', './...'], folder);
  if (options.python) {
    await stat(options.python);
    await lane('media-python-tests', options.python, ['scripts/test-media.py']);
    await lane('image-gen-python-tests', options.python, ['packs/image-gen/tests/test_runner.py']);
    await lane('soot-pet-python-tests', options.python, ['packs/soot/tests/test_pet.py']);
  }
} finally {
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2)+'\n');
}
