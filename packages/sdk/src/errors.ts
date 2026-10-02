/**
 * Every failure the SDK reports is an OctoVoiceError with a stable `code`, so apps can show their
 * own text. `message` is a readable English default.
 */
export type OctoVoiceErrorCode =
  | 'mic-permission-denied'
  | 'mic-not-found'
  | 'mic-in-use'
  | 'mic-unsupported'
  | 'invalid-key'
  | 'origin-not-allowed'
  | 'assistant-not-allowed'
  | 'override-not-allowed'
  | 'rate-limited'
  | 'concurrency-limit'
  | 'server-busy'
  | 'call-expired'
  | 'invalid-request'
  | 'network'
  | 'connection-lost'
  | 'not-active'
  | 'server-error';

export class OctoVoiceError extends Error {
  readonly name = 'OctoVoiceError';
  constructor(
    readonly code: OctoVoiceErrorCode,
    message: string,
    readonly details: { status?: number; apiCode?: string; closeCode?: number; requestId?: string; cause?: unknown } = {}
  ) {
    super(message);
  }
}

/** getUserMedia failure → a clear, actionable error. */
export function micError(error: unknown): OctoVoiceError {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new OctoVoiceError('mic-permission-denied', 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.', { cause: error });
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return new OctoVoiceError('mic-not-found', 'No microphone was found. Connect a microphone and try again.', { cause: error });
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new OctoVoiceError('mic-in-use', 'The microphone could not be started. Another app may be using it.', { cause: error });
  }
  return new OctoVoiceError('mic-unsupported', 'The microphone is not available in this browser.', { cause: error });
}

/** HTTP error from POST /v1/calls → error. */
export function apiError(status: number, body: { code?: string; message?: string } | null, requestId?: string): OctoVoiceError {
  const details = { status, apiCode: body?.code, requestId };
  switch (body?.code) {
    case 'invalid_api_key':
      return new OctoVoiceError('invalid-key', 'The public key is invalid, revoked or expired.', details);
    case 'origin_not_allowed':
      return new OctoVoiceError('origin-not-allowed', `This website (${typeof location !== 'undefined' ? location.origin : 'this origin'}) is not in the public key's allowed origins.`, details);
    case 'forbidden_key_type':
      return new OctoVoiceError('invalid-key', body.message ?? 'This key cannot start browser calls.', details);
    case 'forbidden':
      return /override/i.test(body.message ?? '')
        ? new OctoVoiceError('override-not-allowed', body.message ?? 'These overrides need a call created by your server.', details)
        : new OctoVoiceError('assistant-not-allowed', 'This public key may not be used for this assistant.', details);
    case 'rate_limited':
      return new OctoVoiceError('rate-limited', 'Too many calls were started; wait a moment and try again.', details);
    case 'validation_error':
    case 'bad_request':
    case 'not_found':
    case 'conflict':
      return new OctoVoiceError('invalid-request', body.message ?? 'The call request was rejected.', details);
    default:
      return new OctoVoiceError('server-error', body?.message ?? `The voice service answered HTTP ${status}.`, details);
  }
}

/** Media socket close code (see apps/api/src/voice/webCalls.ts CLOSE) → error; null for normal closes. */
export function closeError(code: number, reason: string): OctoVoiceError | null {
  const details = { closeCode: code, apiCode: reason || undefined };
  switch (code) {
    case 1000:
      return null;
    case 4401:
      return reason === 'token_expired'
        ? new OctoVoiceError('call-expired', 'The call was not connected in time; start it again.', details)
        : new OctoVoiceError('invalid-request', 'The call token is invalid or was already used.', details);
    case 4403:
      return reason === 'org_suspended'
        ? new OctoVoiceError('server-error', 'This voice service account is suspended.', details)
        : new OctoVoiceError('origin-not-allowed', 'This website is not allowed to connect to this call.', details);
    case 4409:
      return new OctoVoiceError('connection-lost', 'The connection was lost and the call could not be resumed.', details);
    case 4429:
      return new OctoVoiceError('concurrency-limit', 'Too many calls are in progress right now; try again shortly.', details);
    case 4503:
      return new OctoVoiceError('server-busy', 'The voice service is busy; try again shortly.', details);
    case 4400:
    case 4408:
      return new OctoVoiceError('invalid-request', 'The voice connection handshake failed.', details);
    default:
      // 1001-3999: the network or a proxy dropped the connection (1006 = no close frame at all)
      return code < 4000
        ? new OctoVoiceError('network', 'Could not reach the voice service. Check your connection and try again.', details)
        : new OctoVoiceError('server-error', 'The voice service closed the connection unexpectedly.', details);
  }
}
