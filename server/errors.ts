/**
 * Turns Gemini, ElevenLabs and network errors into short messages for the user.
 */

export const NO_API_KEY_MESSAGE = 'GEMINI_API_KEY is not set on the server. Add it to the .env file and restart the server.';

const BILLING_MESSAGE =
  'The Gemini account is out of credits, so the AI cannot answer right now. ' +
  'Add credits in AI Studio (https://ai.studio/projects) or put a new GEMINI_API_KEY in the .env file.';
const INVALID_KEY_MESSAGE = 'The Gemini API key is invalid or not permitted. Put a valid GEMINI_API_KEY in the .env file and restart the server.';
const RATE_LIMIT_MESSAGE = 'Request limit reached. Please try again in a little while.';
const BUSY_MESSAGE = 'The model is busy right now. Please try again in a few seconds.';
const NETWORK_MESSAGE = 'Network problem. Check your internet connection and try again.';

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const err = error as any;
  return `${err?.status ?? ''} ${err?.code ?? ''} ${err?.message ?? ''} ${err?.cause?.code ?? ''}`;
}

function isBillingError(text: string): boolean {
  return /prepayment|credits are depleted|billing|\b402\b/i.test(text);
}

function isInvalidKeyError(text: string): boolean {
  return /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|\b401\b|\b403\b/i.test(text);
}

/** Billing and API key problems fail the same way on every retry, so there is no point reconnecting. */
export function isFatalAiError(error: unknown): boolean {
  const text = errorText(error);
  return isBillingError(text) || isInvalidKeyError(text);
}

/** A readable message for a known error, or the fallback (which may be '') for anything else. */
export function toFriendlyError(error: unknown, fallback = 'The request could not be completed. Please try again.'): string {
  const text = errorText(error);
  if (isBillingError(text)) return BILLING_MESSAGE;
  if (isInvalidKeyError(text)) return INVALID_KEY_MESSAGE;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(text)) return RATE_LIMIT_MESSAGE;
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(text)) return BUSY_MESSAGE;
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(text)) return NETWORK_MESSAGE;
  return fallback;
}
