// Composition-only imports. Shared proactive-core never depends on plugins.
import path from 'node:path';
import {activeSubject} from '../../../packages/access-control/index.js';
import {KnowledgeMapClient} from '../../../packages/knowledgemap-client/client.js';
import {WeatherStore} from '../../../packages/personal-domains/dist/store.js';
import {ReminderStore} from '../../../packages/personal-domains/dist/reminder-store.js';
import {getPlanningState} from '../../../packages/personal-domains/dist/planning.js';
import {getReminderState} from '../../../packages/personal-domains/dist/reminders.js';
import {WeatherService} from '../../../packages/personal-domains/dist/weather-service.js';
import {KnowledgeMapWeatherClient} from '../../../packages/personal-domains/dist/knowledgemap-client.js';
import {QWeatherClient} from '../../../packages/personal-domains/dist/qweather-client.js';
import {resolvePersonalWeatherConfig} from '../../../packages/personal-domains/dist/config.js';
import {readContinuityContext} from '../../kurumi-memory/continuity/read-model.js';
import {sendSegments} from '../src/transport.js';
import {error} from '../../../packages/proactive-core/policy.js';

const reads={weather:'weather.read',planning:'planning.read',reminders:'reminders.read',reminder_list:'reminder-list.read'};
export const capabilityCatalog=Object.freeze([
  {kind:'weather',description:'查询当前有效地点的真实天气和预警；不改地点或播报'},
  {kind:'planning',description:'查询已保存地点与行程；不新建或修改安排'},
  {kind:'reminders',description:'查询当前一次性提醒；不创建、变更或投递提醒'},
  {kind:'reminder_list',description:'查询网站共享待做事项；不修改事项或播报'},
]);
export function createDomainAdapters({getConfig,ownerId,stateRoot}) {
  const authorize=permission=>activeSubject(getConfig(),ownerId,permission);
  const readWeather=fn=>{const store=new WeatherStore({stateDirectory:path.join(stateRoot,'state/personal-weather'),readOnly:true});try{return fn(store);}finally{store.close();}};
  return {
    memory() {
      authorize('memory.read');
      const cfg=getConfig(),pcfg=cfg.plugins.entries['kurumi-memory']?.config??{};
      if(pcfg.system?.enabled||pcfg.continuityStoreAdapter&&pcfg.continuityStoreAdapter!=='sqlite')throw error('wake_memory_adapter_not_supported');
      return readContinuityContext({workspace:cfg.agents.entries.main.workspace,ownerId,config:pcfg.continuity});
    },
    async query(kind,{signal,runId,verify}) {
      if(!reads[kind])throw error('wake_query_not_allowed');authorize(reads[kind]);verify();
      if(kind==='planning')return readWeather(store=>{const data=getPlanningState(store);return {asOfUtc:data.asOfUtc,profile:data.profile,weather:data.weather,trips:data.trips};});
      if(kind==='reminders') {
        const store=new ReminderStore({stateDirectory:path.join(stateRoot,'state/personal-reminders'),readOnly:true});
        try{const data=getReminderState(store);return {asOfUtc:data.asOfUtc,activeReminders:data.activeReminders};}finally{store.close();}
      }
      if(kind==='reminder_list') {
        const cfg=getConfig().plugins.entries['personal-reminder-list']?.config;
        if(cfg?.dataSource!=='knowledgemap')throw error('wake_list_adapter_not_supported');
        const client=new KnowledgeMapClient({baseUrl:cfg.bridgeBaseUrl,tokenFile:cfg.bridgeTokenFile});
        const items=await client.allTasks({signal,runId});verify();
        return {items:items.slice(0,60),total:items.length,truncated:items.length>60};
      }
      const cfg=getConfig().plugins.entries['personal-weather']?.config;
      if(!cfg)throw error('wake_weather_unavailable');
      const store=new WeatherStore({stateDirectory:path.join(stateRoot,'state/personal-weather'),readOnly:true});
      try {
        // WeatherService can reuse cache reads, but this purpose never writes
        // cache/proposals/business data or runs migrations/reconciliation.
        const readonly={getEffectivePlace:store.getEffectivePlace.bind(store),getFreshApiCache:store.getFreshApiCache.bind(store),
          deleteExpiredApiCache(){},deleteApiCache(){},putApiCache(){}};
        const client=cfg.weatherBackend==='knowledgemap'?new KnowledgeMapWeatherClient({baseUrl:cfg.bridgeBaseUrl,tokenFile:cfg.bridgeTokenFile,runId})
          :new QWeatherClient(resolvePersonalWeatherConfig(cfg));
        const result=await new WeatherService(readonly,client).getBrief(signal);verify();return result;
      } finally {store.close();}
    },
    async send({route,key,text,signal,assertCurrent}) {
      authorize('proactive.notify');
      const cfg=getConfig();
      if(route.channel!=='kurumi-qq'||route.accountId!=='default'||route.to!=='user:'+ownerId)throw error('invalid_wake_route');
      // One tool invocation = one text-only platform request, with the final
      // guard inside the real QQ transport immediately before HTTP dispatch.
      const result=await sendSegments(cfg,route.to,[{type:'text',data:{text}}],key,{signal,assertDirectAdapterHandoff:assertCurrent});
      return {status:'sent',messageId:result.messageId};
    },
  };
}
