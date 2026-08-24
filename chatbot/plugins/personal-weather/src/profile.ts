import { createHash } from "node:crypto";

import { OWNER_SUBJECT_ID } from "./store.js";
import type {
  CurrentLocation,
  PendingProposalSummary,
  UnixSeconds,
  WeatherStore,
} from "./store.js";
import type { QWeatherClient } from "./qweather-client.js";
import { resolveProfileLocation } from "./weather-location.js";
import type {
  ProfileLocationRecord,
} from "./weather-location.js";
import type { WeatherLocationCandidate } from "./weather-model.js";
import type { LocationSetProposalForCommit } from "./profile-repository.js";

const PROPOSAL_TTL_SECONDS = 24 * 60 * 60;
const MAX_LOCATION_TEXT_LENGTH = 80;

export interface ProfileLocationSummary {
  displayName: string;
  countryCode: string;
  timezone: string;
  precision: "city" | "district" | "point";
  source: CurrentLocation["source"];
  confirmedAtUtc: UnixSeconds;
  revision: number;
}

export interface ProfileState {
  ok: true;
  schemaVersion: 1;
  currentLocation: ProfileLocationSummary;
  pendingProposals: Array<Pick<
    PendingProposalSummary,
    "proposalId" | "previewText" | "payloadHash" | "expiresAtUtc" | "createdAtUtc"
  >>;
  capabilities: {
    stateRead: true;
    currentLocationChange: true;
    arbitraryFieldChange: false;
    homeLocation: false;
    tripArrivalAutoUpdate: false;
  };
}

export interface ProfileChangeProposeInput {
  schema_version: 1;
  request: {
    kind: "current_location.set";
    location: {
      text: string;
      administrative_area?: string;
    };
  };
}

export interface ProfileChangeProposalResult {
  ok: true;
  schemaVersion: 1;
  status: "pending";
  kind: "current_location_set";
  proposalId: string;
  payloadHash: string;
  previewText: string;
  canonicalFacts: {
    domain: "personal_profile";
    schemaVersion: 1;
    kind: "current_location_set";
    currentLocation: Omit<ProfileLocationSummary, "source" | "confirmedAtUtc" | "revision">;
    sourceKind: "owner_text";
  };
  effects: {
    currentLocationChanged: true;
    weatherUsesCurrentLocation: true;
    tripChanged: false;
    reminderChanged: false;
    cronChanged: false;
    memoryChanged: false;
  };
  requiresConfirmation: true;
  expiresAtUtc: UnixSeconds;
}

export interface ProfileUnchangedResult {
  ok: true;
  schemaVersion: 1;
  status: "unchanged";
  currentLocation: ProfileLocationSummary;
  message: string;
  requiresConfirmation: false;
}

export interface ProfileCommitResult {
  ok: true;
  schemaVersion: 1;
  status: "committed";
  proposalId: string;
  idempotent: boolean;
  currentLocation: ProfileLocationSummary;
  effects: {
    currentLocationChanged: true;
    weatherUsesCurrentLocation: true;
    tripChanged: false;
    reminderChanged: false;
    cronChanged: false;
    memoryChanged: false;
  };
}

export type ProfileFailure = {
  ok: false;
  error: {
    code:
      | "invalid_input"
      | "unsupported_request"
      | "location_not_found"
      | "location_ambiguous"
      | "proposal_not_found"
      | "proposal_hash_mismatch"
      | "proposal_expired"
      | "proposal_unavailable"
      | "proposal_payload_invalid";
    message: string;
  };
  candidates?: WeatherLocationCandidate[];
};

type FrozenCurrentLocationFacts = {
  domain: "personal_profile";
  schemaVersion: 1;
  kind: "current_location_set";
  location: ProfileLocationRecord;
  sourceKind: "owner_text";
};

export function getProfileState(store: WeatherStore): ProfileState {
  const currentLocation = store.getCurrentLocation();
  const pendingProposals = store.listPendingProposals()
    .filter((proposal) => proposal.kind === "location_set")
    .map((proposal) => ({
      proposalId: proposal.proposalId,
      previewText: proposal.previewText,
      payloadHash: proposal.payloadHash,
      expiresAtUtc: proposal.expiresAtUtc,
      createdAtUtc: proposal.createdAtUtc,
    }));

  return {
    ok: true,
    schemaVersion: 1,
    currentLocation: summarizeCurrentLocation(currentLocation),
    pendingProposals,
    capabilities: {
      stateRead: true,
      currentLocationChange: true,
      arbitraryFieldChange: false,
      homeLocation: false,
      tripArrivalAutoUpdate: false,
    },
  };
}

