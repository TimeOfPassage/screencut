import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';

import { HttpError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface BrowserManagerOptions {
  executablePath?: string;
  channel?: string;
  headless: boolean;
  sandbox: boolean;
  args: string[];
  launchTimeoutMs: number;
  /** 空闲多少毫秒后关闭浏览器以释放内存，0 表示常驻。 */
  idleTimeoutMs: number;
  logger: Logger;
}

export interface BrowserStatus {
  connected: boolean;
  strategy: string | null;
  activeContexts: number;
}

interface LaunchStrategy {
  label: string;
  options: LaunchOptions;
}

/**
 * 复用同一个浏览器进程：每个请求使用独立的 BrowserContext（互不污染、cookie 隔离），
 * 用完即关；浏览器本身首次用时懒启动，长时间空闲后自动关闭。
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeContexts = 0;
  private strategy: string | null = null;

  constructor(private readonly options: BrowserManagerOptions) {}

  /** 创建一个隔离的上下文，执行完（无论成功与否）都会关闭它。 */
  async withContext<T>(
    contextOptions: BrowserContextOptions,
    run: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    this.cancelIdleShutdown();

    const browser = await this.getBrowser();
    this.activeContexts += 1;

    let context: BrowserContext;
    try {
      context = await browser.newContext(contextOptions);
    } catch (error) {
      this.activeContexts -= 1;
      this.scheduleIdleShutdown();
      throw error;
    }

    try {
      return await run(context);
    } finally {
      await context.close().catch((error: unknown) => {
        this.options.logger.warn('关闭浏览器上下文失败', { error });
      });
      this.activeContexts -= 1;
      this.scheduleIdleShutdown();
    }
  }

  status(): BrowserStatus {
    return {
      connected: this.browser?.isConnected() ?? false,
      strategy: this.strategy,
      activeContexts: this.activeContexts,
    };
  }

  async close(): Promise<void> {
    this.cancelIdleShutdown();
    const browser = this.browser;
    this.browser = null;
    this.strategy = null;
    if (!browser) return;
    await browser.close().catch((error: unknown) => {
      this.options.logger.warn('关闭浏览器失败', { error });
    });
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // 并发请求同时触发启动时，复用同一个启动过程。
    if (!this.launchPromise) {
      const launching = this.launchBrowser();
      this.launchPromise = launching;
      void launching
        .finally(() => {
          if (this.launchPromise === launching) this.launchPromise = null;
        })
        .catch(() => {
          // 失败结果由 await 它的调用方处理，这里只是避免 unhandled rejection。
        });
    }

    return this.launchPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    const failures: string[] = [];

    for (const strategy of this.buildStrategies()) {
      try {
        const browser = await chromium.launch(strategy.options);
        browser.on('disconnected', () => {
          if (this.browser !== browser) return;
          this.browser = null;
          this.strategy = null;
          this.options.logger.warn('浏览器进程已断开，下次请求会重新启动');
        });
        this.browser = browser;
        this.strategy = strategy.label;
        this.options.logger.info('浏览器已就绪', {
          strategy: strategy.label,
          version: browser.version(),
        });
        return browser;
      } catch (error) {
        failures.push(`${strategy.label} (${describe(error)})`);
        this.options.logger.warn('浏览器启动失败', { strategy: strategy.label, error });
      }
    }

    throw new HttpError(
      503,
      `无法启动浏览器，已尝试: ${failures.join('; ')}。` +
        '请安装 Google Chrome，或配置 BROWSER_CHANNEL / BROWSER_EXECUTABLE_PATH，' +
        '或执行 `npx playwright install chromium` 下载内置 chromium。',
      { code: 'browser_unavailable' },
    );
  }

  private buildStrategies(): LaunchStrategy[] {
    const base: LaunchOptions = {
      headless: this.options.headless,
      timeout: this.options.launchTimeoutMs,
      args: this.options.args,
      chromiumSandbox: this.options.sandbox,
    };

    if (this.options.executablePath) {
      return [
        {
          label: `executable:${this.options.executablePath}`,
          options: { ...base, executablePath: this.options.executablePath },
        },
      ];
    }

    if (this.options.channel) {
      return [{ label: `channel:${this.options.channel}`, options: { ...base, channel: this.options.channel } }];
    }

    // 未显式配置时按“本机已装浏览器优先”的顺序探测。
    return [
      { label: 'channel:chrome', options: { ...base, channel: 'chrome' } },
      { label: 'channel:msedge', options: { ...base, channel: 'msedge' } },
      { label: 'bundled:chromium', options: { ...base } },
    ];
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    if (this.options.idleTimeoutMs <= 0 || this.activeContexts > 0 || !this.browser) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeContexts > 0) return;
      this.options.logger.info('浏览器空闲超时，释放资源', {
        idleTimeoutMs: this.options.idleTimeoutMs,
      });
      void this.close();
    }, this.options.idleTimeoutMs);

    // 不要让这个定时器阻止进程退出。
    this.idleTimer.unref();
  }

  private cancelIdleShutdown(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
