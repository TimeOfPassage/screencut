import { existsSync } from 'node:fs';
import process from 'node:process';

import { isLogLevel, LOG_LEVELS, type LogLevel } from './logger.js';

/**
 * playwright 支持的 channel：品牌浏览器 + 内置 chromium。
 * 名字必须与 playwright 注册表一致，否则启动时才报错。
 * 注意 `chromium-headless-shell` 需要 `playwright install --only-shell chromium`。
 */
export const BROWSER_CHANNELS = [
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'chromium',
  'chromium-headless-shell',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
] as const;

export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

export interface BrowserConfig {
  /** 直接指定浏览器可执行文件；显式配置后不再尝试其他方式。 */
  executablePath?: string;
  /** 使用已安装的 Chrome/Edge；显式配置后不再尝试其他方式。 */
  channel?: string;
  headless: boolean;
  /** false 时等价于传入 `--no-sandbox`，root 容器里需要。 */
  sandbox: boolean;
  args: string[];
  launchTimeoutMs: number;
  /** 空闲多少毫秒后关闭浏览器，0 表示不关闭。 */
  idleTimeoutMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  /** 为空表示不鉴权。 */
  apiKeys: string[];
  maxConcurrency: number;
  defaultCaptureTimeoutMs: number;
  shutdownTimeoutMs: number;
  browser: BrowserConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const executablePath = readString(env, 'BROWSER_EXECUTABLE_PATH');
  if (executablePath && !existsSync(executablePath)) {
    throw new InvalidConfigError(`BROWSER_EXECUTABLE_PATH 指向的文件不存在: ${executablePath}`);
  }

  const channel = readString(env, 'BROWSER_CHANNEL');
  if (channel && !isBrowserChannel(channel)) {
    throw new InvalidConfigError(
      `BROWSER_CHANNEL 不支持 "${channel}"，可选值: ${BROWSER_CHANNELS.join(', ')}`,
    );
  }

  const noSandbox = readBoolean(env, 'BROWSER_NO_SANDBOX', false);

  return {
    host: readString(env, 'HOST') ?? '0.0.0.0',
    port: readNumber(env, 'PORT', { fallback: 3000, min: 0, max: 65535 }),
    logLevel: readLogLevel(env),
    apiKeys: readList(env, 'API_KEYS'),
    maxConcurrency: readNumber(env, 'MAX_CONCURRENCY', { fallback: 4, min: 1, max: 64 }),
    defaultCaptureTimeoutMs: readNumber(env, 'CAPTURE_TIMEOUT_MS', {
      fallback: 30_000,
      min: 1_000,
      max: 300_000,
    }),
    shutdownTimeoutMs: readNumber(env, 'SHUTDOWN_TIMEOUT_MS', {
      fallback: 10_000,
      min: 0,
      max: 120_000,
    }),
    browser: {
      executablePath,
      channel,
      headless: readBoolean(env, 'BROWSER_HEADLESS', true),
      sandbox: !noSandbox,
      args: noSandbox
        ? ['--no-sandbox', '--disable-dev-shm-usage', ...readList(env, 'BROWSER_ARGS')]
        : readList(env, 'BROWSER_ARGS'),
      launchTimeoutMs: readNumber(env, 'BROWSER_LAUNCH_TIMEOUT_MS', {
        fallback: 30_000,
        min: 1_000,
        max: 300_000,
      }),
      idleTimeoutMs: readNumber(env, 'BROWSER_IDLE_TIMEOUT_MS', {
        fallback: 60_000,
        min: 0,
        max: 3_600_000,
      }),
    },
  };
}

function isBrowserChannel(value: string): value is BrowserChannel {
  return (BROWSER_CHANNELS as readonly string[]).includes(value);
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = readString(env, name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { fallback: number; min: number; max: number },
): number {
  const raw = readString(env, name);
  if (raw === undefined) return options.fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.min || value > options.max) {
    throw new InvalidConfigError(
      `${name} 必须是 ${options.min} 到 ${options.max} 之间的数字，当前值: ${raw}`,
    );
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readString(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new InvalidConfigError(`${name} 必须是布尔值，当前值: ${raw}`);
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (readString(env, 'LOG_LEVEL') ?? 'info').toLowerCase();
  if (!isLogLevel(raw)) {
    throw new InvalidConfigError(`LOG_LEVEL 不支持 "${raw}"，可选值: ${LOG_LEVELS.join(', ')}`);
  }
  return raw;
}