export async function proposeProfileChange(
  store: WeatherStore,
  client: QWeatherClient,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<ProfileChangeProposalResult | ProfileUnchangedResult | ProfileFailure> {
  const parsed = parseProfileChangeInput(rawInput);
  if (!parsed.ok) return parsed;

  const resolution = await resolveProfileLocation(client, {
    location: parsed.input.request.location.text,
    ...(parsed.input.request.location.administrativeArea === undefined
      ? {}
      : { administrativeArea: parsed.input.request.location.administrativeArea }),
  }, signal);
  if (resolution.kind === "not_found") {
    return profileFailure(
      "location_not_found",
      "未找到可确认的地点；当前所在地没有发生任何变化。",
    );
  }
  if (resolution.kind === "ambiguous") {
    return {
      ...profileFailure(
        "location_ambiguous",
        "地点名称存在多个候选，请补充城市或上级行政区后再变更当前所在地。",
      ),
      candidates: resolution.candidates,
    };
  }

  const current = store.getCurrentLocation();
  if (current.place.qweatherLocationId === resolution.location.location.qweatherLocationId) {
    return {
      ok: true,
      schemaVersion: 1,
      status: "unchanged",
      currentLocation: summarizeCurrentLocation(current),
      message: "该地点已经是当前所在地，未创建提案，也未修改任何资料。",
      requiresConfirmation: false,
    };
  }

  const facts: FrozenCurrentLocationFacts = {
    domain: "personal_profile",
    schemaVersion: 1,
    kind: "current_location_set",
    location: resolution.location.location,
    sourceKind: "owner_text",
  };
  const nowUtc = store.getNowUtc();
  const payloadJson = JSON.stringify(facts);
  const previewText = buildLocationPreview(
    summarizeCurrentLocation(current),
    summarizeResolvedLocation(facts.location),
  );
  const created = store.createPendingProposal({
    kind: "location_set",
    payloadJson,
    previewText,
    expiresAtUtc: nowUtc + PROPOSAL_TTL_SECONDS,
  });

  return {
    ok: true,
    schemaVersion: 1,
    status: "pending",
    kind: "current_location_set",
    proposalId: created.proposalId,
    payloadHash: created.payloadHash,
    previewText,
    canonicalFacts: {
      domain: "personal_profile",
      schemaVersion: 1,
      kind: "current_location_set",
      currentLocation: summarizeResolvedLocation(facts.location),
      sourceKind: "owner_text",
    },
    effects: currentLocationEffects(),
    requiresConfirmation: true,
    expiresAtUtc: created.expiresAtUtc,
  };
}

export function commitProfileChange(
  store: WeatherStore,
  rawInput: unknown,
): ProfileCommitResult | ProfileFailure {
  const parsed = parseCommitInput(rawInput);
  if (!parsed.ok) return parsed;
  const nowUtc = store.getNowUtc();

  return store.withProfileTransaction((repository) => {
    const proposal = repository.getLocationSetProposal(parsed.input.proposalId);
    if (!proposal) {
      return profileFailure("proposal_not_found", "未找到可提交的当前所在地变更提案。");
    }
    if (proposal.payloadHash !== parsed.input.payloadHash) {
      return profileFailure("proposal_hash_mismatch", "提案内容已变化，请重新查询资料状态并确认最新预览。");
    }

    const expectedContextHash = createHash("sha256")
      .update(`${OWNER_SUBJECT_ID}|${proposal.kind}|${proposal.payloadHash}`)
      .digest("hex");
    if (proposal.requestContextHash !== expectedContextHash) {
      return profileFailure("proposal_unavailable", "该提案的确认上下文无效，请重新创建提案。");
    }

    let facts: FrozenCurrentLocationFacts;
    try {
      facts = parseFrozenFacts(proposal);
    } catch (error) {
      return profileFailure(
        "proposal_payload_invalid",
        error instanceof Error ? error.message : "提案内容无法安全提交。",
      );
    }

    if (proposal.status === "committed") {
      return committedResult(proposal.proposalId, store.getCurrentLocation(), true);
    }
    if (proposal.status !== "pending") {
      return profileFailure("proposal_unavailable", "该提案已不可提交，请重新创建一条新的提案。");
    }
    if (proposal.expiresAtUtc <= nowUtc) {
      if (!repository.expirePendingProposal(proposal.proposalId, nowUtc)) {
        throw new Error("Profile proposal changed while being expired");
      }
      repository.insertOwnerAudit({
        action: "profile.proposal.expired",
        entityType: "change_proposal",
        entityId: proposal.proposalId,
        proposalId: proposal.proposalId,
        summaryJson: JSON.stringify({ kind: "current_location_set", reason: "ttl_expired" }),
        atUtc: nowUtc,
      });
      return profileFailure("proposal_expired", "该当前所在地变更提案已过期，未提交任何资料。请重新创建。");
    }

    const placeId = repository.upsertConfirmedPlace(facts.location, nowUtc);
    repository.replaceCurrentLocation({
      placeId,
      sourceSummary: `主人确认当前所在地为${facts.location.displayName}`,
      atUtc: nowUtc,
    });
    if (!repository.markProposalCommitted({
      proposalId: proposal.proposalId,
      payloadHash: proposal.payloadHash,
      placeId,
      atUtc: nowUtc,
    })) {
      throw new Error("Profile proposal changed while being committed");
    }
    repository.insertOwnerAudit({
      action: "profile.current_location.updated",
      entityType: "profile_current_location",
      entityId: String(placeId),
      proposalId: proposal.proposalId,
      summaryJson: JSON.stringify({
        kind: "current_location_set",
        displayName: facts.location.displayName,
        weatherUsesCurrentLocation: true,
      }),
      atUtc: nowUtc,
    });
    return committedResult(proposal.proposalId, store.getCurrentLocation(), false);
  });
}

function currentLocationEffects(): ProfileChangeProposalResult["effects"] {
  return {
    currentLocationChanged: true,
    weatherUsesCurrentLocation: true,
    tripChanged: false,
    reminderChanged: false,
    cronChanged: false,
    memoryChanged: false,
  };
}

function committedResult(
  proposalId: string,
  currentLocation: CurrentLocation,
  idempotent: boolean,
): ProfileCommitResult {
  return {
    ok: true,
    schemaVersion: 1,
    status: "committed",
    proposalId,
    idempotent,
    currentLocation: summarizeCurrentLocation(currentLocation),
    effects: currentLocationEffects(),
  };
}

function buildLocationPreview(
  current: ProfileLocationSummary,
  target: Omit<ProfileLocationSummary, "source" | "confirmedAtUtc" | "revision">,
): string {
  return [
    "已生成待确认个人资料变更：",
    `当前所在地：${current.displayName} → ${target.displayName}`,
    `时区：${target.timezone}`,
    "生效：确认提交时立即生效。",
    "影响：后续未指定地点的天气查询和每日天气简报将读取新所在地。",
    "不会修改：行程、提醒、Cron、长期记忆或任何常住地资料。",
    "尚未提交；请在本次主人 QQ 私聊明确确认后才会更新。",
  ].join("\n");
}

function parseProfileChangeInput(
  rawInput: unknown,
): { ok: true; input: { request: { location: { text: string; administrativeArea?: string } } } }
  | ProfileFailure {
  if (!isRecord(rawInput) || !hasOnlyKeys(rawInput, ["schema_version", "request"])) {
    return profileFailure("invalid_input", "个人资料变更请求只能包含 schema_version 和 request。");
  }
  if (rawInput.schema_version !== 1 || !isRecord(rawInput.request)) {
    return profileFailure("invalid_input", "个人资料变更请求格式无效。");
  }
  const request = rawInput.request;
  if (!hasOnlyKeys(request, ["kind", "location"])) {
    return profileFailure("invalid_input", "当前仅接受受限的地点变更字段。");
  }
  if (request.kind !== "current_location.set") {
    return profileFailure("unsupported_request", "当前 Profile 仅支持 current_location.set。");
  }
  if (!isRecord(request.location) || !hasOnlyKeys(request.location, ["text", "administrative_area"])) {
    return profileFailure("invalid_input", "地点只能包含 text 和可选 administrative_area。");
  }
  const text = normalizeLocationText(request.location.text);
  if (!text) return profileFailure("invalid_input", "地点文本无效。");
  const rawAdministrativeArea = request.location.administrative_area;
  if (rawAdministrativeArea === undefined) {
    return { ok: true, input: { request: { location: { text } } } };
  }
  const administrativeArea = normalizeLocationText(rawAdministrativeArea);
  if (!administrativeArea) return profileFailure("invalid_input", "上级行政区文本无效。");
  return {
    ok: true,
    input: { request: { location: { text, administrativeArea } } },
  };
}

function parseCommitInput(
  rawInput: unknown,
): { ok: true; input: { proposalId: string; payloadHash: string } } | ProfileFailure {
  if (!isRecord(rawInput) || !hasOnlyKeys(rawInput, ["proposal_id", "payload_hash"])) {
    return profileFailure("invalid_input", "提交请求只能包含 proposal_id 和 payload_hash。");
  }
  const proposalId = rawInput.proposal_id;
  if (
    typeof proposalId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(proposalId)
  ) {
    return profileFailure("invalid_input", "proposal_id 必须来自待确认预览。");
  }
  const payloadHash = rawInput.payload_hash;
  if (typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/u.test(payloadHash)) {
    return profileFailure("invalid_input", "payload_hash 必须匹配待确认预览。");
  }
  return { ok: true, input: { proposalId, payloadHash } };
}

function parseFrozenFacts(proposal: LocationSetProposalForCommit): FrozenCurrentLocationFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(proposal.payloadJson) as unknown;
  } catch {
    throw new Error("提案内容已损坏，不能提交。");
  }
  if (!isRecord(raw) || !hasOnlyKeys(raw, ["domain", "schemaVersion", "kind", "location", "sourceKind"])) {
    throw new Error("提案内容不符合当前所在地变更格式。");
  }
  if (
    raw.domain !== "personal_profile"
    || raw.schemaVersion !== 1
    || raw.kind !== "current_location_set"
    || raw.sourceKind !== "owner_text"
  ) {
    throw new Error("提案版本或类型不受支持。");
  }
  const location = parseFrozenLocation(raw.location);
  if (!location) throw new Error("提案地点数据无效。");
  return {
    domain: "personal_profile",
    schemaVersion: 1,
    kind: "current_location_set",
    location,
    sourceKind: "owner_text",
  };
}

