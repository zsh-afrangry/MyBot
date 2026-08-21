export const DEEPSEEK_SEARCH_PROVIDER_ID = "deepseek-search" as const;
export const DEEPSEEK_MODEL_ID = "deepseek-v4-flash" as const;
export const DEEPSEEK_RESPONSES_PATH = "/responses" as const;

export interface SearchCitation {
  title: string;
  url: string;
}

export interface ControlledSearchAnswer {
  schema_version: 1;
  kind: "answer";
  provider: typeof DEEPSEEK_SEARCH_PROVIDER_ID;
  query: string;
  content: string;
  citations: SearchCitation[];
  source_verification: "provider_reported";
  searched_at: string;
  took_ms: number;
  externalContent: {
    untrusted: true;
    source: "web_search";
    wrapped: true;
    provider: typeof DEEPSEEK_SEARCH_PROVIDER_ID;
  };
}

export interface DeepSeekSearchResponsePayload {
  readonly [key: string]: unknown;
}
