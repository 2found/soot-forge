// The signed publish claim (design §3.2/§4). A claim is canonical JSON — keys
// sorted at every level, `sig` left out — signed with HMAC-SHA256 under the
// shared MARKETING_CLAIM_KEY. Publishers keep their own copy of `verifyClaim`
// (packs never import each other); tests pin both copies to one vector.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CLAIM_TTL_MS = 10 * 60 * 1000;
// An open intent is re-issued only after any publisher run it started must have
// ended (lohi-blog publish/unpublish time out at 25 minutes), so a slow deploy
// is never raced by a second claim on the same post.
export const INTENT_STALE_MS = 30 * 60 * 1000;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The hash of exactly what goes out: title, meta, slug, body and link. */
export function contentHash({ title = '', meta = '', slug = '', body = '', link = '' } = {}) {
  return 'sha256:' + createHash('sha256').update(canonical({ title, meta, slug, body, link })).digest('hex');
}

export function signClaim(claim, key) {
  if (!key) throw Object.assign(new Error('MARKETING_CLAIM_KEY is not set for this Soot.'), { code: 'claim_key_missing' });
  const { sig, ...rest } = claim;
  return { ...rest, sig: createHmac('sha256', key).update(canonical(rest)).digest('hex') };
}

/** null when the claim is genuine, current and matches its content; otherwise a refusal code. */
export function verifyClaim(claim, key, now = Date.now()) {
  if (!key) return 'claim_key_missing';
  if (!claim || typeof claim !== 'object' || typeof claim.sig !== 'string') return 'claim_unsigned';
  const { sig, ...rest } = claim;
  const want = createHmac('sha256', key).update(canonical(rest)).digest();
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'claim_forged';
  const exp = Date.parse(claim.expires_at ?? '');
  if (!Number.isFinite(exp) || exp <= now) return 'claim_expired';
  if (claim.content_hash !== contentHash(claim)) return 'claim_hash_mismatch';
  return null;
}
