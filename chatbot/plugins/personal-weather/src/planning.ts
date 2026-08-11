import { createHash } from "node:crypto";

import { OWNER_SUBJECT_ID } from "./store.js";
import type {
  EffectivePlace,
  NotificationPreferences,
  PendingProposalSummary,
  Place,
  TripCreateCommitInput,
  TripCreateProposalForCommit,
  TripSummary,
  UnixSeconds,
  WeatherStore,
} from "./store.js";

const PROPOSAL_TTL_SECONDS = 24 * 60 * 60;
const MAX_TEXT_LENGTH = 200;
const MAX_TIME_HORIZON_SECONDS = 2 * 366 * 24 * 60 * 60;

export const TRANSPORT_MODES = [
  "unknown",
  "air",
  "rail",
  "car",
  "bus",
  "ship",
  "other",
] as const;

export const TIME_PRECISIONS = ["date", "window", "exact"] as const;

export type TransportMode = (typeof TRANSPORT_MODES)[number];
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

export interface PlanningPlaceSummary {
  displayName: string;
  countryCode: string;
  timezone: string;
  precision: Place["precision"];
}

export interface PlanningTimeWindow {
  earliest: string;
  latest: string;
  precision: TimePrecision;
  timezone: string;
}

export interface PlanningState {
  ok: true;
  schemaVersion: 1;
  asOfUtc: UnixSeconds;
  weather: {
    defaultPlace: PlanningPlaceSummary;
    effectivePlace: PlanningPlaceSummary;
    effectiveSource: EffectivePlace["source"];
    dailyBrief: {
      enabled: boolean;
      localTime: string;
      timezoneMode: NotificationPreferences["dailyTimezoneMode"];
      timezone: string;
    };
  };
  trips: TripSummary[];
  pendingProposals: PendingProposalSummary[];
  capabilities: {
    stateRead: true;
    proposalPreview: true;
    proposalCommit: true;
    locationChange: false;
    scheduleChange: false;
  };
}

export interface PlanningChangeProposeInput {
  schema_version: 1;
  request: {
    kind: "trip.create";
    title?: string;
    destination: {
      text: string;
      administrative_area?: string;
    };
    transport_mode?: TransportMode;
    departure?: PlanningTimeWindow;
    arrival?: PlanningTimeWindow;
    weather_mode?: "none" | "dual_city" | "switch_at_arrival";
  };
}

export interface PlanningChangeProposalResult {
  ok: true;
  schemaVersion: 1;
  proposalId: string;
  payloadHash: string;
  status: "pending";
  kind: "trip_create";
  previewText: string;
  canonicalFacts: {
    domain: "weather_travel";
    schemaVersion: 1;
    kind: "trip_create";
    title: string;
    origin: PlanningPlaceSummary;
    destination: {
      text: string;
      administrativeArea: string | null;
      resolution: "pending";
    };
    transportMode: TransportMode;
    departure: PlanningTimeWindow | null;
    arrival: PlanningTimeWindow | null;
    weatherMode: "none" | "dual_city" | "switch_at_arrival";
    sourceKind: "owner_text";
  };
  derivedEffects: [];
  missingFields: Array<"destination_place" | "arrival_time_window">;
  warnings: string[];
  requiresConfirmation: true;
  expiresAtUtc: UnixSeconds;
  persistedAs: "change_proposals";
}

export interface PlanningCommitInput {
  proposal_id: string;
  payload_hash: string;
}

export interface PlanningCommitResult {
  ok: true;
  schemaVersion: 1;
  proposalId: string;
  status: "committed";
  idempotent: boolean;
  trip: TripSummary;
  locationPeriodCreated: false;
  weatherLocationChanged: false;
  warnings: string[];
}

export type PlanningFailure = {
  ok: false;
  error: {
    code:
      | "invalid_input"
      | "unsupported_request"
      | "proposal_not_found"
      | "proposal_hash_mismatch"
      | "proposal_expired"
      | "proposal_unavailable"
      | "proposal_payload_invalid";
    message: string;
  };
};

