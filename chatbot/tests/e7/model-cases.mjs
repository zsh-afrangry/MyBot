// Bounded model acceptance questions/assertions only; importing never calls a model or network. docs/27.
import assert from 'node:assert/strict';
export const modelCases = [
    ['hero-ambiguous', '查一下莉莉的技能。', row => {assert(row.calls.some(c => c.args.action === 'search' && c.args.kind === 'hero')); assert(!row.calls.some(c => c.args.action === 'hero')); assert.match(row.reply, /哪|几位|选择|指的是|具体|确认/u);}],
    ['hero-skills', '查一下梅铃的技能。', row => {assert(row.calls.some(c => c.args.action === 'search')); assert(row.calls.some(c => c.args.action === 'hero' && c.args.heroCode === 'mei-lin' && (!c.args.view || c.args.view === 'skills'))); assert.match(row.reply, /火龙拳|升龙脚|火龙升天/u);}],
    ['hero-stats', '梅铃的基础面板是多少？这些数值算了装备吗？', row => {assert(row.calls.some(c => c.args.action === 'hero' && c.args.view === 'stats')); assert.match(row.reply, /1208|1,208/u); assert.match(row.reply, /不含|不包含|未.*装备|没有.*装备|未计入|不计/u);}],
    ['hero-missing-exclusive', '梅铃的专属装备是什么？', row => {assert(row.calls.some(c => c.args.action === 'hero' && c.args.view === 'exclusive')); assert.match(row.reply, /没有|暂无|未提供|未收录|未查到|缺少|未.*专属/u);}],
    ['artifact-effect', '查一下火龙宝石的效果。', row => {assert(row.calls.some(c => c.args.action === 'artifact')); assert.match(row.reply, /火龙宝石/u); assert.match(row.reply, /区间|范围|未.*(?:等级|满级|突破)/u); assert.doesNotMatch(row.reply, /满级(?:为|是|后|时)/u);}],
    ['effect-dictionary', '第七史诗中的灭亡效果是什么意思？', row => {assert(row.calls.some(c => c.args.action === 'dictionary' && c.args.kind === 'effect')); assert.match(row.reply, /复活/u); assert.doesNotMatch(row.reply, /官方说明|官方结论/u);}],
    ['codes', '查最新的国际服兑换码，能保证我现在一定能兑换吗？', row => {assert(row.calls.some(c => c.args.action === 'codes' && c.args.server === '国际服')); assert.match(row.reply, /不能保证|无法保证|不保证|未(?:实际|经过)?验证|尚未经过验证|不一定|不能构成可用承诺/u); assert.doesNotMatch(row.reply.slice(0, 160), /目前(?:还|仍)在有效期内的/u); assert.match(row.reply, /时区/u);}],
    ['game-news', '查一下国际服最新两条游戏公告，告诉我有没有读到公告正文。', row => {assert(row.calls.some(c => c.args.action === 'news' && c.args.kind === 'game' && c.args.server === '国际服')); assert.match(row.reply, /未.*正文|没有.*正文|尚未|未.*解析|只.*目录|仅.*目录/u);}],
  ];
