import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

// A simulated society is a platform: every persona is its own Soot, named by the
// host in `call.soot`, and meets content in a feed it shares with the others.
// This module is the platform's passive state. An outside driver (driver.mjs)
// advances the rounds; nothing here calls a model, starts an agent or reaches
// the network.

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ATTENTION = ['skip', 'some', 'full'];
// What an A/B is decided on and the feed is ranked by. `depth` is how far through a post people got, on average.
const METRICS = ['full', 'stopped', 'depth', 'like', 'share', 'comment'];
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const TYPES = ['scale', 'text', 'tags', 'yesno'];
const MAX = { agents: 1000, subjects: 4, context: 60, content: 12000, rounds: 48, feed: 8, questions: 8, text: 400, post: 280, record: 16 * 1024 * 1024 };
const PREVIEW = 30000;

const fail = message => { const error = new Error(message); error.safe = true; throw error; };
function keys(value, allowed, required = [], where = 'input') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${where} must be an object`);
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) fail(`${where}: unknown field ${extra[0]}`);
  const missing = required.filter(k => value[k] === undefined || value[k] === null);
  if (missing.length) fail(`${where}: missing ${missing[0]}`);
}
function text(value, max, where, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${where} must be non-empty text`);
  if ([...value].length > max) fail(`${where} is longer than ${max} characters`);
  return value.trim();
}
function ident(value, where) { if (typeof value !== 'string' || !ID.test(value)) fail(`${where} must match ${ID.source}`); return value; }
function int(value, min, max, where) { if (!Number.isInteger(value) || value < min || value > max) fail(`${where} must be an integer ${min}–${max}`); return value; }
function list(value, max, where, item) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${where} must be a list of at most ${max}`);
  return value.map((v, i) => item(v, `${where}[${i}]`));
}
const tag = (v, where) => text(v, 40, where).toLowerCase().replace(/\s+/g, '-');
export const unit = (...parts) => createHash('sha256').update(parts.join('\0')).digest().readUInt32BE(0) / 0x100000000;

// One store per workspace: persona Soots each talk in their own conversation, so
// a simulation is named by its id, not by the conversation that started it.
export function stateDirectory(env = process.env) {
  const base = env.SOOT_PACK_STATE || env.SOCIETY_STATE_DIR;
  if (!base || !isAbsolute(base)) fail('This Soot host did not provide SOOT_PACK_STATE; update the Soot runtime');
  return join(base, 'sims');
}
export async function load(dir, sim) {
  try { return JSON.parse(await readFile(join(dir, ident(sim, 'sim') + '.json'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(dir, world) {
  world.revision = (world.revision || 0) + 1; world.updated_at = new Date().toISOString();
  const raw = JSON.stringify(world); if (Buffer.byteLength(raw) > MAX.record) fail('Simulation record is full; run a smaller simulation');
  const temp = join(dir, '.' + randomUUID()); const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
  await rename(temp, join(dir, world.id + '.json'));
}
// Persona Soots write in parallel, so a busy lock waits briefly. The record is
// replaced by rename, so a writer that died holding the lock left a consistent
// file; a lock older than any tool timeout has no live owner.
async function locked(dir, sim, action) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `.${ident(sim, 'sim')}.lock`); const deadline = Date.now() + 20000;
  let lock;
  for (let delay = 15; !lock; delay = Math.min(delay * 2, 300)) {
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > 60000) { await unlink(path).catch(() => {}); continue; }
      if (Date.now() > deadline) fail('Simulation is busy; call again in a moment');
      await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    }
  }
  try { return await action(); } finally { await lock.close(); await unlink(path).catch(() => {}); }
}
async function need(dir, sim) { const world = await load(dir, sim); if (!world) fail(`No simulation "${sim}" in this workspace`); return world; }
const member = (world, who) => world.agents[who] || fail('This account is not part of that simulation');

const DEFAULT_QUESTIONS = {
  vi: [
    { id: 'retell', type: 'text', ask: 'Kể lại nội dung đó nói gì, như kể cho một người bạn. Không nhớ hoặc đã lướt qua thì nói thẳng.' },
    { id: 'clarity', type: 'scale', ask: 'Gặp một lần có hiểu ngay không (1 không hiểu gì, 5 hiểu hết)' },
    { id: 'intent', type: 'scale', ask: 'Trong tuần này bạn có làm gì với nó không: lưu, gửi ai đó, thử, mua (1 chắc chắn không, 5 chắc chắn có)' },
    { id: 'objections', type: 'tags', ask: 'Điều làm bạn khó chịu hoặc không tin, mỗi ý một nhãn ngắn (ad-feel, unclear-<từ>, no-use, too-long, not-for-me)' },
    { id: 'why', type: 'text', ask: 'Vì sao bạn đã xem hết, xem một phần, hay lướt qua' },
  ],
  en: [
    { id: 'retell', type: 'text', ask: 'Retell what it said, as you would to a friend. If you scrolled past or cannot remember, say so.' },
    { id: 'clarity', type: 'scale', ask: 'Did you get it on one pass (1 not at all, 5 completely)' },
    { id: 'intent', type: 'scale', ask: 'Will you do anything with it this week: save, send, try, buy (1 certainly not, 5 certainly)' },
    { id: 'objections', type: 'tags', ask: 'What put you off or was hard to believe, one short tag each (ad-feel, unclear-<word>, no-use, too-long, not-for-me)' },
    { id: 'why', type: 'text', ask: 'Why you finished it, watched part of it, or scrolled past' },
  ],
};

// ---------- the driver's side: build a simulation ----------

function agentCard(v, where) {
  keys(v, ['id', 'name', 'age', 'sex', 'zone', 'region', 'occupation', 'education', 'segment', 'activity'], ['id', 'name'], where);
  const activity = v.activity ?? 0.6;
  if (typeof activity !== 'number' || !(activity > 0 && activity <= 1)) fail(`${where}.activity must be a number above 0 and at most 1`);
  return {
    id: ident(v.id, `${where}.id`), name: text(v.name, 80, `${where}.name`), age: v.age === undefined || v.age === null ? undefined : int(v.age, 13, 99, `${where}.age`),
    sex: text(v.sex, 30, `${where}.sex`, true), zone: text(v.zone, 40, `${where}.zone`, true), region: text(v.region, 80, `${where}.region`, true),
    occupation: text(v.occupation, 120, `${where}.occupation`, true), education: text(v.education, 80, `${where}.education`, true),
    segment: v.segment ? tag(v.segment, `${where}.segment`) : 'all', activity,
  };
}
// A brief names the decision, the platform, the subjects under test (one arm
// each), the other content they compete with, and what to ask afterwards.
export async function create(dir, input) {
  keys(input, ['sim', 'goal', 'platform', 'language', 'subjects', 'context', 'questions', 'rounds', 'feed_size', 'seed', 'metric', 'agents'], ['sim', 'goal', 'subjects', 'agents']);
  const metric = input.metric ?? 'full'; if (!METRICS.includes(metric)) fail(`metric must be one of ${METRICS.join(', ')}`);
  const language = text(input.language, 20, 'language', true) || 'vi';
  const subjects = list(input.subjects, MAX.subjects, 'subjects', (v, w) => {
    keys(v, ['id', 'label', 'account', 'content'], ['id', 'content'], w);
    return { id: ident(v.id, `${w}.id`), label: text(v.label, 80, `${w}.label`, true) || v.id, account: text(v.account, 60, `${w}.account`, true) || `account-${v.id}`, content: text(v.content, MAX.content, `${w}.content`) };
  });
  if (!subjects.length || new Set(subjects.map(s => s.id)).size !== subjects.length) fail('subjects needs 1–4 entries with unique ids');
  const context = list(input.context, MAX.context, 'context', (v, w) => { keys(v, ['account', 'content'], ['account', 'content'], w); return { account: text(v.account, 60, `${w}.account`), content: text(v.content, MAX.content, `${w}.content`) }; });
  const questions = list(input.questions, MAX.questions, 'questions', (v, w) => {
    keys(v, ['id', 'ask', 'type'], ['id', 'ask', 'type'], w);
    if (!TYPES.includes(v.type)) fail(`${w}.type must be one of ${TYPES.join(', ')}`);
    return { id: ident(v.id, `${w}.id`), ask: text(v.ask, 300, `${w}.ask`), type: v.type };
  });
  if (new Set(questions.map(q => q.id)).size !== questions.length) fail('question ids must be unique');
  const cards = list(input.agents, MAX.agents, 'agents', agentCard);
  if (cards.length < subjects.length || new Set(cards.map(a => a.id)).size !== cards.length) fail('agents needs unique ids and at least one persona per subject');
  const seed = text(input.seed, 80, 'seed', true) || ident(input.sim, 'sim');
  // Between-subjects: a persona meets exactly one subject, so nobody compares
  // variants side by side and no one sees the same content twice.
  const order = cards.map(a => a.id).sort((a, b) => unit(seed, 'arm', a) - unit(seed, 'arm', b));
  const arm = Object.fromEntries(order.map((id, i) => [id, subjects[i % subjects.length].id]));
  const world = {
    version: 2, id: ident(input.sim, 'sim'), created_at: new Date().toISOString(), revision: 0,
    brief: { goal: text(input.goal, 600, 'goal'), platform: text(input.platform, 60, 'platform', true) || 'feed', language, subjects: subjects.map(({ id, label, account }) => ({ id, label, account })), questions: questions.length ? questions : (DEFAULT_QUESTIONS[language.slice(0, 2)] || DEFAULT_QUESTIONS.en) },
    design: { rounds: int(input.rounds ?? 6, 1, MAX.rounds, 'rounds'), feed_size: int(input.feed_size ?? 5, 1, MAX.feed, 'feed_size'), seed, metric },
    round: 0, phase: 'feed',
    agents: Object.fromEntries(cards.map(a => [a.id, { ...a, id: undefined, arm: arm[a.id] }])),
    posts: [
      ...subjects.map(s => ({ id: s.id, account: s.account, round: 0, content: s.content, subject: s.id, arm: s.id })),
      ...context.map((c, i) => ({ id: `c${i + 1}`, account: c.account, round: 0, content: c.content })),
    ],
    impressions: [], reactions: [], follows: [], answers: {}, experts: {}, conversations: {},
  };
  return locked(dir, world.id, async () => {
    if (await load(dir, world.id)) fail(`Simulation "${world.id}" already exists; pick another id`);
    await save(dir, world);
    return { sim: world.id, agents: cards.length, arms: Object.fromEntries(subjects.map(s => [s.id, order.filter(id => arm[id] === s.id).length])), posts: world.posts.length, rounds: world.design.rounds };
  });
}
export const active = (world, round) => Object.entries(world.agents).filter(([id, a]) => unit(world.design.seed, 'active', String(round), id) < a.activity).map(([id]) => id);
export async function advance(dir, sim, patch) {
  return locked(dir, sim, async () => {
    const world = await need(dir, sim);
    if (patch.round !== undefined) world.round = int(patch.round, 0, world.design.rounds, 'round');
    if (patch.phase !== undefined) world.phase = ['feed', 'interview', 'done'].includes(patch.phase) ? patch.phase : fail('unknown phase');
    for (const [id, conv] of Object.entries(patch.conversations || {})) if (world.agents[id]) world.conversations[id] = String(conv).slice(0, 80);
    await save(dir, world); return world;
  });
}

// ---------- a persona's side: the feed ----------

const rootOf = p => p.repost_of || p.id;
const who = (world, id) => world.agents[id]?.name || id;
function counts(world, id) {
  const rs = world.reactions.filter(r => r.post === id);
  return { likes: rs.filter(r => r.like).length, shares: rs.filter(r => r.share).length, comments: rs.filter(r => r.comment).length };
}
function render(world, p, me) {
  const original = p.repost_of ? world.posts.find(x => x.id === p.repost_of) : p;
  const arm = world.agents[me].arm;
  const comments = world.reactions.filter(r => r.post === original.id && r.comment && (!original.arm || world.agents[r.agent]?.arm === arm)).slice(-3).map(r => `${who(world, r.agent)}: ${r.comment}`);
  return {
    post: p.id, account: original.account || who(world, original.author), ...(p.repost_of ? { shared_by: who(world, p.author) } : {}),
    content: original.content, ...(original.quote_of ? { replying_to: original.quote_of } : {}), ...counts(world, original.id), ...(comments.length ? { top_comments: comments } : {}),
  };
}
// Opening the app: unseen posts from this persona's corner of the world, drawn
// by engagement, follows and recency. The draw is seeded, and a second call in
// the same round returns the same feed, so a retry never burns unseen posts.
export async function timeline(dir, me, input) {
  keys(input, ['sim'], ['sim']);
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim), self = member(world, me), round = world.round;
    if (world.phase !== 'feed') fail('The feed is closed; the simulation is in its interview phase');
    const mine = world.impressions.filter(i => i.agent === me);
    let shown = mine.filter(i => i.round === round).map(i => world.posts.find(p => p.id === i.post));
    if (!shown.length) {
      const seen = new Set(mine.map(i => rootOf(world.posts.find(p => p.id === i.post))));
      const follows = new Set(world.follows.filter(f => f.agent === me).map(f => f.account));
      const pool = world.posts.filter(p => p.author !== me && (!p.arm || p.arm === self.arm) && !seen.has(rootOf(p))).map(p => {
        const c = counts(world, rootOf(p));
        const weight = 1 + 0.5 * c.likes + 1.5 * c.shares + 0.3 * c.comments + (follows.has(p.account || p.author) ? 2 : 0) + (p.round >= round - 1 ? 1 : 0);
        return { p, key: -Math.log(unit(world.design.seed, me, String(round), p.id) || 1e-9) / weight };
      }).sort((a, b) => a.key - b.key);
      const roots = new Set(); shown = [];
      for (const { p } of pool) { if (shown.length >= world.design.feed_size) break; if (roots.has(rootOf(p))) continue; roots.add(rootOf(p)); shown.push(p); }
      // Every persona meets its subject once, in its first session, at a seeded
      // place in the feed; after that the subject travels only by shares.
      const subject = world.posts.find(p => p.subject === self.arm);
      if (!mine.length && subject && !roots.has(subject.id)) { if (shown.length >= world.design.feed_size) shown.pop(); shown.splice(Math.floor(unit(world.design.seed, 'slot', me) * (shown.length + 1)), 0, subject); }
      for (const p of shown) world.impressions.push({ agent: me, post: p.id, round });
      await save(dir, world);
    }
    const build = n => ({ sim: world.id, round, platform: world.brief.platform, feed: shown.slice(0, n).map(p => render(world, p, me)), next: shown.length ? 'Record what you did with EVERY post above in one micro-fish_act call.' : 'Nothing new right now. Close the app; there is nothing to record.' });
    let n = shown.length, out = build(n);
    while (n > 1 && Buffer.byteLength(JSON.stringify(out)) > PREVIEW) out = build(--n);
    return out;
  });
}
export async function act(dir, me, input) {
  keys(input, ['sim', 'reactions', 'new_post'], ['sim', 'reactions']);
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim), self = member(world, me), round = world.round;
    if (world.phase !== 'feed') fail('The feed is closed');
    const shown = new Set(world.impressions.filter(i => i.agent === me && i.round === round).map(i => i.post));
    if (!shown.size) fail('Open the feed with micro-fish_timeline first');
    const rows = list(input.reactions, MAX.feed, 'reactions', (v, w) => {
      keys(v, ['post', 'attention', 'depth', 'like', 'share', 'follow', 'comment', 'quote'], ['post', 'attention'], w);
      if (!shown.has(v.post)) fail(`${w}: "${v.post}" was not in your feed this session`);
      if (!ATTENTION.includes(v.attention)) fail(`${w}.attention must be one of ${ATTENTION.join(', ')}`);
      for (const k of ['like', 'share', 'follow']) if (v[k] !== undefined && typeof v[k] !== 'boolean') fail(`${w}.${k} must be true or false`);
      const depth = v.attention === 'full' ? 100 : v.depth === undefined || v.depth === null ? null : int(v.depth, 0, 100, `${w}.depth`);
      return { post: v.post, attention: v.attention, depth, like: v.like === true, share: v.share === true, follow: v.follow === true, comment: text(v.comment, MAX.post, `${w}.comment`, true) || null, quote: text(v.quote, MAX.post, `${w}.quote`, true) || null };
    });
    if (new Set(rows.map(r => r.post)).size !== rows.length) fail('A post appears twice');
    const own = text(input.new_post, MAX.post, 'new_post', true);
    for (const r of rows) {
      const shownPost = world.posts.find(p => p.id === r.post), original = world.posts.find(p => p.id === rootOf(shownPost));
      const before = world.reactions.find(x => x.agent === me && x.post === original.id);
      world.reactions = world.reactions.filter(x => x !== before);
      world.reactions.push({ agent: me, post: original.id, round, attention: r.attention, depth: r.depth, like: r.like, share: r.share, comment: r.comment, via: shownPost.id });
      const account = original.account || original.author;
      if (r.follow && !world.follows.some(f => f.agent === me && f.account === account)) world.follows.push({ agent: me, account, round });
      if (r.share && !before?.share) world.posts.push({ id: `u${world.posts.length}`, author: me, round, repost_of: original.id, arm: self.arm });
      if (r.quote) world.posts.push({ id: `u${world.posts.length}`, author: me, round, content: r.quote, quote_of: original.id, arm: self.arm });
    }
    if (own) world.posts.push({ id: `u${world.posts.length}`, author: me, round, content: own, arm: self.arm });
    await save(dir, world);
    return { sim: world.id, round, recorded: rows.length, missing: [...shown].filter(id => !rows.some(r => r.post === id)) };
  });
}
// After the feed closes, each persona that met a subject answers the brief's
// questions about it from its own memory of the session.
export async function answer(dir, me, input) {
  keys(input, ['sim', 'answers'], ['sim', 'answers']);
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim); member(world, me);
    if (world.phase !== 'interview') fail('Interviews have not started');
    const qs = Object.fromEntries(world.brief.questions.map(q => [q.id, q]));
    keys(input.answers, Object.keys(qs), [], 'answers');
    const out = {};
    for (const [id, v] of Object.entries(input.answers)) {
      if (v === null || v === undefined || v === '') continue;
      const w = `answers.${id}`, type = qs[id].type;
      out[id] = type === 'scale' ? int(v, 1, 5, w) : type === 'yesno' ? (typeof v === 'boolean' ? v : fail(`${w} must be true or false`)) : type === 'tags' ? list(v, 6, w, tag) : text(v, MAX.text, w);
    }
    world.answers[me] = { values: out, at: new Date().toISOString() };
    await save(dir, world);
    return { sim: world.id, recorded: Object.keys(out), skipped: Object.keys(qs).filter(id => !(id in out)) };
  });
}

// ---------- experts ----------

export async function brief(dir, input) {
  keys(input, ['sim'], ['sim']);
  const world = await need(dir, input.sim);
  const out = { sim: world.id, goal: world.brief.goal, platform: world.brief.platform, language: world.brief.language, subjects: world.brief.subjects.map(s => ({ ...s, content: world.posts.find(p => p.subject === s.id).content })) };
  if (Buffer.byteLength(JSON.stringify(out)) > PREVIEW) for (const s of out.subjects) s.content = [...s.content].slice(0, Math.floor(PREVIEW / 4 / out.subjects.length)).join('') + '…';
  return out;
}
// An expert names what is wrong and how to fix it. There is no verdict and no
// overall score: over 95 recorded reviews those were ITERATE 94 times and
// rounded to 6 two times in three, so they told nothing apart.
export async function expert(dir, input) {
  keys(input, ['sim', 'expert', 'lens', 'findings', 'strengths', 'coverage'], ['sim', 'expert', 'lens', 'findings', 'coverage']);
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim), valid = new Set(world.brief.subjects.map(s => s.id));
    const id = ident(input.expert, 'expert');
    world.experts[id] = {
      lens: text(input.lens, 200, 'lens'),
      findings: list(input.findings, 12, 'findings', (f, w) => {
        keys(f, ['severity', 'subject', 'issue', 'evidence', 'fix'], ['severity', 'issue', 'fix'], w);
        if (!SEVERITIES.includes(f.severity)) fail(`${w}.severity must be P0–P3`);
        if (f.subject && !valid.has(f.subject)) fail(`${w}.subject is unknown`);
        return { severity: f.severity, subject: f.subject || null, issue: text(f.issue, 300, `${w}.issue`), evidence: text(f.evidence, 300, `${w}.evidence`, true) || null, fix: text(f.fix, 300, `${w}.fix`) };
      }),
      strengths: list(input.strengths, 8, 'strengths', (s, w) => text(s, 200, w)), coverage: text(input.coverage, 400, 'coverage'), at: new Date().toISOString(),
    };
    await save(dir, world);
    return { sim: world.id, expert: id, experts: Object.keys(world.experts).length };
  });
}

// ---------- reading the record ----------

const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r2 = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;
const pct = (k, n) => n ? Math.round(1000 * k / n) / 10 : null;
function wilson(k, n) {
  if (!n) return null; const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.round(1000 * Math.max(0, c - m)) / 10, Math.round(1000 * Math.min(1, c + m)) / 10];
}
const rate = (k, n) => ({ k, pct: pct(k, n), ci95: wilson(k, n) });
// How far through a post a reaction got, 0–100. A skip with no depth recorded
// is 0 and a full is 100; a "some" without one is unknown and left out.
const depthOf = r => r.depth ?? (r.attention === 'full' ? 100 : r.attention === 'skip' ? 0 : null);
function mean(xs) {
  if (!xs.length) return { n: 0, pct: null, ci95: null };
  const m = avg(xs), half = xs.length > 1 ? 1.96 * Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) : null;
  const r1 = x => Math.round(10 * x) / 10;
  return { n: xs.length, pct: r1(m), ci95: half === null ? null : [r1(Math.max(0, m - half)), r1(Math.min(100, m + half))] };
}
function top(values, limit) {
  const c = {}; for (const v of values) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, limit);
}
function behaviour(world, post, agents) {
  const ids = new Set(agents), reached = new Set(world.impressions.filter(i => ids.has(i.agent) && rootOf(world.posts.find(p => p.id === i.post)) === post).map(i => i.agent));
  const rs = world.reactions.filter(r => r.post === post && ids.has(r.agent)), n = reached.size, c = f => rs.filter(f).length;
  return {
    reached: n, recorded: rs.length, skip: rate(c(r => r.attention === 'skip'), n), some: rate(c(r => r.attention === 'some'), n), full: rate(c(r => r.attention === 'full'), n),
    stopped: rate(c(r => r.attention !== 'skip'), n), depth: mean(rs.map(depthOf).filter(x => x !== null)), like: rate(c(r => r.like), n), share: rate(c(r => r.share), n), comment: rate(c(r => r.comment), n),
    follow: rate(world.follows.filter(f => ids.has(f.agent) && f.account === (world.posts.find(p => p.id === post).account)).length, n),
  };
}
const ageBand = a => a === undefined ? 'unknown' : a < 25 ? '18-24' : a < 35 ? '25-34' : a < 45 ? '35-44' : '45+';
export async function tally(dir, input) {
  keys(input, ['sim', 'by'], ['sim']);
  const world = await need(dir, input.sim);
  const by = input.by ?? 'segment'; if (!['segment', 'zone', 'sex', 'age'].includes(by)) fail('by must be segment, zone, sex or age');
  const group = a => by === 'age' ? ageBand(a.age) : (a[by] || 'unknown');
  const everyone = Object.keys(world.agents), warnings = [], metric = world.design.metric || 'full';
  const out = {
    sim: world.id, goal: world.brief.goal, platform: world.brief.platform, population: everyone.length, rounds: { run: world.round, planned: world.design.rounds }, phase: world.phase,
    complete: world.phase === 'done', totals: { impressions: world.impressions.length, reactions: world.reactions.length, user_posts: world.posts.filter(p => p.author).length, follows: world.follows.length },
    subjects: {}, feed_rank: [], comparison: null, experts: null, warnings,
  };
  // Where the subjects stand among everything else in the same feed: the
  // context posts are the scale, so "60% finished it" reads against what the
  // same people did with the other things they were shown.
  const originals = world.posts.filter(p => !p.author);
  out.feed_rank = originals.map(p => { const b = behaviour(world, p.id, everyone); return { post: p.id, account: p.account, subject: Boolean(p.subject), reached: b.reached, full_pct: b.full.pct, stopped_pct: b.stopped.pct, depth_pct: b.depth.pct, like_pct: b.like.pct, comment_pct: b.comment.pct, share_pct: b.share.pct }; })
    .sort((a, b) => (b[`${metric}_pct`] ?? -1) - (a[`${metric}_pct`] ?? -1)).map((row, i) => ({ rank: i + 1, ...row }));
  for (const s of world.brief.subjects) {
    const arm = everyone.filter(id => world.agents[id].arm === s.id), b = behaviour(world, s.id, arm);
    const rs = world.reactions.filter(r => r.post === s.id);
    const answered = arm.filter(id => world.answers[id]), interview = {};
    for (const q of world.brief.questions) {
      const vals = answered.map(id => [id, world.answers[id].values[q.id]]).filter(([, v]) => v !== undefined);
      if (q.type === 'scale') { const xs = vals.map(([, v]) => v); interview[q.id] = { n: xs.length, mean: r2(avg(xs)), top2: rate(xs.filter(x => x >= 4).length, xs.length), dist: [1, 2, 3, 4, 5].map(v => xs.filter(x => x === v).length) }; }
      else if (q.type === 'yesno') interview[q.id] = { n: vals.length, yes: rate(vals.filter(([, v]) => v).length, vals.length) };
      else if (q.type === 'tags') interview[q.id] = { n: vals.length, tags: top(vals.flatMap(([, v]) => v), 10) };
      else interview[q.id] = { n: vals.length, answers: vals.slice(0, 40).map(([id, v]) => ({ who: who(world, id), attention: rs.find(r => r.agent === id)?.attention || 'not-recorded', text: v })) };
    }
    const groups = {}; for (const id of arm) (groups[group(world.agents[id])] ||= []).push(id);
    const descendants = world.posts.filter(p => p.author && (p.repost_of === s.id || p.quote_of === s.id));
    out.subjects[s.id] = {
      label: s.label, account: s.account, assigned: arm.length, ...b, rank_in_feed: out.feed_rank.find(r => r.post === s.id)?.rank, of: originals.length,
      comments: rs.filter(r => r.comment).map(r => ({ who: who(world, r.agent), round: r.round, text: r.comment })),
      quotes: descendants.filter(p => p.quote_of).map(p => ({ who: who(world, p.author), round: p.round, text: p.content })),
      spread: { shares: descendants.filter(p => p.repost_of).length, quotes: descendants.filter(p => p.quote_of).length, reached_by_share: world.impressions.filter(i => descendants.some(p => p.id === i.post)).length },
      interview: { asked: [...new Set(world.impressions.filter(i => rootOf(world.posts.find(p => p.id === i.post)) === s.id).map(i => i.agent))].length, answered: answered.length, ...interview },
      [`by_${by}`]: Object.fromEntries(Object.entries(groups).map(([g, ids]) => { const x = behaviour(world, s.id, ids); return [g, { reached: x.reached, full_pct: x.full.pct, stopped_pct: x.stopped.pct, depth_pct: x.depth.pct, like_pct: x.like.pct }]; })),
    };
    if (b.reached && b.reached < 30) warnings.push(`${s.id}: reached ${b.reached} personas — read rates as directional, not as a forecast`);
    if (b.recorded < b.reached) warnings.push(`${s.id}: ${b.reached - b.recorded} personas saw it and recorded nothing`);
    if (b.reached >= 10 && b.full.pct >= 80) warnings.push(`${s.id}: ${b.full.pct}% gave it full attention; simulated people are kinder than real ones — read its rank among the context posts, not the rate alone`);
  }
  const ids = world.brief.subjects.map(s => s.id);
  if (ids.length > 1) {
    const ranked = ids.map(id => [id, out.subjects[id][metric]]).filter(([, f]) => f.ci95).sort((a, b) => b[1].pct - a[1].pct);
    if (ranked.length) out.comparison = { metric, leader: ranked[0][0], clear: ranked.slice(1).every(([, f]) => ranked[0][1].ci95[0] > f.ci95[1]), order: ranked.map(([id, f]) => ({ subject: id, pct: f.pct, ci95: f.ci95 })) };
  }
  const panel = Object.entries(world.experts);
  if (panel.length) out.experts = {
    n: panel.length, lenses: panel.map(([id, e]) => ({ expert: id, lens: e.lens, coverage: e.coverage })),
    blocking: panel.flatMap(([id, e]) => e.findings.filter(f => ['P0', 'P1'].includes(f.severity)).map(f => ({ expert: id, ...f }))).slice(0, 16),
    other: panel.flatMap(([id, e]) => e.findings.filter(f => !['P0', 'P1'].includes(f.severity)).map(f => ({ expert: id, ...f }))).slice(0, 16),
  };
  if (!out.complete) warnings.push('Simulation is incomplete; these numbers cover what was recorded so far');
  out.caveat = 'Simulated personas from one model family, reading a text description of the content: use for direction, objections and wording, never as a forecast of reach, views or conversion. Validate the decision with real people.';
  for (const s of Object.values(out.subjects)) while (Buffer.byteLength(JSON.stringify(out)) > PREVIEW && s.comments.length > 5) s.comments.pop();
  for (const s of Object.values(out.subjects)) for (const q of Object.values(s.interview)) while (Buffer.byteLength(JSON.stringify(out)) > PREVIEW && q?.answers?.length > 5) q.answers.pop();
  return out;
}
export async function status(dir, input) {
  keys(input, ['sim'], []);
  if (!input.sim) {
    const files = await readdir(dir).catch(() => []), sims = [];
    for (const f of files.filter(f => f.endsWith('.json') && !f.startsWith('.')).slice(0, 50)) { const w = await load(dir, f.slice(0, -5)).catch(() => null); if (w) sims.push({ sim: w.id, goal: w.brief.goal, agents: Object.keys(w.agents).length, phase: w.phase, updated_at: w.updated_at }); }
    return { sims };
  }
  const world = await need(dir, input.sim);
  return { sim: world.id, goal: world.brief.goal, platform: world.brief.platform, subjects: world.brief.subjects, agents: Object.keys(world.agents).length, round: world.round, rounds: world.design.rounds, phase: world.phase, interviews: Object.keys(world.answers).length, experts: Object.keys(world.experts) };
}
export async function profile(dir, input) {
  keys(input, ['sim', 'persona'], ['sim', 'persona']);
  const world = await need(dir, input.sim), id = ident(input.persona, 'persona'), p = world.agents[id];
  if (!p) fail(`Unknown persona "${input.persona}"`);
  const label = pid => { const post = world.posts.find(x => x.id === pid); return post.subject ? `subject ${post.subject}` : (post.account || who(world, post.author)); };
  return { sim: world.id, persona: { id, ...p }, sessions: [...new Set(world.impressions.filter(i => i.agent === id).map(i => i.round))].map(round => ({ round, saw: world.impressions.filter(i => i.agent === id && i.round === round).map(i => label(i.post)) })),
    reactions: world.reactions.filter(r => r.agent === id).map(r => ({ round: r.round, on: label(r.post), attention: r.attention, depth: depthOf(r), like: r.like, share: r.share, comment: r.comment })),
    posts: world.posts.filter(x => x.author === id && x.content).map(x => x.content), answers: world.answers[id]?.values || null };
}

const AS_SELF = { timeline, act, answer };
const SHARED = { brief, expert, tally, status, profile };
export async function execute(call, operation, env = process.env) {
  if (!call || call.api_version !== 'soot/v1') fail('Unsupported Soot contract');
  const input = typeof call.input === 'string' ? JSON.parse(call.input || '{}') : (call.input ?? {});
  const dir = stateDirectory(env);
  if (AS_SELF[operation]) return AS_SELF[operation](dir, call.soot || fail('The host did not name the calling Soot'), input);
  if (SHARED[operation]) return SHARED[operation](dir, input);
  fail('Unknown Micro Fish operation');
}
