import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import type { CaptureOptions } from '../src/screenshot/schema.js';
import type { ScreenshotResult, ScreenshotService } from '../src/screenshot/service.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const logger = createLogger({ level: 'silent' });

function createTestApp(options: { apiKeys?: string[]; capture?: (options: CaptureOptions) => Promise<ScreenshotResult> } = {}) {
  const capture = vi.fn(
    options.capture ??
      (async (captureOptions: CaptureOptions): Promise<ScreenshotResult> => ({
        buffer: PNG_SIGNATURE,
        contentType: captureOptions.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        format: captureOptions.format,
        bytes: PNG_SIGNATURE.byteLength,
        durationMs: 12,
      })),
  );

  const service: ScreenshotService = { capture };
  return { app: createApp({ service, logger, apiKeys: options.apiKeys }), capture };
}

describe('GET /health', () => {
  it('返回服务状态', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });
});

describe('GET /api/screenshot', () => {
  it('缺少 url 时返回 400', async () => {
    const { app, capture } = createTestApp();
    const response = await request(app).get('/api/screenshot');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.details).toContainEqual({ path: 'url', message: expect.any(String) });
    expect(capture).not.toHaveBeenCalled();
  });

  it('默认返回 png 二进制', async () => {
    const { app, capture } = createTestApp();
    const response = await request(app).get('/api/screenshot?url=example.com&fullPage=true');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.from(response.body).equals(PNG_SIGNATURE)).toBe(true);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://example.com/',
      fullPage: true,
      format: 'png',
      response: 'image',
    });
  });

  it('response=json 时返回 base64 与 dataUri', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/screenshot?url=example.com&response=json');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      url: 'https://example.com/',
      format: 'png',
      contentType: 'image/png',
      bytes: PNG_SIGNATURE.byteLength,
      fullPage: false,
      selector: null,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
    expect(response.body.data).toBe(PNG_SIGNATURE.toString('base64'));
    expect(response.body.dataUri).toBe(`data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`);
  });

  it('jpeg 请求会带上 quality', async () => {
    const { app, capture } = createTestApp();
    const response = await request(app).get('/api/screenshot?url=example.com&format=jpeg&quality=70');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ format: 'jpeg', quality: 70 });
  });
});

describe('POST /api/screenshot', () => {
  it('接受 JSON body，body 覆盖 query', async () => {
    const { app, capture } = createTestApp();
    const response = await request(app)
      .post('/api/screenshot?format=png')
      .send({ url: 'example.com', format: 'jpeg', quality: 50, selector: '#hero' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://example.com/',
      format: 'jpeg',
      quality: 50,
      selector: '#hero',
    });
  });

  it('body 不是合法 JSON 时返回 400', async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post('/api/screenshot')
      .set('content-type', 'application/json')
      .send('{"url": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_request');
  });
});

describe('鉴权', () => {
  it('未配置 API_KEYS 时直接放行', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/screenshot?url=example.com');
    expect(response.status).toBe(200);
  });

  it('配置 API_KEYS 后缺少 key 返回 401', async () => {
    const { app, capture } = createTestApp({ apiKeys: ['s3cret'] });
    const response = await request(app).get('/api/screenshot?url=example.com');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
    expect(capture).not.toHaveBeenCalled();
  });

  it('错误的 key 返回 401', async () => {
    const { app } = createTestApp({ apiKeys: ['s3cret'] });
    const response = await request(app).get('/api/screenshot?url=example.com').set('x-api-key', 'nope');

    expect(response.status).toBe(401);
  });

  it('支持 x-api-key 与 Authorization: Bearer', async () => {
    const { app } = createTestApp({ apiKeys: ['s3cret'] });

    await expect(
      request(app).get('/api/screenshot?url=example.com').set('x-api-key', 's3cret'),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request(app).get('/api/screenshot?url=example.com').set('authorization', 'Bearer s3cret'),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe('错误处理', () => {
  it('透出 service 抛出的 HttpError', async () => {
    const { app } = createTestApp({
      capture: async () => {
        throw new HttpError(504, '在 30000ms 内未能完成截图', { code: 'capture_timeout' });
      },
    });

    const response = await request(app).get('/api/screenshot?url=example.com');

    expect(response.status).toBe(504);
    expect(response.body.error).toEqual({ code: 'capture_timeout', message: '在 30000ms 内未能完成截图' });
  });

  it('未知异常兜底为 500，且不泄漏内部细节', async () => {
    const { app } = createTestApp({
      capture: async () => {
        throw new Error('database exploded');
      },
    });

    const response = await request(app).get('/api/screenshot?url=example.com');

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({ code: 'internal_error', message: '服务内部错误' });
    expect(response.text).not.toContain('database exploded');
  });

  it('未知路由返回 404', async () => {
    const { app } = createTestApp();
    const response = await request(app).get('/api/nope');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
