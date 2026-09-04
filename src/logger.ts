/** Minimal pino-compatible logger so baileys can log without the pino dependency tree. */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

export interface BaileysLogger {
  level: string;
  trace: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  debug: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  info: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  warn: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  error: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  fatal: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => BaileysLogger;
}

export function createWorkerLogger(label: string, level: LogLevel = 'info'): BaileysLogger {
  const make =
    (lvl: LogLevel) =>
    (obj: unknown, msg?: string, ...args: unknown[]): void => {
      if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
      const message = typeof obj === 'string' ? obj : msg ?? '';
      const extra = typeof obj === 'string' || obj === undefined ? '' : ` ${JSON.stringify(obj)}`;
      // eslint-disable-next-line no-console
      console.log(`${lvl.toUpperCase()} [${label}]${message ? ` ${message}` : ''}${extra}`, ...args);
    };

  return {
    level,
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    child: bindings =>
      createWorkerLogger(`${label} ${JSON.stringify(bindings)}`, level),
  };
}