export function getPlanningState(store: WeatherStore): PlanningState {
  const asOfUtc = store.getNowUtc();
  const defaultPlace = store.getDefaultPlace();
  const effectivePlace = store.getEffectivePlace(asOfUtc);
  const preferences = store.getNotificationPreferences();

  return {
    ok: true,
    schemaVersion: 1,
    asOfUtc,
    weather: {
      defaultPlace: summarizePlace(defaultPlace),
      effectivePlace: summarizePlace(effectivePlace.place),
      effectiveSource: effectivePlace.source,
      dailyBrief: {
        enabled: preferences.dailyEnabled,
        localTime: formatMinuteOfDay(preferences.dailyMinuteOfDay),
        timezoneMode: preferences.dailyTimezoneMode,
        timezone: preferences.dailyTimezone,
      },
    },
    trips: store.listTripSummaries(),
    pendingProposals: store.listPendingProposals(),
    capabilities: {
      stateRead: true,
      proposalPreview: true,
      proposalCommit: true,
      locationChange: false,
      scheduleChange: false,
    },
  };
}

/**
 * Commit exactly one previously previewed `trip.create` proposal. All model
 * supplied fields are just identifiers for a frozen server-side payload; the
 * actual trip data is parsed again from that payload before the store executes
 * its transaction.
 */
export function commitPlanningProposal(
  store: WeatherStore,
  rawInput: unknown,
): PlanningCommitResult | PlanningFailure {
  const parsed = parseCommitInput(rawInput);
  if (!parsed.ok) return parsed;
  const nowUtc = store.getNowUtc();

  return store.withPlanningTransaction((repository) => {
    const proposal = repository.getTripCreateProposal(parsed.input.proposalId);
    if (!proposal) {
      return proposalFailure("proposal_not_found", "未找到可提交的行程提案。");
    }
    if (proposal.payloadHash !== parsed.input.payloadHash) {
      return proposalFailure("proposal_hash_mismatch", "提案内容已变化，请重新查询状态并确认最新预览。");
    }

    const expectedContextHash = createHash("sha256")
      .update(`${OWNER_SUBJECT_ID}|${proposal.kind}|${proposal.payloadHash}`)
      .digest("hex");
    if (proposal.requestContextHash !== expectedContextHash) {
      return proposalFailure("proposal_unavailable", "该提案的确认上下文无效，请重新创建提案。");
    }

    if (proposal.status === "committed") {
      const trip = proposal.resultTripId === null
        ? undefined
        : repository.getTripSummary(proposal.resultTripId);
      if (!trip) {
        return proposalFailure("proposal_unavailable", "该提案的已提交记录不完整，不能重复提交。");
      }
      return committedResult(proposal.proposalId, trip, true);
    }
    if (proposal.status !== "pending") {
      return proposalFailure("proposal_unavailable", "该提案已不可提交，请重新创建一条新的提案。");
    }
    if (proposal.expiresAtUtc <= nowUtc) {
      if (!repository.expirePendingProposal(proposal.proposalId, nowUtc)) {
        throw new Error("Proposal changed while being expired");
      }
      repository.insertOwnerAudit({
        action: "proposal.expired",
        entityType: "change_proposal",
        entityId: proposal.proposalId,
        proposalId: proposal.proposalId,
        summaryJson: JSON.stringify({ kind: "trip_create", reason: "ttl_expired" }),
        atUtc: nowUtc,
      });
      return proposalFailure("proposal_expired", "该提案已过期，未提交任何行程。请重新创建提案。");
    }

    let commitInput: TripCreateCommitInput;
    try {
      commitInput = buildCommitInput(proposal, store, nowUtc);
    } catch (error) {
      return proposalFailure(
        "proposal_payload_invalid",
        error instanceof Error ? error.message : "提案内容无法安全提交。",
      );
    }

    const tripId = repository.insertPlannedTrip(commitInput, nowUtc);
    if (!repository.markProposalCommitted({
      proposalId: proposal.proposalId,
      payloadHash: proposal.payloadHash,
      tripId,
      atUtc: nowUtc,
    })) {
      throw new Error("Proposal changed while being committed");
    }
    repository.insertOwnerAudit({
      action: "trip.committed",
      entityType: "trip",
      entityId: String(tripId),
      proposalId: proposal.proposalId,
      summaryJson: JSON.stringify({
        kind: "trip_create",
        weatherLocationChanged: false,
        locationPeriodCreated: false,
      }),
      atUtc: nowUtc,
    });
    const trip = repository.getTripSummary(tripId);
    if (!trip) throw new Error("Committed trip could not be read back");
    return committedResult(proposal.proposalId, trip, false);
  });
}

