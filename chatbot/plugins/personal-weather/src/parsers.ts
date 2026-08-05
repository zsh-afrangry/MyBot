import type {
  ParseIssue,
  ParseResult,
  QwAlert,
  QwAlertColor,
  QwAlertResponse,
  QwCondition,
  QwCurrentResponse,
  QwDailyItem,
  QwDailyResponse,
  QwForecastPeriod,
  QwGeoLocation,
  QwGeoLookupResponse,
  QwHourlyItem,
  QwHourlyResponse,
  QwMeasurement,
  QwMetadata,
  QwPrecipitation,
  QwWind,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export const QWEATHER_TEXT_LIMITS = Object.freeze({
  metadataTag: 256,
  attribution: 512,
  condition: 120,
  code: 64,
  unit: 24,
  locationName: 160,
  locationId: 96,
  administrativeName: 160,
  timezone: 96,
  shortValue: 96,
  alertId: 160,
  senderName: 200,
  headline: 360,
  description: 2_000,
  criteria: 1_000,
  instruction: 2_000,
});

const ARRAY_LIMITS = Object.freeze({
  attributions: 32,
  days: 10,
  hours: 240,
  alerts: 100,
  supersedes: 64,
  responseTypes: 32,
  geoLocations: 20,
  licenses: 16,
});

const UNSAFE_TEXT_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ParseIssue[],
  path: string,
  code: ParseIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function hasBlockingIssue(issues: ParseIssue[]): boolean {
  return issues.some(
    (entry) =>
      entry.code === "invalid_type" ||
      entry.code === "missing_field" ||
      entry.code === "invalid_value",
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateByCodePoint(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) {
    return value;
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function cleanText(
  value: string,
  path: string,
  issues: ParseIssue[],
  options: { maxLength: number; multiline?: boolean },
): string {
  const withoutUnsafeCharacters = value.replace(UNSAFE_TEXT_CHARACTERS, "");
  if (withoutUnsafeCharacters !== value) {
    addIssue(
      issues,
      path,
      "sanitized_text",
      "Unsafe control or bidirectional text characters were removed.",
    );
  }

  const normalized = options.multiline
    ? withoutUnsafeCharacters
        .replace(/\r\n?/gu, "\n")
        .replace(/[\t ]+/gu, " ")
        .replace(/ *\n */gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim()
    : withoutUnsafeCharacters.replace(/\s+/gu, " ").trim();

  if (codePointLength(normalized) > options.maxLength) {
    addIssue(
      issues,
      path,
      "truncated_text",
      `Text was truncated to ${options.maxLength} Unicode characters.`,
    );
    return truncateByCodePoint(normalized, options.maxLength);
  }
  return normalized;
}

/** A small public helper for formatter and security-focused tests. */
export function sanitizeQWeatherText(
  value: string,
  options: { maxLength?: number; multiline?: boolean } = {},
): string {
  return cleanText(value, "$", [], {
    maxLength: options.maxLength ?? QWEATHER_TEXT_LIMITS.description,
    ...(options.multiline !== undefined
      ? { multiline: options.multiline }
      : {}),
  });
}

function parseRequiredText(
  value: unknown,
  path: string,
  issues: ParseIssue[],
  options: { maxLength: number; multiline?: boolean },
): string | undefined {
  if (value === null || value === undefined) {
    addIssue(issues, path, "missing_field", "Required text field is missing.");
    return undefined;
  }
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_type", "Expected a text value.");
    return undefined;
  }
  const parsed = cleanText(value, path, issues, options);
  if (parsed.length === 0) {
    addIssue(issues, path, "invalid_value", "Text value is empty after normalization.");
    return undefined;
  }
  return parsed;
}

function parseOptionalText(
  value: unknown,
  path: string,
  issues: ParseIssue[],
  options: { maxLength: number; multiline?: boolean },
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    addIssue(issues, path, "invalid_type", "Expected optional text or null.");
    return undefined;
  }
  const parsed = cleanText(value, path, issues, options);
  if (parsed.length === 0) {
    addIssue(issues, path, "invalid_value", "Optional text is empty after normalization.");
    return undefined;
  }
  return parsed;
}

function parseRequiredFiniteNumber(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): number | undefined {
  if (value === null || value === undefined) {
    addIssue(issues, path, "missing_field", "Required number field is missing.");
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, path, "invalid_type", "Expected a finite number.");
    return undefined;
  }
  return value;
}

function parseOptionalFiniteNumber(
  value: unknown,
  path: string,
  issues: ParseIssue[],
  range?: { min: number; max: number },
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, path, "invalid_type", "Expected an optional finite number or null.");
    return undefined;
  }
  if (range && (value < range.min || value > range.max)) {
    addIssue(
      issues,
      path,
      "invalid_value",
      `Number must be between ${range.min} and ${range.max}.`,
    );
    return undefined;
  }
  return value;
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function parseRequiredDateTime(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): string | undefined {
  const parsed = parseRequiredText(value, path, issues, { maxLength: 48 });
  if (parsed === undefined) {
    return undefined;
  }
  if (!isStrictIsoDateTime(parsed)) {
    addIssue(issues, path, "invalid_value", "Expected an ISO 8601 date-time with timezone.");
    return undefined;
  }
  return parsed;
}

function parseOptionalDateTime(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = parseOptionalText(value, path, issues, { maxLength: 48 });
  if (parsed === undefined) {
    return undefined;
  }
  if (!isStrictIsoDateTime(parsed)) {
    addIssue(issues, path, "invalid_value", "Expected an ISO 8601 date-time with timezone.");
    return undefined;
  }
  return parsed;
}

function parseRequiredRecord(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): UnknownRecord | undefined {
  if (value === null || value === undefined) {
    addIssue(issues, path, "missing_field", "Required object is missing.");
    return undefined;
  }
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  return value;
}

function parseOptionalRecord(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): UnknownRecord | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    addIssue(issues, path, "invalid_type", "Expected an optional object or null.");
    return undefined;
  }
  return value;
}

