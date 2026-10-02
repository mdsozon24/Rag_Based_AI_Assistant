/**
 * Tokens, password hashing and API key formats.
 *
 * - Session, email and invitation tokens: 256 random bits, base64url; stored only as SHA-256.
 * - Passwords: argon2id (OWASP parameters: 19 MiB memory, 2 iterations, 1 lane).
 * - API keys: "sk_" (private) / "pk_" (public) + 256 random bits; stored only as SHA-256, with
 *   a short display prefix. A database leak does not reveal usable keys or sessions.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const newId = (): string => randomUUID();

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- passwords

// Algorithm defaults to argon2id (the const enum cannot be referenced with isolatedModules)
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(200, 'Password must be at most 200 characters');

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Verify against a throwaway hash so unknown emails take as long as wrong passwords. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(await dummyHash, password);
}

// ---------------------------------------------------------------- API keys

export type ApiKeyType = 'private' | 'public';

const KEY_PREFIX: Record<ApiKeyType, string> = { private: 'sk_', public: 'pk_' };
const KEY_PATTERN = /^(sk|pk)_[A-Za-z0-9_-]{43}$/;

export interface GeneratedKey {
  /** The full key: shown to the user once, never stored. */
  key: string;
  hash: string;
  /** Safe to show in listings, e.g. "sk_4fKx9a". */
  prefix: string;
}

export function generateApiKey(type: ApiKeyType): GeneratedKey {
  const key = KEY_PREFIX[type] + randomToken(32);
  return { key, hash: sha256(key), prefix: key.slice(0, 9) };
}

/** Type of a presented key, or null if it does not look like one of ours. */
export function apiKeyType(key: string): ApiKeyType | null {
  if (!KEY_PATTERN.test(key)) return null;
  return key.startsWith('sk_') ? 'private' : 'public';
}

export function maskedKey(prefix: string): string {
  return `${prefix}••••••••`;
}
