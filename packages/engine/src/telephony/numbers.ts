import { z } from 'zod';

export const e164Schema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Must be an E.164 number, for example +8801712345678');
export const bangladeshE164Schema = z.string().regex(/^\+880[1-9][0-9]{8,9}$/, 'Must be a Bangladesh E.164 number, for example +8801712345678');

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && e164Schema.safeParse(value).success;
}

export function countryFromE164(value: string): string {
  if (value.startsWith('+880')) return 'BD';
  if (value.startsWith('+1')) return 'US';
  if (value.startsWith('+44')) return 'GB';
  return 'ZZ';
}