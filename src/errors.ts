/** 携带 HTTP 状态码的错误，会被错误处理中间件转换为 JSON 响应。 */
export interface HttpErrorOptions {
  /** 机器可读的错误码，默认根据状态码推断。 */
  code?: string;
  /** 附加信息，会原样放进响应的 `error.details` 字段。 */
  details?: unknown;
  /** 原始错误，仅用于日志，不会返回给客户端。 */
  cause?: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code ?? defaultCode(status);
    this.details = options.details;
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

function defaultCode(status: number): string {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'too_many_requests';
  if (status === 503) return 'service_unavailable';
  if (status === 504) return 'gateway_timeout';
  if (status >= 500) return 'internal_error';
  return 'error';
}
