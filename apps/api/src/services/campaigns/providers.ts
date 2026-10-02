/**
 * Telephony providers whose adapter is real: it places real calls and verifies the provider's
 * signature. The other adapters (SIP, Telnyx, Vonage) are deterministic stand-ins until their
 * account-specific wire code exists; their "signature check" accepts everything and their dials
 * place no call. In production campaigns therefore refuse to dial through them and refuse their
 * call-progress callbacks, instead of pretending (or being forged).
 */
import type { TelephonyProvider } from '../../../../../packages/engine/src/telephony/types.ts';

export const LIVE_PROVIDERS: ReadonlySet<TelephonyProvider> = new Set<TelephonyProvider>(['twilio']);

export function providerUsable(env: string, provider: TelephonyProvider): boolean {
  return env !== 'production' || LIVE_PROVIDERS.has(provider);
}
