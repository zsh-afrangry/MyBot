// Fixed 2C text contracts only. No arbitrary paths, images, writes or game actions.
import {codePattern,fail,object} from './policy.js';
import {text} from './text.js';
export const GAMEPLAY_KINDS=['gvgHomework','gvgHot','fates','fateHeroes','heroFates','packs'];
export const FATE_TIERS=['T0','T0.5','T1','T1.5','T2','T3'];
const stable=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const numericId=v=>typeof v==='string'&&/^\d{1,10}$/.test(v);
const code=v=>typeof v==='string'&&codePattern.test(v);
const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const money=v=>(typeof v==='string'&&/^\d+(?:\.\d{1,8})?$/.test(v))||num(v);
const invalid=()=>fail('invalid_response');
const team=(r,prefix)=>[1,2,3].map(n=>r[prefix+'Hero'+n]).filter(v=>v!=null&&v!=='');
const teams=(r,prefix)=>[1,2,3].filter(n=>r[prefix+'Hero'+n]).map(n=>({heroCode:r[prefix+'Hero'+n],name:text(r[prefix+'Hero'+n+'Obj']?.name)||null}));
export function validateGameplayQuery(a){
 if(a.action==='gvg'){
  a.view??='homework';a.match??='exact';
  if(!['homework','hot_defenses'].includes(a.view)||!['exact','contains'].includes(a.match))fail('invalid_query');
  if(a.view==='hot_defenses'&&a.offenseHeroCodes)fail('invalid_query');
  for(const key of ['defenseHeroCodes','offenseHeroCodes'])if(key in a){
   if(!Array.isArray(a[key])||!a[key].length||a[key].length>3||a[key].some(v=>!code(v))||new Set(a[key]).size!==a[key].length)fail('invalid_query');
   a[key]=[...a[key]].sort();
  }
 }
 if(a.action==='fates'){
  a.view??='list';if(!['list','recommended_heroes','hero_fates'].includes(a.view)||!stable(a.seasonId))fail('invalid_query');
  if(a.view==='hero_fates'?!code(a.heroCode):'heroCode' in a)fail('invalid_query');
 }
 if(a.action==='packs'){
  a.mode??='list';if(!['list','get'].includes(a.mode)||(a.mode==='get'?!numericId(a.packId)||['limit','cursor'].some(k=>k in a):'packId' in a))fail('invalid_query');
 }
}
export function gameplayRows(kind,data){return kind==='gvgHomework'?data?.list:kind==='fateHeroes'?data?.heroes:kind==='heroFates'?data?.items:data;}
export function validateGameplayData(kind,data,params={}){
 const rows=gameplayRows(kind,data);
 if(!Array.isArray(rows)||rows.length>(['gvgHomework','gvgHot'].includes(kind)?100:10000))invalid();
 if(kind==='gvgHomework'){
  const p=data.pagination;if(!object(p)||p.page!==(params.page??1)||p.size!==100||!Number.isInteger(p.total)||p.total<0||(rows.length>0&&p.total<(p.page-1)*100+rows.length))invalid();
 }
 if(kind==='fateHeroes'&&(!object(data)||data.seasonId!==params.seasonId||!Array.isArray(data.seasons)||data.seasons.some(v=>!stable(v))||!Array.isArray(data.tiers)||data.tiers.some(v=>typeof v!=='string')))invalid();
 if(kind==='heroFates'&&(!object(data)||data.seasonId!==params.seasonId||data.heroCode!==params.heroCode))invalid();
 const seen=new Set();
 for(const r of rows){
  if(!object(r))invalid();const id=kind==='heroFates'?r.chaos_fate_id:String(kind==='packs'?r.packId:r.id??'');
  if((kind==='heroFates'?!stable(id)||(r.id!=null&&!numericId(String(r.id))):!numericId(id))||seen.has(id))invalid();seen.add(id);
  if(['gvgHomework','gvgHot'].includes(kind)){
   for(const prefix of kind==='gvgHomework'?['defense','offense']:['defense']){const t=team(r,prefix);if(!t.length||t.some(v=>!code(v))||new Set(t).size!==t.length)invalid();}
   if(kind==='gvgHomework'&&['win','lose'].some(k=>r[k]!=null&&(!Number.isInteger(r[k])||r[k]<0)))invalid();
  }
  if(kind==='fates'&&(!stable(r.chaos_fate_id)||!stable(r.season_id)||typeof r.fate_name!=='string'||typeof r.fate_desc!=='string'))invalid();
  if(kind==='fateHeroes'&&(!code(r.hero_code)||typeof r.name!=='string'||typeof r.tier!=='string'))invalid();
  if(kind==='heroFates'&&(r.hero_code!==params.heroCode||!stable(r.chaos_fate_id)||typeof r.fate_name!=='string'||typeof r.fate_desc!=='string'||r.recTier!=null&&typeof r.recTier!=='string'))invalid();
  if(kind==='packs'){
   if(typeof r.packName!=='string'||!money(r.packPrice)||['totalSkyStoneValue','valueRatio'].some(k=>r[k]!=null&&!num(r[k]))||!Array.isArray(r.itemBreakdown)||r.itemBreakdown.length>100)invalid();
   for(const i of r.itemBreakdown)if(!object(i)||!numericId(String(i.itemId))||typeof i.itemName!=='string'||['quantity','unitPrice','totalPrice'].some(k=>i[k]!=null&&!num(i[k])))invalid();
  }
 }
 return data;
}
const matches=(actual,wanted,mode)=>!wanted||wanted.every(c=>actual.includes(c))&&(mode==='contains'||actual.length===wanted.length);
const fate=r=>({id:r.id==null?null:String(r.id),fateId:r.chaos_fate_id,name:text(r.fate_name),description:text(r.fate_desc),type:text(r.type),tier:text(r.tier),condition:text(r.condition)||null,statValue:text(r.fate_stat_value)||null});
const pack=r=>({packId:String(r.packId),name:text(r.packName),price:r.packPrice,currency:null,totalSkyStoneValue:r.totalSkyStoneValue??null,valueRatio:r.valueRatio??null,
 items:r.itemBreakdown.map(i=>({itemId:String(i.itemId),name:text(i.itemName),quantity:i.quantity??null,unitSkyStoneValue:i.unitPrice??null,totalSkyStoneValue:i.totalPrice??null})),
 valuationBasis:{source:'E7·WIKI',realtimePriceVerified:false,ratioFormula:null,note:'站点按道具天青石估值计算；保留来源单价/数量/总值。币种和比率公式未注明，不推算或作为实时商城价格/购买建议。'}});