function parseRequiredArray(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): unknown[] | undefined {
  if (value === null || value === undefined) {
    addIssue(issues, path, "missing_field", "Required array is missing.");
    return undefined;
  }
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "Expected an array.");
    return undefined;
  }
  return value;
}

function limitArray<T>(
  values: T[],
  limit: number,
  path: string,
  issues: ParseIssue[],
): T[] {
  if (values.length <= limit) {
    return values;
  }
  addIssue(
    issues,
    path,
    "truncated_array",
    `Array was limited to the first ${limit} entries.`,
  );
  return values.slice(0, limit);
}

function parseTextArray(
  value: unknown,
  path: string,
  issues: ParseIssue[],
  options: { maxItems: number; maxTextLength: number },
): string[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "Expected an optional text array or null.");
    return undefined;
  }

  const result: string[] = [];
  for (const [index, entry] of limitArray(value, options.maxItems, path, issues).entries()) {
    const parsed = parseOptionalText(entry, `${path}[${index}]`, issues, {
      maxLength: options.maxTextLength,
      multiline: false,
    });
    if (parsed !== undefined && !result.includes(parsed)) {
      result.push(parsed);
    }
  }
  return result;
}

function parseMetadata(
  value: unknown,
  path: string,
  fatalIssues: ParseIssue[],
  warnings: ParseIssue[],
): QwMetadata | undefined {
  const record = parseRequiredRecord(value, path, fatalIssues);
  if (!record) {
    return undefined;
  }
  const tag = parseRequiredText(record.tag, `${path}.tag`, fatalIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.metadataTag,
  });
  let attributions: string[] = [];
  if (record.attributions === null || record.attributions === undefined) {
    addIssue(
      warnings,
      `${path}.attributions`,
      "missing_field",
      "Attributions are missing; callers must not invent upstream attribution data.",
    );
  } else {
    attributions =
      parseTextArray(record.attributions, `${path}.attributions`, warnings, {
        maxItems: ARRAY_LIMITS.attributions,
        maxTextLength: QWEATHER_TEXT_LIMITS.attribution,
      }) ?? [];
  }
  return tag === undefined ? undefined : { tag, attributions };
}

