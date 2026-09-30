import { timingSafeEqual } from 'node:crypto';

import type { ErrorRequestHandler, Request, RequestHandler } from 'express';

import { HttpError, isHttpError } from './errors.js';
import type { Logger } from './logger.js';

/** 记录每个请求的方法、路径、状态码和耗时（不记录 query，避免泄漏 URL 中的敏感参数）。 */
export function createRequestLogger(logger: Logger): RequestHandler {
  const log = logger.child('http');

  return (req, res, next) => {
    const startedAt = Date.now();

    res.on('finish', () => {
      const payload = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };

      if (res.statusCode >= 500) log.error('请求处理失败', payload);
      else if (res.statusCode >= 400) log.warn('请求被拒绝', payload);
      else log.info('请求完成', payload);
    });

    next();
  };
}

/**
 * 可选的 API Key 鉴权：`x-api-key: <key>` 或 `Authorization: Bearer <key>`。
 * `apiKeys` 为空时直接放行（仅建议在内网部署时这样做）。
 */
export function createApiKeyMiddleware(apiKeys: string[], logger: Logger): RequestHandler {
  if (apiKeys.length === 0) {
    return (_req, _res, next) => {
      next();
    };
  }

  const expected = apiKeys.map((key) => Buffer.from(key, 'utf8'));
  const log = logger.child('auth');

  return (req, _res, next) => {
    const provided = readApiKey(req);

    if (provided !== undefined) {
      const candidate = Buffer.from(provided, 'utf8');
      if (expected.some((key) => safeEqual(key, candidate))) {
        next();
        return;
      }
    }

    log.warn('鉴权失败', { path: req.path, hasKey: provided !== undefined });
    next(new HttpError(401, '缺少或无效的 API Key', { code: 'unauthorized' }));
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `没有匹配的路由: ${req.method} ${req.path}` },
  });
};

/** 把所有异常统一转换成 `{ error: { code, message, details? } }`。 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  const log = logger.child('http');

  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const httpError = normalizeError(error);
    const payload = { path: req.path, method: req.method, status: httpError.status, error };

    if (httpError.status >= 500) log.error('请求出现异常', payload);
    else log.warn('请求参数或状态异常', payload);

    res.status(httpError.status).json({ error: httpError.toJSON() });
  };
}

function readApiKey(req: Request): string | undefined {
  const headerKey = req.get('x-api-key')?.trim();
  if (headerKey) return headerKey;

  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/** 长度一致的比较才使用 timingSafeEqual，避免密钥被逐字节猜测。 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeError(error: unknown): HttpError {
  if (isHttpError(error)) return error;

  if (error instanceof Error) {
    // body-parser 之类的中间件会抛出带 status 的错误（例如 JSON 解析失败）。
    const status = readClientStatus(error);
    if (status !== undefined) {
      return new HttpError(status, error.message || '请求不合法', {
        code: 'bad_request',
        cause: error,
      });
    }

    return new HttpError(500, '服务内部错误', { code: 'internal_error', cause: error });
  }

  return new HttpError(500, '服务内部错误', { code: 'internal_error', details: error });
}

function readClientStatus(error: Error): number | undefined {
  const candidate = (error as { status?: unknown; statusCode?: unknown });
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;

  if (typeof status === 'number' && status >= 400 && status < 500) return status;
  return undefined;
}
