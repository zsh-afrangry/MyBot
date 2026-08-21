import { isIP } from "node:net";

import { SearchError } from "./errors.js";
import type {
  ControlledSearchAnswer,
  SearchCitation,
} from "./types.js";
import { DEEPSEEK_SEARCH_PROVIDER_ID } from "./types.js";

const MAX_CITATIONS = 5;
const MAX_ANSWER_LENGTH = 6_000;
const MAX_TITLE_LENGTH = 200;

export interface ParseSearchResponseOptions {
  query: string;
  searchedAt: string;
  tookMs: number;
}

export function parseDeepSeekSearchResponse(
  payload: unknown,
  options: ParseSearchResponseOptions,
): ControlledSearchAnswer {
  const record = asRecord(payload);
  if (!record || (record.status !== undefined && record.status !== "completed")) {
    throw new SearchError("INVALID_RESPONSE");
  }

  const texts = collectOutputTexts(record.output);
  const structured = findStructuredAnswer(texts);

  const content = readBoundedText(
    structured?.answer ?? findAnswerText(texts),
    MAX_ANSWER_LENGTH,
  );
  if (!content) throw new SearchError("INVALID_RESPONSE");

  // A structured answer owns its evidence boundary.  If it explicitly returns
  // `sources: []`, nearby provider page visits may be approximate searches and
  // must not be promoted to citations.  Only the natural-language fallback is
  // allowed to use page visits or URLs found in text.
  const providerPageSources = structured ? [] : collectProviderPageSources(record.output);
  const textUrlSources = structured ? [] : extractTextUrlSources(texts);
  const structuredSources = structured?.sources ?? [];
  const citations = normalizeCitations([
    ...structuredSources,
    ...providerPageSources,
    ...textUrlSources,
  ]);
  if (citations.length === 0) throw new SearchError("INVALID_RESPONSE");

  return {
    schema_version: 1,
    kind: "answer",
    provider: DEEPSEEK_SEARCH_PROVIDER_ID,
    query: options.query,
    content,
    citations,
    source_verification: "provider_reported",
    searched_at: options.searchedAt,
    took_ms: Math.max(0, Math.floor(options.tookMs)),
    externalContent: {
      untrusted: true,
      source: "web_search",
      wrapped: true,
      provider: DEEPSEEK_SEARCH_PROVIDER_ID,
    },
  };
}

function collectOutputTexts(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const texts: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    if (itemRecord?.type !== "message" || !Array.isArray(itemRecord.content)) continue;
    for (const content of itemRecord.content) {
      const contentRecord = asRecord(content);
      if (contentRecord?.type === "output_text" && typeof contentRecord.text === "string") {
        texts.push(contentRecord.text);
      }
    }
  }
  return texts;
}

function findStructuredAnswer(texts: string[]): {
  answer: string;
  sources: unknown[];
} | undefined {
  for (const text of [...texts].reverse()) {
    for (const candidate of extractJsonObjects(text).reverse()) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        const record = asRecord(parsed);
        if (typeof record?.answer === "string" && Array.isArray(record.sources)) {
          return { answer: record.answer, sources: record.sources };
        }
        if (typeof record?.answer === "string" && Array.isArray(record.citations)) {
          return { answer: record.answer, sources: record.citations };
        }
      } catch {
        // Continue searching other bounded JSON candidates.
      }
    }
  }
  return undefined;
}

function findAnswerText(texts: string[]): string {
  for (const text of [...texts].reverse()) {
    for (const candidate of extractJsonObjects(text).reverse()) {
      try {
        const record = asRecord(JSON.parse(candidate));
        if (typeof record?.answer === "string") return record.answer;
      } catch {
        // Continue searching other bounded JSON candidates.
      }
    }
    const bounded = readBoundedText(text, MAX_ANSWER_LENGTH);
    if (bounded) return bounded;
  }
  return "";
}

function collectProviderPageSources(output: unknown): Array<{ url: string }> {
  if (!Array.isArray(output)) return [];
  const sources: Array<{ url: string }> = [];
  for (const item of output) {
    const record = asRecord(item);
    if (
      record?.type !== "web_search_call" ||
      record.status === "failed" ||
      record.status === "incomplete"
    ) {
      continue;
    }
    const action = asRecord(record.action);
    if (action?.type !== "open_page" || typeof action.url !== "string") continue;
    sources.push({ url: action.url });
  }
  return sources;
}

function extractTextUrlSources(texts: string[]): Array<{ url: string }> {
  const sources: Array<{ url: string }> = [];
  const seen = new Set<string>();
  const urlPattern = /https:\/\/[^\s<>"'`)}\]]+/gu;
  for (const text of texts) {
    for (const match of text.matchAll(urlPattern)) {
      const url = match[0].replace(/[.,;:!?。，；：！？、）》】]+$/u, "");
      if (!url || seen.has(url)) continue;
      sources.push({ url });
      seen.add(url);
    }
  }
  return sources;
}

function extractJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function normalizeCitations(raw: unknown): SearchCitation[] {
  if (!Array.isArray(raw)) return [];
  const citations: SearchCitation[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || typeof record.url !== "string") continue;
    const url = canonicalizePublicHttpsUrl(record.url);
    if (!url || seen.has(url)) continue;
    const title = readBoundedText(record.title, MAX_TITLE_LENGTH) || new URL(url).hostname;
    citations.push({ title, url });
    seen.add(url);
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations;
}

export function canonicalizePublicHttpsUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !hostname ||
      isIP(hostname) !== 0 ||
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function readBoundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, maxLength);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