export function proposePlanningChange(
  store: WeatherStore,
  rawInput: unknown,
): PlanningChangeProposalResult | PlanningFailure {
  const asOfUtc = store.getNowUtc();
  const parsed = parsePlanningChangeInput(rawInput, asOfUtc);
  if (!parsed.ok) {
    return parsed;
  }

  const origin = summarizePlace(store.getEffectivePlace(asOfUtc).place);
  const request = parsed.input.request;
  const title = request.title ?? `前往${request.destination.text}的出行计划`;
  const transportMode = request.transport_mode ?? "unknown";
  const weatherMode = request.weather_mode ?? "none";
  const canonicalFacts: PlanningChangeProposalResult["canonicalFacts"] = {
    domain: "weather_travel",
    schemaVersion: 1,
    kind: "trip_create",
    title,
    origin,
    destination: {
      text: request.destination.text,
      administrativeArea: request.destination.administrative_area ?? null,
      resolution: "pending",
    },
    transportMode,
    departure: request.departure ?? null,
    arrival: request.arrival ?? null,
    weatherMode,
    sourceKind: "owner_text",
  };

  const missingFields: PlanningChangeProposalResult["missingFields"] = [
    "destination_place",
  ];
  const warnings = [
    "目的地尚未通过受控地点目录消歧；当前提案不会切换天气地点。",
  ];
  if (request.arrival === undefined) {
    missingFields.push("arrival_time_window");
    warnings.push("尚未提供到达时间窗；当前提案不会切换天气地点，仅记录出行意图。");
  } else if (request.arrival.precision === "date") {
    missingFields.push("arrival_time_window");
    warnings.push("到达信息只有日期精度；需要明确到达时间或时间窗后，才可能派生天气地点。");
  }

  const payloadJson = JSON.stringify(canonicalFacts);
  const previewText = buildProposalPreview(canonicalFacts, missingFields, warnings);
  const created = store.createPendingProposal({
    kind: "trip_create",
    payloadJson,
    previewText,
    expiresAtUtc: asOfUtc + PROPOSAL_TTL_SECONDS,
  });

  return {
    ok: true,
    schemaVersion: 1,
    proposalId: created.proposalId,
    payloadHash: created.payloadHash,
    status: "pending",
    kind: "trip_create",
    previewText,
    canonicalFacts,
    derivedEffects: [],
    missingFields,
    warnings,
    requiresConfirmation: true,
    expiresAtUtc: created.expiresAtUtc,
    persistedAs: "change_proposals",
  };
}

function parseCommitInput(
  rawInput: unknown,
): { ok: true; input: { proposalId: string; payloadHash: string } } | PlanningFailure {
  if (!isRecord(rawInput) || !hasOnlyKeys(rawInput, ["proposal_id", "payload_hash"])) {
    return invalidInput("提交请求只能包含 proposal_id 和 payload_hash。");
  }
  const proposalId = rawInput.proposal_id;
  if (
    typeof proposalId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(proposalId)
  ) {
    return invalidInput("proposal_id 必须是提案预览返回的 UUID。");
  }
  const payloadHash = rawInput.payload_hash;
  if (typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/u.test(payloadHash)) {
    return invalidInput("payload_hash 必须匹配提案预览返回的内容哈希。");
  }
  return { ok: true, input: { proposalId, payloadHash } };
}

function buildCommitInput(
  proposal: TripCreateProposalForCommit,
  store: WeatherStore,
  asOfUtc: UnixSeconds,
): TripCreateCommitInput {
  const facts = parseFrozenTripCreateFacts(proposal.payloadJson, asOfUtc);
  const originPlaceId = store.getEffectivePlace(asOfUtc).place.id;
  return {
    proposalId: proposal.proposalId,
    payloadHash: proposal.payloadHash,
    title: facts.title,
    originPlaceId,
    destinationText: facts.destination.text,
    destinationAdministrativeArea: facts.destination.administrativeArea,
    transportMode: facts.transportMode,
    departure: toStoredTimeWindow(facts.departure),
    arrival: toStoredTimeWindow(facts.arrival),
    weatherMode: facts.weatherMode,
    sourceSummary: buildCommittedTripSourceSummary(facts),
  };
}

