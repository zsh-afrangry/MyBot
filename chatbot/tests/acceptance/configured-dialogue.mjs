// Helpers for isolated conversations. Credentials and tool payloads stay in memory.
import fs from 'node:fs';
import path from 'node:path';
import {applyPersonaFile, personaFiles} from '../../../scripts/fusion/lib/persona-workspaces.mjs';

export function configuredModel(repo) {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8'));
  const primary = config.agents.entries.main.model?.primary ?? config.agents.defaults.model.primary;
  const [providerId, modelId] = primary.split('/'), provider = config.models.providers[providerId];
  const url = new URL(provider.baseUrl);
  if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash || !modelId) {
    throw Error('unsupported_model_endpoint');
  }
  const env = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json', 'utf8'));
  const key = env[provider.apiKey?.id];
  if (typeof key !== 'string' || !key) throw Error('model_credential_unavailable');
  return {primary, modelId, url: url.href.replace(/\/$/u, '') + '/chat/completions', key};
}

export async function relayConfiguredModel(upstream, request, reply) {
  const response = await fetch(upstream.url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
    body: JSON.stringify({...request, model: upstream.modelId, max_tokens: 2000, temperature: 0}),
  });
  if (!response.ok) throw Error('Configured model HTTP ' + response.status);
  reply.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
  for await (const chunk of response.body) reply.write(chunk);
  reply.end();
}

export function syntheticPersona({repo, root, config, policy, userFile}) {
  const source = path.join(root, 'persona-source');
  const put = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, bytes, {mode: 0o600});
  };
  const {identityName, roleFile} = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
  put(path.join(source, 'config/persona.json'), JSON.stringify({identityName, roleFile, userFile,
    agentsIntro: '你正在协助合成测试用户。'}));
  put(path.join(source, 'config/access-control.json'), JSON.stringify(policy));
  put(path.join(source, 'config/runtime.config.json'), JSON.stringify(config));
  for (const file of [roleFile, 'scripts/fusion/templates/AGENTS.md']) put(path.join(source, file), fs.readFileSync(path.join(repo, file)));
  for (const [file, text] of personaFiles(source, root).files) applyPersonaFile(file, text);
}

export function observedToolCall({name, arguments: payload}) {
  let args;
  try {args = JSON.parse(payload);} catch {args = {};}
  if (name === 'dispatch_action' && typeof args?.id === 'string') {
    const tool = /^openclaw:[^:]+:([^:]+)$/u.exec(args.id)?.[1] ?? args.id;
    return {tool, args: args.args ?? {}};
  }
  return {tool: name, args: args ?? {}};
}

export function findObservedToolResult(results, tool, identifiers) {
  return results.findLast(row => row.tool === tool
    && Object.entries(identifiers ?? {}).every(([key, value]) => row.args?.[key] === value));
}

export function observeToolResults() {
  const calls = new Map(), seen = new Set();
  return (messages, results) => {
    for (const message of messages) for (const call of message.tool_calls ?? []) {
      calls.set(call.id, observedToolCall(call.function));
    }
    for (const message of messages) {
      const id = message.tool_call_id;
      if (message.role !== 'tool' || !id || seen.has(id) || !calls.has(id)) continue;
      seen.add(id);
      let value = message.content;
      for (let i = 0; i < 7; i++) {
        if (typeof value === 'string') {try {value = JSON.parse(value); continue;} catch {break;}}
        if (Array.isArray(value) && value.length === 1) {value = value[0].text; continue;}
        if (value?.result) {value = value.result; continue;}
        if (value?.content?.length === 1) {value = value.content[0].text; continue;}
        break;
      }
      results.push({...calls.get(id), value});
    }
  };
}