function parseMeasurement(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwMeasurement | undefined {
  const record = parseRequiredRecord(value, path, issues);
  if (!record) {
    return undefined;
  }
  const measurementValue = parseRequiredFiniteNumber(record.value, `${path}.value`, issues);
  const unit = parseRequiredText(record.unit, `${path}.unit`, issues, {
    maxLength: QWEATHER_TEXT_LIMITS.unit,
  });
  if (measurementValue === undefined || unit === undefined) {
    return undefined;
  }
  return { value: measurementValue, unit };
}

function parseOptionalMeasurement(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwMeasurement | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return parseMeasurement(value, path, issues);
}

function parseCondition(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwCondition | undefined {
  const record = parseRequiredRecord(value, path, issues);
  if (!record) {
    return undefined;
  }
  const text = parseRequiredText(record.text, `${path}.text`, issues, {
    maxLength: QWEATHER_TEXT_LIMITS.condition,
  });
  const code = parseRequiredText(record.code, `${path}.code`, issues, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });
  if (text === undefined || code === undefined) {
    return undefined;
  }
  return { text, code };
}

function parseOptionalCondition(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwCondition | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return parseCondition(value, path, issues);
}

function parseWind(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwWind | undefined {
  const record = parseOptionalRecord(value, path, issues);
  if (!record) {
    return undefined;
  }

  let direction: QwWind["direction"];
  const directionRecord = parseOptionalRecord(record.direction, `${path}.direction`, issues);
  if (directionRecord) {
    const degree = parseOptionalFiniteNumber(
      directionRecord.degree,
      `${path}.direction.degree`,
      issues,
      { min: 0, max: 365 },
    );
    const compass = parseOptionalText(
      directionRecord.compass,
      `${path}.direction.compass`,
      issues,
      { maxLength: QWEATHER_TEXT_LIMITS.code },
    );
    if (degree !== undefined || compass !== undefined) {
      direction = { degree, compass };
    }
  }

  const speed = parseOptionalMeasurement(record.speed, `${path}.speed`, issues);
  const scale = parseOptionalFiniteNumber(record.scale, `${path}.scale`, issues);
  if (direction === undefined && speed === undefined && scale === undefined) {
    return undefined;
  }
  return { direction, speed, scale };
}

function parsePrecipitation(
  value: unknown,
  path: string,
  issues: ParseIssue[],
): QwPrecipitation | undefined {
  const record = parseOptionalRecord(value, path, issues);
  if (!record) {
    return undefined;
  }
  const amount = parseOptionalMeasurement(record.amount, `${path}.amount`, issues);
  const intensity = parseOptionalMeasurement(record.intensity, `${path}.intensity`, issues);
  const probability = parseOptionalFiniteNumber(
    record.probability,
    `${path}.probability`,
    issues,
    { min: 0, max: 1 },
  );
  const type = parseOptionalText(record.type, `${path}.type`, issues, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });
  if (
    amount === undefined &&
    intensity === undefined &&
    probability === undefined &&
    type === undefined
  ) {
    return undefined;
  }
  return { amount, intensity, probability, type };
}

function parseForecastPeriod(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwForecastPeriod | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const coreIssues: ParseIssue[] = [];
  const record = parseRequiredRecord(value, path, coreIssues);
  if (!record) {
    warnings.push(...coreIssues);
    return undefined;
  }
  const forecastStartTime = parseRequiredDateTime(
    record.forecastStartTime,
    `${path}.forecastStartTime`,
    coreIssues,
  );
  const forecastEndTime = parseRequiredDateTime(
    record.forecastEndTime,
    `${path}.forecastEndTime`,
    coreIssues,
  );
  if (
    forecastStartTime !== undefined &&
    forecastEndTime !== undefined &&
    Date.parse(forecastEndTime) <= Date.parse(forecastStartTime)
  ) {
    addIssue(
      coreIssues,
      `${path}.forecastEndTime`,
      "invalid_value",
      "Forecast end time must be after its start time.",
    );
  }
  if (
    hasBlockingIssue(coreIssues) ||
    forecastStartTime === undefined ||
    forecastEndTime === undefined
  ) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid forecast period was omitted.");
    return undefined;
  }
  warnings.push(...coreIssues);

  return {
    forecastStartTime,
    forecastEndTime,
    condition: parseOptionalCondition(record.condition, `${path}.condition`, warnings),
    temperatureMax: parseOptionalMeasurement(
      record.temperatureMax,
      `${path}.temperatureMax`,
      warnings,
    ),
    temperatureMin: parseOptionalMeasurement(
      record.temperatureMin,
      `${path}.temperatureMin`,
      warnings,
    ),
    humidity: parseOptionalFiniteNumber(record.humidity, `${path}.humidity`, warnings, {
      min: 0,
      max: 1,
    }),
    wind: parseWind(record.wind, `${path}.wind`, warnings),
    windGustMax: parseOptionalMeasurement(
      record.windGustMax,
      `${path}.windGustMax`,
      warnings,
    ),
    precipitation: parsePrecipitation(
      record.precipitation,
      `${path}.precipitation`,
      warnings,
    ),
    cloudCover: parseOptionalFiniteNumber(record.cloudCover, `${path}.cloudCover`, warnings, {
      min: 0,
      max: 1,
    }),
  };
}

