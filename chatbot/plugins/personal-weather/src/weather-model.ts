import type {
  QwAlert,
  QwAlertState,
  QwCondition,
  QwMeasurement,
  QwPrecipitation,
  QwWind,
} from "./types.js";

export interface WeatherLocation {
  displayName: string;
  shortName: string;
  latitude: number;
  longitude: number;
  timezone: string;
  qweatherLocationId?: string;
}

export type ComponentState = "fresh" | "cached-fresh" | "unavailable";

export interface ComponentQuality {
  state: ComponentState;
  fetchedAt?: string;
  publicErrorCode?: string;
}

export interface RainWindow {
  startTime: string;
  endTime: string;
  maxProbability?: number;
  precipitationType?: string;
}

export interface WeatherBrief {
  schemaVersion: 1;
  location: WeatherLocation;
  generatedAt: string;
  current: {
    condition: QwCondition;
    temperature: QwMeasurement;
    feelsLike?: QwMeasurement;
    humidity?: number;
    wind?: QwWind;
    precipitation?: QwPrecipitation;
    uvIndex?: number;
  };
  today?: {
    forecastStartTime: string;
    forecastEndTime: string;
    temperatureMax: QwMeasurement;
    temperatureMin: QwMeasurement;
    daytimeCondition?: QwCondition;
    nighttimeCondition?: QwCondition;
    uvIndexMax?: number;
  };
  next24Hours?: {
    availableHours: number;
    maxPrecipitationProbability?: number;
    rainWindows: RainWindow[];
  };
  alerts: {
    availability: "available" | "unavailable";
    state: QwAlertState | "unavailable";
    items: QwAlert[];
  };
  attributions: string[];
  quality: Record<"current" | "daily" | "hourly" | "alerts", ComponentQuality>;
  warnings: string[];
}

export type WeatherBriefResult =
  | {
      ok: true;
      brief: WeatherBrief;
      formattedText: string;
    }
  | {
      ok: false;
      code: string;
      retryable: boolean;
      message: string;
    };
