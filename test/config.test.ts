import { describe, expect, it } from 'vitest';

import { BROWSER_CHANNELS, InvalidConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('没有任何环境变量时给出默认值', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      apiKeys: [],
      maxConcurrency: 4,
      defaultCaptureTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000,
    });
    expect(config.browser).toMatchObject({
      headless: true,
      sandbox: true,
      args: [],
      launchTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
    });
    expect(config.browser.channel).toBeUndefined();
    expect(config.browser.executablePath).toBeUndefined();
  });

  it('解析逗号分隔的列表，忽略空白项', () => {
    expect(loadConfig({ API_KEYS: 'a, b ,,c' }).apiKeys).toEqual(['a', 'b', 'c']);
    expect(loadConfig({ BROWSER_ARGS: '--foo=1, --bar' }).browser.args).toEqual(['--foo=1', '--bar']);
  });

  it('BROWSER_NO_SANDBOX 会关闭沙箱并补上容器里必需的参数', () => {
    const config = loadConfig({ BROWSER_NO_SANDBOX: 'true', BROWSER_ARGS: '--foo' });

    expect(config.browser.sandbox).toBe(false);
    expect(config.browser.args).toEqual(['--no-sandbox', '--disable-dev-shm-usage', '--foo']);
  });

  it.each(BROWSER_CHANNELS)('接受合法的 channel: %s', (channel) => {
    expect(loadConfig({ BROWSER_CHANNEL: channel }).browser.channel).toBe(channel);
  });

  it('拒绝拼错或不存在的 channel', () => {
    // 真实 channel 是 chromium-headless-shell，写错会在启动时才暴露，这里提前拦下来
    expect(() => loadConfig({ BROWSER_CHANNEL: 'chrome-headless-shell' })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ BROWSER_CHANNEL: 'safari' })).toThrow(/BROWSER_CHANNEL 不支持/);
  });

  it('BROWSER_EXECUTABLE_PATH 指向不存在的文件时直接报错', () => {
    expect(() => loadConfig({ BROWSER_EXECUTABLE_PATH: '/nope/chrome' })).toThrow(
      /BROWSER_EXECUTABLE_PATH 指向的文件不存在/,
    );
  });

  it.each([
    ['PORT 不是数字', { PORT: 'abc' }],
    ['PORT 越界', { PORT: '70000' }],
    ['MAX_CONCURRENCY 为 0', { MAX_CONCURRENCY: '0' }],
    ['LOG_LEVEL 非法', { LOG_LEVEL: 'verbose' }],
    ['BROWSER_HEADLESS 非法', { BROWSER_HEADLESS: 'maybe' }],
  ])('配置非法时报错: %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError);
  });

  it('能解析 Dockerfile 里给的那套环境变量', () => {
    const config = loadConfig({
      HOST: '0.0.0.0',
      PORT: '3000',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      BROWSER_CHANNEL: 'chromium-headless-shell',
      BROWSER_HEADLESS: 'true',
      BROWSER_NO_SANDBOX: 'true',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.browser.channel).toBe('chromium-headless-shell');
    expect(config.browser.sandbox).toBe(false);
  });
});
