/**
 * Contact list handling: CSV parsing, number normalization, time zone defaults, and row validation
 * with a report of every rejected row.
 */
import { requiredVariables, VARIABLE_NAME } from '../../../../../packages/engine/src/assistant/variables.ts';
import { isValidTimeZone } from './schedule.ts';

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Single-time-zone countries by calling code (longest prefix wins). Others use the campaign default. */
const ZONE_BY_PREFIX: Record<string, string> = {
  '880': 'Asia/Dhaka', '91': 'Asia/Kolkata', '92': 'Asia/Karachi', '94': 'Asia/Colombo', '977': 'Asia/Kathmandu', '975': 'Asia/Thimphu',
  '960': 'Indian/Maldives', '971': 'Asia/Dubai', '966': 'Asia/Riyadh', '974': 'Asia/Qatar', '965': 'Asia/Kuwait', '968': 'Asia/Muscat',
  '65': 'Asia/Singapore', '60': 'Asia/Kuala_Lumpur', '66': 'Asia/Bangkok', '84': 'Asia/Ho_Chi_Minh', '63': 'Asia/Manila', '81': 'Asia/Tokyo',
  '82': 'Asia/Seoul', '86': 'Asia/Shanghai', '44': 'Europe/London', '49': 'Europe/Berlin', '33': 'Europe/Paris', '39': 'Europe/Rome',
  '34': 'Europe/Madrid', '31': 'Europe/Amsterdam', '90': 'Europe/Istanbul', '20': 'Africa/Cairo', '234': 'Africa/Lagos', '254': 'Africa/Nairobi',
  '27': 'Africa/Johannesburg',
};

export function timeZoneForNumber(e164: string): string | null {
  const digits = e164.slice(1);
  for (const length of [3, 2]) {
    const zone = ZONE_BY_PREFIX[digits.slice(0, length)];
    if (zone) return zone;
  }
  return null;
}

/**
 * E.164 from what people put in spreadsheets: spaces, dashes, dots and brackets are removed, and "00"
 * becomes "+". With defaultCountry "BD", Bangladesh national numbers (01712345678, 8801712345678)
 * are accepted too. Anything else must already be a valid E.164 number.
 */
export function normalizeNumber(raw: string, defaultCountry?: string): { number: string } | { error: string } {
  let value = raw.trim().replace(/[\s\-.()]/g, '');
  if (!value) return { error: 'The phone number is empty' };
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (defaultCountry === 'BD') {
    if (/^01[3-9]\d{8}$/.test(value)) value = `+88${value}`;
    else if (/^8801[3-9]\d{8}$/.test(value)) value = `+${value}`;
  }
  if (!E164.test(value)) {
    return { error: value.startsWith('+') ? 'Not a valid E.164 number (+ then 8 to 15 digits, for example +8801712345678)' : 'Not an E.164 number: it must start with + and the country code (or set defaultCountry to BD for numbers like 01712345678)' };
  }
  return { number: value };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export interface ColumnMapping {
  /** Column holding the phone number (default: phone, number, mobile, msisdn or e164). */
  phone?: string;
  name?: string;
  timezone?: string;
  /** {{variable}} name → CSV column. Unmapped columns become variables named after the column. */
  variables?: Record<string, string>;
}

export interface ImportOptions {
  mapping?: ColumnMapping;
  defaultCountry?: string;
  /** Zone used when a row has none and the number's country has several or is unknown. */
  defaultTimeZone: string;
  /** Variables the assistant needs and cannot default (rows without them are rejected). */
  requiredFields?: { firstMessage?: string; systemPrompt?: string };
  variableDefaults?: Record<string, string>;
  maxRows: number;
}

export interface ParsedContact {
  rowNumber: number;
  e164: string;
  name: string | null;
  timeZone: string;
  variables: Record<string, string>;
}

export interface RejectedRow {
  /** 1-based line in the file, counting the header as line 1. */
  row: number;
  value: string;
  reason: string;
}

export interface ParsedImport {
  contacts: ParsedContact[];
  rejected: RejectedRow[];
  /** Rows after the header (blank lines excluded). */
  totalRows: number;
}

const PHONE_HEADERS = ['phone', 'number', 'mobile', 'msisdn', 'e164', 'phone_number', 'phonenumber', 'mobile_number'];
const MAX_VALUE_CHARS = 1000;
const MAX_VARIABLES = 50;

export class CsvError extends Error {}

function slug(header: string): string {
  return header.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 64);
}

