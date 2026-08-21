import { SearchError } from "./errors.js";

export const MAX_QUERY_LENGTH = 200;

const SECRET_PATTERNS = [
  /\bsk-[a-z0-9_-]{16,}\b/iu,
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*\S+/iu,
];

// These are deliberately narrow, format-based guards for identifiers that
// should not be sent to a public search provider. Semantic privacy
// classification remains an Agent responsibility and is not attempted here.
const HIGH_RISK_IDENTIFIER_TOKEN =
  String.raw`(?=[A-Za-z0-9_-]{6,}\b)(?=[A-Za-z0-9_-]*(?:\d|[-_]))[A-Za-z0-9][A-Za-z0-9_-]{5,}`;

const SENSITIVE_IDENTIFIER_PATTERNS = [
  // QQ/OpenID-like identifiers are rejected when labelled, and a bare
  // 32-hex token is rejected conservatively because it is indistinguishable
  // from the configured QQ OpenID shape at this boundary.
  new RegExp(
    String.raw`\b(?:open[-_ ]?id|qq\s*(?:open[-_ ]?id|id))\s*[:=：]?\s*[A-Za-z0-9_-]{16,}\b`,
    "iu",
  ),
  /(?<![A-F0-9])[A-F0-9]{32}(?![A-F0-9])/iu,
  new RegExp(
    String.raw`(?:票号|机票号|订单号|预订号|确认码|快递单号)\s*[:：=#]?\s*${HIGH_RISK_IDENTIFIER_TOKEN}`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:ticket|pnr|booking(?:\s+(?:reference|code|number))?|confirmation(?:\s+(?:code|number))?|reservation(?:\s+(?:code|number))?|tracking(?:\s+(?:number|id))?)\s*[:=#]?\s*${HIGH_RISK_IDENTIFIER_TOKEN}`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:身份证(?:号|号码)?|护照(?:号|号码)?|passport(?:\s*(?:no|number|id))?)\s*[:：=#]?\s*(?:${HIGH_RISK_IDENTIFIER_TOKEN}|\d{17}[\dX])`,
    "iu",
  ),
  /(?<!\d)\d{17}[\dX](?!\d)/iu,
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SearchError("INVALID_INPUT");
  }

  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new SearchError("INVALID_INPUT");
  }
  const query = raw.normalize("NFC").trim();
  if (
    query.length === 0 ||
    [...query].length > MAX_QUERY_LENGTH ||
    SECRET_PATTERNS.some((pattern) => pattern.test(query)) ||
    SENSITIVE_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(query))
  ) {
    throw new SearchError("INVALID_INPUT");
  }

  return query;
}

export function readSearchQuery(rawParams: unknown): string {
  if (!isRecord(rawParams) || Object.keys(rawParams).some((key) => key !== "query")) {
    throw new SearchError("INVALID_INPUT");
  }
  return normalizeSearchQuery(rawParams.query);
}

export function readProviderSearchQuery(rawParams: unknown): string {
  // OpenClaw's shared web-search runtime may attach provider-neutral filters
  // (freshness, domains, country, language, etc.). DeepSeek's Responses
  // endpoint ignores those fields in this MVP, so only the actual query is
  // read here. The model-facing personal tool remains strict via
  // readSearchQuery above.
  if (!isRecord(rawParams)) throw new SearchError("INVALID_INPUT");
  return normalizeSearchQuery(rawParams.query);
}
