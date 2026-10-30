// Opt-in real Soot + real Devin/Codex journey. Never runs from npm test/CI.
// Requires uv, Python >=3.12, FFmpeg and an already authorized Soot provider.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { archivePack } from './archive.mjs';
import { materialize, readCatalog } from './catalog.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--soot', '--output', '--tts-url', '--voice', '--ocr-binding-file', '--google-binding-file', '--google-document', '--google-spreadsheet', '--only', '--provider', '--model', '--hyperframes-cli', '--hyperframes-project', '--hyperframes-browser'].includes(key) || !process.argv[i+1])
    throw new Error('Usage: node scripts/live-media.mjs --soot BINARY --output NEW_DIRECTORY [--tts-url URL --voice ID] [--ocr-binding-file FILE] [--google-binding-file FILE --google-document ID --google-spreadsheet ID] [--only google-workspace|office-ocr] [--provider ID --model NAME] [--hyperframes-cli FILE --hyperframes-project DIRECTORY --hyperframes-browser FILE]');
  options[key.slice(2)] = process.argv[i+1];
}
if (!options.soot || !options.output) throw new Error('--soot and --output required; evidence directory must be new');
if (Boolean(options['hyperframes-cli']) !== Boolean(options['hyperframes-project'])) throw new Error('HyperFrames live QA requires both --hyperframes-cli and --hyperframes-project');
if (options.only && !['google-workspace', 'office-ocr'].includes(options.only)) throw new Error('--only supports google-workspace or office-ocr');
if (options['google-binding-file'] && !options['google-document']) throw new Error('Authorized Google live QA requires --google-document');
const binary = resolve(options.soot);
const output = resolve(options.output);
await mkdir(output); // fail on reuse: never overwrite a previous test's state/receipts
const workspace = join(output, 'workspace');
const files = join(workspace, 'files');
await mkdir(files, { recursive: true });
await mkdir(join(workspace, 'soots'));
const packs = ['office', 'ocr', 'tts', 'google-workspace', 'video-editor'];
// Whole packs; Google Workspace stays read-only for this lane.
const selections = { office: ['office'], ocr: ['ocr'], tts: ['tts'], 'google-workspace': ['google-workspace:read'], 'video-editor': ['video-editor'] };
// The host grants exactly what each pack's needs name (workspace, env:NAME); operator needs are entered in Nest.
const grants = {}, toolHosts = {}, credentials = {};
for (const id of packs) {
  const manifest = JSON.parse(await readFile(join(repo, 'packs', id, 'pack.json')));
  const sourced = Object.fromEntries(Object.entries(manifest.needs?.credentials ?? {}).filter(([, need]) => (need.from ?? 'operator') !== 'operator').map(([name, need]) => [name, need.from]));
  grants[id] = { credentials: sourced, ...(manifest.needs?.env?.length ? { env: manifest.needs.env } : {}) };
  toolHosts[id] = { workspace: files };
  // Operator needs are entered in Nest; this headless lane binds them from the environment instead.
  if (id === 'google-workspace') credentials[id] = { GOOGLE_WORKSPACE_BINDING: { env: 'SOOT_MEDIA_GOOGLE_WORKSPACE_BINDING',
    operations: manifest.tools.filter(tool => selections[id][0].endsWith(':read') ? tool.run.mode === 'read' : true).map(tool => `${id}_${tool.name}`) } };
  const definition = { id, soul: 'SOUL.md', mission: 'mission.md', packs: selections[id] };
  if (options.provider) definition.model = { provider: options.provider, ...(options.model ? { name: options.model } : {}), fallbacks: [] };
  await writeFile(join(workspace, 'soots', `${id}.json`), JSON.stringify(definition, null, 2));
}
await writeFile(join(workspace, 'soots/SOUL.md'), 'You are a Soot. Complete authorized tasks using selected tools. Preserve originals, exact words and evidence. Report missing prerequisites and unknown effects honestly. Never invent a tool result.\n');
await writeFile(join(workspace, 'soots/mission.md'), 'Exercise the selected pack on the supplied local fixtures. Call real tools and return concrete paths/hashes and measured findings. Keep final answers concise.\n');
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const config = { listen: `127.0.0.1:${port}`, token_env: 'SOOT_MEDIA_RUNTIME_TOKEN', packs_dir: 'packs', data_dir: 'data',
  default_soot: 'office', soots: packs.map(id => `soots/${id}.json`), pack_grants: grants, tool_hosts: toolHosts, credentials,
  execution: { max_turns: 24, max_tool_calls: 40, tool_timeout: '6m', subagents: 0, advisor: false, memory_consolidation: false, todo_nudges: 0 } };