export async function queryGameplay(args,{get,pageRows}){
 let data,status='ok',missingFields=[];
 if(args.action==='gvg'){
  const requested=[...args.defenseHeroCodes??[],...args.offenseHeroCodes??[]];
  if(requested.length){const cards=await get('cards');if(requested.some(c=>!cards.data.some(r=>r.code===c)))fail('unknown_hero');}
  let rows,stamp,coverage;
  if(args.view==='hot_defenses'){
   const all=await get('gvgHot');rows=all.data;stamp=all.hash;coverage={scope:'upstream_top_100',fetched:rows.length,totalAvailable:null,note:'只筛来源热门防守前100条，不等于全部防守；不把热度或来源winRate解释为可靠胜率。'};
  }else{
   rows=[];const hashes=[],ids=new Set();let total;
   for(let page=1;page<=30;page++){
    const r=await get('gvgHomework',{page}),p=r.data.pagination;
    if(total===undefined)total=p.total;else if(total!==p.total)fail('gvg_snapshot_changed');
    if(total>3000)fail('gvg_catalog_too_large');
    for(const row of r.data.list){if(ids.has(String(row.id)))fail('gvg_snapshot_changed');ids.add(String(row.id));rows.push(row);}hashes.push(r.hash);
    if(rows.length===total)break;if(r.data.list.length!==100||rows.length>total)fail('gvg_snapshot_changed');
   }
   if(rows.length!==total)fail('gvg_snapshot_changed');stamp=hashes;coverage={scope:'complete_verified_pages',fetched:rows.length,totalAvailable:total,note:'固定每页100条、最多3000条，核对总数/重复ID后在本地按无槽位顺序的阵容筛选；分页不是上游跨页事务。'};
  }
  const selected=rows.filter(r=>matches(team(r,'defense'),args.defenseHeroCodes,args.match)&&matches(team(r,'offense'),args.offenseHeroCodes,args.match));
  data={...pageRows(selected.map(r=>({id:String(r.id),defense:teams(r,'defense'),...(args.view==='homework'?{offense:teams(r,'offense'),scene:text(r.scene),strategy:text(r.strategy),equipment:text(r.equipment),artifact:text(r.artifact),note:text(r.note),author:text(r.author)||null,updatedAt:text(r.updateTime)||null,observations:{wins:r.win??null,losses:r.lose??null,reliableWinRate:null},equipmentByHero:[1,2,3].map(n=>({heroCode:r['offenseHero'+n]??null,equipment:text(r['offenseHero'+n+'Equipment']),artifact:text(r['offenseHero'+n+'Artifact'])}))}:{description:text(r.description),weight:r.weight??null,searchCount:r.searchCount??null,reliableWinRate:null})})),args,stamp),match:args.match,coverage,sampleWarning:'计数只是来源样本，不能据少量胜负推导可靠胜率、确定克制或保证胜利。'};
 }
 if(args.action==='fates'){
  const all=await get('fates'),seasons=[...new Set(all.data.map(r=>r.season_id))];
  if(!seasons.includes(args.seasonId))return{status:'not_found',data:{availableSeasons:seasons},missingFields};
  if(args.view==='list')data={...pageRows(all.data.filter(r=>r.season_id===args.seasonId).map(fate),args,all.hash),seasonId:args.seasonId,availableSeasons:seasons};
  else{
   if(args.view==='hero_fates'){const cards=await get('cards');if(!cards.data.some(r=>r.code===args.heroCode))fail('unknown_hero');}
   const r=await get(args.view==='hero_fates'?'heroFates':'fateHeroes',{seasonId:args.seasonId,...(args.heroCode?{heroCode:args.heroCode}:{})});
   const values=args.view==='hero_fates'?r.data.items.map(v=>({...fate(v),heroCode:v.hero_code,source:text(v.source),recommendationTier:v.recTier||null,recommended:FATE_TIERS.includes(v.recTier)?true:!v.recTier?false:null,remark:text(v.remark)}))
    :r.data.heroes.map(v=>({heroCode:v.hero_code,name:text(v.name),recommendationTier:v.tier,knownTier:FATE_TIERS.includes(v.tier),remark:text(v.remark),fateCount:v.fateCount??null}));
   data={...pageRows(values,args,r.hash),seasonId:args.seasonId,...(args.heroCode?{heroCode:args.heroCode,recommendationCounts:{recommended:values.filter(v=>v.recommended===true).length,candidate:values.filter(v=>v.recommended===false).length,unknown:values.filter(v=>v.recommended===null).length}}:{}),availableSeasons:seasons,recommendationBasis:'仅站点该赛季推荐；hero_fates无recTier是普通候选，未知分档保留未知，不把所有候选都称作推荐。'};
   if(values.some(v=>v.recommended===null||v.knownTier===false))missingFields.push('recommendationTier');
  }
 }
 if(args.action==='packs'){
  const all=await get('packs');
  if(args.mode==='get'){const row=all.data.find(r=>String(r.packId)===args.packId);data=row?pack(row):null;if(!row)status='not_found';}
  else data={...pageRows(all.data.map(r=>({packId:String(r.packId),name:text(r.packName),price:r.packPrice,currency:null,totalSkyStoneValue:r.totalSkyStoneValue??null,valueRatio:r.valueRatio??null})),args,all.hash),valuationBasis:'站点列表估值；详情看get，币种/比率公式未注明，不是实时商城报价或购买建议。'};
  missingFields.push('currency','ratioFormula');
 }
 return{data,status,missingFields};
}
