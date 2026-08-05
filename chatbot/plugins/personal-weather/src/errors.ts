import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";

export type WeatherErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_FAILED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "NO_DATA"
  | "REQUEST_CANCELLED";

const PUBLIC_MESSAGES: Record<WeatherErrorCode, string> = {
  CONFIG_INVALID: "天气服务尚未正确配置。",
  AUTH_FAILED: "天气服务鉴权失败。",
  FORBIDDEN: "天气服务拒绝了本次请求。",
  RATE_LIMITED: "天气服务请求过于频繁，请稍后再试。",
  TIMEOUT: "天气服务响应超时。",
  UPSTREAM_UNAVAILABLE: "天气服务暂时不可用。",
  INVALID_RESPONSE: "天气服务返回了无法识别的数据。",
  NO_DATA: "天气服务暂时没有可用数据。",
  REQUEST_CANCELLED: "天气查询已取消。",
};

export class WeatherError extends Error {
  readonly code: WeatherErrorCode;
  readonly retryable: boolean;

  constructor(
    code: WeatherErrorCode,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(PUBLIC_MESSAGES[code], { cause: options.cause });
    this.name = "WeatherError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }

  toPublicResult(): {
    ok: false;
    code: WeatherErrorCode;
    retryable: boolean;
    message: string;
  } {
    return {
      ok: false,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export function asWeatherError(error: unknown): WeatherError {
  if (error instanceof WeatherError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new WeatherError("REQUEST_CANCELLED", { cause: error });
  }
  if (error instanceof SsrFBlockedError) {
    return new WeatherError("CONFIG_INVALID", { cause: error });
  }
  return new WeatherError("UPSTREAM_UNAVAILABLE", {
    retryable: true,
    cause: error,
  });
}