function parseFrozenTripCreateFacts(
  payloadJson: string,
  asOfUtc: UnixSeconds,
): PlanningChangeProposalResult["canonicalFacts"] {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new Error("提案内容已损坏，不能提交。");
  }
  if (!isRecord(raw) || !hasOnlyKeys(raw, [
    "domain",
    "schemaVersion",
    "kind",
    "title",
    "origin",
    "destination",
    "transportMode",
    "departure",
    "arrival",
    "weatherMode",
    "sourceKind",
  ])) {
    throw new Error("提案内容不符合已冻结的行程格式，不能提交。");
  }
  if (
    raw.domain !== "weather_travel"
    || raw.schemaVersion !== 1
    || raw.kind !== "trip_create"
    || raw.sourceKind !== "owner_text"
  ) {
    throw new Error("提案类型或来源不受支持，不能提交。");
  }

  const title = readRequiredText(raw.title, "frozen title");
  if (!title.ok) throw new Error(title.error.message);
  const origin = parseFrozenPlaceSummary(raw.origin, "origin");
  const destination = parseFrozenDestination(raw.destination);
  const transportMode = parseEnum(raw.transportMode, TRANSPORT_MODES, "transportMode");
  if (!transportMode.ok || transportMode.value === undefined) {
    throw new Error("冻结的交通方式无效。");
  }
  const weatherMode = parseEnum(
    raw.weatherMode,
    ["none", "dual_city", "switch_at_arrival"] as const,
    "weatherMode",
  );
  if (!weatherMode.ok || weatherMode.value === undefined) {
    throw new Error("冻结的天气模式无效。");
  }
  const departure = parseFrozenTimeWindow(raw.departure, "departure", asOfUtc);
  const arrival = parseFrozenTimeWindow(raw.arrival, "arrival", asOfUtc);

  return {
    domain: "weather_travel",
    schemaVersion: 1,
    kind: "trip_create",
    title: title.value,
    origin,
    destination,
    transportMode: transportMode.value,
    departure,
    arrival,
    weatherMode: weatherMode.value,
    sourceKind: "owner_text",
  };
}

function parseFrozenPlaceSummary(raw: unknown, name: string): PlanningPlaceSummary {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["displayName", "countryCode", "timezone", "precision"])) {
    throw new Error(`冻结的 ${name} 地点格式无效。`);
  }
  const displayName = readRequiredText(raw.displayName, `${name}.displayName`);
  const countryCode = readRequiredText(raw.countryCode, `${name}.countryCode`);
  const timezone = readRequiredText(raw.timezone, `${name}.timezone`);
  if (!displayName.ok || !countryCode.ok || !timezone.ok || !isValidTimezone(timezone.value)) {
    throw new Error(`冻结的 ${name} 地点信息无效。`);
  }
  if (countryCode.value.length !== 2 || !["city", "district", "point"].includes(raw.precision as string)) {
    throw new Error(`冻结的 ${name} 地点精度无效。`);
  }
  return {
    displayName: displayName.value,
    countryCode: countryCode.value,
    timezone: timezone.value,
    precision: raw.precision as Place["precision"],
  };
}

function parseFrozenDestination(
  raw: unknown,
): PlanningChangeProposalResult["canonicalFacts"]["destination"] {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["text", "administrativeArea", "resolution"])) {
    throw new Error("冻结的目的地格式无效。");
  }
  const text = readRequiredText(raw.text, "destination.text");
  if (!text.ok) throw new Error(text.error.message);
  if (raw.administrativeArea !== null && raw.administrativeArea !== undefined) {
    const area = readRequiredText(raw.administrativeArea, "destination.administrativeArea");
    if (!area.ok) throw new Error(area.error.message);
    if (raw.resolution !== "pending") throw new Error("目的地解析状态无效。");
    return { text: text.value, administrativeArea: area.value, resolution: "pending" };
  }
  if (raw.resolution !== "pending") throw new Error("目的地解析状态无效。");
  return { text: text.value, administrativeArea: null, resolution: "pending" };
}

function parseFrozenTimeWindow(
  raw: unknown,
  name: string,
  asOfUtc: UnixSeconds,
): PlanningTimeWindow | null {
  if (raw === null) return null;
  const parsed = parseTimeWindow(raw, name, asOfUtc);
  if (!parsed.ok || parsed.value === undefined) {
    throw new Error(parsed.ok ? `冻结的 ${name} 时间不能为空。` : parsed.error.message);
  }
  return parsed.value;
}

function toStoredTimeWindow(
  window: PlanningTimeWindow | null,
): TripCreateCommitInput["departure"] {
  if (window === null) return null;
  const earliestUtc = timestampToUnixSeconds(window.earliest);
  const latestUtc = timestampToUnixSeconds(window.latest);
  if (earliestUtc === undefined || latestUtc === undefined) {
    throw new Error("冻结的时间无法转换为 UTC。");
  }
  return { earliestUtc, latestUtc, precision: window.precision };
}

