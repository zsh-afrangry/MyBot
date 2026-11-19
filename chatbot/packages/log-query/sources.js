// One source catalogue for CLI collection and the owner tool. Paths are never model input.
import path from 'node:path';
export const SOURCES=Object.freeze([
  'openclaw-runtime','openclaw-session','openclaw-receipt','snowluma','cron-runs','channel-delivery',
  'access-control','trace-events','personal-reminders','personal-reminder-list','kurumi-memory','e7',
  'papers','web-deepseek','knowledgemap','proactive','snowluma-messages',
]);
export const QQ_SOURCES=Object.freeze(SOURCES.filter(id=>!['proactive','snowluma-messages'].includes(id)));
export function traceSources(root,config={}) {
  const paperRoot=config.plugins?.entries?.['kurumi-papers']?.config?.root??path.join(root,'documents');
  return [
    ...[['trace-events','trace-events.jsonl'],['e7','e7-events.jsonl'],['kurumi-memory','memory-events.jsonl'],['access-control','access-events.jsonl']]
      .map(([id,name])=>({id,file:path.join(root,'channel',name)})),
    {id:'papers',file:path.join(paperRoot,'events.jsonl'),paperRoot},
    {id:'web-deepseek',file:config.plugins?.entries?.['kurumi-web-deepseek']?.config?.traceFile},
    ...['knowledgemap','proactive'].map(id=>({id,file:path.join(root,'state',id,'trace.jsonl')})),
  ];
}
