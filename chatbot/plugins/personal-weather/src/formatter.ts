import type { QwMeasurement, QwWind } from "./types.js";
import type { RainWindow, WeatherBrief } from "./weather-model.js";

export interface FormatWeatherOptions {
  greeting?: boolean;
  maxLength?: number;
}

const COMPASS_ZH: Readonly<Record<string, string>> = {
  n: "北风",
  nne: "北东北风",
  ne: "东北风",
  ene: "东东北风",
  e: "东风",
  ese: "东东南风",
  se: "东南风",
  sse: "南东南风",
  s: "南风",
  ssw: "南西南风",
  sw: "西南风",
  wsw: "西西南风",
  w: "西风",
  wnw: "西西北风",
  nw: "西北风",
  nnw: "北西北风",
};

export function formatWeatherBrief(
  brief: WeatherBrief,
  options: FormatWeatherOptions = {},
): string {
  const lines: string[] = [];
  if (options.greeting ?? false) {
    lines.push("早上好，主人～");
  }

  const currentParts = [
    `现在${brief.current.condition.text}`,
    formatTemperature(brief.current.temperature),
  ];
  if (brief.current.feelsLike) {
    currentParts.push(`体感${formatTemperature(brief.current.feelsLike)}`);
  }
  if (brief.current.humidity !== undefined) {
    currentParts.push(`湿度${formatRatio(brief.current.humidity)}`);
  }
  const wind = formatWind(brief.current.wind);
  if (wind) {
    currentParts.push(wind);
  }
  lines.push(`${brief.location.shortName || brief.location.displayName}：${currentParts.join("，")}。`);

  if (brief.today) {
    const conditions = [
      brief.today.daytimeCondition?.text,
      brief.today.nighttimeCondition?.text,
    ].filter((value): value is string => Boolean(value));
    const conditionText = [...new Set(conditions)].join("转");
    const details = [
      `今天${formatTemperature(brief.today.temperatureMin)}～${formatTemperature(brief.today.temperatureMax)}`,
      conditionText || undefined,
      brief.today.uvIndexMax !== undefined
        ? `最高紫外线指数${formatNumber(brief.today.uvIndexMax)}`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    lines.push(`${details.join("，")}。`);
  } else {
    lines.push("今日高低温预报暂不可用。");
  }

  if (brief.next24Hours) {
    lines.push(formatRainSummary(brief));
  } else {
    lines.push("未来24小时降雨趋势暂不可用。");
  }

  if (brief.alerts.availability === "unavailable") {
    lines.push("官方预警数据暂不可用，不能据此判断“无预警”。");
  } else if (brief.alerts.state === "none") {
    lines.push("当前无官方气象预警。");
  } else if (brief.alerts.items.length > 0) {
    const alertTexts = brief.alerts.items.slice(0, 3).map((alert) => {
      const title = alert.headline ?? alert.eventType?.name ?? "气象预警";
      return alert.severity ? `${title}（${alert.severity}）` : title;
    });
    lines.push(`官方预警：${alertTexts.join("；")}。`);
  } else {
    lines.push("官方预警返回状态不明确，请以当地官方信息为准。");
  }

  const unavailable = Object.entries(brief.quality)
    .filter(([, quality]) => quality.state === "unavailable")
    .map(([component]) => componentLabel(component));
  if (unavailable.length > 0) {
    lines.push(`本次${unavailable.join("、")}数据有缺失。`);
  }

  lines.push(
    `数据：${formatAttributions(brief.attributions)}；查询于${formatLocalTime(
      brief.generatedAt,
      brief.location.timezone,
    )}（${brief.location.timezone}）。`,
  );

  return truncateMessage(lines.join("\n"), options.maxLength ?? 1800);
}

function formatRainSummary(brief: WeatherBrief): string {
  const hourly = brief.next24Hours;
  if (!hourly || hourly.availableHours === 0) {
    return "未来24小时暂无足够的逐小时数据。";
  }

  const probability = hourly.maxPrecipitationProbability;
  const windows = [...hourly.rainWindows].sort(
    (left, right) => Date.parse(left.startTime) - Date.parse(right.startTime),
  );
  const peakWindow = windows.reduce<RainWindow | undefined>((best, candidate) => {
    if (candidate.maxProbability === undefined) {
      return best;
    }
    if (
      !best ||
      best.maxProbability === undefined ||
      candidate.maxProbability > best.maxProbability
    ) {
      return candidate;
    }
    return best;
  }, undefined);
  const parts: string[] = [];
  if (windows.length > 0) {
    parts.push(
      `未来24小时降雨趋势：${windows
        .map((window) => formatRainWindow(window, brief.location.timezone))
        .join("；")}`,
    );
  } else if (probability !== undefined) {
    parts.push(`未来24小时最高降雨概率${formatRatio(probability)}`);
  } else {
    parts.push("未来24小时降雨概率数据不完整");
  }

  if (peakWindow?.maxProbability !== undefined) {
    parts.push(
      `最高降雨概率${formatRatio(peakWindow.maxProbability)}，对应时段${formatRainWindowClock(
        peakWindow,
        brief.location.timezone,
      )}`,
    );
  } else if (windows.length > 0) {
    parts.push("未来24小时预计有降水");
  }

  if (probability !== undefined && probability >= 0.6) {
    parts.push("出门建议带伞");
  } else if (probability !== undefined && probability >= 0.3) {
    parts.push("可能有雨，可带伞");
  } else if (windows.length > 0) {
    parts.push("可留意临近天气变化");
  }
  return `${parts.join("，")}。`;
}

function formatRainWindow(window: RainWindow, timezone: string): string {
  const range = formatRainWindowClock(window, timezone);
  return window.maxProbability !== undefined
    ? `${range}约${formatRatio(window.maxProbability)}`
    : range;
}

function formatRainWindowClock(window: RainWindow, timezone: string): string {
  return `${formatClock(window.startTime, timezone)}～${formatClock(window.endTime, timezone)}`;
}

function formatTemperature(measurement: QwMeasurement): string {
  const value = formatNumber(measurement.value);
  const unit = measurement.unit.trim().toLowerCase();
  if (["celsius", "degree-celsius", "°c", "c"].includes(unit)) {
    return `${value}°C`;
  }
  if (["fahrenheit", "degree-fahrenheit", "°f", "f"].includes(unit)) {
    return `${value}°F`;
  }
  return `${value}${measurement.unit}`;
}

function formatWind(wind?: QwWind): string | undefined {
  if (!wind) {
    return undefined;
  }
  const compass = wind.direction?.compass?.trim();
  const direction = compass
    ? COMPASS_ZH[compass.toLowerCase()] ??
      (/[风]$/u.test(compass) ? compass : `${compass}风`)
    : undefined;
  const scale = wind.scale !== undefined ? `${formatNumber(wind.scale)}级` : undefined;
  if (direction || scale) {
    return [direction, scale].filter(Boolean).join("");
  }
  if (wind.speed) {
    return `风速${formatMeasurement(wind.speed)}`;
  }
  return undefined;
}

function formatMeasurement(measurement: QwMeasurement): string {
  const unitMap: Readonly<Record<string, string>> = {
    "kilometer-per-hour": "km/h",
    "meter-per-second": "m/s",
    millimeter: "mm",
  };
  const unit = unitMap[measurement.unit.toLowerCase()] ?? measurement.unit;
  return `${formatNumber(measurement.value)}${unit}`;
}

function formatRatio(value: number): string {
  return `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function formatLocalTime(value: string, timezone: string): string {
  return formatWithTimezone(value, timezone, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatClock(value: string, timezone: string): string {
  return formatWithTimezone(value, timezone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatWithTimezone(
  value: string,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...options,
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat("zh-CN", {
      ...options,
      timeZone: "UTC",
    }).format(new Date(value));
  }
}

function formatAttributions(attributions: string[]): string {
  const normalized = attributions
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !/^qweather$/iu.test(value) && value !== "和风天气")
    .slice(0, 3);
  return ["和风天气", ...normalized].join("、");
}

function componentLabel(value: string): string {
  return (
    {
      current: "实况",
      daily: "每日预报",
      hourly: "逐小时预报",
      alerts: "官方预警",
    }[value] ?? value
  );
}

function truncateMessage(value: string, maxLength: number): string {
  const codepoints = [...value];
  if (codepoints.length <= maxLength) {
    return value;
  }
  return `${codepoints.slice(0, Math.max(maxLength - 1, 0)).join("")}…`;
}
