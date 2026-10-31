// All dates are shown in UTC, matching the API's buckets and range boundaries.

const nf = new Intl.NumberFormat('en-US');
export const num = (n: number) => nf.format(n);

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const dayYearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });

export const fmtDay = (iso: string) => dayFmt.format(new Date(iso));
export const fmtDayYear = (iso: string) => dayYearFmt.format(new Date(iso));
export const fmtHour = (iso: string) => hourFmt.format(new Date(iso));
export const fmtDateTime = (iso: string) => `${fmtDay(iso)}, ${fmtHour(iso)} UTC`;

export const DAY_MS = 86_400_000;

// The API's `to` is exclusive; show the last included day.
export function fmtRange(from: string, to: string) {
  const last = new Date(Date.parse(to) - 1).toISOString();
  const span = Date.parse(to) - Date.parse(from);
  if (span <= DAY_MS && from.endsWith('T00:00:00Z')) return `${fmtDayYear(from)} · UTC`;
  return `${fmtDay(from)} – ${fmtDayYear(last)} · UTC`;
}

export function fmtDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export const fmtSigned = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

export const NA = 'N/A';