export function parseContactCsv(csv: string, options: ImportOptions): ParsedImport {
  const table = parseCsv(csv);
  if (table.length === 0) throw new CsvError('The file is empty');
  const header = table[0].map((cell) => cell.trim());
  const find = (name: string | undefined, fallbacks: string[]): number => {
    const wanted = (name ? [name] : fallbacks).map((n) => n.toLowerCase());
    return header.findIndex((cell) => wanted.includes(cell.toLowerCase()));
  };
  const phoneColumn = find(options.mapping?.phone, PHONE_HEADERS);
  if (phoneColumn < 0) throw new CsvError(options.mapping?.phone ? `The phone column "${options.mapping.phone}" is not in the header (${header.join(', ')})` : `No phone column found. Name it one of ${PHONE_HEADERS.slice(0, 5).join(', ')}, or set mapping.phone`);
  const nameColumn = find(options.mapping?.name, ['name', 'full_name', 'customer_name']);
  const zoneColumn = find(options.mapping?.timezone, ['timezone', 'time_zone', 'tz']);

  // Variable → column index
  const variableColumns = new Map<string, number>();
  for (const [variable, column] of Object.entries(options.mapping?.variables ?? {})) {
    if (!VARIABLE_NAME.test(variable)) throw new CsvError(`"${variable}" is not a valid variable name (letters, digits and underscores, not starting with a digit)`);
    const index = header.findIndex((cell) => cell.toLowerCase() === column.toLowerCase());
    if (index < 0) throw new CsvError(`The column "${column}" mapped to {{${variable}}} is not in the header (${header.join(', ')})`);
    variableColumns.set(variable, index);
  }
  const claimed = new Set([phoneColumn, nameColumn, zoneColumn, ...variableColumns.values()]);
  header.forEach((cell, index) => {
    if (claimed.has(index) || !cell) return;
    const name = slug(cell);
    // Unmapped columns are variables under their own name, unless that name is taken or invalid
    if (VARIABLE_NAME.test(name) && !variableColumns.has(name)) variableColumns.set(name, index);
  });
  if (variableColumns.size > MAX_VARIABLES) throw new CsvError(`At most ${MAX_VARIABLES} variable columns`);
  if (!options.mapping?.variables?.customer_name && nameColumn >= 0 && !variableColumns.has('customer_name')) variableColumns.set('customer_name', nameColumn);

  const rows = table.slice(1);
  if (rows.length > options.maxRows) throw new CsvError(`The file has ${rows.length} rows; the limit is ${options.maxRows} per upload. Split it into several uploads.`);

  const contacts: ParsedContact[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  rows.forEach((cells, index) => {
    const row = index + 2;
    const raw = (cells[phoneColumn] ?? '').trim();
    const reject = (reason: string) => rejected.push({ row, value: raw, reason });
    const phone = normalizeNumber(raw, options.defaultCountry);
    if ('error' in phone) return reject(phone.error);
    const earlier = seen.get(phone.number);
    if (earlier !== undefined) return reject(`Duplicate of row ${earlier}`);

    let timeZone = zoneColumn >= 0 ? (cells[zoneColumn] ?? '').trim() : '';
    if (timeZone && !isValidTimeZone(timeZone)) return reject(`"${timeZone}" is not a time zone name (use IANA names like Asia/Dhaka)`);
    timeZone ||= timeZoneForNumber(phone.number) ?? options.defaultTimeZone;

    const variables: Record<string, string> = {};
    for (const [variable, column] of variableColumns) {
      const value = (cells[column] ?? '').trim();
      if (value.length > MAX_VALUE_CHARS) return reject(`The value for {{${variable}}} is longer than ${MAX_VALUE_CHARS} characters`);
      if (value) variables[variable] = value;
    }
    const missing = requiredVariables(options.requiredFields ?? {}, { ...(options.variableDefaults ?? {}), ...variables });
    if (missing.length) return reject(`Missing ${missing.map((m) => `{{${m.name}}}`).join(', ')} (the assistant needs ${missing.length === 1 ? 'it' : 'them'}; add a column or map one)`);

    seen.set(phone.number, row);
    const name = nameColumn >= 0 ? (cells[nameColumn] ?? '').trim().slice(0, 200) : '';
    contacts.push({ rowNumber: row, e164: phone.number, name: name || null, timeZone, variables });
  });
  return { contacts, rejected, totalRows: rows.length };
}

/** A CSV cell that cannot be run as a spreadsheet formula (OWASP CSV injection). */
export function csvCell(value: unknown, options: { raw?: boolean } = {}): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (!options.raw && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
