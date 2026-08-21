import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";

export type SearchErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "FORBIDDEN_CONTEXT"
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "REQUEST_CANCELLED";

const PUBLIC_MESSAGES: Record<SearchErrorCode, string> = {
  CONFIG_INVALID: "搜索服务配置无效。",
  AUTH_NOT_CONFIGURED: "搜索服务尚未配置 API Key。",
  AUTH_FAILED: "搜索服务鉴权失败。",
  FORBIDDEN_CONTEXT: "此工具仅支持主人 QQ 私聊。",
  INVALID_INPUT: "搜索 query 无效或包含不应外发的敏感内容；请改为不含私人标识的公开主题。",
  RATE_LIMITED: "搜索服务请求过于频繁，请稍后再试。",
  QUOTA_EXCEEDED: "搜索服务已达到本地保守配额，请稍后再试。",
  TIMEOUT: "搜索服务响应超时。",
  UPSTREAM_UNAVAILABLE: "搜索服务暂时不可用。",
  INVALID_RESPONSE: "搜索服务返回了无法核验的结果。",
  REQUEST_CANCELLED: "搜索请求已取消。",
};

const DEFAULT_RETRYABLE = new Set<SearchErrorCode>([
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
]);

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly retryable: boolean;

  constructor(
    code: SearchErrorCode,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(PUBLIC_MESSAGES[code], { cause: options.cause });
    this.name = "SearchError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }

  readonly retryAfterMs?: number;

  toPublicResult(): {
    ok: false;
    code: SearchErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
    message: string;
  } {
    return {
      ok: false,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export function asSearchError(error: unknown): SearchError {
  if (error instanceof SearchError) return error;
  if (error instanceof SsrFBlockedError) {
    return new SearchError("CONFIG_INVALID", { cause: error });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new SearchError("REQUEST_CANCELLED", { cause: error });
  }
  return new SearchError("UPSTREAM_UNAVAILABLE", {
    retryable: true,
    cause: error,
  });
}
