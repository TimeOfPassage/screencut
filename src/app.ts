import process from 'node:process';

import express from 'express';
import type { Express } from 'express';

import { createApiKeyMiddleware, createErrorHandler, createRequestLogger, notFoundHandler } from './middleware.js';
import type { Logger } from './logger.js';
import { createScreenshotRouter } from './screenshot/router.js';
import type { ScreenshotService } from './screenshot/service.js';

export interface AppDependencies {
  service: ScreenshotService;
  logger: Logger;
  /** 为空表示不启用鉴权。 */
  apiKeys?: string[];
  /** 附加到 /health 响应里的运行时信息（浏览器状态、队列长度等）。 */
  status?: () => Record<string, unknown>;
}

export function createApp(deps: AppDependencies): Express {
  const logger = deps.logger;
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(express.json({ limit: '256kb' }));
  app.use(createRequestLogger(logger));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      ...(deps.status ? { details: deps.status() } : {}),
    });
  });

  app.use('/api', createApiKeyMiddleware(deps.apiKeys ?? [], logger), createScreenshotRouter({ service: deps.service }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
