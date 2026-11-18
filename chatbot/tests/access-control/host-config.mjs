// Assemble the full trust boundary for temporary Gateway fixtures only.
import path from 'node:path';

export function withHostControl(config, repo) {
  const plugins = config.plugins;
  const qq = plugins?.entries?.['kurumi-qq'];
  if (qq?.enabled !== true) return config;
  const {exec, proactive, ...channelConfig} = qq.config ?? {};
  if (Object.keys(channelConfig).length) qq.config = channelConfig;
  else delete qq.config;
  plugins.entries['kurumi-host-control'] ??= {enabled: true,
    config: {...(exec ? {exec} : {}), ...(proactive ? {proactive} : {})}};
  if (!plugins.allow.includes('kurumi-host-control')) plugins.allow.push('kurumi-host-control');
  const pluginPath = path.join(repo, 'chatbot/plugins/kurumi-host-control');
  if (!plugins.load.paths.includes(pluginPath)) plugins.load.paths.push(pluginPath);
  return config;
}
