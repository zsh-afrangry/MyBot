import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

/** Test-only bounded tool loop for the configured primary model. No QQ delivery. */
export async function createModelDriver(fixture, options = {}) {
  const root = resolve(process.env.KURUMI_SOURCE_ROOT || (()=>{throw new Error('This acceptance harness reads a legacy tree. Set KURUMI_SOURCE_ROOT to an extracted legacy source (see kurumi-backups); it no longer defaults to /home/afrangry/.openclaw')})());
  const cfg = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8"));
  const primary = cfg.agents.defaults.model.primary;
  const slash = primary.indexOf("/"), provider = cfg.models.providers[primary.slice(0, slash)];
  if (provider.api !== "anthropic-messages" || provider.apiKey?.source !== "env")
    throw Error("This test driver requires the configured anthropic-messages provider with an environment SecretRef");
  const env = { ...parseEnv(readFileSync(join(root, ".env"), "utf8")), ...process.env };
  const apiKey = env[provider.apiKey.id];
  if (!apiKey) throw Error("Primary model environment credential unavailable");
  const hostRoot = process.env.OPENCLAW_HOST_ROOT || "/home/afrangry/.npm-global/lib/node_modules/openclaw";
  const { default: Anthropic } = await import(pathToFileURL(join(hostRoot, "node_modules/@anthropic-ai/sdk/index.js")).href);
  const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, timeout: 60_000, maxRetries: 0 });
  const names = options.toolNames ?? ["personal_planning_state_get", "personal_planning_change_propose", "personal_planning_change_commit"];
  const definitions = fixture.toolDefinitions(names);
  const system = readFileSync(join(root, "chatbot/AGENTS.md"), "utf8") +
    "\n本轮运行于隔离验收环境。消息身份已由测试入口提供为主人 QQ 私聊；工具访问独立测试数据库。" +
    "测试提案允许按主人明确请求生成并在后续有效确认后提交。只使用本轮实际提供的工具，工具结果是事实来源。";
  const messages = [], turns = [];
  return {
    model: primary, turns,
    async turn(content) {
      const evidence = { content, calls: [], responses: [] }; turns.push(evidence);
      messages.push({ role: "user", content });
      for (let step = 0; step < 6; step++) {
        let response;
        try {
          response = await client.messages.create({ model: primary.slice(slash + 1), max_tokens: 2048,
            system, tools: definitions, messages });
        } catch (error) { throw Error(`Model request failed: ${error.name}; HTTP status ${error.status ?? "unknown"}`); }
        evidence.responses.push({ content: response.content, stopReason: response.stop_reason, usage: response.usage });
        messages.push({ role: "assistant", content: response.content });
        const calls = response.content.filter(block => block.type === "tool_use");
        if (!calls.length) {
          evidence.reply = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          return evidence;
        }
        const results = [];
        for (const call of calls) {
          if (!names.includes(call.name)) throw Error("Model requested an unexposed tool");
          const result = await fixture.tool(call.name, call.input);
          evidence.calls.push({ name: call.name, input: call.input, result });
          results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
        }
        messages.push({ role: "user", content: results });
      }
      throw Error("Model exceeded six tool rounds per turn");
    },
  };
}