const configFile = join(workspace, 'deployment.json');
await writeFile(configFile, JSON.stringify(config, null, 2));
const ffmpeg = (await exec('which', ['ffmpeg'])).stdout.trim();
const ffprobe = (await exec('which', ['ffprobe'])).stdout.trim();
const env = { ...process.env, SOOT_MEDIA_RUNTIME_TOKEN: randomBytes(32).toString('hex'), SOOT_MEDIA_PYTHON: join(output, 'runtimes/shared/bin/python'),
  SOOT_VIDEO_BINDING: JSON.stringify({ ffmpeg, ffprobe }),
  SOOT_OCR_BINDING: JSON.stringify({ base_url: 'http://127.0.0.1:1/v1', model: 'deepseek-ai/DeepSeek-OCR-2' }),
  SOOT_MEDIA_GOOGLE_WORKSPACE_BINDING: JSON.stringify({ access_token: 'expired-synthetic-fixture', expires_at: 1 }),
  SOOT_TTS_BINDING: JSON.stringify({ engine: 'omnivoice', base_url: options['tts-url'] ?? 'http://127.0.0.1:1', voices: [options.voice ?? 'reference'] }),
};
if (options['ocr-binding-file']) env.SOOT_OCR_BINDING = await readFile(resolve(options['ocr-binding-file']), 'utf8');
if (options['google-binding-file']) env.SOOT_MEDIA_GOOGLE_WORKSPACE_BINDING = await readFile(resolve(options['google-binding-file']), 'utf8');
if (options['hyperframes-cli']) env.SOOT_HYPERFRAMES_BINDING = JSON.stringify({ node: process.execPath, cli: resolve(options['hyperframes-cli']), ffmpeg, ffprobe,
  ...(options['hyperframes-browser'] ? { browser: resolve(options['hyperframes-browser']) } : {}) });
