// `soot-channel <telegram|discord>` process lifecycle (channel-adapter.v1 §2, §4.1–4.2).
import {HostClient} from './client.mjs';
import {EXIT_CONFIG, EXIT_OK, ExitError, PlatformError, backoff, deadline, makeLogger, sleep} from './errors.mjs';
import {Inbound} from './inbound.mjs';
import {Journal} from './journal.mjs';
import {Outbox} from './outbox.mjs';
import {Telegram} from '../platform/telegram.mjs';
import {Discord} from '../platform/discord.mjs';

export const CONTRACT = 'channel-adapter.v1';
export const VERSION = '0.2.0';
// channel-adapter v1.1 (§9.1): declared on every StatusReport.
export const CONTRACT_REVISION = 1;
const PLATFORMS = {telegram: Telegram, discord: Discord};
const REQUIRED = ['SOOT_CHANNEL_API', 'SOOT_CHANNEL_TOKEN', 'SOOT_CHANNEL_BINDING', 'SOOT_CHANNEL_PLATFORM', 'SOOT_CHANNEL_PLATFORM_TOKEN', 'SOOT_CHANNEL_STATE_DIR'];
const STOP_BUDGET_MS = 9000;
const STATUS_EVERY_MS = 5 * 60_000;

// Reads only the contract environment. Anything missing or inconsistent is a
// configuration the adapter cannot fix: exit 78.
export function readConfig(argv, env) {
  const platform = argv[0];
  if (env.SOOT_CHANNEL_CONTRACT !== CONTRACT) throw new ExitError(EXIT_CONFIG, 'unsupported_contract');
  for (const name of REQUIRED) if (!env[name]) throw new ExitError(EXIT_CONFIG, `missing_${name.toLowerCase()}`);
  if (!PLATFORMS[platform] || env.SOOT_CHANNEL_PLATFORM !== platform) throw new ExitError(EXIT_CONFIG, 'platform_mismatch');
  return {
    platform,
    api: env.SOOT_CHANNEL_API,
    token: env.SOOT_CHANNEL_TOKEN,
    binding: env.SOOT_CHANNEL_BINDING,
    platformToken: env.SOOT_CHANNEL_PLATFORM_TOKEN,
    stateDir: env.SOOT_CHANNEL_STATE_DIR,
  };
}

// Runs until stopped or a terminal condition; resolves to the exit code.
// `options` exists for tests: platform base URLs, fetch/WebSocket and timings.
export async function runAdapter({argv, env, stop, log = makeLogger(), fetch = globalThis.fetch, platformOptions = {}, timing = {}}) {
  const stopper = new AbortController();
  const signal = stopper.signal;
  stop?.addEventListener('abort', () => stopper.abort(), {once: true});
  let config;
  try { config = readConfig(argv, env); }
  catch (error) { log('config_invalid', {detail: error.detail}); return error.exitCode; }

  const client = new HostClient({api: config.api, token: config.token, fetch, log, signal, backoffBase: timing.backoffBase});
  let session, platform, outbox, status;
  try {
    session = await fetchSession(client);
    const journal = new Journal(config.stateDir);
    platform = new PLATFORMS[config.platform]({token: config.platformToken, fetch, log, backoffBase: timing.backoffBase, ...platformOptions});
    status = new StatusReporter(client, log);
    status.report('connecting');
    const account = await startPlatform(platform, status, signal, timing.backoffBase);
    if (!account) return EXIT_OK;
    status.account = account;
    status.report('connected', null, true);

    const health = (state, detail, reason) => status.report(state, detail, false, reason);
    const inbound = new Inbound({client, journal, platform: platform.name, getSession: () => session, ops: platform.ops(), log});
    let fatal;
    const failed = new Promise(resolve => { fatal = resolve; });
    outbox = new Outbox({
      client, journal, platform, getSession: () => session, log, onHealth: health,
      silenceMs: timing.silenceMs, ackDelayMs: timing.ackDelayMs, backoffBase: timing.backoffBase,
      onConnectionLost: async () => { session = await fetchSession(client); },
    });
    outbox.onFatal = fatal;
    const heartbeat = setInterval(() => status.report(status.state, status.detail, true, status.reason), STATUS_EVERY_MS);
    heartbeat.unref?.();
    const stopped = new Promise(resolve => signal.addEventListener('abort', () => resolve(null), {once: true}));
    const outcome = await Promise.race([
      platform.listen(inbound, journal, signal, health).then(() => null, error => error),
      outbox.run(signal).then(() => null, error => error),
      failed, stopped,
    ]);
    clearInterval(heartbeat);
    stopper.abort();
    await Promise.race([outbox.drain(), deadline(STOP_BUDGET_MS)]);
    return await finish(outcome, status, log);
  } catch (error) {
    stopper.abort();
    if (outbox) await Promise.race([outbox.drain(), deadline(STOP_BUDGET_MS)]);
    return await finish(error, status, log);
  } finally {
    platform?.close?.();
  }
}

async function finish(outcome, status, log) {
  if (!outcome) return EXIT_OK;
  if (outcome instanceof ExitError) { log('exit', {code: outcome.exitCode, detail: outcome.detail}); return outcome.exitCode; }
  if (outcome instanceof PlatformError && outcome.tokenInvalid) {
    await status?.final('platform_token_invalid', outcome.code, outcome.reason);
    log('exit', {code: EXIT_CONFIG, detail: outcome.code});
    return EXIT_CONFIG;
  }
  log('crash', {name: outcome?.name, code: outcome?.code});
  return 1;
}

async function fetchSession(client) {
  const {status, body} = await client.get('/v1/channel/session');
  if (status !== 200) throw new ExitError(EXIT_CONFIG, body?.code || `session_${status}`);
  if (body.contract !== CONTRACT) throw new ExitError(EXIT_CONFIG, 'unsupported_contract');
  return body;
}

// The platform's first call proves the bot token. Rejected → exit 78 (after
// status); unreachable → retry with backoff while reporting degraded.
async function startPlatform(platform, status, signal, base = 1000) {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try { return await platform.start(signal); }
    catch (error) {
      if (!(error instanceof PlatformError) || error.tokenInvalid) throw error;
      status.report('degraded', error.code, false, error.reason);
      await sleep(Math.max(error.retryAfter * 1000, backoff(attempt, base)), signal);
    }
  }
  return null;
}

class StatusReporter {
  constructor(client, log) {
    this.client = client;
    this.log = log;
    this.state = null;
    this.detail = null;
    this.reason = null;
    this.account = null;
    this.chain = Promise.resolve();
  }

  // Sent on every change (fire and forget: health never blocks delivery).
  report(state, detail = null, force = false, reason = null) {
    if (!force && state === this.state && detail === this.detail && reason === this.reason) return;
    if (!force && state === 'connected' && this.state === 'connected') return;
    this.state = state;
    this.detail = detail;
    this.reason = reason;
    const body = {state, adapter_version: VERSION, contract_revision: CONTRACT_REVISION};
    if (reason) body.reason = reason;
    if (detail) body.detail = detail;
    if (this.account) body.platform_account = this.account;
    this.chain = this.chain.then(() => this.client.post('/v1/channel/status', body)).catch(error => this.log('status_failed', {name: error?.name}));
  }

  async final(state, detail, reason) {
    this.report(state, detail, true, reason);
    await Promise.race([this.chain, deadline(3000)]);
  }
}
