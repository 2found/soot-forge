#!/usr/bin/env node
// The clock of a simulated society. world.mjs is the platform's passive state;
// this driver builds the persona Soots, wakes the active ones each round, then
// interviews them, runs the expert lenses and asks for the report. It decides
// nothing about the content: every judgment is a persona Soot's own run.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { active, advance, create, load, status, tally, unit } from './world.mjs';

const PACK = resolve(import.meta.dirname, '..');
const die = message => { console.error(`micro-fish: ${message}`); process.exit(1); };
const note = message => console.error(message);
const json = file => JSON.parse(readFileSync(file, 'utf8'));

function options(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { rest.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[key] = true; else flags[key] = argv[++i];
  }
  return { flags, rest };
}
function workspace(flags) {
  const ws = resolve(flags.workspace || die('--workspace <dir> is required'));
  const deploy = join(ws, 'deployment.json');
  if (!existsSync(deploy)) die(`no Soot workspace at ${ws}`);
  const d = json(deploy), packs = join(ws, d.packs_dir || 'packs');
  return { ws, deploy, d, state: join(ws, d.data_dir || 'data', 'pack-state', 'micro-fish', 'sims'), installed: join(packs, 'micro-fish') };
}

// ---------- the brief ----------

// A named feed ships with the pack; a list is the caller's own.
function contextPosts(context, language) {
  if (Array.isArray(context)) return context;
  const name = context || `${language}-short-video`, file = join(PACK, 'feeds', `${name}.json`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) die(`no shipped feed "${name}"; pass context as a list of {account, content}`);
  return json(file).posts;
}
function readBrief(file) {
  const b = json(file), language = b.language || 'vi';
  const audience = { n: 24, library: 'vn-nemotron-400', ...(b.audience || {}) };
  if (!Number.isInteger(audience.n) || audience.n < 1 || audience.n > 400) die('audience.n must be 1–400');
  for (const s of b.subjects || []) if (s.file) { s.content = readFileSync(resolve(dirname(file), s.file), 'utf8'); delete s.file; }
  return { ...b, language, audience, context: contextPosts(b.context, language), experts: b.experts || [], rounds: b.rounds ?? 4, feed_size: b.feed_size ?? 4, seed: b.seed || b.sim };
}

// ---------- the population ----------

