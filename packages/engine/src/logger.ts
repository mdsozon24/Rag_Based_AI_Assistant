/**
 * Minimal structured JSON logger. The call shape matches pino (`log.info({ ...fields }, 'msg')`,
 * `log.child({ call_id })`), so pino can replace it in Phase 1 without touching call sites.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50, silent: 100 };

export interface Logger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { type: value.name, message: value.message, ...(value.cause ? { cause: String(value.cause) } : {}) };
  return value;
}

export function createLogger(
  options: { level?: LogLevel; bindings?: Record<string, unknown>; sink?: LogSink } = {}
): Logger {
  const level = options.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) || 'info');
  const threshold = LEVELS[level] ?? LEVELS.info;
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));

  const write = (lvl: Exclude<LogLevel, 'silent'>, fields: Record<string, unknown>, msg: string) => {
    if (LEVELS[lvl] < threshold) return;
    const entry: Record<string, unknown> = { level: lvl, time: new Date().toISOString(), ...bindings };
    for (const [key, value] of Object.entries(fields)) entry[key] = key === 'err' ? serializeError(value) : value;
    entry.msg = msg;
    sink(JSON.stringify(entry));
  };

  return {
    debug: (fields, msg) => write('debug', fields, msg),
    info: (fields, msg) => write('info', fields, msg),
    warn: (fields, msg) => write('warn', fields, msg),
    error: (fields, msg) => write('error', fields, msg),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