function committedResult(
  proposalId: string,
  trip: TripSummary,
  idempotent: boolean,
): PlanningCommitResult {
  return {
    ok: true,
    schemaVersion: 1,
    proposalId,
    status: "committed",
    idempotent,
    trip,
    locationPeriodCreated: false,
    weatherLocationChanged: false,
    warnings: [
      "行程已提交为 planned 记录。目的地尚未通过受控地点目录消歧，因此天气地点未切换。",
      "当前不会修改每日提醒或 Cron；地点切换会在后续地点消歧功能完成后单独确认。",
    ],
  };
}

function buildCommittedTripSourceSummary(
  facts: PlanningChangeProposalResult["canonicalFacts"],
): string {
  const area = facts.destination.administrativeArea
    ? `；行政区=${facts.destination.administrativeArea}`
    : "";
  return `主人确认的行程提案；目的地=${facts.destination.text}${area}；地点尚未消歧，不切换天气地点。`;
}

function proposalFailure(
  code: Exclude<PlanningFailure["error"]["code"], "invalid_input" | "unsupported_request">,
  message: string,
): PlanningFailure {
  return { ok: false, error: { code, message } };
}

function parsePlanningChangeInput(
  rawInput: unknown,
  asOfUtc: UnixSeconds,
): { ok: true; input: PlanningChangeProposeInput } | PlanningFailure {
  if (!isRecord(rawInput)) {
    return invalidInput("参数必须是对象。");
  }
  if (rawInput.schema_version !== 1) {
    return invalidInput("仅支持 schema_version=1 的提案请求。");
  }
  if (!isRecord(rawInput.request)) {
    return invalidInput("缺少 request 对象。");
  }

  const request = rawInput.request;
  if (request.kind !== "trip.create") {
    return { ok: false, error: { code: "unsupported_request", message: "当前仅支持 trip.create。" } };
  }
  if (!hasOnlyKeys(request, [
    "kind",
    "title",
    "destination",
    "transport_mode",
    "departure",
    "arrival",
    "weather_mode",
  ])) {
    return invalidInput("request 含有未允许的字段。");
  }

  const title = readOptionalText(request.title, "title");
  if (!title.ok) return title;
  const destination = parseDestination(request.destination);
  if (!destination.ok) return destination;
  const transportMode = parseEnum(request.transport_mode, TRANSPORT_MODES, "transport_mode");
  if (!transportMode.ok) return transportMode;
  const weatherMode = parseEnum(
    request.weather_mode,
    ["none", "dual_city", "switch_at_arrival"] as const,
    "weather_mode",
  );
  if (!weatherMode.ok) return weatherMode;
  const departure = parseTimeWindow(request.departure, "departure", asOfUtc);
  if (!departure.ok) return departure;
  const arrival = parseTimeWindow(request.arrival, "arrival", asOfUtc);
  if (!arrival.ok) return arrival;

  return {
    ok: true,
    input: {
      schema_version: 1,
      request: {
        kind: "trip.create",
        ...(title.value === undefined ? {} : { title: title.value }),
        destination: destination.value,
        ...(transportMode.value === undefined ? {} : { transport_mode: transportMode.value }),
        ...(departure.value === undefined ? {} : { departure: departure.value }),
        ...(arrival.value === undefined ? {} : { arrival: arrival.value }),
        ...(weatherMode.value === undefined ? {} : { weather_mode: weatherMode.value }),
      },
    },
  };
}

function parseDestination(raw: unknown):
  | { ok: true; value: PlanningChangeProposeInput["request"]["destination"] }
  | PlanningFailure {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["text", "administrative_area"])) {
    return invalidInput("destination 必须只包含 text 和 administrative_area。");
  }
  const text = readRequiredText(raw.text, "destination.text");
  if (!text.ok) return text;
  const area = readOptionalText(raw.administrative_area, "destination.administrative_area");
  if (!area.ok) return area;
  return {
    ok: true,
    value: {
      text: text.value,
      ...(area.value === undefined ? {} : { administrative_area: area.value }),
    },
  };
}

