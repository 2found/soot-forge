// Contract HTTP client for /v1/channel/* (channel-adapter.v1 §3).
import {EXIT_OK, ExitError, backoff, sleep} from './errors.mjs';

export class HostClient {
  constructor({api, token, fetch = globalThis.fetch, log = () => {}, signal, backoffBase = 1000, backoffMax = 60_000}) {
    this.api = api.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetch;
    this.log = log;
    this.signal = signal;
    this.backoffBase = backoffBase;
    this.backoffMax = backoffMax;
  }

  headers(extra = {}) {
    return {authorization: `Bearer ${this.token}`, accept: 'application/json', ...extra};
  }

  // One logical request: retries the same body (same request_id) on 5xx, network
  // errors and 429 without a user-facing sentence; returns {status, body} otherwise.
  // 401 credential_invalid ends the process with exit 0 (§2).
  async request(method, path, body, {retryRateLimit = true} = {}) {
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted && attempt > 0) throw new ExitError(EXIT_OK, 'stopping');
      let response;
      try {
        response = await this.fetch(this.api + path, {
          method,
          headers: this.headers(body === undefined ? {} : {'content-type': 'application/json'}),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        this.log('host_network_error', {path: routeOf(path), name: error?.name, attempt});
        await sleep(backoff(attempt, this.backoffBase, this.backoffMax), this.signal);
        continue;
      }
      const parsed = await readJSON(response);
      if (response.status === 401) throw new ExitError(EXIT_OK, parsed?.code || 'credential_invalid');
      if (response.status >= 500) {
        this.log('host_unavailable', {path: routeOf(path), status: response.status, code: parsed?.code, attempt});
        await sleep(Math.max(retryAfter(response, parsed) * 1000, backoff(attempt, this.backoffBase, this.backoffMax)), this.signal);
        continue;
      }
      if (response.status === 429 && retryRateLimit && !hasUserText(parsed)) {
        this.log('host_rate_limited', {path: routeOf(path), attempt});
        await sleep(Math.max(retryAfter(response, parsed) * 1000, this.backoffBase), this.signal);
        continue;
      }
      if (response.status === 400 && parsed?.code === 'invalid_request') this.log('host_invalid_request', {path: routeOf(path)});
      return {status: response.status, body: parsed ?? {}};
    }
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
}

// A 429 that carries a sentence for the person (a pairing lockout) is final: we show
// it instead of holding the chat for minutes.
const hasUserText = body => Boolean(body && (body.reply || body.toast || body.notice));

function retryAfter(response, body) {
  const value = Number(body?.retry_after ?? response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : 0;
}

async function readJSON(response) {
  try { return JSON.parse(await response.text()); } catch { return null; }
}

// Paths only, no query string (cursor values are harmless but keep logs uniform).
export const routeOf = path => path.split('?')[0];
