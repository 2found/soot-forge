// Process outcomes the contract fixes (channel-adapter.v1 §2): 0 = credential dead or
// replaced (the supervisor decides), 78 = configuration the adapter cannot fix.
export const EXIT_OK = 0;
export const EXIT_CONFIG = 78;

export class ExitError extends Error {
  constructor(code, detail) {
    super(`exit ${code}: ${detail}`);
    this.exitCode = code;
    this.detail = detail;
  }
}

// A platform call that failed. `retryable` decides the outbox ack (§4.9);
// `tokenInvalid` means the platform refused the bot's setup (exit 78); `reason` is the
// v1.1 StatusReport reason (§9.4), `code` stays the low-level detail.
export class PlatformError extends Error {
  constructor(code, {retryable = false, tokenInvalid = false, retryAfter = 0, editGone = false, reason = null} = {}) {
    super(code);
    this.code = code;
    this.reason = reason;
    this.retryable = retryable;
    this.tokenInvalid = tokenInvalid;
    this.retryAfter = retryAfter;
    this.editGone = editGone;
  }
}

// Logs carry codes and ids only: never message text, tokens or platform payloads (§6.5).
export function makeLogger(stream = process.stderr) {
  return (event, fields = {}) => {
    try { stream.write(JSON.stringify({at: new Date().toISOString(), event, ...fields}) + '\n'); } catch {}
  };
}

export const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, {once: true});
});

// A deadline for Promise.race that never keeps the process alive on its own.
export const deadline = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.());

// Backoff 1 s → max, ×2 with full jitter on the upper half.
export function backoff(attempt, base = 1000, max = 60_000) {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + Math.random() * ceiling / 2);
}