function parseTimeWindow(
  raw: unknown,
  name: string,
  asOfUtc: UnixSeconds,
): { ok: true; value: PlanningTimeWindow | undefined } | PlanningFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["earliest", "latest", "precision", "timezone"])) {
    return invalidInput(`${name} 含有未允许的字段。`);
  }
  const earliest = readRequiredText(raw.earliest, `${name}.earliest`);
  if (!earliest.ok) return earliest;
  const latest = readRequiredText(raw.latest, `${name}.latest`);
  if (!latest.ok) return latest;
  const precision = parseEnum(raw.precision, TIME_PRECISIONS, `${name}.precision`);
  if (!precision.ok || precision.value === undefined) {
    return precision.ok ? invalidInput(`${name}.precision 不能为空。`) : precision;
  }
  const timezone = readRequiredText(raw.timezone, `${name}.timezone`);
  if (!timezone.ok) return timezone;
  if (!isValidTimezone(timezone.value)) {
    return invalidInput(`${name}.timezone 不是有效的时区标识。`);
  }
  const earliestMs = parseTimestamp(earliest.value);
  const latestMs = parseTimestamp(latest.value);
  if (earliestMs === undefined || latestMs === undefined) {
    return invalidInput(`${name} 必须使用带时区的 ISO-8601 时间。`);
  }
  if (latestMs < earliestMs) {
    return invalidInput(`${name}.latest 不能早于 earliest。`);
  }
  if ((latestMs - earliestMs) / 1000 > 31 * 24 * 60 * 60) {
    return invalidInput(`${name} 时间窗不能超过 31 天。`);
  }
  const nowMs = asOfUtc * 1000;
  if (earliestMs < nowMs - 24 * 60 * 60 * 1000 || earliestMs > nowMs + MAX_TIME_HORIZON_SECONDS * 1000) {
    return invalidInput(`${name} 超出允许的时间范围。`);
  }
  return {
    ok: true,
    value: {
      earliest: earliest.value,
      latest: latest.value,
      precision: precision.value,
      timezone: timezone.value,
    },
  };
}

function buildProposalPreview(
  facts: PlanningChangeProposalResult["canonicalFacts"],
  missingFields: PlanningChangeProposalResult["missingFields"],
  warnings: string[],
): string {
  const lines = [
    "待确认的出行计划提案（P2A 预览）",
    `- 目的地：${facts.destination.text}`,
    `- 当前天气参考地：${facts.origin.displayName}`,
    `- 交通方式：${formatTransportMode(facts.transportMode)}`,
    `- 到达信息：${formatWindow(facts.arrival)}`,
    "- 当前动作：只保存待确认提案，不修改地点、行程、提醒时间或定时任务。",
    "- 下一步：主人明确确认后，后续版本才会提供提交能力。",
  ];
  if (missingFields.length > 0) {
    lines.push(`- 待补充：${missingFields.join("、")}`);
  }
  if (warnings.length > 0) {
    lines.push(`- 说明：${warnings.join(" ")}`);
  }
  return lines.join("\n");
}

function summarizePlace(place: Place): PlanningPlaceSummary {
  return {
    displayName: place.displayName,
    countryCode: place.countryCode,
    timezone: place.timezone,
    precision: place.precision,
  };
}

function formatMinuteOfDay(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatTransportMode(mode: TransportMode): string {
  return {
    unknown: "未确定",
    air: "飞机",
    rail: "火车/高铁",
    car: "汽车",
    bus: "大巴",
    ship: "船",
    other: "其他",
  }[mode];
}

function formatWindow(window: PlanningTimeWindow | null): string {
  if (window === null) return "未提供";
  if (window.precision === "date") return `${window.earliest} 至 ${window.latest}（日期）`;
  return `${window.earliest} 至 ${window.latest}（${window.precision}）`;
}

function parseTimestamp(value: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestampToUnixSeconds(value: string): UnixSeconds | undefined {
  const milliseconds = parseTimestamp(value);
  if (milliseconds === undefined) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function readRequiredText(value: unknown, field: string): { ok: true; value: string } | PlanningFailure {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(`${field} 必须是非空文本。`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return invalidInput(`${field} 超出长度或包含不安全字符。`);
  }
  return { ok: true, value: normalized };
}

function readOptionalText(value: unknown, field: string): { ok: true; value: string | undefined } | PlanningFailure {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = readRequiredText(value, field);
  return parsed.ok ? parsed : parsed;
}

function parseEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): { ok: true; value: T[number] | undefined } | PlanningFailure {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !allowed.includes(value)) {
    return invalidInput(`${field} 不是允许的枚举值。`);
  }
  return { ok: true, value: value as T[number] };
}

function invalidInput(message: string): PlanningFailure {
  return { ok: false, error: { code: "invalid_input", message } };
}
