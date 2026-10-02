/**
 * Calling schedule in the CONTACT's time zone. Pure functions: no clock, no database.
 *
 * A schedule is local calendar dates (inclusive), allowed ISO weekdays (1 = Monday ... 7 = Sunday)
 * and a same-day window [windowStart, windowEnd) in local time. The platform also has an outer
 * limit (HardCap, default 08:00-21:00) that no campaign can exceed: the effective window is the
 * intersection of the two. A contact may be dialed at an instant only if, in the contact's own time
 * zone, the local date is inside the dates, the weekday is allowed, and the local time is inside the
 * effective window. The dialer checks this again right before every dial.
 */

export interface Schedule {
  /** First day calls may start, YYYY-MM-DD in the contact's time zone. */
  startDate: string;
  /** Last day calls may start (inclusive), YYYY-MM-DD in the contact's time zone. */
  endDate: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  allowedDays: readonly number[];
  /** "HH:MM" local, inclusive. */
  windowStart: string;
  /** "HH:MM" local, exclusive. Must be after windowStart (no overnight windows). */
  windowEnd: string;
}

export interface HardCap {
  start: string;
  end: string;
}

export const DEFAULT_HARD_CAP: HardCap = { start: '08:00', end: '21:00' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function minutesOf(time: string): number {
  const match = TIME.exec(time);
  if (!match) throw new Error(`Invalid time "${time}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(zone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** 1 = Monday ... 7 = Sunday */
  isoWeekday: number;
}

export function localParts(instant: Date, zone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    isoWeekday: WEEKDAYS[parts.weekday],
  };
}

/** UTC offset of `zone` at `instant`, in ms (positive east of UTC). */
function offsetMs(instant: number, zone: string): number {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant))) parts[part.type] = part.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which `zone`'s clock reads `date` + `minutes`. Around a clock change the wall
 * time may not exist or may occur twice; the result is then the nearest valid instant (calling
 * windows start at 08:00 or later, so no real zone has a change inside the windows).
 */
export function zonedInstant(date: string, minutes: number, zone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // The offset in force at the wall time, corrected once for a change between the guess and the answer
  const guess = wallAsUtc - offsetMs(wallAsUtc, zone);
  return new Date(wallAsUtc - offsetMs(guess, zone));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The window campaigns may actually use: their own, cut to the platform cap. Null if empty. */
export function effectiveWindow(schedule: Pick<Schedule, 'windowStart' | 'windowEnd'>, cap: HardCap = DEFAULT_HARD_CAP): { start: number; end: number } | null {
  const start = Math.max(minutesOf(schedule.windowStart), minutesOf(cap.start));
  const end = Math.min(minutesOf(schedule.windowEnd), minutesOf(cap.end));
  return start < end ? { start, end } : null;
}

export interface ScheduleIssue {
  path: string;
  message: string;
}

export function validateSchedule(schedule: Schedule, cap: HardCap = DEFAULT_HARD_CAP): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  if (!isValidDate(schedule.startDate)) issues.push({ path: 'schedule.startDate', message: 'Must be a date like 2026-10-05' });
  if (!isValidDate(schedule.endDate)) issues.push({ path: 'schedule.endDate', message: 'Must be a date like 2026-10-31' });
  if (isValidDate(schedule.startDate) && isValidDate(schedule.endDate) && schedule.endDate < schedule.startDate) issues.push({ path: 'schedule.endDate', message: 'Must not be before startDate' });
  if (!schedule.allowedDays.length) issues.push({ path: 'schedule.allowedDays', message: 'List at least one allowed weekday (1 = Monday ... 7 = Sunday)' });
  if (schedule.allowedDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) issues.push({ path: 'schedule.allowedDays', message: 'Weekdays are 1 (Monday) to 7 (Sunday)' });
  if (!TIME.test(schedule.windowStart) || !TIME.test(schedule.windowEnd)) {
    issues.push({ path: 'schedule.windowStart', message: 'Times are 24-hour HH:MM' });
  } else if (minutesOf(schedule.windowStart) >= minutesOf(schedule.windowEnd)) {
    issues.push({ path: 'schedule.windowEnd', message: 'Must be after windowStart (windows cannot cross midnight)' });
  } else if (!effectiveWindow(schedule, cap)) {
    issues.push({ path: 'schedule.windowStart', message: `The window must overlap the platform calling hours ${cap.start}-${cap.end} (contact local time)` });
  }
  return issues;
}

export type Blocked = 'before-start-date' | 'after-end-date' | 'day-not-allowed' | 'outside-hours';

export type Allowed = { allowed: true } | { allowed: false; reason: Blocked };

/** May a call to a contact in `zone` start at `instant`? */
export function checkAllowed(instant: Date, zone: string, schedule: Schedule, cap: HardCap = DEFAULT_HARD_CAP): Allowed {
  const local = localParts(instant, zone);
  if (local.date < schedule.startDate) return { allowed: false, reason: 'before-start-date' };
  if (local.date > schedule.endDate) return { allowed: false, reason: 'after-end-date' };
  if (!schedule.allowedDays.includes(local.isoWeekday)) return { allowed: false, reason: 'day-not-allowed' };
  const window = effectiveWindow(schedule, cap);
  if (!window || local.minutes < window.start || local.minutes >= window.end) return { allowed: false, reason: 'outside-hours' };
  return { allowed: true };
}

/**
 * The earliest instant at or after `instant` when a call to `zone` may start, or null when the
 * schedule has no such time left (end date passed, or no allowed day and window).
 */
export function nextAllowedAt(instant: Date, zone: string, schedule: Schedule, cap: HardCap = DEFAULT_HARD_CAP): Date | null {
  const window = effectiveWindow(schedule, cap);
  if (!window || !schedule.allowedDays.length) return null;
  const now = localParts(instant, zone);
  let date = now.date < schedule.startDate ? schedule.startDate : now.date;
  // 8 days is enough to meet any allowed weekday; the end date bounds the rest
  for (let i = 0; i < 400 && date <= schedule.endDate; i++, date = addDays(date, 1)) {
    const weekday = localParts(zonedInstant(date, 12 * 60, zone), zone).isoWeekday;
    if (!schedule.allowedDays.includes(weekday)) continue;
    if (date === now.date) {
      if (now.minutes >= window.start && now.minutes < window.end) return instant;
      if (now.minutes >= window.end) continue;
    }
    const opens = zonedInstant(date, window.start, zone);
    if (opens.getTime() > instant.getTime()) return opens;
  }
  return null;
}

/**
 * True once no time zone on Earth can still be on `endDate` (UTC-12 is the last to leave it),
 * so a campaign whose contacts all wait for the schedule can be completed.
 */
export function scheduleEnded(now: Date, endDate: string): boolean {
  return now.getTime() >= zonedInstant(addDays(endDate, 1), 12 * 60, 'UTC').getTime();
}