function parseFrozenLocation(value: unknown): ProfileLocationRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "placeKey",
    "displayName",
    "countryCode",
    "adm1",
    "adm2",
    "district",
    "localityName",
    "latitude",
    "longitude",
    "timezone",
    "precision",
    "qweatherLocationId",
  ])) return undefined;
  if (
    !isSafeText(value.placeKey, 160)
    || !isSafeText(value.displayName, 200)
    || typeof value.countryCode !== "string"
    || !/^[A-Z]{2}$/u.test(value.countryCode)
    || !isNullableSafeText(value.adm1, 160)
    || !isNullableSafeText(value.adm2, 160)
    || !isNullableSafeText(value.district, 160)
    || typeof value.latitude !== "number"
    || !Number.isFinite(value.latitude)
    || value.latitude < -90
    || value.latitude > 90
    || typeof value.longitude !== "number"
    || !Number.isFinite(value.longitude)
    || value.longitude < -180
    || value.longitude > 180
    || !isSafeText(value.timezone, 100)
    || (value.precision !== "city" && value.precision !== "district" && value.precision !== "point")
    || !isSafeText(value.qweatherLocationId, 96)
  ) return undefined;
  const localityName = value.localityName === undefined
    ? deriveLegacyLocalityName({
      displayName: value.displayName,
      adm1: value.adm1,
      adm2: value.adm2,
      district: value.district,
    })
    : isSafeText(value.localityName, 200)
      ? value.localityName
      : undefined;
  if (!localityName) return undefined;
  return {
    placeKey: value.placeKey,
    displayName: value.displayName,
    countryCode: value.countryCode,
    adm1: value.adm1,
    adm2: value.adm2,
    district: value.district,
    localityName,
    latitude: value.latitude,
    longitude: value.longitude,
    timezone: value.timezone,
    precision: value.precision,
    qweatherLocationId: value.qweatherLocationId,
  };
}

