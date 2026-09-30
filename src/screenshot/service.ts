import type { BrowserContextOptions, Page, PageScreenshotOptions } from 'playwright-core';

import type { BrowserManager } from '../browser/manager.js';
import { HttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { Semaphore } from '../semaphore.js';
import type { CaptureFormat, CaptureOptions } from './schema.js';

export interface ScreenshotResult {
  buffer: Buffer;
  contentType: string;
  format: CaptureFormat;
  bytes: number;
  durationMs: number;
}

export interface ScreenshotService {
  capture(options: CaptureOptions): Promise<ScreenshotResult>;
}

export interface PlaywrightScreenshotServiceOptions {
  browserManager: BrowserManager;
  logger: Logger;
  /** 同时进行的截图上限，超出的请求排队。 */
  maxConcurrency: number;
  /** 请求未指定 timeout 时使用的默认值。 */
  defaultTimeoutMs: number;
}

const CONTENT_TYPES: Record<CaptureFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

export class PlaywrightScreenshotService implements ScreenshotService {
  private readonly browserManager: BrowserManager;
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly semaphore: Semaphore;

  constructor(options: PlaywrightScreenshotServiceOptions) {
    this.browserManager = options.browserManager;
    this.logger = options.logger;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.semaphore = new Semaphore(options.maxConcurrency);
  }

  get activeCaptures(): number {
    return this.semaphore.activeCount;
  }

  get queuedCaptures(): number {
    return this.semaphore.queuedCount;
  }

  async capture(options: CaptureOptions): Promise<ScreenshotResult> {
    const timeoutMs = options.timeout ?? this.defaultTimeoutMs;

    return this.semaphore.run(async () => {
      const startedAt = Date.now();

      try {
        const buffer = await this.capturePage(options, timeoutMs);
        const result: ScreenshotResult = {
          buffer,
          contentType: CONTENT_TYPES[options.format],
          format: options.format,
          bytes: buffer.byteLength,
          durationMs: Date.now() - startedAt,
        };

        this.logger.info('截图完成', {
          url: options.url,
          format: options.format,
          bytes: result.bytes,
          durationMs: result.durationMs,
          fullPage: options.fullPage,
          selector: options.selector ?? null,
        });

        return result;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw toCaptureError(error, options.url, timeoutMs);
      }
    });
  }

  private async capturePage(options: CaptureOptions, timeoutMs: number): Promise<Buffer> {
    const contextOptions: BrowserContextOptions = {
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.deviceScaleFactor,
      colorScheme: options.darkMode,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    };
    if (options.userAgent) contextOptions.userAgent = options.userAgent;
    if (options.headers) contextOptions.extraHTTPHeaders = options.headers;

    return this.browserManager.withContext(contextOptions, async (context) => {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);

      await page.goto(options.url, { waitUntil: options.waitUntil, timeout: timeoutMs });

      if (options.waitForSelector) {
        await page.locator(options.waitForSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      }
      if (options.waitForTimeout) {
        await delay(options.waitForTimeout);
      }

      return captureTarget(page, options);
    });
  }
}

async function captureTarget(page: Page, options: CaptureOptions): Promise<Buffer> {
  if (options.selector) {
    // 元素截图不支持 fullPage / clip，这两者的组合已在参数校验阶段拒绝。
    return page.locator(options.selector).first().screenshot({
      type: options.format,
      omitBackground: options.omitBackground,
      ...(options.format === 'jpeg' && options.quality !== undefined ? { quality: options.quality } : {}),
    });
  }

  const screenshotOptions: PageScreenshotOptions = {
    type: options.format,
    fullPage: options.fullPage,
    omitBackground: options.omitBackground,
  };
  if (options.clip) screenshotOptions.clip = options.clip;
  if (options.format === 'jpeg' && options.quality !== undefined) {
    screenshotOptions.quality = options.quality;
  }

  return page.screenshot(screenshotOptions);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toCaptureError(error: unknown, url: string, timeoutMs: number): HttpError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const summary = firstLine(message);

  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(message)) {
    return new HttpError(504, `在 ${timeoutMs}ms 内未能完成对 ${url} 的截图`, {
      code: 'capture_timeout',
      details: summary,
      cause: error,
    });
  }

  if (/ERR_NAME_NOT_RESOLVED/.test(message)) {
    return new HttpError(502, `无法解析 ${url} 的域名`, {
      code: 'dns_error',
      details: summary,
      cause: error,
    });
  }

  if (/ERR_CONNECTION|ERR_SSL|ERR_CERT|ERR_EMPTY_RESPONSE/.test(message)) {
    return new HttpError(502, `无法连接到 ${url}`, {
      code: 'connection_error',
      details: summary,
      cause: error,
    });
  }

  return new HttpError(502, `截取 ${url} 失败`, {
    code: 'capture_failed',
    details: summary,
    cause: error,
  });
}

function firstLine(message: string): string {
  return message.split('\n').find((line) => line.trim().length > 0)?.trim() ?? message;
}
