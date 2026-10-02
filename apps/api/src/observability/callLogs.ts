/**
 * Log lines of one call, correlated by call_id.
 *
 * A call's engine logs already go to stdout as JSON with call_id and org_id. This wraps the logger a
 * call uses so the same lines (info and above) are also kept in the call's debug timeline, where the
 * org can read them next to the events they explain. Stored lines are sanitised first: only simple
 * values are kept, values under keys that usually hold what was said or sent (text, args, content...)
 * are dropped, and error messages are scrubbed of secrets.
 */
import type { Logger } from '../../../../packages/engine/src/logger.ts';
import { scrubText } from './errors.ts';

export interface CallLogLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, string | number | boolean | null>;
}

/** Keys whose values are conversation or payload content: never stored in the timeline. */
const CONTENT_KEYS = new Set(['text', 'args', 'content', 'body', 'message', 'transcript', 'prompt', 'systemPrompt', 'heardText', 'response', 'request']);
const MAX_FIELDS = 12;
const MAX_VALUE = 200;

export function sanitizeFields(fields: Record<string, unknown>): CallLogLine['fields'] {
  const out: CallLogLine['fields'] = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Object.keys(out).length >= MAX_FIELDS) break;
    if (CONTENT_KEYS.has(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value as number | boolean | null;
    else if (typeof value === 'string') out[key] = scrubText(value).slice(0, MAX_VALUE);
    else if (value instanceof Error) out[key] = scrubText(`${value.name}: ${value.message}`).slice(0, MAX_VALUE);
  }
  return out;
}

/** A logger that passes everything to `base` and also hands info, warn and error lines to `sink`. */
export function teeLogger(base: Logger, sink: (line: CallLogLine) => void, bound: Record<string, unknown> = {}): Logger {
  const tee = (level: CallLogLine['level']) => (fields: Record<string, unknown>, msg: string) => {
    base[level](fields, msg);
    try {
      sink({ level, msg: msg.slice(0, 200), fields: sanitizeFields({ ...bound, ...fields }) });
    } catch {
      // keeping a copy must never break the call
    }
  };
  return {
    debug: (fields, msg) => base.debug(fields, msg),
    info: tee('info'),
    warn: tee('warn'),
    error: tee('error'),
    child: (bindings) => teeLogger(base.child(bindings), sink, { ...bound, ...bindings }),
  };
}
