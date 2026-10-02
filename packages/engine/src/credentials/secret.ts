/**
 * A secret value that cannot leak by accident: JSON.stringify, String(), template literals and
 * util.inspect (console.log, loggers) all print "[REDACTED]". Use reveal() at the point of use.
 */
import { inspect } from 'node:util';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return 'Secret([REDACTED])';
  }
}

/**
 * Masked form for display: last 4 characters, never more than a quarter of the secret.
 * Short secrets show no characters at all.
 */
export function maskSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < 16) return '••••';
  const visible = Math.min(4, Math.floor(value.length / 4));
  return `••••${value.slice(-visible)}`;
}
