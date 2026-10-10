import {localTime} from './time.js';
export function formatDigest(items, at) {
  if (!items.length) return '';
  const lines = [`提醒列表 · ${localTime(at).slice(0, 16).replace('T', ' ')}（Asia/Shanghai）`, `未完成 ${items.length} 项：`];
  items.forEach((item, index) => {
    const ddl = item.ddl ? item.ddl.replace('T', ' ') + (item.ddl.length === 10 ? ' 当日结束' : '') : '未设 DDL';
    lines.push(`${index + 1}. ${item.title}〔${item.id}〕\n   DDL：${ddl}`);
    if (item.content) lines.push(`   内容：${item.content}`);
    if (item.note) lines.push(`   备注：${item.note}`);
  });
  return lines.join('\n');
}
