// Query-parameter parsing shared by all routes. All times are UTC unix seconds.
// Ranges are half-open: [from, to). An event at exactly `to` belongs to the next range.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const HOUR = 3600;
export const DAY = 86400;

export interface Coverage {
  start: number; // UTC midnight of the first event's day
  end: number;   // UTC midnight after the last event's day (exclusive)
  firstEventAt: number;
  lastEventAt: number;
}

export function coverageFrom(minTs: number | null, maxTs: number | null): Coverage | null {
  if (minTs === null || maxTs === null) return null;
  return {
    start: Math.floor(minTs / DAY) * DAY,
    end: Math.floor(maxTs / DAY) * DAY + DAY,
    firstEventAt: minTs,
    lastEventAt: maxTs,
  };
}

// Accepts `2026-08-01` (midnight UTC) or `2026-08-01T12:00[:00[.000]]Z`. Offsets other
// than Z are rejected so there is never any doubt about the time zone.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

function parseInstant(name: string, v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !(DATE.test(v) || DATETIME.test(v))) {
    throw new ApiError(400, 'invalid_parameter',
      `${name} must be a UTC date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:MM:SSZ)`);
  }
  const ms = Date.parse(DATE.test(v) ? `${v}T00:00:00Z` : v);
  // Date.parse accepts impossible dates like 2026-02-31 by rolling over; reject those.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v.slice(0, 10)) {
    throw new ApiError(400, 'invalid_parameter', `${name} is not a valid date: ${v}`);
  }
  return Math.floor(ms / 1000);
}

export interface Range {
  from: number;
  to: number;
}

// Defaults to the full coverage. Ranges must lie inside the coverage: outside it
// there is no data, and a partly covered range would understate every count.
export function parseRange(q: Record<string, unknown>, cov: Coverage): Range {
  const from = parseInstant('from', q.from) ?? cov.start;
  const to = parseInstant('to', q.to) ?? cov.end;
  if (from >= to) throw new ApiError(400, 'invalid_range', '`from` must be earlier than `to`');
  if (from < cov.start || to > cov.end) {
    throw new ApiError(400, 'range_outside_coverage',
      `range must be within the dataset coverage ${iso(cov.start)} to ${iso(cov.end)}`);
  }
  return { from, to };
}

export function parseLimit(v: unknown, def: number, max: number, name = 'limit'): number {
  if (v === undefined || v === '') return def;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < (name === 'offset' ? 0 : 1) || n > max) {
    throw new ApiError(400, 'invalid_parameter', `${name} must be an integer between ${name === 'offset' ? 0 : 1} and ${max}`);
  }
  return n;
}

export function parseBool(v: unknown, name: string): boolean {
  if (v === undefined || v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  throw new ApiError(400, 'invalid_parameter', `${name} must be true or false`);
}

export const MAX_BUCKETS = 1000;
export const AUTO_HOURLY_MAX = 72 * HOUR;

// `auto` picks hourly buckets for ranges up to 72h, daily otherwise.
export function parseBucket(v: unknown, r: Range): number {
  const choice = v === undefined || v === '' ? 'auto' : v;
  let size: number;
  if (choice === 'hour') size = HOUR;
  else if (choice === 'day') size = DAY;
  else if (choice === 'auto') size = r.to - r.from <= AUTO_HOURLY_MAX ? HOUR : DAY;
  else throw new ApiError(400, 'invalid_parameter', 'bucket must be hour, day or auto');
  const count = Math.ceil(r.to / size) - Math.floor(r.from / size);
  if (count > MAX_BUCKETS) {
    throw new ApiError(400, 'invalid_parameter', `too many buckets (${count}); use a larger bucket or a shorter range`);
  }
  return size;
}

export const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
export const isoOrNull = (s: number | null) => (s === null ? null : iso(s));