function parseDailyItem(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwDailyItem | undefined {
  const coreIssues: ParseIssue[] = [];
  const record = parseRequiredRecord(value, path, coreIssues);
  if (!record) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid daily forecast entry was dropped.");
    return undefined;
  }

  const forecastStartTime = parseRequiredDateTime(
    record.forecastStartTime,
    `${path}.forecastStartTime`,
    coreIssues,
  );
  const forecastEndTime = parseRequiredDateTime(
    record.forecastEndTime,
    `${path}.forecastEndTime`,
    coreIssues,
  );
  const temperatureMax = parseMeasurement(
    record.temperatureMax,
    `${path}.temperatureMax`,
    coreIssues,
  );
  const temperatureMin = parseMeasurement(
    record.temperatureMin,
    `${path}.temperatureMin`,
    coreIssues,
  );
  if (
    forecastStartTime !== undefined &&
    forecastEndTime !== undefined &&
    Date.parse(forecastEndTime) <= Date.parse(forecastStartTime)
  ) {
    addIssue(
      coreIssues,
      `${path}.forecastEndTime`,
      "invalid_value",
      "Forecast end time must be after its start time.",
    );
  }

  if (
    hasBlockingIssue(coreIssues) ||
    forecastStartTime === undefined ||
    forecastEndTime === undefined ||
    temperatureMax === undefined ||
    temperatureMin === undefined
  ) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid daily forecast entry was dropped.");
    return undefined;
  }
  warnings.push(...coreIssues);

  return {
    forecastStartTime,
    forecastEndTime,
    temperatureMax,
    temperatureMin,
    temperatureAvg: parseOptionalMeasurement(
      record.temperatureAvg,
      `${path}.temperatureAvg`,
      warnings,
    ),
    uvIndexMax: parseOptionalFiniteNumber(record.uvIndexMax, `${path}.uvIndexMax`, warnings, {
      min: 0,
      max: 15,
    }),
    daytime: parseForecastPeriod(record.daytime, `${path}.daytime`, warnings),
    nighttime: parseForecastPeriod(record.nighttime, `${path}.nighttime`, warnings),
  };
}

function parseHourlyItem(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwHourlyItem | undefined {
  const coreIssues: ParseIssue[] = [];
  const record = parseRequiredRecord(value, path, coreIssues);
  if (!record) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid hourly forecast entry was dropped.");
    return undefined;
  }
  const forecastTime = parseRequiredDateTime(
    record.forecastTime,
    `${path}.forecastTime`,
    coreIssues,
  );
  if (hasBlockingIssue(coreIssues) || forecastTime === undefined) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid hourly forecast entry was dropped.");
    return undefined;
  }
  warnings.push(...coreIssues);
  return {
    forecastTime,
    condition: parseOptionalCondition(record.condition, `${path}.condition`, warnings),
    temperature: parseOptionalMeasurement(record.temperature, `${path}.temperature`, warnings),
    feelsLike: parseOptionalMeasurement(record.feelsLike, `${path}.feelsLike`, warnings),
    humidity: parseOptionalFiniteNumber(record.humidity, `${path}.humidity`, warnings, {
      min: 0,
      max: 1,
    }),
    wind: parseWind(record.wind, `${path}.wind`, warnings),
    windGust: parseOptionalMeasurement(record.windGust, `${path}.windGust`, warnings),
    precipitation: parsePrecipitation(
      record.precipitation,
      `${path}.precipitation`,
      warnings,
    ),
    pressure: parseOptionalMeasurement(record.pressure, `${path}.pressure`, warnings),
    visibility: parseOptionalMeasurement(record.visibility, `${path}.visibility`, warnings),
    dewPoint: parseOptionalMeasurement(record.dewPoint, `${path}.dewPoint`, warnings),
    cloudCover: parseOptionalFiniteNumber(record.cloudCover, `${path}.cloudCover`, warnings, {
      min: 0,
      max: 1,
    }),
    uvIndex: parseOptionalFiniteNumber(record.uvIndex, `${path}.uvIndex`, warnings, {
      min: 0,
      max: 15,
    }),
  };
}

