import process from 'node:process';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogMeta = Record<string, unknown>;

/** 极简结构化日志接口，输出单行 JSON，方便被采集器解析。 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** 派生子 logger，会在日志里附加 `scope` 字段。 */
  child(scope: string): Logger;
}

export function createLogger(options: { level: LogLevel; scope?: string }): Logger {
  return new ConsoleLogger(options.level, options.scope);
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope?: string,
  ) {}

  child(scope: string): Logger {
    return new ConsoleLogger(this.level, this.scope ? `${this.scope}.${scope}` : scope);
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void {
    if (this.level === 'silent' || LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const entry: LogMeta = {
      time: new Date().toISOString(),
      level,
      ...(this.scope ? { scope: this.scope } : {}),
      message,
    };

    for (const [key, value] of Object.entries(meta ?? {})) {
      entry[key] = serialize(value);
    }

    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'warn' || level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }
}

/** Error 用 JSON.stringify 会丢掉 message/stack，这里显式展开。 */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  return value;
}
