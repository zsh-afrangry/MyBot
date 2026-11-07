import {localTime} from './time.js';
export function digestFacts(items, at) {
  return [`未完成：${items.length}项；快照：${localTime(at).slice(0,16).replace('T',' ')}（Asia/Shanghai）`,
    ...items.map(item => [`事项：${item.title}〔${item.id}〕`,
      `DDL：${item.ddl ? item.ddl.replace('T',' ')+(item.ddl.length===10?' 当日结束':'') : '未设 DDL'}`,
      ...(item.content?['内容：'+item.content]:[]),...(item.note?['备注：'+item.note]:[])].join('\n'))];
}
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
