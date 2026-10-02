/** Why a call ended. Recorded on every call; values are stable strings for storage and webhooks. */
export enum EndReason {
  CustomerHungUp = 'customer-hung-up',
  AssistantEnded = 'assistant-ended',
  SilenceTimeout = 'silence-timeout',
  MaxDuration = 'max-duration',
  ErrorStt = 'error-stt',
  ErrorLlm = 'error-llm',
  ErrorTts = 'error-tts',
  Transferred = 'transferred',
  /** The person asked not to be called again (campaign calls). */
  OptOut = 'opted-out',
  /** Ended through the control API (POST /v1/calls/{id}/end). */
  ApiEnded = 'api-ended',
  /** The server shut down while the call was live. */
  ServerShutdown = 'server-shutdown',
  /** A bug or an unexpected exception inside the engine itself (not a provider failure). */
  ErrorInternal = 'error-internal',
}

export type ProviderStage = 'stt' | 'llm' | 'tts';

export function errorEndReason(stage: ProviderStage): EndReason {
  return stage === 'stt' ? EndReason.ErrorStt : stage === 'llm' ? EndReason.ErrorLlm : EndReason.ErrorTts;
}
