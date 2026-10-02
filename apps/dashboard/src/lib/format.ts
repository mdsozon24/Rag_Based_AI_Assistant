/** Display formatting in the viewer's own locale and time zone. */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const number = new Intl.NumberFormat();

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : dateOnly.format(date);
}

/** "3 minutes ago", "yesterday". */
export function formatRelative(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return relative.format(0, 'second');
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return formatDate(date);
}

/** 92000 → "1m 32s"; under a minute "45s"; null → "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Offset into a call: 65_400 → "1:05". */
export function formatOffset(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return digits ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : number.format(Math.round(value));
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/** "customer-ended-call" → "Customer ended call". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const words = value.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