const invoke = (program, args, extra={}) => exec(program, args, { cwd: workspace, env, timeout: 420_000, maxBuffer: 2*1024*1024, ...extra });
// Use the official installer on release-like archives: no direct pack path mounts.
const catalog = await readCatalog(repo);
for (const id of packs) {
  const archive = join(output, `${id}.tar.gz`);
  const prepared = await materialize(catalog.packs.find(p => p.id === id), repo, join(output, 'materialized'));
  await archivePack(prepared, archive, id);
  const installation = await invoke(binary, ['add', archive, '--config', configFile, '--json']);
  await writeFile(join(output, `${id}-install.json`), installation.stdout);
  const installed = join(workspace, 'packs', id);
  const runtimeDir = join(output, 'runtimes/shared');
  if (id === packs[0]) await invoke('uv', ['venv', '--python', '3.12', runtimeDir]);
  if (id !== 'tts') await invoke('uv', ['pip', 'install', '--require-hashes', '--python', join(runtimeDir, 'bin/python'), '-r', join(installed, 'requirements.lock')]);
  console.log(`Installed/prepared ${id} through soot add`);
}
// Native file fixtures are generated with an independent helper, not provider replies.
await invoke(join(output, 'runtimes/shared/bin/python'), [join(repo, 'scripts/media-fixtures.py'), files]);
if (options['hyperframes-project']) await cp(resolve(options['hyperframes-project']), join(files, 'motion'), {
  recursive: true,
  filter: source => !source.split(/[\\/]/).some(p => ['node_modules', '.git', '.venv', '.hyperframes', 'output', 'renders', 'snapshots'].includes(p)),
});
const check = await invoke(binary, ['check', '--config', configFile, '--show', '--secrets', '--json']);
await writeFile(join(output, 'check.json'), check.stdout);
let logs = '';
const runtime = spawn(binary, ['serve', '--config', configFile], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
runtime.stdout.on('data', chunk => { logs += chunk; });
runtime.stderr.on('data', chunk => { logs += chunk; });
const api = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${env.SOOT_MEDIA_RUNTIME_TOKEN}` };
const summary = { scope: options.only ?? 'all-media', runtime: (await invoke(binary, ['version'])).stdout.trim(), provider: options.provider ?? 'inherited host', lanes: [] };
async function history(conversation) {
  const events = []; let after = 0;
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`${api}/v1/conversations/${conversation}/events?after=${after}&limit=100`, { headers });
    if (!response.ok) throw new Error(`History returned HTTP ${response.status}`);
    const data = await response.json();
    const rows = data.events ?? data.items ?? (Array.isArray(data) ? data : []);
    events.push(...rows);
    const next = data.next_after ?? data.nextAfter;
    if (!next || next === after || rows.length === 0) break;
    after = next;
  }
  return events;
}
async function run(id, label, prompt, expectedFiles=[], expectedTool=null, negative=false) {
  console.log(`Real provider journey: ${label}`);
  const started = Date.now();
  let result;
  try {
    const { stdout } = await invoke(binary, ['run', '--config', configFile, '--soot', id, '--json', '--timeout', '6m', prompt]);
    result = JSON.parse(stdout);
  } catch (e) {
    // A deliberately missing prerequisite can correctly park a real Soot run.
    // Only this explicit negative lane may accept the CLI's nonzero blocked result.
    try { result = JSON.parse(e.stdout); } catch {}
    if (!negative || result?.state !== 'blocked') {
      await writeFile(join(output, `${label}-failure.json`), e.stdout || JSON.stringify({ error: 'Soot run failed; see public runtime diagnostics' }));
      if (result?.conversation_id) await writeFile(join(output, `${label}-events.json`), JSON.stringify(await history(result.conversation_id), null, 2));
      throw new Error(`Real Soot journey failed: ${label}`);
    }
  }
  if (!['completed', ...(negative ? ['blocked'] : [])].includes(result.state)) throw new Error(`Unexpected run state: ${result.state}`);
  await writeFile(join(output, `${label}.json`), JSON.stringify(result, null, 2));
  const conversation = result.conversation_id ?? result.conversation ?? result.run?.conversation_id;
  if (!conversation) throw new Error('CLI result did not expose conversation ID');
  const events = await history(conversation);
  await writeFile(join(output, `${label}-events.json`), JSON.stringify(events, null, 2));
  if (expectedTool && !events.some(e => e.type === 'tool.started' && e.text === expectedTool)) throw new Error(`No public tool-start evidence for ${expectedTool}`);
  if (expectedTool && !negative && !events.some(e => e.type === 'tool.completed' && e.text === expectedTool)) throw new Error(`No successful public tool-completion evidence for ${expectedTool}`);
  if (negative && !events.some(e => e.type === 'tool.failed' && e.text === expectedTool)) throw new Error(`Negative case did not observe a failed ${expectedTool}`);
  for (const file of expectedFiles) await readFile(join(files, file));
  summary.lanes.push({ id, label, negative, state: result.state, seconds: (Date.now()-started)/1000, conversation, expected_files: expectedFiles, evidence: `${label}-events.json` });
  await writeFile(join(output, 'summary.json'), JSON.stringify({...summary, status:"running"}, null, 2));
}
try {
  for (let i = 0; i < 100; i++) {
    if (runtime.exitCode !== null) throw new Error('Owned runtime exited before readiness');
    try { if ((await fetch(`${api}/v1/conversations/soots`, { headers })).ok) break; } catch {}
    if (i === 99) throw new Error('Owned runtime did not become ready');
    await new Promise(r => setTimeout(r, 200));
  }
  if (!options.only || options.only === 'office-ocr') {
    await run('office', 'office-roundtrip', 'Use the Office tools to create four NEW artifacts from supplied JSON specs: word.json -> result.docx (docx), excel.json -> result.xlsx (xlsx), slides.json -> result.pptx (pptx), pdf.json -> result.pdf (pdf). Inspect each result. Then render page 0 of result.pdf to result-page.png. Report actual paths/hashes and note that Excel formulas are not calculated. The files and font already exist under FILE_ROOT; do not request shell or rewrite specs.', ['result.docx','result.xlsx','result.pptx','result.pdf','result-page.png'], 'office_compose');
    await run('office', 'office-negative', 'Exercise one deliberate negative case: call office_inspect with path "../outside.docx". This is an authorized safety test of path rejection, not a request to read outside the workspace. Report the actual error and do not find another route.', [], 'office_inspect', true);
    await run('ocr', 'ocr-native', 'Assess result.pdf page 0, then recognize it to result-ocr.md. It has a native text layer: use native extraction and report which engine the tool actually used. Also assess scan.png to identify its necessary route, without claiming a model has already read it.', ['result-ocr.md'], 'ocr_recognize');
    if (options['ocr-binding-file']) await run('ocr', 'ocr-model', 'Recognize scan.png to scan-ocr.md using the bound DeepSeek OCR service. Report the observed text and pending visual verification.', ['scan-ocr.md'], 'ocr_recognize');
    else await run('ocr', 'ocr-unavailable', 'Call ocr_recognize for scan.png with output scan-ocr.md. This test has no running OCR endpoint; report the actual service blocker and do not invent extracted text or silently change models.', [], 'ocr_recognize', true);
  }
  if (!options.only) {
    if (options['tts-url']) await run('tts', 'tts-omnivoice', `List OmniVoice voices, then synthesize EXACTLY "Xin chào Việt Nam. Soot giúp bạn làm việc với tài liệu và video." using voice ${options.voice ?? 'reference'} and speed 0.85 to narration.wav. Inspect narration.wav and report measured duration/hash. The returned transcript is the request, not proof that all words were spoken. Do not claim you listened.`, ['narration.wav'], 'tts_synthesize');
    else await run('tts', 'tts-inspect', 'Inspect fixture.wav and report actual PCM duration. Attempt listing voices and report that the model endpoint is unavailable. Do not claim synthetic fixture audio was generated by OmniVoice.', [], 'tts_inspect');
    await run('tts', 'tts-denied-voice', 'Call tts_synthesize with text "Xin chào", voice "ungranted_voice", output denied-voice.wav. This intentional negative case must report the host voice allowlist rejection without a substitute.', [], 'tts_synthesize', true);
    await run('video-editor', 'video-render', 'Validate timeline.json, render it to result.mp4, probe the final result, then decode samples at 0.1, 0.6 and 1.0 seconds into contact-sheet.png. Report actual duration/canvas/hash. Use the supplied exact captions/audio; no posting. State final listening/phone-size inspection are pending.', ['result.mp4','contact-sheet.png'], 'video-editor_render');
    if (options['tts-url']) {
      await invoke(join(output, 'runtimes/shared/bin/python'), [join(repo, 'scripts/media-fixtures.py'), files, '--narrated']);
      await run('video-editor', 'video-narrated', 'Validate narrated-timeline.json, render narrated.mp4 and probe it. This timeline uses the actual previously generated OmniVoice narration.wav. Decode contact samples at 0.25, 1.5 and 2.5 seconds to narrated-contact.png. Report measured video/audio findings. Caption timings are manually authored phrase display intervals, not verified word alignment. Do not claim listening.', ['narrated.mp4','narrated-contact.png'], 'video-editor_render');
    }
    if (options['hyperframes-project']) await run('video-editor', 'video-hyperframes', 'Use video-editor_hyperframes to check the authorized project motion, then render motion to motion.mp4. Probe the exported video and decode frames at 0.25, 1.0 and 1.75 seconds into motion-contact.png. Report actual structural/contrast findings, duration and hash; do not publish.', ['motion.mp4','motion-contact.png'], 'video-editor_hyperframes');
    await run('video-editor', 'video-negative', 'Validate invalid-timeline.json. It intentionally contains an overlong caption and unsafe directives. Report the actual failure and do not render or repair the supplied invalid fixture.', [], 'video-editor_validate', true);
  }
  if (!options.only || options.only === 'google-workspace') {
  await run('google-workspace', options['google-binding-file'] ? 'google-live-read' : 'google-expired-token', `Call google-workspace_docs_read for document_id "${options['google-document'] ?? 'sample_document_123'}". ${options['google-binding-file'] ? 'Report actual tabs/revision and read bounded content. This read-only test authorizes no Google mutations.' : 'The fixture token is deliberately expired; report the actual credential blocker, and do not claim a Google read succeeded.'}`, [], 'google-workspace_docs_read', !options['google-binding-file']);
  if (!options['google-binding-file'] || options['google-spreadsheet']) {
    const sheetsPrompt = options['google-binding-file']
      ? `Call google-workspace_sheets_info for spreadsheet_id ${JSON.stringify(options['google-spreadsheet'])}, then google-workspace_sheets_read for that actual first tab at A1:B2 with render FORMULA. Report actual formulas/values and snapshot. Do not change anything.`
      : 'Call google-workspace_sheets_read with spreadsheet_id "sample_spreadsheet_123", range "Sheet1!A1:B2", render "FORMULA". This deliberately expired-token test requires one direct read call; the range is a synthetic fixture, so no metadata lookup is needed. Report the actual credential blocker and do not invent sheet values.';
    await run('google-workspace', options['google-binding-file'] ? 'google-sheets-live-read' : 'google-sheets-expired-token', sheetsPrompt, [], 'google-workspace_sheets_read', !options['google-binding-file']);
  }
  await run('google-workspace', options['google-binding-file'] ? 'google-drive-live-read' : 'google-drive-expired-token', `Call google-workspace_drive_list with limit 5 and kind all. ${options['google-binding-file'] ? 'Report only actual returned IDs/types and pagination; do not mutate or share files.' : 'The fixture token is deliberately expired; report the actual credential blocker, not invented Drive files.'}`, [], 'google-workspace_drive_list', !options['google-binding-file']);
  }
  if (!options.only) await invoke(join(output, 'runtimes/shared/bin/python'), [join(repo, 'scripts/media-verify.py'), files]);
  if (options.only === 'office-ocr') await invoke(join(output, 'runtimes/shared/bin/python'), [join(repo, 'scripts/media-verify.py'), files, '--office-ocr']);
  summary.status = "completed";
  summary.vendor_status = { soot_provider: 'real', deepseek_ocr: (!options.only || options.only === 'office-ocr') && options['ocr-binding-file'] ? 'real endpoint exercised' : 'NOT RUN: no bound OCR model service',
    omnivoice: !options.only && options['tts-url'] ? 'real endpoint exercised; listening pending' : 'NOT RUN: no bound model service', google: options['google-binding-file'] ? 'real read exercised; mutations not tested' : 'NOT RUN: no authorized Google credentials',
    hyperframes: !options.only && options['hyperframes-project'] ? 'real local CLI check/render through Soot' : 'NOT RUN: no authorized motion project' };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`Completed real Soot journeys; evidence: ${output}`);
} finally {
  runtime.kill('SIGTERM');
  await Promise.race([new Promise(r => runtime.once('exit', r)), new Promise(r => setTimeout(r, 10000))]);
  if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGKILL');
  // Runtime logs can contain vendor diagnostics. Keep them private and do not publish them.
  await writeFile(join(output, 'runtime.log'), logs, { mode: 0o600 });
}