const SURNAMES = 'Nguyễn|Trần|Lê|Phạm|Hoàng|Huỳnh|Phan|Vũ|Võ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Lý|Đinh|Đoàn|Trịnh|Lương|Mai|Trương|Hà|Cao|Lâm|Tạ|Châu|Thái|Quách|Tô';
const GIVEN = { Nam: ['Minh', 'Hùng', 'Tuấn', 'Dũng', 'Khoa', 'Phúc', 'Long', 'Sơn', 'Thành', 'Quân'], 'Nữ': ['Lan', 'Hương', 'Trang', 'Ngọc', 'Thảo', 'Mai', 'Linh', 'Hạnh', 'Yến', 'Nhi'] };
function nameOf(row) {
  if (row.name) return String(row.name).slice(0, 80);
  const found = new RegExp(`(?:${SURNAMES})(?:\\s\\p{Lu}\\p{Ll}+){1,3}`, 'u').exec([row.persona, row.professional_persona, row.arts_persona].join(' '));
  if (found) return found[0];
  const family = SURNAMES.split('|'), given = GIVEN[row.sex] || [...GIVEN.Nam, ...GIVEN['Nữ']];
  return `${family[Math.floor(unit('family', row.uuid) * 12)]} ${given[Math.floor(unit('given', row.uuid) * given.length)]}`;
}
const personaId = row => `p-${String(row.uuid || row.id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10)}`;
function library(name) {
  const file = isAbsolute(name) ? name : join(PACK, 'personas', `${name}.jsonl`);
  if (!existsSync(file)) die(`no persona library ${file}`);
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
// The audience is a stated filter over the library, then a seeded draw: the same
// brief always meets the same people.
function select(brief) {
  const a = brief.audience, match = a.match ? new RegExp(a.match, 'iu') : null;
  const pool = library(a.library).filter(r =>
    (!a.age || (r.age >= a.age[0] && r.age <= a.age[1])) && (!a.sex || r.sex === a.sex) && (!a.zone || r.zone === a.zone) && (!a.region || r.region === a.region) &&
    (!match || match.test(Object.values(r).filter(v => typeof v === 'string').join('\n'))));
  // `cap` takes everyone the filter leaves when that is fewer than asked for.
  if (pool.length < a.n && !(a.cap && pool.length)) die(`the audience filter leaves ${pool.length} personas in ${a.library}; asked for ${a.n}`);
  return pool.sort((x, y) => unit(brief.seed, 'pick', x.uuid) - unit(brief.seed, 'pick', y.uuid)).slice(0, a.n);
}
const card = row => ({
  id: personaId(row), name: nameOf(row), age: row.age, sex: row.sex, zone: row.zone, region: row.region, occupation: row.occupation?.slice(0, 120), education: row.education_level,
  // People under 25 open a feed more often than people over 35; a default, not a measurement.
  activity: row.activity ?? (row.age <= 24 ? 0.8 : row.age <= 34 ? 0.65 : 0.5),
});
const TEXT = {
  vi: {
    soul: (row, name) => [
      `Bạn là ${name}, ${row.age} tuổi, ${row.sex}, ${row.occupation}, học vấn ${row.education_level}, ${row.marital_status}, sống ở ${String(row.zone).toLowerCase()} vùng ${row.region}.`,
      row.persona, row.cultural_background, row.hobbies_and_interests && `Sở thích: ${row.hobbies_and_interests}`, row.arts_persona,
      'Bạn là người thật đang cầm điện thoại, không phải trợ lý. Không bao giờ nhắc tới AI, mô phỏng hay mô hình. Chỉ nói tiếng Việt, đúng giọng của mình.',
    ],
    mission: `Mỗi tin nhắn là một lần bạn mở một ứng dụng lướt vài phút. Tin nhắn cho bạn mã phiên; dùng đúng mã đó làm \`sim\`.

1. Gọi micro-fish_timeline để xem feed.
2. Gọi micro-fish_act MỘT lần, ghi bạn đã làm gì với TỪNG bài trong feed.
3. Trả lời đúng một dòng: bạn vừa xem gì.

Làm như người thật. Phần lớn bài bạn lướt qua trong hai giây đầu (attention: skip). Chỉ dừng lại (some) hoặc xem hết (full) khi nó thật sự dính tới đời sống, công việc hay sở thích của bạn; thứ không dành cho người như bạn thì lướt. Với mỗi bài, ghi \`depth\`: bạn đã xem hoặc đọc được bao nhiêu phần trăm của bài trước khi lướt đi (lướt ngay là 0–5, bỏ giữa chừng là đúng chỗ bạn bỏ, xem hết là 100). Kể cả khi đã dừng lại, người ta thường bỏ đi trước khi hết bài; rất ít bài được xem tới cuối. Chỉ like, bình luận, chia sẻ, follow khi chính bạn ngoài đời sẽ làm; đa số mọi người không bao giờ bình luận. Bình luận và bài đăng viết như bạn vẫn viết trên mạng, có thể cãi lại bình luận của người khác. Gặp quảng cáo thì phản ứng như bạn vẫn phản ứng với quảng cáo. Không bịa ra trải nghiệm mình không có: chưa đọc, chưa dùng, chưa mua thì đừng nói là rồi.

Khi tin nhắn báo feed đã đóng và hỏi lại về một bài, trả lời bằng micro-fish_answer theo đúng điều bạn còn nhớ. Đã lướt qua thì nói là đã lướt qua, đừng đoán nội dung.`,
    open: (hour, platform, sim) => `Bây giờ là ${hour} giờ. Bạn mở ${platform}. Mã phiên: ${sim}`,
    nudge: sim => `Bạn chưa ghi lại đã làm gì với feed vừa xem. Gọi micro-fish_act cho mã phiên ${sim}, đủ từng bài.`,
    interview: (sim, subject, questions) => `Feed đã đóng. Mã phiên: ${sim}. Lúc nãy trong feed có bài của tài khoản "${subject.account}". Trả lời các câu dưới đây về bài đó bằng MỘT lần gọi micro-fish_answer, theo đúng điều bạn còn nhớ:\n${questions}`,
    type: { scale: 'số 1–5', text: 'một hai câu', tags: 'danh sách nhãn ngắn, có thể rỗng', yesno: 'true hoặc false' },
    expert: (sim, e) => `Mô phỏng ${sim}. Bạn là chuyên gia "${e.id}". Góc nhìn: ${e.lens}`,
    report: sim => `Viết báo cáo cho mô phỏng ${sim}.`,
  },
  en: {
    soul: (row, name) => [
      `You are ${name}, ${row.age}, ${row.sex}, ${row.occupation}, ${row.education_level}, ${row.marital_status}, living in ${row.zone}, ${row.region}.`,
      row.persona, row.cultural_background, row.hobbies_and_interests && `Interests: ${row.hobbies_and_interests}`, row.arts_persona,
      'You are a real person holding a phone, not an assistant. Never mention AI, simulation or models. Write in your own voice.',
    ],
    mission: `Each message is one time you open an app and scroll for a few minutes. The message gives a session code; use it as \`sim\`.

1. Call micro-fish_timeline to see your feed.
2. Call micro-fish_act ONCE, recording what you did with EVERY post in the feed.
3. Reply with exactly one line: what you just looked at.

Behave like a real person. You scroll past most posts within two seconds (attention: skip). Stop (some) or finish (full) only when it truly touches your life, work or interests; scroll past what is not for someone like you. For every post record \`depth\`: the percent of it you watched or read before moving on (an instant scroll is 0–5, leaving midway is the point where you left, finishing is 100). Even after stopping, people usually leave before the end; very few posts are finished. Like, comment, share or follow only when you would in real life; most people never comment. Write comments and posts the way you write online, and argue with other people's comments if you would. Treat ads the way you treat ads. Never invent an experience you do not have: if you have not read, used or bought it, do not say you have.

When a message says the feed is closed and asks about a post, answer with micro-fish_answer from what you actually remember. If you scrolled past it, say so; do not guess its content.`,
    open: (hour, platform, sim) => `It is ${hour}:00. You open ${platform}. Session code: ${sim}`,
    nudge: sim => `You have not recorded what you did with the feed you just saw. Call micro-fish_act for session ${sim}, covering every post.`,
    interview: (sim, subject, questions) => `The feed is closed. Session code: ${sim}. Earlier your feed had a post from the account "${subject.account}". Answer these about that post in ONE micro-fish_answer call, from what you actually remember:\n${questions}`,
    type: { scale: 'a number 1–5', text: 'one or two sentences', tags: 'a list of short tags, may be empty', yesno: 'true or false' },
    expert: (sim, e) => `Simulation ${sim}. You are expert "${e.id}". Lens: ${e.lens}`,
    report: sim => `Write the report for simulation ${sim}.`,
  },
};
const words = language => TEXT[String(language).slice(0, 2)] || TEXT.en;

// Adds the brief's personas the workspace does not have yet, each as its own
// Soot. The runtime reads its roster at start, so a caller restarts it when
// `added` is not zero.
function populate(w, brief, flags) {
  const rows = select(brief), t = words(brief.language); let added = 0;
  for (const row of rows) {
    const id = personaId(row), dir = join(w.ws, 'soots', id), name = nameOf(row);
    if (existsSync(join(dir, 'soot.json'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SOUL.md'), t.soul(row, name).filter(Boolean).join('\n\n') + '\n');
    writeFileSync(join(dir, 'MISSION.md'), t.mission + '\n');
    writeFileSync(join(dir, 'soot.json'), JSON.stringify({ channels: null, conversation: { publish: 'final' }, description: `${name}, ${row.age}, ${row.occupation}`.slice(0, 200), id, mission: 'MISSION.md', name, packs: ['micro-fish:tools=timeline,act,answer'], soul: 'SOUL.md' }, null, 2) + '\n');
    w.d.soots.push(`soots/${id}/soot.json`); added++;
  }
  const workers = Number(flags.workers || 8);
  if (added || w.d.workers !== workers) { w.d.workers = workers; w.d.run_timeout = '15m'; writeFileSync(w.deploy, JSON.stringify(w.d, null, 2) + '\n'); }
  return { added, personas: w.d.soots.filter(s => s.startsWith('soots/p-')).length, selected: rows.length };
}

// ---------- the run ----------

function soot(w, id, message, conversation) {
  return new Promise(done => {
    const child = spawn('soot', ['run', '--config', w.deploy, '--soot', id, '--json', '--quiet', '--timeout', '8m', '--stdin', ...(conversation ? ['--conversation', conversation] : [])], { cwd: w.ws });
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.resume();
    child.on('error', () => done({ state: 'failed', text: 'soot is not installed' }));
    child.on('close', () => {
      let result; try { result = JSON.parse(out); } catch { result = { state: 'failed', text: out.slice(0, 200) }; }
      // Waiting cannot fix a persona the runtime never loaded.
      if ((result.diagnostics || []).some(d => d.code === 'agent_selection_required')) die(`the runtime does not serve ${id}: it started before this persona was added. Stop it, run "soot migrate adopt --config ${w.deploy}", start it and run again`);
      done(result);
    });
    child.stdin.end(message);
  });
}
async function pool(items, size, work) { const queue = [...items]; await Promise.all(Array.from({ length: Math.max(1, size) }, async () => { while (queue.length) await work(queue.shift()); })); }
const member = (w, role) => w.d.soots.map(s => s.split('/')[1]).find(id => id === role || id.endsWith(`-${role}`)) || die(`the workspace has no ${role} Soot`);
const HOURS = [12, 19, 21, 22, 7, 12, 20, 23];
// A failed session is usually the provider's rate limit: wait, then ask again.
// Reopening a feed in the same round returns the same feed, so a retry is safe.
const WAITS = (process.env.MICRO_FISH_RETRY_WAITS || '20,60,150').split(',').map(Number);
const sleep = seconds => new Promise(done => setTimeout(done, seconds * 1000 * (0.75 + Math.random() / 2)));
// A phase in which fewer than four sessions in five finished would bias
// everything after it; the run stops there and resumes from the record.
function hold(phase, done, total, sim) {
  if (!total || done / total >= 0.8) return;
  console.log(JSON.stringify({ sim, state: 'stopped', phase, completed: done, of: total, reason: 'most sessions failed even after waiting; the provider is probably rate limiting or rejecting the model (see the server log, failure_kind)', resume: 'run the same command again; it continues from the recorded round' }));
  process.exit(2);
}

async function run(w, brief, flags) {
  const t = words(brief.language), parallel = Number(flags.parallel || w.d.workers || 4), started = Date.now();
  const rows = select(brief), missing = rows.filter(r => !w.d.soots.includes(`soots/${personaId(r)}/soot.json`));
  if (missing.length) die(`${missing.length} personas are not in the workspace; run populate first`);
  let world = await load(w.state, brief.sim);
  if (!world) {
    mkdirSync(w.state, { recursive: true, mode: 0o700 }); chmodSync(w.state, 0o700);
    const made = await create(w.state, { sim: brief.sim, goal: brief.goal, platform: brief.platform, language: brief.language, subjects: brief.subjects, context: brief.context, questions: brief.questions, rounds: brief.rounds, feed_size: brief.feed_size, seed: brief.seed, metric: brief.metric, agents: rows.map(card) });
    note(`created ${made.sim}: ${made.agents} personas, arms ${JSON.stringify(made.arms)}, ${made.posts} posts`);
    world = await load(w.state, brief.sim);
  } else note(`resuming ${world.id} at round ${world.round}, phase ${world.phase}`);
  const stats = { sessions: 0, failed: 0, nudged: 0, retried: 0 };
  const retrying = async call => { for (let i = 0; ; i++) { const result = await call(); if (result.state === 'completed' || i >= WAITS.length) return result; stats.retried++; await sleep(WAITS[i]); } };
  const turn = (id, message) => retrying(async () => {
    const conversation = (await load(w.state, brief.sim)).conversations[id];
    const result = await soot(w, id, message, conversation);
    if (result.conversation_id && !conversation) await advance(w.state, brief.sim, { conversations: { [id]: result.conversation_id } });
    return result;
  });
  const unrecorded = (now, id, round) => { const seen = now.impressions.filter(i => i.agent === id && i.round === round); return !seen.length || seen.some(i => !now.reactions.some(r => r.agent === id && r.round === round && r.via === i.post)); };
  for (let round = Math.max(1, world.round); world.phase === 'feed' && round <= world.design.rounds; round++) {
    world = await advance(w.state, brief.sim, { round });
    const awake = active(world, round).filter(id => unrecorded(world, id, round)), t0 = Date.now(); let ok = 0;
    await pool(awake, parallel, async id => {
      stats.sessions++;
      let result = await turn(id, t.open(HOURS[(round - 1) % HOURS.length], world.brief.platform, world.id));
      const now = await load(w.state, brief.sim);
      // One reminder for a session that opened the feed and recorded nothing.
      if (now.impressions.some(i => i.agent === id && i.round === round) && unrecorded(now, id, round)) { stats.nudged++; result = await turn(id, t.nudge(world.id)); }
      if (result.state === 'completed') ok++; else stats.failed++;
    });
    note(`round ${round}/${world.design.rounds}: ${awake.length} awake, ${ok} completed, ${Math.round((Date.now() - t0) / 1000)}s`);
    hold(`round ${round}`, ok, awake.length, world.id);
  }
  world = await advance(w.state, brief.sim, { phase: world.phase === 'done' ? 'done' : 'interview' });
  if (world.phase === 'interview') {
    const questions = world.brief.questions.map(q => `- ${q.id} (${t.type[q.type]}): ${q.ask}`).join('\n');
    const met = Object.keys(world.agents).filter(id => !world.answers[id] && world.impressions.some(i => i.agent === id && (world.posts.find(p => p.id === i.post).repost_of || i.post) === world.agents[id].arm));
    const t0 = Date.now(); let ok = 0;
    await pool(met, parallel, async id => { const subject = world.brief.subjects.find(s => s.id === world.agents[id].arm); const r = await turn(id, t.interview(world.id, subject, questions)); if (r.state === 'completed') ok++; else stats.failed++; });
    const answered = Object.keys((await load(w.state, brief.sim)).answers).length;
    note(`interviews: ${met.length} asked, ${answered} on record, ${Math.round((Date.now() - t0) / 1000)}s`);
    hold('interview', ok, met.length, world.id);
    const expert = brief.experts.length ? member(w, 'expert') : null, lenses = brief.experts.filter(e => !world.experts[e.id]); ok = 0;
    await pool(lenses, parallel, async e => { const r = await retrying(() => soot(w, expert, t.expert(world.id, e))); if (r.state === 'completed') ok++; else stats.failed++; });
    if (brief.experts.length) note(`experts: ${Object.keys((await load(w.state, brief.sim)).experts).length}/${brief.experts.length} lenses on record`);
    hold('experts', ok, lenses.length, world.id);
    world = await advance(w.state, brief.sim, { phase: 'done' });
  }
  let report = null;
  if (!flags['no-report']) { const r = await retrying(() => soot(w, member(w, 'analyst'), t.report(world.id))); report = r.state === 'completed' ? r.text : null; if (!report) stats.failed++; }
  const out = flags.out ? resolve(flags.out) : null;
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${world.id}.tally.json`), JSON.stringify(await tally(w.state, { sim: world.id }), null, 1) + '\n'); if (report) writeFileSync(join(out, `${world.id}.report.md`), report + '\n'); }
  console.log(JSON.stringify({ sim: world.id, state: stats.failed ? 'completed_with_failures' : 'completed', ...stats, seconds: Math.round((Date.now() - started) / 1000), ...(out ? { tally: join(out, `${world.id}.tally.json`), report: report ? join(out, `${world.id}.report.md`) : null } : { report }) }));
}

const { flags, rest } = options(process.argv.slice(2));
const [command, ...args] = rest;
try {
  if (command === 'populate') console.log(JSON.stringify(populate(workspace(flags), readBrief(args[0] || die('populate <brief.json>')), flags)));
  else if (command === 'run') await run(workspace(flags), readBrief(args[0] || die('run <brief.json>')), flags);
  else if (command === 'tally') console.log(JSON.stringify(await tally(workspace(flags).state, { sim: args[0] || die('tally <sim>'), ...(flags.by ? { by: flags.by } : {}) }), null, 1));
  else if (command === 'sims') console.log(JSON.stringify(await status(workspace(flags).state, {}), null, 1));
  else if (command === 'ask') {
    // An interview: one more message in that persona's own conversation of the sim.
    const w = workspace(flags), [sim, persona, file] = args; if (!file) die('ask <sim> <persona> <message-file>');
    const world = await load(w.state, sim) || die(`no simulation ${sim}`);
    const id = world.agents[persona] ? persona : Object.keys(world.agents).find(a => world.agents[a].name === persona) || die(`no persona ${persona} in ${sim}`);
    const r = await soot(w, id, readFileSync(file, 'utf8'), world.conversations[id]);
    console.log(JSON.stringify({ persona: id, name: world.agents[id].name, state: r.state, text: r.text }));
  } else if (command === 'personas') console.log(readdirSync(join(PACK, 'personas')).filter(f => f.endsWith('.jsonl')).map(f => `${f.slice(0, -6)}\t${library(f.slice(0, -6)).length}`).join('\n'));
  else die('usage: driver.mjs populate|run <brief.json> | tally <sim> [--by age|zone|sex] | ask <sim> <persona> <file> | sims | personas   (all with --workspace <dir>)');
} catch (error) { die(error.safe ? error.message : (error.stack || String(error))); }
