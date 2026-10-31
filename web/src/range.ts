import { DAY_MS } from './format';

// Time range selection, stored in the URL as either `range=<preset>` or `from`/`to`
// (YYYY-MM-DD, `to` exclusive, as the API expects). Presets end at the dataset's end,
// not today's date: the data is a fixed snapshot.

export const PRESETS = [
  { key: '24h', label: '24h', days: 1 },
  { key: '7d', label: '7d', days: 7 },
  { key: '14d', label: '14d', days: 14 },
  { key: 'all', label: 'All', days: null },
] as const;
export type PresetKey = (typeof PRESETS)[number]['key'];
export const DEFAULT_PRESET: PresetKey = '7d';

export interface Coverage {
  start: string;
  end: string;
}

export interface Selection {
  preset: PresetKey | null; // null = custom
  from: string;
  to: string;
}

const day = (iso: string) => iso.slice(0, 10);
const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString().replace('.000Z', 'Z');

export function presetRange(key: PresetKey, cov: Coverage) {
  const p = PRESETS.find((x) => x.key === key)!;
  return { from: p.days === null ? cov.start : shift(cov.end, -p.days), to: cov.end };
}

export function readSelection(search: string, cov: Coverage): Selection {
  const q = new URLSearchParams(search);
  const from = q.get('from');
  const to = q.get('to');
  const valid = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  if (valid(from) && valid(to)) {
    const f = `${from}T00:00:00Z`;
    const t = `${to}T00:00:00Z`;
    if (f < t && f >= cov.start && t <= cov.end) return { preset: null, from: f, to: t };
  }
  const key = (PRESETS.find((p) => p.key === q.get('range'))?.key ?? DEFAULT_PRESET) as PresetKey;
  return { preset: key, ...presetRange(key, cov) };
}

// Query string to carry the selection across pages.
export function selectionQuery(sel: Selection): string {
  return sel.preset ? `range=${sel.preset}` : `from=${day(sel.from)}&to=${day(sel.to)}`;
}

export const toDateInput = day;
export const lastIncludedDay = (to: string) => day(shift(to, -1));
export const nextDay = (d: string) => day(shift(`${d}T00:00:00Z`, 1));
