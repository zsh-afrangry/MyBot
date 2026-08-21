export function completedDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "reasoning",
        status: "completed",
        content: [{ type: "reasoning_text", text: "internal" }],
      },
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: ["OpenClaw official web search"],
        },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "前置说明。",
            annotations: [],
          },
          {
            type: "output_text",
            text: JSON.stringify({
              answer: "OpenClaw 的 web_search 会将 Provider 结果规范化后交给调用方。",
              sources: [
                {
                  title: "OpenClaw Web Search",
                  url: "https://docs.openclaw.ai/tools/web#result-shape",
                },
              ],
            }),
            annotations: [],
          },
        ],
      },
    ],
  };
}

export function naturalLanguageDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "open_page",
          url: "https://docs.openclaw.ai/tools/web#ws_call_id=call_fixture",
        },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "OpenClaw 的 web_search 结果由 Provider 规范化后返回。",
        }],
      },
    ],
  };
}

export function naturalLanguageWithUrlDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", queries: ["public query"] },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "结论见官方页面：https://docs.openclaw.ai/tools/web。",
        }],
      },
    ],
  };
}

export function visualBoundaryDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            answer:
              "这个问题依赖图片、图表或扫描 PDF 的视觉内容；DeepSeek 检索 Worker 未完成视觉核验，" +
              "请交给具备视觉能力的后续路径。",
            sources: [{
              title: "Public reference",
              url: "https://example.com/reference",
            }],
          }),
        }],
      },
    ],
  };
}

export function currentEventDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", queries: ["2026 current public event"] },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://example.org/current-event" },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            answer: "截至检索时间，公开来源对该当前事件的报道如上；事件状态可能继续变化。",
            sources: [{
              title: "Current event reference",
              url: "https://example.org/current-event",
            }],
          }),
        }],
      },
    ],
  };
}

export function smallNicheDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://example.org/niche-reference" },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            answer: "这是一个小众公开主题；结论仅依据该来源，相关性和覆盖面有限。",
            sources: [{
              title: "Niche topic reference",
              url: "https://example.org/niche-reference",
            }],
          }),
        }],
      },
    ],
  };
}

export function zeroResultDeepSeekResponse(): Record<string, unknown> {
  return {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", queries: ["query with no public matches"] },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            answer: "未找到足够的公开来源，无法给出可核验结论。",
            sources: [],
          }),
        }],
      },
    ],
  };
}

export function deepSeekModelConfig(apiKey: unknown = {
  source: "env",
  provider: "default",
  id: "DEEPSEEK_API_KEY",
}): Record<string, unknown> {
  return {
    models: {
      providers: {
        "deepseek-search": {
          baseUrl: "https://api.deepseek.com",
          api: "openai-responses",
          apiKey,
          models: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash (Web Search)",
              reasoning: true,
              input: ["text"],
            },
          ],
        },
      },
    },
  };
}

// Build these test identifiers from pieces so the complete synthetic canary
// is not embedded in the compiled test artifacts or package scan results.
export function sensitiveOpenIdQuery(): string {
  return ["OpenID: ", "A1B2C3D4E5F60718", "293A4B5C6D7E8F90"].join("");
}

export function sensitiveTicketQuery(): string {
  return ["票号：Kurumi", "TicketCanary", "-20260812", "-7F3A9C"].join("");
}
