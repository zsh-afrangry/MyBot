// Bounded model acceptance questions/assertions only; importing never calls a model or network. docs/27.
import assert from 'node:assert/strict';
function verifyReviews(row, results, heroCode, category) {
  const index = row.calls.findIndex(({args}) => args.action === 'reviews' && args.heroCode === heroCode && args.category === category);
  assert(index >= 0);
  const {items, total} = results[index].data;
  if (total === 0) assert.match(row.reply, /没有|暂无|未.*(?:收录|找到|列出|提供)|空/u);
  else {
    const labels = items.flatMap(({author, title}) => [author, title]).filter(Boolean);
    if (labels.length) assert(labels.some(value => row.reply.includes(value)));
  }
}
export const modelCases = [
    ['gvg-hot','查E7wiki热门GVG防守的前两条，说明查询覆盖范围和胜率能否保证可靠。',row=>{assert(row.calls.some(c=>c.args.action==='gvg'&&c.args.view==='hot_defenses'));assert.match(row.reply,/100|一百/u);assert.match(row.reply,/不能|不代表|无法|不保证|不等于/u);assert.match(row.reply,/胜率|样本/u);}],
    ['fates-candidates','查混沌宿命赛季pvp_rta_chaos_s1中残影的菲奥雷托（remnant-violet）的候选宿命，简短说明普通候选和recTier推荐各有多少，各举一个例子并注明E7wiki来源，不要把全部候选都叫推荐。',row=>{assert(row.calls.some(c=>c.args.action==='fates'&&c.args.view==='hero_fates'&&c.args.heroCode==='remnant-violet'&&c.args.seasonId==='pvp_rta_chaos_s1'));assert.match(row.reply,/候选/u);assert.match(row.reply,/推荐/u);}],
    ['fates-seasons', '混沌宿命有哪些赛季？请列出可查询的赛季 ID。', (row, results) => {
      const index = row.calls.findIndex(({args}) => args.action === 'fates' && (!args.view || args.view === 'list') && !('seasonId' in args));
      assert(index >= 0);
      assert(results[index].data.items.every(({seasonId}) => row.reply.includes(seasonId)));
      assert.match(row.reply, /UTC/iu);
    }],
    ['packs-value','查E7wiki礼包列表，然后打开第一条详情，说明其中的道具数量和站点估值。币种、比率公式、实时商城价格能确定吗？',row=>{assert(row.calls.some(c=>c.args.action==='packs'&&(!c.args.mode||c.args.mode==='list')));assert(row.calls.some(c=>c.args.action==='packs'&&c.args.mode==='get'&&c.args.packId));assert.match(row.reply,/币种/u);assert.match(row.reply,/公式/u);assert.match(row.reply,/未|不能|无法|不明/u);}],
    ['hero-ambiguous', '查一下莉莉的技能。', row => {assert(row.calls.some(c => c.args.action === 'search' && c.args.kind === 'hero')); assert(!row.calls.some(c => c.args.action === 'hero')); assert.match(row.reply, /哪|几位|选择|指的是|具体|确认/u);}],
    ['hero-skills', '查一下梅铃的技能。', row => {assert(row.calls.some(c => c.args.action === 'search')); assert(row.calls.some(c => c.args.action === 'hero' && c.args.heroCode === 'mei-lin' && (!c.args.view || c.args.view === 'skills'))); assert.match(row.reply, /火龙拳|升龙脚|火龙升天/u);}],
    ['hero-stats', '梅铃的基础面板是多少？这些数值算了装备吗？', row => {assert(row.calls.some(c => c.args.action === 'hero' && c.args.view === 'stats')); assert.match(row.reply, /1208|1,208/u); assert.match(row.reply, /不含|不包含|未.*装备|没有.*装备|未计入|不计/u);}],
    ['hero-missing-exclusive', '梅铃的专属装备是什么？', row => {assert(row.calls.some(c => c.args.action === 'hero' && c.args.view === 'exclusive')); assert.match(row.reply, /没有|暂无|未提供|未收录|未查到|缺少|未.*专属/u);}],
    ['artifact-effect', '查一下火龙宝石的效果。', row => {assert(row.calls.some(c => c.args.action === 'artifact')); assert.match(row.reply, /火龙宝石/u); assert.match(row.reply, /区间|范围|未.*(?:等级|满级|突破)/u); assert.doesNotMatch(row.reply, /满级(?:为|是|后|时)/u);}],
    ['effect-dictionary', '第七史诗中的灭亡效果是什么意思？', row => {assert(row.calls.some(c => c.args.action === 'dictionary' && c.args.kind === 'effect')); assert.match(row.reply, /复活/u); assert.match(row.reply, /UTC/iu); assert.doesNotMatch(row.reply, /官方说明|官方结论/u);}],
    ['codes', '查最新的国际服兑换码，能保证我现在一定能兑换吗？', row => {assert(row.calls.some(c => c.args.action === 'codes' && c.args.server === '国际服')); assert.match(row.reply, /不能保证|无法保证|不保证|未(?:实际|经过)?验证|尚未经过验证|不一定|不能构成可用承诺/u); assert.doesNotMatch(row.reply.slice(0, 160), /目前(?:还|仍)在有效期内的/u); assert.match(row.reply, /时区/u);}],
    ['game-news', '查一下国际服最新两条游戏公告，告诉我有没有读到公告正文。', row => {assert(row.calls.some(c => c.args.action === 'news' && c.args.kind === 'game' && c.args.server === '国际服')); assert.match(row.reply, /未.*正文|没有.*正文|尚未|未.*解析|只.*目录|仅.*目录/u);}],
    ['builds-sample', '查梅铃的两条社区配装示例，说明面板是否含装备，保留作者和更新时间。', row => {assert(row.calls.some(c => c.args.action === 'search')); assert(row.calls.some(c => c.args.action === 'builds' && c.args.heroCode === 'mei-lin')); assert.match(row.reply, /含装备|包含装备|已.*装备|装备.*样本/u); assert.match(row.reply, /作者|来源|Fribbels/u);}],
    ['builds-filtered', '查梅铃的配装，只要同时包含开战和穿透、速度至少218、暴伤至少250%的，取前三条。', row => {assert(row.calls.some(c => c.args.action === 'builds' && c.args.filters?.sets?.includes('开战') && c.args.filters?.sets?.includes('穿透') && c.args.filters?.minStats?.spd === 218 && c.args.filters?.minStats?.chd === 250 && c.args.limit === 3)); assert.doesNotMatch(row.reply, /28900%|25000%/u);}],
    ['reviews-rta', '查小春的RTA测评，告诉我标题、作者和更新时间。', (row, results) => verifyReviews(row, results, 'haru', 'RTA')],
    ['reviews-pve', '查梅铃的PVE测评，列标题、作者和更新时间。来源没有的话直接说没有，不用自己编。', (row, results) => verifyReviews(row, results, 'mei-lin', 'PVE')],
    ['rankings-artifacts', '看看E7wiki有哪些神器榜单，打开其中一份，列出前五条并保留榜单名称和更新时间。', row => {
      assert(row.calls.some(c => c.args.action === 'rankings' && (!c.args.mode || c.args.mode === 'list') && c.args.objectType === 'artifact'));
      assert(row.calls.some(c => c.args.action === 'rankings' && c.args.mode === 'get' && c.args.rankingId));
      assert.match(row.reply, /神器/u); assert.match(row.reply, /2026|更新|日期/u);
    }],
    ['content-guide', '查E7wiki的“挑战深渊1层30秒速刷光辉精髓”攻略，读取正文后告诉我要点；如果图片没有提取，明确说明。', row => {
      assert(row.calls.some(c => c.args.action === 'content' && c.args.kind === 'guide' && (!c.args.mode || c.args.mode === 'search')));
      assert(row.calls.some(c => c.args.action === 'content' && c.args.kind === 'guide' && c.args.mode === 'get' && c.args.contentId));
      assert.match(row.reply, /图片|截图|配图/u); assert.match(row.reply, /未|无法|没/u);
    }],
    ['content-faq', '查E7wiki FAQ：团战比对方少人时，防御塔的血量如何变化？请读取对应问答并保留作者和日期。', row => {
      assert(row.calls.some(c => c.args.action === 'content' && c.args.kind === 'faq' && (!c.args.mode || c.args.mode === 'search')));
      assert(row.calls.some(c => c.args.action === 'content' && c.args.kind === 'faq' && c.args.mode === 'get' && c.args.contentId));
      assert.match(row.reply, /血量|生命/u); assert.match(row.reply, /作者|来源/u); assert.match(row.reply, /20\d{2}/u);
    }],
  ];
