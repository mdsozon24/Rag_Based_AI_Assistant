/**
 * Wire-format fixtures per vendor. They follow each vendor's documented message shapes
 * (checked against the docs on 2026-10-01); they are hand-assembled, not captured from live
 * traffic, because no Deepgram/OpenAI/Cartesia keys were available. Replace with real captures
 * when keys exist (see docs/PROGRESS.md).
 */

/** Every transcriber harness recognizes this utterance. */
export const UTTERANCE = { partial: 'hello', final: 'hello world' };

// ElevenLabs Scribe v2 Realtime (server -> client JSON)
export const SCRIBE = {
  sessionStarted: { message_type: 'session_started', session_id: 'sess_1', config: {} },
  partial: { message_type: 'partial_transcript', text: UTTERANCE.partial },
  committed: { message_type: 'committed_transcript', text: UTTERANCE.final },
  authError: { message_type: 'auth_error', error: 'Invalid API key' },
};

// Deepgram /v1/listen Results messages
function deepgramResults(transcript: string, flags: { is_final: boolean; from_finalize?: boolean }) {
  return {
    type: 'Results',
    channel_index: [0, 1],
    duration: 0.5,
    start: 0,
    is_final: flags.is_final,
    speech_final: false,
    ...(flags.from_finalize ? { from_finalize: true } : {}),
    channel: { alternatives: [{ transcript, confidence: 0.98, words: [] }] },
    metadata: { request_id: 'req_1', model_info: { name: 'general-nova-3', version: '2026', arch: 'nova-3' } },
  };
}
export const DEEPGRAM = {
  interim: deepgramResults(UTTERANCE.partial, { is_final: false }),
  finalPart: deepgramResults('hello', { is_final: true }),
  finalizeResult: deepgramResults('world', { is_final: true, from_finalize: true }),
};

// OpenAI Chat Completions SSE
const oaiChunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
export const MODEL_TEXT = 'Hello there! How can I help?';
export const OPENAI_TEXT_STREAM = [
  oaiChunk({ role: 'assistant', content: '' }),
  oaiChunk({ content: 'Hello there!' }),
  // A chunk split mid-event, as TCP may deliver it
  oaiChunk({ content: ' How can' }).slice(0, 30),
  oaiChunk({ content: ' How can' }).slice(30),
  oaiChunk({ content: ' I help?' }),
  oaiChunk({}, 'stop'),
  `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 } })}\n\n`,
  'data: [DONE]\n\n',
];
export const OPENAI_TOOL_STREAM = [
  oaiChunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'endCall', arguments: '' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"reas' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: 'on":"done"}' } }] }),
  oaiChunk({}, 'tool_calls'),
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`,
  'data: [DONE]\n\n',
];

// Gemini generateContentStream chunks
export const GEMINI_TEXT_STREAM = [
  { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking about it', thought: true }, { text: 'Hello there!' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: ' How can I help?' }] } }], usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 9, totalTokenCount: 51 } },
];
export const GEMINI_TOOL_STREAM = [
  { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'fc_1', name: 'endCall', args: { reason: 'done' } } }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 } },
];

/** 100 ms of 24 kHz PCM16 audio (4800 bytes), split into odd-sized network chunks. */
export function pcmFixture(): { chunks: Uint8Array[]; totalBytes: number } {
  const bytes = new Uint8Array(4800);
  for (let i = 0; i < bytes.length; i += 2) {
    const v = Math.round(5000 * Math.sin((2 * Math.PI * 440 * (i / 2)) / 24000)) & 0xffff;
    bytes[i] = v & 0xff;
    bytes[i + 1] = v >> 8;
  }
  const sizes = [1, 999, 1801, 1999];
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (const size of sizes) {
    chunks.push(bytes.slice(at, at + size));
    at += size;
  }
  return { chunks, totalBytes: bytes.length };
}
