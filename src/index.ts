import process from 'node:process';

import { createApp } from './app.js';
import { BrowserManager } from './browser/manager.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PlaywrightScreenshotService } from './screenshot/service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const browserManager = new BrowserManager({ ...config.browser, logger: logger.child('browser') });

  const service = new PlaywrightScreenshotService({
    browserManager,
    logger: logger.child('screenshot'),
    maxConcurrency: config.maxConcurrency,
    defaultTimeoutMs: config.defaultCaptureTimeoutMs,
  });

  const app = createApp({
    service,
    logger,
    apiKeys: config.apiKeys,
    status: () => ({
      browser: browserManager.status(),
      capture: { active: service.activeCaptures, queued: service.queuedCaptures },
    }),
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('screencut 已启动', {
      url: `http://${config.host}:${config.port}`,
      maxConcurrency: config.maxConcurrency,
      auth: config.apiKeys.length > 0,
      browser: config.browser.executablePath ?? config.browser.channel ?? 'auto',
    });
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('开始优雅退出', { signal });

    // 兜底：超过约定时间仍未退出就强制结束，避免卡死。
    const forceExit = setTimeout(() => {
      logger.warn('优雅退出超时，强制结束进程', { shutdownTimeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      await browserManager.close();
      logger.info('已停止');
      process.exit(0);
    } catch (error) {
      logger.error('退出过程出错', { error });
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((error: unknown) => {
  // 此时 logger 可能还没建好（例如配置不合法），直接写 stderr。
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
