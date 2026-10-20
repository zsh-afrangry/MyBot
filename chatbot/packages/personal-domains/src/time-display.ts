/** Presentation only: callers retain their original epoch/TTL for authorization. */
export function formatTimestamp<T extends string>(atUtc: number, timezone: T) {
  return { utc: new Date(atUtc * 1000).toISOString(), local: formatDateTime(atUtc, timezone), timezone };
}

/** Deterministic ISO-style local timestamp; never ask the model to calculate epoch dates. */
export function formatDateTime(atUtc: number, timezone: string): string;
export function formatDateTime(atUtc: number | null, timezone: string): string | null;
export function formatDateTime(atUtc: number | null, timezone: string): string | null {
  if (atUtc === null) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(atUtc * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  const offset = value("timeZoneName").replace(/^GMT/u, "") || "+00:00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}${offset}`;
}
