import express from 'express';
import type { Request, Response } from 'express';

import type { CaptureOptions } from './schema.js';
import { parseCaptureRequest } from './schema.js';
import type { ScreenshotResult, ScreenshotService } from './service.js';

export interface ScreenshotRouterDependencies {
  service: ScreenshotService;
}

/**
 * `GET /api/screenshot?url=...` 与 `POST /api/screenshot`（JSON body）共用同一套参数，
 * body 的优先级高于 query，方便把长参数放进 body、短参数放在 URL 里调试。
 */
export function createScreenshotRouter({ service }: ScreenshotRouterDependencies) {
  const router = express.Router();

  const handler = async (req: Request, res: Response): Promise<void> => {
    const options = parseCaptureRequest({
      ...asPlainRecord(req.query),
      ...asPlainRecord(req.body),
    });

    const result = await service.capture(options);
    sendResult(res, options, result);
  };

  router.get('/screenshot', handler);
  router.post('/screenshot', handler);

  return router;
}

function sendResult(res: Response, options: CaptureOptions, result: ScreenshotResult): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Screenshot-Duration-Ms', String(result.durationMs));

  if (options.response === 'json') {
    res.status(200).json({
      url: options.url,
      format: result.format,
      contentType: result.contentType,
      bytes: result.bytes,
      durationMs: result.durationMs,
      viewport: {
        width: options.width,
        height: options.height,
        deviceScaleFactor: options.deviceScaleFactor,
      },
      fullPage: options.fullPage,
      selector: options.selector ?? null,
      data: result.buffer.toString('base64'),
      dataUri: `data:${result.contentType};base64,${result.buffer.toString('base64')}`,
    });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Length', String(result.bytes));
  res.end(result.buffer);
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
