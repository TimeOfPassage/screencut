import { z } from 'zod';

import { HttpError } from '../errors.js';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * 同时接受 JSON 里的布尔值和 query string 里的 "true"/"false"/"1"/"0"。
 * 注意不能用 z.coerce.boolean()，它会把 "false" 也当成 true。
 */
const booleanish = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;

    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;

    ctx.addIssue({ code: 'custom', message: `无法解析为布尔值: "${value}"` });
    return z.NEVER;
  });

const targetUrl = z
  .string()
  .trim()
  .min(1, 'url 不能为空')
  .transform((value) => {
    // 省略协议时默认补 https://，方便直接传 example.com
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    try {
      // 归一化（补全尾斜杠、小写主机名等），保证同样的目标得到同样的 key
      return new URL(candidate).toString();
    } catch {
      // 解析失败时原样返回，由下面的 refine 给出明确的错误信息
      return candidate;
    }
  })
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url 必须是合法的 http/https 地址' },
  );

const clipSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** clip 既接受对象，也接受 query string 里的 "x,y,width,height"。 */
const clipInput = z.union([clipSchema, z.string()]).transform((value, ctx) => {
  if (typeof value !== 'string') return value;

  const [x, y, width, height] = value.split(',').map((part) => Number(part.trim()));

  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    ctx.addIssue({ code: 'custom', message: 'clip 需要 4 个数字: "x,y,width,height"' });
    return z.NEVER;
  }

  const numbers = [x, y, width, height];
  if (numbers.some((part) => !Number.isFinite(part)) || width <= 0 || height <= 0) {
    ctx.addIssue({ code: 'custom', message: 'clip 的 width/height 必须为正数，坐标必须是有限数字' });
    return z.NEVER;
  }

  return { x, y, width, height };
});

export const captureRequestSchema = z
  .object({
    url: targetUrl,

    /** 输出格式，jpeg 才支持 quality。 */
    format: z.enum(['png', 'jpeg']).default('png'),
    quality: z.coerce.number().int().min(0).max(100).optional(),

    /** 视口尺寸（CSS 像素）。 */
    width: z.coerce.number().int().min(1).max(10_000).default(1280),
    height: z.coerce.number().int().min(1).max(10_000).default(800),
    deviceScaleFactor: z.coerce.number().min(0.1).max(4).default(1),

    /** 截取整页，而不是仅视口内容。 */
    fullPage: booleanish.default(false),
    /** 只截取匹配到的第一个元素。 */
    selector: z.string().trim().min(1).optional(),
    /** 截取页面指定区域。 */
    clip: clipInput.optional(),

    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
    /** 导航/等待超时，缺省时使用服务端配置。 */
    timeout: z.coerce.number().int().min(1_000).max(300_000).optional(),
    waitForSelector: z.string().trim().min(1).optional(),
    /** 页面加载完成后再等待的毫秒数，用于等待动画/懒加载。 */
    waitForTimeout: z.coerce.number().int().min(0).max(60_000).optional(),

    userAgent: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    darkMode: z.enum(['light', 'dark', 'no-preference']).default('no-preference'),
    ignoreHTTPSErrors: booleanish.default(false),
    /** 透明背景，仅 png 支持。 */
    omitBackground: booleanish.default(false),

    /** image 直接返回图片二进制，json 返回 base64。 */
    response: z.enum(['image', 'json']).default('image'),
  })
  .refine((options) => options.format !== 'png' || options.quality === undefined, {
    path: ['quality'],
    message: 'quality 仅在 format=jpeg 时可用',
  })
  .refine((options) => options.selector === undefined || !options.fullPage, {
    path: ['fullPage'],
    message: 'fullPage 不能与 selector 同时使用',
  })
  .refine((options) => options.selector === undefined || options.clip === undefined, {
    path: ['clip'],
    message: 'clip 不能与 selector 同时使用',
  })
  .refine((options) => !(options.fullPage && options.clip !== undefined), {
    path: ['clip'],
    message: 'clip 不能与 fullPage 同时使用',
  })
  .refine((options) => !options.omitBackground || options.format === 'png', {
    path: ['omitBackground'],
    message: 'omitBackground 仅在 format=png 时可用',
  });

export type CaptureOptions = z.infer<typeof captureRequestSchema>;
export type CaptureFormat = CaptureOptions['format'];

/**
 * 校验请求参数，失败时抛出 400，details 里带上每个字段的校验错误。
 */
export function parseCaptureRequest(input: unknown): CaptureOptions {
  const result = captureRequestSchema.safeParse(input);
  if (result.success) return result.data;

  throw new HttpError(400, '截图参数不合法', {
    code: 'invalid_request',
    details: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  });
}
