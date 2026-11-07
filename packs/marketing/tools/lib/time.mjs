// Local-time helpers for quiet hours, caps by local day and slot finding.
// Built on Intl only; the channel/settings rows name the timezone.

export const DEFAULT_QUIET = { from: '23:00', to: '07:00', tz: 'Asia/Ho_Chi_Minh' };
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function localParts(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

export function inQuiet(ms, quiet = DEFAULT_QUIET) {
  if (!quiet?.from || !quiet?.to) return false;
  const { minutes } = localParts(ms, quiet.tz || DEFAULT_QUIET.tz);
  const from = toMin(quiet.from), to = toMin(quiet.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export const localDay = (ms, tz = DEFAULT_QUIET.tz) => localParts(ms, tz).day;

/** The start (UTC ms) of the local day containing ms. */
export function localDayStart(ms, tz = DEFAULT_QUIET.tz) {
  const { minutes } = localParts(ms, tz);
  let start = Math.floor(ms / MIN) * MIN - minutes * MIN;
  // DST-free zones land exactly; others settle within an hour either side.
  while (localParts(start, tz).day !== localParts(ms, tz).day) start += HOUR;
  return start;
}

/**
 * The first slot at or after `from` that is outside quiet hours, at least
 * `spacingMin` after every taken time, and under `cap` taken on its local day.
 * `jitterMin` (0..9) shifts the slot so posts do not land on round minutes.
 */
export function nextSlot({ from, taken = [], cap = 1, spacingMin = 0, quiet = DEFAULT_QUIET, jitterMin = 0, horizonDays = 30 }) {
  const tz = quiet?.tz || DEFAULT_QUIET.tz;
  const step = 10 * MIN;
  let t = Math.ceil(from / step) * step;
  for (const end = from + horizonDays * DAY; t < end; t += step) {
    const at = t + jitterMin * MIN;
    if (inQuiet(at, quiet)) continue;
    if (taken.some(x => Math.abs(x - at) < spacingMin * MIN)) continue;
    const day = localDay(at, tz);
    if (taken.filter(x => localDay(x, tz) === day).length >= cap) continue;
    return at;
  }
  return null;
}