/** Accept pre-v4 frozen proposals without inventing a provider type. */
function deriveLegacyLocalityName(input: {
  displayName: string;
  adm1: string | null;
  adm2: string | null;
  district: string | null;
}): string {
  const prefix = `${input.adm1 ?? ""}${input.adm2 ?? ""}`;
  if (prefix && input.displayName.startsWith(prefix)) {
    const leaf = input.displayName.slice(prefix.length);
    if (leaf) return leaf;
  }
  return input.district ?? input.displayName;
}

function summarizeCurrentLocation(location: CurrentLocation): ProfileLocationSummary {
  return {
    displayName: location.place.displayName,
    countryCode: location.place.countryCode,
    timezone: location.place.timezone,
    precision: location.place.precision,
    source: location.source,
    confirmedAtUtc: location.confirmedAtUtc,
    revision: location.revision,
  };
}

function summarizeResolvedLocation(
  location: ProfileLocationRecord,
): Omit<ProfileLocationSummary, "source" | "confirmedAtUtc" | "revision"> {
  return {
    displayName: location.displayName,
    countryCode: location.countryCode,
    timezone: location.timezone,
    precision: location.precision,
  };
}

function normalizeLocationText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1
    && normalized.length <= MAX_LOCATION_TEXT_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function profileFailure(
  code: ProfileFailure["error"]["code"],
  message: string,
): ProfileFailure {
  return { ok: false, error: { code, message: message.trim() } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.every((key) => keys.includes(key));
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isNullableSafeText(value: unknown, maximum: number): value is string | null {
  return value === null || isSafeText(value, maximum);
}
