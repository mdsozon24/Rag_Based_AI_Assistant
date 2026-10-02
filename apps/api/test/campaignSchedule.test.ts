/** Schedule, time zone and CSV rules: pure functions, no database. */
import { describe, expect, it } from 'vitest';
import { csvCell, normalizeNumber, parseContactCsv, timeZoneForNumber } from '../src/services/campaigns/contacts.ts';
import { checkAllowed, effectiveWindow, localParts, nextAllowedAt, scheduleEnded, validateSchedule, zonedInstant, type Schedule } from '../src/services/campaigns/schedule.ts';

const at = (iso: string) => new Date(iso);
const WEEKDAYS: Schedule = { startDate: '2026-10-01', endDate: '2026-10-31', allowedDays: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '18:00' };

describe('local time in the contact’s zone', () => {
  it('reads the same instant differently in different zones', () => {
    const instant = at('2026-10-05T03:30:00Z'); // Monday
    expect(localParts(instant, 'Asia/Dhaka')).toEqual({ date: '2026-10-05', minutes: 9 * 60 + 30, isoWeekday: 1 });
    expect(localParts(instant, 'America/New_York')).toEqual({ date: '2026-10-04', minutes: 23 * 60 + 30, isoWeekday: 7 });
    expect(localParts(instant, 'Pacific/Kiritimati')).toEqual({ date: '2026-10-05', minutes: 17 * 60 + 30, isoWeekday: 1 });
  });

  it('converts local wall time back to an instant, across daylight saving', () => {
    expect(zonedInstant('2026-10-05', 9 * 60, 'Asia/Dhaka').toISOString()).toBe('2026-10-05T03:00:00.000Z');
    // New York: UTC-4 before 2026-11-01, UTC-5 after
    expect(zonedInstant('2026-10-30', 9 * 60, 'America/New_York').toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(zonedInstant('2026-11-02', 9 * 60, 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
    // The day clocks change itself
    expect(zonedInstant('2026-11-01', 9 * 60, 'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(zonedInstant('2026-03-29', 9 * 60, 'Europe/London').toISOString()).toBe('2026-03-29T08:00:00.000Z');
  });
});

describe('checkAllowed', () => {
  it('uses the window as [start, end) in local time', () => {
    const zone = 'Asia/Dhaka';
    // Monday 2026-10-05, Dhaka is UTC+6 with no daylight saving
    expect(checkAllowed(at('2026-10-05T02:59:59Z'), zone, WEEKDAYS)).toEqual({ allowed: false, reason: 'outside-hours' });
    expect(checkAllowed(at('2026-10-05T03:00:00Z'), zone, WEEKDAYS)).toEqual({ allowed: true });
    expect(checkAllowed(at('2026-10-05T11:59:59Z'), zone, WEEKDAYS)).toEqual({ allowed: true });
    expect(checkAllowed(at('2026-10-05T12:00:00Z'), zone, WEEKDAYS)).toEqual({ allowed: false, reason: 'outside-hours' });
  });

  it('judges the weekday in the contact’s zone, not UTC', () => {
    // 03:00 UTC on Monday 2026-10-05 is Monday 09:00 in Dhaka (allowed) but still Sunday 23:00 in New York
    expect(checkAllowed(at('2026-10-05T03:00:00Z'), 'Asia/Dhaka', WEEKDAYS)).toEqual({ allowed: true });
    expect(checkAllowed(at('2026-10-05T03:00:00Z'), 'America/New_York', WEEKDAYS)).toEqual({ allowed: false, reason: 'day-not-allowed' });
    expect(checkAllowed(at('2026-10-04T10:00:00Z'), 'Asia/Dhaka', WEEKDAYS)).toEqual({ allowed: false, reason: 'day-not-allowed' });
  });

  it('applies start and end dates as local dates, inclusive', () => {
    expect(checkAllowed(at('2026-10-01T04:00:00Z'), 'Asia/Dhaka', WEEKDAYS)).toEqual({ allowed: true }); // Thu 10:00 Dhaka, first day
    expect(checkAllowed(at('2026-09-30T14:00:00Z'), 'Asia/Dhaka', WEEKDAYS)).toEqual({ allowed: false, reason: 'before-start-date' });
    // Last day: Saturday 31 Oct is not allowed, so use a schedule ending on a Friday
    const ends: Schedule = { ...WEEKDAYS, endDate: '2026-10-30' };
    expect(checkAllowed(at('2026-10-30T11:59:00Z'), 'Asia/Dhaka', ends)).toEqual({ allowed: true });
    expect(checkAllowed(at('2026-10-31T03:00:00Z'), 'Asia/Dhaka', ends)).toEqual({ allowed: false, reason: 'after-end-date' });
    // 2026-10-30 23:00 in New York is already 31 Oct in UTC and Dhaka, but still the end date there (and outside hours)
    expect(checkAllowed(at('2026-10-30T22:30:00Z'), 'America/New_York', { ...ends, windowEnd: '18:00' })).toEqual({ allowed: false, reason: 'outside-hours' });
  });

  it('never exceeds the platform hours, whatever the campaign asks for', () => {
    const night: Schedule = { ...WEEKDAYS, windowStart: '00:00', windowEnd: '23:59' };
    expect(effectiveWindow(night)).toEqual({ start: 8 * 60, end: 21 * 60 });
    expect(checkAllowed(at('2026-10-05T01:30:00Z'), 'Asia/Dhaka', night)).toEqual({ allowed: false, reason: 'outside-hours' }); // 07:30 local
    expect(checkAllowed(at('2026-10-05T02:00:00Z'), 'Asia/Dhaka', night)).toEqual({ allowed: true }); // 08:00 local
    expect(checkAllowed(at('2026-10-05T14:59:00Z'), 'Asia/Dhaka', night)).toEqual({ allowed: true }); // 20:59 local
    expect(checkAllowed(at('2026-10-05T15:00:00Z'), 'Asia/Dhaka', night)).toEqual({ allowed: false, reason: 'outside-hours' }); // 21:00 local
    // A configurable cap
    expect(checkAllowed(at('2026-10-05T14:00:00Z'), 'Asia/Dhaka', night, { start: '10:00', end: '20:00' })).toEqual({ allowed: false, reason: 'outside-hours' });
  });

  it('follows daylight saving: 09:00 New York is 13:00 UTC before the change and 14:00 after', () => {
    const schedule: Schedule = { ...WEEKDAYS, startDate: '2026-10-01', endDate: '2026-11-30' };
    expect(checkAllowed(at('2026-10-30T12:59:00Z'), 'America/New_York', schedule)).toEqual({ allowed: false, reason: 'outside-hours' });
    expect(checkAllowed(at('2026-10-30T13:00:00Z'), 'America/New_York', schedule)).toEqual({ allowed: true });
    expect(checkAllowed(at('2026-11-02T13:00:00Z'), 'America/New_York', schedule)).toEqual({ allowed: false, reason: 'outside-hours' });
    expect(checkAllowed(at('2026-11-02T14:00:00Z'), 'America/New_York', schedule)).toEqual({ allowed: true });
  });
});

describe('nextAllowedAt', () => {
  it('returns now when allowed', () => {
    const now = at('2026-10-05T05:00:00Z');
    expect(nextAllowedAt(now, 'Asia/Dhaka', WEEKDAYS)).toBe(now);
  });

  it('waits for today’s window, tomorrow’s, or Monday', () => {
    expect(nextAllowedAt(at('2026-10-05T01:00:00Z'), 'Asia/Dhaka', WEEKDAYS)?.toISOString()).toBe('2026-10-05T03:00:00.000Z'); // Mon 07:00 → 09:00
    expect(nextAllowedAt(at('2026-10-05T13:00:00Z'), 'Asia/Dhaka', WEEKDAYS)?.toISOString()).toBe('2026-10-06T03:00:00.000Z'); // Mon 19:00 → Tue 09:00
    expect(nextAllowedAt(at('2026-10-09T13:00:00Z'), 'Asia/Dhaka', WEEKDAYS)?.toISOString()).toBe('2026-10-12T03:00:00.000Z'); // Fri 19:00 → Mon
    expect(nextAllowedAt(at('2026-09-01T00:00:00Z'), 'Asia/Dhaka', WEEKDAYS)?.toISOString()).toBe('2026-10-01T03:00:00.000Z'); // before the start date
  });

  it('uses the contact’s zone for the next opening', () => {
    // Monday 14:00 UTC = 10:00 New York (inside), and 20:00 Dhaka (outside, next opening Tuesday)
    const instant = at('2026-10-05T14:00:00Z');
    expect(nextAllowedAt(instant, 'America/New_York', WEEKDAYS)).toBe(instant);
    expect(nextAllowedAt(instant, 'Asia/Dhaka', WEEKDAYS)?.toISOString()).toBe('2026-10-06T03:00:00.000Z');
  });

  it('is null once the schedule is over or can never match', () => {
    expect(nextAllowedAt(at('2026-10-31T12:00:00Z'), 'Asia/Dhaka', { ...WEEKDAYS, endDate: '2026-10-30' })).toBeNull();
    expect(nextAllowedAt(at('2026-10-05T00:00:00Z'), 'Asia/Dhaka', { ...WEEKDAYS, windowStart: '21:00', windowEnd: '22:00' })).toBeNull();
    expect(nextAllowedAt(at('2026-10-05T00:00:00Z'), 'Asia/Dhaka', { ...WEEKDAYS, allowedDays: [] })).toBeNull();
  });

  it('crosses a daylight saving change', () => {
    const schedule: Schedule = { ...WEEKDAYS, startDate: '2026-10-01', endDate: '2026-11-30' };
    // Friday evening in New York 30 Oct, next opening Monday 2 Nov 09:00 EST = 14:00 UTC
    expect(nextAllowedAt(at('2026-10-31T01:00:00Z'), 'America/New_York', schedule)?.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('agrees with checkAllowed at the returned instant, one minute before, and for several zones', () => {
    for (const zone of ['Asia/Dhaka', 'America/New_York', 'Pacific/Auckland', 'Asia/Kathmandu', 'Europe/London']) {
      for (let hours = 0; hours < 24 * 9; hours += 5) {
        const from = new Date(Date.UTC(2026, 9, 3, 0, 17) + hours * 3_600_000);
        const next = nextAllowedAt(from, zone, WEEKDAYS);
        if (!next) continue;
        expect(checkAllowed(next, zone, WEEKDAYS).allowed, `${zone} from ${from.toISOString()} → ${next.toISOString()}`).toBe(true);
        if (next.getTime() > from.getTime()) expect(checkAllowed(new Date(next.getTime() - 60_000), zone, WEEKDAYS).allowed, `${zone} one minute before`).toBe(false);
      }
    }
  });
});

describe('validation and campaign end', () => {
  it('lists every problem with a schedule', () => {
    expect(validateSchedule(WEEKDAYS)).toEqual([]);
    const issues = validateSchedule({ startDate: '2026-02-30', endDate: '2026-01-01', allowedDays: [0, 8], windowStart: '18:00', windowEnd: '09:00' }).map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining(['schedule.startDate', 'schedule.allowedDays', 'schedule.windowEnd']));
    expect(validateSchedule({ ...WEEKDAYS, allowedDays: [] }).map((i) => i.path)).toEqual(['schedule.allowedDays']);
    expect(validateSchedule({ ...WEEKDAYS, windowStart: '21:30', windowEnd: '23:00' })[0].message).toMatch(/overlap the platform calling hours/);
    expect(validateSchedule({ ...WEEKDAYS, endDate: '2026-09-01' })[0].path).toBe('schedule.endDate');
  });

  it('ends a campaign only when no zone can still be on its end date', () => {
    expect(scheduleEnded(at('2026-10-31T23:00:00Z'), '2026-10-31')).toBe(false);
    expect(scheduleEnded(at('2026-11-01T11:59:00Z'), '2026-10-31')).toBe(false); // UTC-12 is still on the 31st
    expect(scheduleEnded(at('2026-11-01T12:00:00Z'), '2026-10-31')).toBe(true);
  });
});

describe('numbers and time zones', () => {
  it('normalizes spreadsheet formatting and Bangladesh national numbers', () => {
    expect(normalizeNumber('+880 1712-345678')).toEqual({ number: '+8801712345678' });
    expect(normalizeNumber('008801712345678')).toEqual({ number: '+8801712345678' });
    expect(normalizeNumber('(+1) 415.555.0100')).toEqual({ number: '+14155550100' });
    expect(normalizeNumber('01712345678', 'BD')).toEqual({ number: '+8801712345678' });
    expect(normalizeNumber('8801712345678', 'BD')).toEqual({ number: '+8801712345678' });
    expect(normalizeNumber('01712345678')).toMatchObject({ error: expect.stringContaining('defaultCountry') });
    expect(normalizeNumber('+0123456789')).toHaveProperty('error');
    expect(normalizeNumber('+88017')).toHaveProperty('error');
    expect(normalizeNumber('   ')).toHaveProperty('error');
    expect(normalizeNumber('+8801712345678abc')).toHaveProperty('error');
  });

  it('derives zones only for single-zone countries', () => {
    expect(timeZoneForNumber('+8801712345678')).toBe('Asia/Dhaka');
    expect(timeZoneForNumber('+9779812345678')).toBe('Asia/Kathmandu');
    expect(timeZoneForNumber('+441234567890')).toBe('Europe/London');
    expect(timeZoneForNumber('+14155550100')).toBeNull();
    expect(timeZoneForNumber('+61412345678')).toBeNull();
  });
});

describe('CSV import', () => {
  const base = { defaultTimeZone: 'Asia/Dhaka', maxRows: 100 };

  it('validates, dedupes and reports bad rows, with variables from columns', () => {
    const csv = [
      'Phone,Name,City,Timezone',
      '+8801712345678,Ada,Dhaka,',
      '"+880 1812-345678","Rahman, Karim",Chattogram,Asia/Dhaka',
      '+8801712345678,Ada again,Dhaka,', // duplicate of row 2
      '01912345678,Local format,Dhaka,', // not E.164
      '+8801612345678,Nobody,Dhaka,Mars/Olympus', // bad zone
      '+8801512345678,NY contact,New York,America/New_York',
      ',empty,,',
      '+441234567890,Londoner,London,',
    ].join('\r\n');
    const result = parseContactCsv(csv, base);
    expect(result.totalRows).toBe(8);
    expect(result.contacts.map((c) => [c.e164, c.name, c.timeZone])).toEqual([
      ['+8801712345678', 'Ada', 'Asia/Dhaka'],
      ['+8801812345678', 'Rahman, Karim', 'Asia/Dhaka'],
      ['+8801512345678', 'NY contact', 'America/New_York'],
      ['+441234567890', 'Londoner', 'Europe/London'],
    ]);
    expect(result.contacts[1].variables).toEqual({ City: 'Chattogram', customer_name: 'Rahman, Karim' });
    expect(result.rejected).toEqual([
      { row: 4, value: '+8801712345678', reason: 'Duplicate of row 2' },
      { row: 5, value: '01912345678', reason: expect.stringContaining('E.164') },
      { row: 6, value: '+8801612345678', reason: expect.stringContaining('Mars/Olympus') },
      { row: 8, value: '', reason: 'The phone number is empty' },
    ]);
  });

  it('maps columns to {{variables}} and applies the default country', () => {
    const result = parseContactCsv('Mobile,Customer,Plan\n01712345678,Ada,Gold', { ...base, defaultCountry: 'BD', mapping: { phone: 'Mobile', variables: { customer_name: 'Customer', plan_name: 'Plan' } } });
    expect(result.contacts[0]).toMatchObject({ e164: '+8801712345678', variables: { customer_name: 'Ada', plan_name: 'Gold' } });
    expect(result.rejected).toEqual([]);
  });

  it('rejects rows missing variables the assistant needs, unless it has defaults', () => {
    const csv = 'phone,customer_name\n+8801712345678,Ada\n+8801812345678,';
    const strict = parseContactCsv(csv, { ...base, requiredFields: { firstMessage: 'Hello {{customer_name}}, about {{order_id}}' } });
    expect(strict.contacts).toHaveLength(0);
    expect(strict.rejected.map((r) => r.reason)).toEqual([expect.stringContaining('{{order_id}}'), expect.stringContaining('{{customer_name}}')]);
    const lenient = parseContactCsv(csv, { ...base, requiredFields: { firstMessage: 'Hello {{customer_name}}' }, variableDefaults: { customer_name: 'there' } });
    expect(lenient.contacts).toHaveLength(2);
  });

  it('handles quoted newlines, a BOM, blank lines, and refuses unusable files', () => {
    const result = parseContactCsv('﻿phone,note\n+8801712345678,"line one\nline two"\n\n', base);
    expect(result.contacts[0].variables.note).toBe('line one\nline two');
    expect(() => parseContactCsv('', base)).toThrow(/empty/);
    expect(() => parseContactCsv('name\nAda', base)).toThrow(/No phone column/);
    expect(() => parseContactCsv('phone\n+8801712345678', { ...base, mapping: { phone: 'tel' } })).toThrow(/"tel"/);
    expect(() => parseContactCsv('phone\n+8801712345678', { ...base, mapping: { variables: { 'bad name': 'phone' } } })).toThrow(/not a valid variable name/);
    expect(() => parseContactCsv('phone\n+8801712345678\n+8801812345678', { ...base, maxRows: 1 })).toThrow(/limit is 1/);
  });

  it('escapes spreadsheet formulas when exporting', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+8801712345678', { raw: true })).toBe('+8801712345678');
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('plain, with comma')).toBe('"plain, with comma"');
    expect(csvCell(null)).toBe('');
  });
});
