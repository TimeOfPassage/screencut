import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/errors.js';
import { captureRequestSchema, parseCaptureRequest } from '../src/screenshot/schema.js';

describe('parseCaptureRequest', () => {
  it('为缺省字段填充默认值', () => {
    const options = parseCaptureRequest({ url: 'https://example.com' });

    expect(options).toMatchObject({
      url: 'https://example.com/',
      format: 'png',
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      fullPage: false,
      waitUntil: 'load',
      darkMode: 'no-preference',
      ignoreHTTPSErrors: false,
      omitBackground: false,
      response: 'image',
    });
    expect(options.selector).toBeUndefined();
    expect(options.quality).toBeUndefined();
  });

  it('省略协议时补全 https', () => {
    expect(parseCaptureRequest({ url: 'example.com/a?b=1' }).url).toBe('https://example.com/a?b=1');
    expect(parseCaptureRequest({ url: ' http://example.com ' }).url).toBe('http://example.com/');
  });

  it('接受 query string 形态的字符串参数', () => {
    const options = parseCaptureRequest({
      url: 'example.com',
      fullPage: 'true',
      width: '375',
      height: '667',
      deviceScaleFactor: '2',
      response: 'json',
      ignoreHTTPSErrors: '0',
    });

    expect(options.fullPage).toBe(true);
    expect(options.ignoreHTTPSErrors).toBe(false);
    expect(options.response).toBe('json');
    expect(options.width).toBe(375);
    expect(options.height).toBe(667);
    expect(options.deviceScaleFactor).toBe(2);
  });

  it('支持字符串形态的 clip', () => {
    expect(parseCaptureRequest({ url: 'example.com', clip: '10,20,100,50' }).clip).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('拒绝缺少 url 的请求，并在 details 里给出字段路径', () => {
    try {
      parseCaptureRequest({});
      throw new Error('应当抛出 HttpError');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      expect(httpError.status).toBe(400);
      expect(httpError.code).toBe('invalid_request');
      expect(httpError.details).toContainEqual({ path: 'url', message: expect.any(String) });
    }
  });

  it.each([
    ['非 http(s) 协议', { url: 'ftp://example.com' }],
    ['无法解析的地址', { url: 'https://' }],
    ['png 搭配 quality', { url: 'example.com', quality: 80 }],
    ['fullPage 搭配 clip', { url: 'example.com', fullPage: true, clip: '0,0,10,10' }],
    ['fullPage 搭配 selector', { url: 'example.com', fullPage: true, selector: '#main' }],
    ['clip 搭配 selector', { url: 'example.com', clip: '0,0,10,10', selector: '#main' }],
    ['jpeg 搭配 omitBackground', { url: 'example.com', format: 'jpeg', omitBackground: true }],
    ['viewport 越界', { url: 'example.com', width: 99999 }],
    ['无法解析的 clip', { url: 'example.com', clip: '0,0,foo,10' }],
    ['未知的 format', { url: 'example.com', format: 'gif' }],
  ])('拒绝非法组合: %s', (_label, input) => {
    expect(captureRequestSchema.safeParse(input).success).toBe(false);
    expect(() => parseCaptureRequest(input)).toThrow(HttpError);
  });
});
