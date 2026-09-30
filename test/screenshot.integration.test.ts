import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { BrowserManager } from '../src/browser/manager.js';
import { isHttpError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { parseCaptureRequest } from '../src/screenshot/schema.js';
import { PlaywrightScreenshotService } from '../src/screenshot/service.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);
const silent = createLogger({ level: 'silent' });

// 本地页面作为夹具，测试不依赖外网。
const PAGE = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>screencut fixture</title>
    <style>
      body { margin: 0; font-family: sans-serif; }
      #box { width: 120px; height: 60px; background: #2563eb; }
      #tall { height: 2000px; background: linear-gradient(#ffffff, #000000); }
      #delayed { width: 40px; height: 40px; background: #16a34a; visibility: hidden; }
    </style>
  </head>
  <body>
    <div id="box"></div>
    <div id="tall"></div>
    <div id="delayed"></div>
    <script>setTimeout(() => { document.getElementById('delayed').style.visibility = 'visible'; }, 300);</script>
  </body>
</html>`;

let server: Server;
let origin: string;
let browserManager: BrowserManager;
let service: PlaywrightScreenshotService;
/** 非空表示本机没有可用浏览器，真实截图相关用例应跳过。 */
let browserUnavailable: string | null = null;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('测试服务器启动失败');
  origin = `http://127.0.0.1:${address.port}`;

  browserManager = new BrowserManager({
    headless: true,
    sandbox: true,
    args: [],
    launchTimeoutMs: 30_000,
    idleTimeoutMs: 0,
    logger: silent,
  });

  service = new PlaywrightScreenshotService({
    browserManager,
    logger: silent,
    maxConcurrency: 2,
    defaultTimeoutMs: 30_000,
  });

  // 预热一次：既验证浏览器可用，也让后续用例更快。
  try {
    await service.capture(parseCaptureRequest({ url: origin }));
  } catch (error) {
    if (isHttpError(error) && error.code === 'browser_unavailable') {
      browserUnavailable = error.message;
      return;
    }
    throw error;
  }
});

afterAll(async () => {
  await browserManager.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** 本机缺少浏览器时跳过用例，保证 `npm test` 在任何机器上都能跑通。 */
function skipWithoutBrowser(context: TestContext): void {
  if (browserUnavailable) context.skip(`本机没有可用的 Chrome/Chromium: ${browserUnavailable}`);
}

describe('真实浏览器截图', () => {
  it('截取视口并返回 png', async (context) => {
    skipWithoutBrowser(context);

    const result = await service.capture(parseCaptureRequest({ url: origin, width: 800, height: 600 }));

    expect(result.format).toBe('png');
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('支持整页、元素截图与 jpeg 输出', async (context) => {
    skipWithoutBrowser(context);

    const fullPage = await service.capture(parseCaptureRequest({ url: origin, fullPage: true }));
    const element = await service.capture(parseCaptureRequest({ url: origin, selector: '#box' }));
    const jpeg = await service.capture(
      parseCaptureRequest({ url: origin, format: 'jpeg', quality: 60, waitForSelector: '#delayed' }),
    );

    // 整页截图包含 2000px 高的渐变，必然远大于 120x60 的小方块。
    expect(element.bytes).toBeLessThan(fullPage.bytes);

    expect(jpeg.format).toBe('jpeg');
    expect(jpeg.contentType).toBe('image/jpeg');
    expect(jpeg.buffer.subarray(0, 2).equals(JPEG_SIGNATURE)).toBe(true);
  });

  it('无法连接的目标返回 502/504 而不是崩溃', async (context) => {
    skipWithoutBrowser(context);

    let error: unknown;
    try {
      // 127.0.0.1:1 上没有服务在监听。
      await service.capture(parseCaptureRequest({ url: 'http://127.0.0.1:1/never-listening', timeout: 5_000 }));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(isHttpError(error)).toBe(true);
    expect([502, 504]).toContain((error as { status: number }).status);
  });
});
