// Identity keys: one normalized key per way of reaching or recognizing a
// person. Two contacts never share a key (the `identities.key` column is
// unique), so an exact match is the only thing that joins records
// automatically; a similar name only ever suggests.
import { fail } from './store.mjs';

/** Ways to reach a person: storing one needs their consent. */
export const REACH_KINDS = ['email', 'phone', 'telegram', 'discord', 'zalo', 'facebook', 'x', 'github', 'linkedin'];
/** Ways to recognize a person that reach no one: an account id in a product, a company website. */
export const REF_KINDS = ['account', 'website'];
export const IDENTITY_KINDS = [...REACH_KINDS, ...REF_KINDS];

export const PRODUCT = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function product(value, fallback) {
  const p = value ?? fallback ?? null;
  if (p === null || p === '') return null;
  if (typeof p !== 'string' || !PRODUCT.test(p)) fail('invalid_request', `product must be a product id like "lohi" (got ${JSON.stringify(p)}).`);
  return p;
}

const handle = v => {
  let s = v.trim();
  if (/^https?:\/\//i.test(s) || s.includes('/')) s = s.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? '';
  return s.replace(/^@+/, '').toLowerCase();
};

/** {kind, value, display, key} for one identity; throws invalid_request. */
export function identity({ kind, value }, productId) {
  if (!IDENTITY_KINDS.includes(kind)) fail('invalid_request', `identity kind must be one of ${IDENTITY_KINDS.join(', ')}.`);
  if (typeof value !== 'string' || !value.trim()) fail('invalid_request', `identity ${kind} needs a value.`);
  const raw = value.trim().slice(0, 200);
  let norm;
  switch (kind) {
    case 'email':
      norm = raw.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) fail('invalid_request', `"${raw}" is not an email address.`);
      break;
    case 'phone': {
      // Digits only; "+84 912" and "0084912" are the same number. A national
      // number ("0912…") stays as written: save numbers in international form.
      norm = raw.replace(/\D/g, '').replace(/^00/, '');
      if (norm.length < 6 || norm.length > 15) fail('invalid_request', `"${raw}" is not a phone number.`);
      break;
    }
    case 'website':
      norm = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(norm)) fail('invalid_request', `"${raw}" is not a website domain.`);
      break;
    case 'account':
      if (!productId) fail('product_required', 'An account identity belongs to one product: give product.');
      norm = `${productId}:${raw}`;
      break;
    default:
      norm = handle(raw);
      if (!norm) fail('invalid_request', `"${raw}" is not a ${kind} handle.`);
  }
  return { kind, value: kind === 'account' ? raw : (kind === 'email' || kind === 'website' ? norm : raw), key: `${kind}:${norm}` };
}

/** The principal of the conversation, as the host set it (never model input). */
export function principalOf(ctx) {
  const p = ctx?.principal;
  return p && typeof p.tenant === 'string' && typeof p.sub === 'string' && p.tenant && p.sub ? `${p.tenant}:${p.sub}` : null;
}

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
export { fold };