function parseOptionalMessageType(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwAlert["messageType"] | undefined {
  const record = parseOptionalRecord(value, path, warnings);
  if (!record) {
    return undefined;
  }
  const code = parseOptionalText(record.code, `${path}.code`, warnings, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });
  const supersedes = parseTextArray(record.supersedes, `${path}.supersedes`, warnings, {
    maxItems: ARRAY_LIMITS.supersedes,
    maxTextLength: QWEATHER_TEXT_LIMITS.alertId,
  });
  if (code === undefined && supersedes === undefined) {
    return undefined;
  }
  return { code, supersedes };
}

function parseOptionalEventType(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwAlert["eventType"] | undefined {
  const record = parseOptionalRecord(value, path, warnings);
  if (!record) {
    return undefined;
  }
  const name = parseOptionalText(record.name, `${path}.name`, warnings, {
    maxLength: QWEATHER_TEXT_LIMITS.senderName,
  });
  const code = parseOptionalText(record.code, `${path}.code`, warnings, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });
  if (name === undefined && code === undefined) {
    return undefined;
  }
  return { name, code };
}

function parseOptionalAlertColor(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwAlertColor | undefined {
  const record = parseOptionalRecord(value, path, warnings);
  if (!record) {
    return undefined;
  }
  const code = parseOptionalText(record.code, `${path}.code`, warnings, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });
  const red = parseOptionalFiniteNumber(record.red, `${path}.red`, warnings, { min: 0, max: 255 });
  const green = parseOptionalFiniteNumber(record.green, `${path}.green`, warnings, {
    min: 0,
    max: 255,
  });
  const blue = parseOptionalFiniteNumber(record.blue, `${path}.blue`, warnings, {
    min: 0,
    max: 255,
  });
  const alpha = parseOptionalFiniteNumber(record.alpha, `${path}.alpha`, warnings, {
    min: 0,
    max: 1,
  });
  if (
    code === undefined &&
    red === undefined &&
    green === undefined &&
    blue === undefined &&
    alpha === undefined
  ) {
    return undefined;
  }
  return { code, red, green, blue, alpha };
}

function parseAlert(value: unknown, path: string, warnings: ParseIssue[]): QwAlert | undefined {
  const coreIssues: ParseIssue[] = [];
  const record = parseRequiredRecord(value, path, coreIssues);
  if (!record) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid alert entry was dropped.");
    return undefined;
  }
  const id = parseRequiredText(record.id, `${path}.id`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.alertId,
  });
  if (hasBlockingIssue(coreIssues) || id === undefined) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Alert without a usable ID was dropped.");
    return undefined;
  }
  warnings.push(...coreIssues);

  return {
    id,
    senderName: parseOptionalText(record.senderName, `${path}.senderName`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.senderName,
    }),
    issuedTime: parseOptionalDateTime(record.issuedTime, `${path}.issuedTime`, warnings),
    messageType: parseOptionalMessageType(record.messageType, `${path}.messageType`, warnings),
    eventType: parseOptionalEventType(record.eventType, `${path}.eventType`, warnings),
    urgency: parseOptionalText(record.urgency, `${path}.urgency`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.code,
    }),
    severity: parseOptionalText(record.severity, `${path}.severity`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.code,
    }),
    certainty: parseOptionalText(record.certainty, `${path}.certainty`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.code,
    }),
    icon: parseOptionalText(record.icon, `${path}.icon`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.code,
    }),
    color: parseOptionalAlertColor(record.color, `${path}.color`, warnings),
    effectiveTime: parseOptionalDateTime(record.effectiveTime, `${path}.effectiveTime`, warnings),
    onsetTime: parseOptionalDateTime(record.onsetTime, `${path}.onsetTime`, warnings),
    expireTime: parseOptionalDateTime(record.expireTime, `${path}.expireTime`, warnings),
    headline: parseOptionalText(record.headline, `${path}.headline`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.headline,
    }),
    description: parseOptionalText(record.description, `${path}.description`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.description,
      multiline: true,
    }),
    criteria: parseOptionalText(record.criteria, `${path}.criteria`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.criteria,
      multiline: true,
    }),
    responseTypes: parseTextArray(record.responseTypes, `${path}.responseTypes`, warnings, {
      maxItems: ARRAY_LIMITS.responseTypes,
      maxTextLength: QWEATHER_TEXT_LIMITS.code,
    }),
    instruction: parseOptionalText(record.instruction, `${path}.instruction`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.instruction,
      multiline: true,
    }),
  };
}

