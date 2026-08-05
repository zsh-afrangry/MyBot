/**
 * Runtime-normalized QWeather data used by the personal-weather plugin.
 *
 * Network payloads must enter the parser as `unknown`. These interfaces only
 * describe values that have already passed the checks in `parsers.ts`.
 */

export type IsoDateTime = string;

export type ParseIssueCode =
  | "invalid_type"
  | "missing_field"
  | "invalid_value"
  | "dropped_item"
  | "truncated_array"
  | "truncated_text"
  | "sanitized_text"
  | "inconsistent_response";

export interface ParseIssue {
  /** JSON-style path. It never contains a value copied from the response. */
  path: string;
  code: ParseIssueCode;
  /** Stable, non-sensitive explanation suitable for diagnostics. */
  message: string;
}

export type ParseResult<T> =
  | {
      ok: true;
      data: T;
      /** Recoverable problems, including individual records that were dropped. */
      warnings: ParseIssue[];
    }
  | {
      ok: false;
      /** Fatal structural problems. Raw response values are never included. */
      issues: ParseIssue[];
    };

export interface QwMetadata {
  tag: string;
  attributions: string[];
}

export interface QwMeasurement {
  value: number;
  unit: string;
}

export interface QwCondition {
  text: string;
  code: string;
}

export interface QwWind {
  direction?: {
    degree?: number | undefined;
    /** Kept open so new QWeather compass codes remain usable. */
    compass?: string | undefined;
  } | undefined;
  speed?: QwMeasurement | undefined;
  scale?: number | undefined;
}

export interface QwPrecipitation {
  amount?: QwMeasurement | undefined;
  intensity?: QwMeasurement | undefined;
  /** QWeather v1 represents probability as a ratio in the inclusive range 0..1. */
  probability?: number | undefined;
  /** Kept open so new precipitation types remain usable. */
  type?: string | undefined;
}

export interface QwCurrentResponse {
  metadata: QwMetadata;
  condition: QwCondition;
  temperature: QwMeasurement;
  feelsLike?: QwMeasurement | undefined;
  humidity?: number | undefined;
  wind?: QwWind | undefined;
  windGust?: QwMeasurement | undefined;
  precipitation?: QwPrecipitation | undefined;
  pressure?: QwMeasurement | undefined;
  visibility?: QwMeasurement | undefined;
  dewPoint?: QwMeasurement | undefined;
  cloudCover?: number | undefined;
  uvIndex?: number | undefined;
}

export interface QwForecastPeriod {
  forecastStartTime: IsoDateTime;
  forecastEndTime: IsoDateTime;
  condition?: QwCondition | undefined;
  temperatureMax?: QwMeasurement | undefined;
  temperatureMin?: QwMeasurement | undefined;
  humidity?: number | undefined;
  wind?: QwWind | undefined;
  windGustMax?: QwMeasurement | undefined;
  precipitation?: QwPrecipitation | undefined;
  cloudCover?: number | undefined;
}

export interface QwDailyItem {
  forecastStartTime: IsoDateTime;
  forecastEndTime: IsoDateTime;
  temperatureMax: QwMeasurement;
  temperatureMin: QwMeasurement;
  temperatureAvg?: QwMeasurement | undefined;
  uvIndexMax?: number | undefined;
  daytime?: QwForecastPeriod | undefined;
  nighttime?: QwForecastPeriod | undefined;
}

export interface QwDailyResponse {
  metadata: QwMetadata;
  /** Invalid individual entries are removed by the parser. */
  days: QwDailyItem[];
}

export interface QwHourlyItem {
  forecastTime: IsoDateTime;
  condition?: QwCondition | undefined;
  temperature?: QwMeasurement | undefined;
  feelsLike?: QwMeasurement | undefined;
  humidity?: number | undefined;
  wind?: QwWind | undefined;
  windGust?: QwMeasurement | undefined;
  precipitation?: QwPrecipitation | undefined;
  pressure?: QwMeasurement | undefined;
  visibility?: QwMeasurement | undefined;
  dewPoint?: QwMeasurement | undefined;
  cloudCover?: number | undefined;
  uvIndex?: number | undefined;
}

export interface QwHourlyResponse {
  metadata: QwMetadata;
  /** Invalid individual entries are removed by the parser. */
  hours: QwHourlyItem[];
}

export interface QwAlertColor {
  /** Kept open so new color codes remain usable. */
  code?: string | undefined;
  red?: number | undefined;
  green?: number | undefined;
  blue?: number | undefined;
  alpha?: number | undefined;
}

export interface QwAlert {
  id: string;
  senderName?: string | undefined;
  issuedTime?: IsoDateTime | undefined;
  messageType?: {
    /** Kept open so new message types remain usable. */
    code?: string | undefined;
    supersedes?: string[] | undefined;
  } | undefined;
  eventType?: {
    name?: string | undefined;
    code?: string | undefined;
  } | undefined;
  urgency?: string | undefined;
  severity?: string | undefined;
  certainty?: string | undefined;
  icon?: string | undefined;
  color?: QwAlertColor | undefined;
  effectiveTime?: IsoDateTime | undefined;
  onsetTime?: IsoDateTime | undefined;
  expireTime?: IsoDateTime | undefined;
  headline?: string | undefined;
  description?: string | undefined;
  criteria?: string | undefined;
  responseTypes?: string[] | undefined;
  instruction?: string | undefined;
}

/**
 * `none` is intentionally narrow: it is emitted only when QWeather returned
 * `metadata.zeroResult === true` and the original alerts array was empty.
 */
export type QwAlertState = "active" | "none" | "indeterminate";

export interface QwAlertResponse {
  metadata: QwMetadata & { zeroResult?: boolean | undefined };
  alerts: QwAlert[];
  state: QwAlertState;
}

export interface QwGeoLocation {
  name: string;
  id: string;
  latitude: number;
  longitude: number;
  adm2: string;
  adm1: string;
  country: string;
  timezone: string;
  utcOffset?: string | undefined;
  isDst?: string | undefined;
  type?: string | undefined;
  rank?: string | undefined;
  fxLink?: string | undefined;
}

export interface QwGeoLookupResponse {
  /** GeoAPI v2 returns a string status code in its JSON body. */
  code: string;
  /** Invalid individual candidates are removed by the parser. */
  locations: QwGeoLocation[];
  attributions: string[];
  licenses: string[];
}
