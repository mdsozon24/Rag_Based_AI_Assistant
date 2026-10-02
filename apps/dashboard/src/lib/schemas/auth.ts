/**
 * Client-side rules for the auth forms, the same as the API's (apps/api/src/routes/auth.ts,
 * apps/api/src/auth/crypto.ts). Checked by apps/api/test/dashboardParity.test.ts.
 */
import { z } from 'zod';

export const email = z.string().trim().toLowerCase().min(1, 'Enter your email address').email('Enter a valid email address').max(254, 'At most 254 characters');
export const password = z.string().min(10, 'Password must be at least 10 characters').max(200, 'Password must be at most 200 characters');
export const personName = z.string().trim().min(1, 'Enter your name').max(100, 'At most 100 characters');
export const orgName = z.string().trim().min(1, 'Enter a name').max(100, 'At most 100 characters');

export const signupSchema = z.object({ name: personName, email, password, orgName: orgName.optional() });
export const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password').max(200) });
export const emailOnlySchema = z.object({ email });
export const resetSchema = z
  .object({ password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });
export const createOrgSchema = z.object({ name: orgName });