function parseStrictDecimal(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!DECIMAL_NUMBER.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCoordinate(
  value: unknown,
  path: string,
  issues: ParseIssue[],
  range: { min: number; max: number },
): number | undefined {
  const parsed = parseStrictDecimal(value);
  if (parsed === undefined) {
    addIssue(issues, path, "invalid_type", "Expected a decimal coordinate.");
    return undefined;
  }
  if (parsed < range.min || parsed > range.max) {
    addIssue(issues, path, "invalid_value", "Coordinate is outside its valid range.");
    return undefined;
  }
  return parsed;
}

function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseOptionalHttpUrl(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): string | undefined {
  const parsed = parseOptionalText(value, path, warnings, {
    maxLength: QWEATHER_TEXT_LIMITS.attribution,
  });
  if (parsed === undefined) {
    return undefined;
  }
  try {
    const url = new URL(parsed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    addIssue(warnings, path, "invalid_value", "Expected an HTTP or HTTPS URL.");
    return undefined;
  }
}

function parseGeoLocation(
  value: unknown,
  path: string,
  warnings: ParseIssue[],
): QwGeoLocation | undefined {
  const coreIssues: ParseIssue[] = [];
  const record = parseRequiredRecord(value, path, coreIssues);
  if (!record) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid GeoAPI candidate was dropped.");
    return undefined;
  }
  const name = parseRequiredText(record.name, `${path}.name`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.locationName,
  });
  const id = parseRequiredText(record.id, `${path}.id`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.locationId,
  });
  const latitude = parseCoordinate(record.lat, `${path}.lat`, coreIssues, { min: -90, max: 90 });
  const longitude = parseCoordinate(record.lon, `${path}.lon`, coreIssues, {
    min: -180,
    max: 180,
  });
  const adm2 = parseRequiredText(record.adm2, `${path}.adm2`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.administrativeName,
  });
  const adm1 = parseRequiredText(record.adm1, `${path}.adm1`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.administrativeName,
  });
  const country = parseRequiredText(record.country, `${path}.country`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.administrativeName,
  });
  const timezone = parseRequiredText(record.tz, `${path}.tz`, coreIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.timezone,
  });
  if (timezone !== undefined && !isValidIanaTimezone(timezone)) {
    addIssue(coreIssues, `${path}.tz`, "invalid_value", "Expected a valid IANA timezone.");
  }
  if (
    hasBlockingIssue(coreIssues) ||
    name === undefined ||
    id === undefined ||
    latitude === undefined ||
    longitude === undefined ||
    adm2 === undefined ||
    adm1 === undefined ||
    country === undefined ||
    timezone === undefined
  ) {
    warnings.push(...coreIssues);
    addIssue(warnings, path, "dropped_item", "Invalid GeoAPI candidate was dropped.");
    return undefined;
  }
  warnings.push(...coreIssues);

  return {
    name,
    id,
    latitude,
    longitude,
    adm2,
    adm1,
    country,
    timezone,
    utcOffset: parseOptionalText(record.utcOffset, `${path}.utcOffset`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.shortValue,
    }),
    isDst: parseOptionalText(record.isDst, `${path}.isDst`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.shortValue,
    }),
    type: parseOptionalText(record.type, `${path}.type`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.shortValue,
    }),
    rank: parseOptionalText(record.rank, `${path}.rank`, warnings, {
      maxLength: QWEATHER_TEXT_LIMITS.shortValue,
    }),
    fxLink: parseOptionalHttpUrl(record.fxLink, `${path}.fxLink`, warnings),
  };
}

function failed<T>(fatalIssues: ParseIssue[], warnings: ParseIssue[]): ParseResult<T> {
  return { ok: false, issues: [...fatalIssues, ...warnings] };
}

export function parseQWeatherCurrent(input: unknown): ParseResult<QwCurrentResponse> {
  const fatalIssues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const record = parseRequiredRecord(input, "$", fatalIssues);
  if (!record) {
    return failed(fatalIssues, warnings);
  }

  const metadata = parseMetadata(record.metadata, "$.metadata", fatalIssues, warnings);
  const condition = parseCondition(record.condition, "$.condition", fatalIssues);
  const temperature = parseMeasurement(record.temperature, "$.temperature", fatalIssues);
  if (
    hasBlockingIssue(fatalIssues) ||
    metadata === undefined ||
    condition === undefined ||
    temperature === undefined
  ) {
    return failed(fatalIssues, warnings);
  }
  warnings.push(...fatalIssues);

  return {
    ok: true,
    data: {
      metadata,
      condition,
      temperature,
      feelsLike: parseOptionalMeasurement(record.feelsLike, "$.feelsLike", warnings),
      humidity: parseOptionalFiniteNumber(record.humidity, "$.humidity", warnings, {
        min: 0,
        max: 1,
      }),
      wind: parseWind(record.wind, "$.wind", warnings),
      windGust: parseOptionalMeasurement(record.windGust, "$.windGust", warnings),
      precipitation: parsePrecipitation(record.precipitation, "$.precipitation", warnings),
      pressure: parseOptionalMeasurement(record.pressure, "$.pressure", warnings),
      visibility: parseOptionalMeasurement(record.visibility, "$.visibility", warnings),
      dewPoint: parseOptionalMeasurement(record.dewPoint, "$.dewPoint", warnings),
      cloudCover: parseOptionalFiniteNumber(record.cloudCover, "$.cloudCover", warnings, {
        min: 0,
        max: 1,
      }),
      uvIndex: parseOptionalFiniteNumber(record.uvIndex, "$.uvIndex", warnings, {
        min: 0,
        max: 15,
      }),
    },
    warnings,
  };
}

export function parseQWeatherDaily(input: unknown): ParseResult<QwDailyResponse> {
  const fatalIssues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const record = parseRequiredRecord(input, "$", fatalIssues);
  if (!record) {
    return failed(fatalIssues, warnings);
  }
  const metadata = parseMetadata(record.metadata, "$.metadata", fatalIssues, warnings);
  const rawDays = parseRequiredArray(record.days, "$.days", fatalIssues);
  if (hasBlockingIssue(fatalIssues) || metadata === undefined || rawDays === undefined) {
    return failed(fatalIssues, warnings);
  }
  warnings.push(...fatalIssues);

  const days: QwDailyItem[] = [];
  for (const [index, value] of limitArray(rawDays, ARRAY_LIMITS.days, "$.days", warnings).entries()) {
    const parsed = parseDailyItem(value, `$.days[${index}]`, warnings);
    if (parsed) {
      days.push(parsed);
    }
  }
  return { ok: true, data: { metadata, days }, warnings };
}

export function parseQWeatherHourly(input: unknown): ParseResult<QwHourlyResponse> {
  const fatalIssues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const record = parseRequiredRecord(input, "$", fatalIssues);
  if (!record) {
    return failed(fatalIssues, warnings);
  }
  const metadata = parseMetadata(record.metadata, "$.metadata", fatalIssues, warnings);
  const rawHours = parseRequiredArray(record.hours, "$.hours", fatalIssues);
  if (hasBlockingIssue(fatalIssues) || metadata === undefined || rawHours === undefined) {
    return failed(fatalIssues, warnings);
  }
  warnings.push(...fatalIssues);

  const hours: QwHourlyItem[] = [];
  for (const [index, value] of limitArray(rawHours, ARRAY_LIMITS.hours, "$.hours", warnings).entries()) {
    const parsed = parseHourlyItem(value, `$.hours[${index}]`, warnings);
    if (parsed) {
      hours.push(parsed);
    }
  }
  return { ok: true, data: { metadata, hours }, warnings };
}

export function parseQWeatherAlerts(input: unknown): ParseResult<QwAlertResponse> {
  const fatalIssues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const record = parseRequiredRecord(input, "$", fatalIssues);
  if (!record) {
    return failed(fatalIssues, warnings);
  }
  const metadata = parseMetadata(record.metadata, "$.metadata", fatalIssues, warnings);
  const metadataRecord = isRecord(record.metadata) ? record.metadata : undefined;
  let zeroResult: boolean | undefined;
  if (metadataRecord?.zeroResult !== null && metadataRecord?.zeroResult !== undefined) {
    if (typeof metadataRecord.zeroResult === "boolean") {
      zeroResult = metadataRecord.zeroResult;
    } else {
      addIssue(
        warnings,
        "$.metadata.zeroResult",
        "invalid_type",
        "Expected zeroResult to be boolean or null.",
      );
    }
  }
  const rawAlerts = parseRequiredArray(record.alerts, "$.alerts", fatalIssues);
  if (hasBlockingIssue(fatalIssues) || metadata === undefined || rawAlerts === undefined) {
    return failed(fatalIssues, warnings);
  }
  warnings.push(...fatalIssues);

  const alerts: QwAlert[] = [];
  for (const [index, value] of limitArray(
    rawAlerts,
    ARRAY_LIMITS.alerts,
    "$.alerts",
    warnings,
  ).entries()) {
    const parsed = parseAlert(value, `$.alerts[${index}]`, warnings);
    if (parsed) {
      alerts.push(parsed);
    }
  }

  if (zeroResult === true && rawAlerts.length > 0) {
    addIssue(
      warnings,
      "$.metadata.zeroResult",
      "inconsistent_response",
      "zeroResult is true while the original alerts array is not empty.",
    );
  } else if (rawAlerts.length === 0 && zeroResult !== true) {
    addIssue(
      warnings,
      "$.alerts",
      "inconsistent_response",
      "An empty alerts array without zeroResult=true cannot prove that no alert is active.",
    );
  }

  const state =
    alerts.length > 0
      ? "active"
      : rawAlerts.length === 0 && zeroResult === true
        ? "none"
        : "indeterminate";

  return {
    ok: true,
    data: { metadata: { ...metadata, zeroResult }, alerts, state },
    warnings,
  };
}

export function parseQWeatherGeoLookup(input: unknown): ParseResult<QwGeoLookupResponse> {
  const fatalIssues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const record = parseRequiredRecord(input, "$", fatalIssues);
  if (!record) {
    return failed(fatalIssues, warnings);
  }
  const code = parseRequiredText(record.code, "$.code", fatalIssues, {
    maxLength: QWEATHER_TEXT_LIMITS.code,
  });

  let rawLocations: unknown[] = [];
  if (record.location !== null && record.location !== undefined) {
    const parsedLocations = parseRequiredArray(record.location, "$.location", fatalIssues);
    if (parsedLocations) {
      rawLocations = parsedLocations;
    }
  } else if (code === "200") {
    addIssue(fatalIssues, "$.location", "missing_field", "Successful GeoAPI response lacks locations.");
  }
  if (hasBlockingIssue(fatalIssues) || code === undefined) {
    return failed(fatalIssues, warnings);
  }
  warnings.push(...fatalIssues);

  const locations: QwGeoLocation[] = [];
  for (const [index, value] of limitArray(
    rawLocations,
    ARRAY_LIMITS.geoLocations,
    "$.location",
    warnings,
  ).entries()) {
    const parsed = parseGeoLocation(value, `$.location[${index}]`, warnings);
    if (parsed) {
      locations.push(parsed);
    }
  }

  let attributions: string[] = [];
  let licenses: string[] = [];
  const refer = parseOptionalRecord(record.refer, "$.refer", warnings);
  if (refer) {
    attributions =
      parseTextArray(refer.sources, "$.refer.sources", warnings, {
        maxItems: ARRAY_LIMITS.attributions,
        maxTextLength: QWEATHER_TEXT_LIMITS.attribution,
      }) ?? [];
    licenses =
      parseTextArray(refer.license, "$.refer.license", warnings, {
        maxItems: ARRAY_LIMITS.licenses,
        maxTextLength: QWEATHER_TEXT_LIMITS.attribution,
      }) ?? [];
  }

  return { ok: true, data: { code, locations, attributions, licenses }, warnings };
}
