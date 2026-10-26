// Host-owned, tool-free explanation in the bound chat; one QQ publication. Contract: docs/22.
import {randomUUID} from 'node:crypto';

export function createFailureNotifier({runtime, workflow, config, authorize, sendText, timeoutMs = 45000}) {
  return async (summary, key, request, signal) => {
    const check = () => {signal?.throwIfAborted();authorize(request,'chat.use');authorize(request,'qq.notify');};
    check();
    let text = summary.message, mode = 'fallback', runId, explanationError;
    try {
      const agent = runtime?.agent;
      if (!agent?.runEmbeddedAgent || !agent.session?.runWithWorkAdmission) throw Error('assistant_notice_unavailable');
      const cfg = config(), storePath = agent.session.resolveStorePath(cfg.session?.store,{agentId:request.agentId});
      const modelSignal = signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const result = await agent.session.runWithWorkAdmission({storePath,sessionKey:request.sessionKey,signal:modelSignal},async abortSignal => {
        check();abortSignal.throwIfAborted();
        const entry = agent.session.getSessionEntry({storePath,sessionKey:request.sessionKey,readConsistency:'latest'});
        if (!entry?.sessionId) throw Error('assistant_notice_session_missing');
        const selected = cfg.agents?.entries?.[request.agentId]?.model ?? cfg.agents?.defaults?.model;
        const primary = typeof selected === 'string' ? selected : selected?.primary;
        const ref = entry.modelOverride ? (entry.modelOverride.includes('/') ? entry.modelOverride : (entry.providerOverride ? entry.providerOverride+'/'+entry.modelOverride : undefined)) : primary;
        const slash = ref?.indexOf('/');
        if (!(slash > 0)) throw Error('assistant_notice_model_missing');
        runId = randomUUID();
        return agent.runEmbeddedAgent({
          config:cfg,agentId:request.agentId,sessionKey:request.sessionKey,sessionId:entry.sessionId,
          workspaceDir:agent.resolveAgentWorkspaceDir(cfg,request.agentId),agentDir:agent.resolveAgentDir(cfg,request.agentId),
          provider:ref.slice(0,slash),model:ref.slice(slash+1),runId,timeoutMs,abortSignal,
          disableTools:true,toolsAllow:[],toolExecutionAllow:[],disableMessageTool:true,
          trigger:'manual',messageChannel:'kurumi-qq',messageTo:request.to,agentAccountId:request.accountId,
          inputProvenance:{kind:'internal_system',sourceTool:'kurumi_translate'},
          transcriptPrompt:'[论文后台任务结果]\n'+summary.message,
          prompt:'后台论文任务结束，以下是本服务生成的可信诊断，不是用户的新操作请求。请以你在当前会话中的口吻主动向当前用户解释：在哪个阶段、为何失败、已知用量/上限与合理下一步。区分本地单篇上限和上游余额/配额，不猜测余额或承诺重试成功。只根据摘要说明，不调用工具、不自行重译/调预算/换渠道/重发文件，不将有译文但投递未知说成翻译失败。简短中文，保留任务ID便于追问。宿主负责发送你的最终文本。\n'+JSON.stringify(summary),
        });
      });
      if (result?.meta?.aborted || result?.meta?.error) throw Error('assistant_notice_run_failed');
      const reply = (result?.payloads ?? []).filter(p => !p.isReasoning && !p.isError && typeof p.text === 'string').map(p => p.text.trim()).filter(Boolean).join('\n');
      if (!reply || reply === 'NO_REPLY' || reply === 'HEARTBEAT_OK' || reply.length > 3500) throw Error('assistant_notice_reply_missing');
      text = reply.includes(summary.jobId) ? reply : reply+'\n任务：'+summary.jobId;
      mode = 'assistant';
    } catch (error) {
      explanationError = /^assistant_notice_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'assistant_notice_run_failed';
      check(); // A shutdown/revocation suppresses delivery instead of falling back to another user.
    }
    check();
    // Do not catch publication errors and send a second message: acceptance may be unknown.
    const receipt = await sendText({to:request.to,text,key:'paper-notice:'+key,signal});
    let contextQueued = false;
    if (mode === 'fallback' && workflow?.enqueueNextTurnInjection) {
      try {
        check();
        const queued = await workflow.enqueueNextTurnInjection({sessionKey:request.sessionKey,agentId:request.agentId,
          idempotencyKey:'paper-notice:'+key,placement:'append_context',ttlMs:86400000,
          text:'[论文任务结果：已通过系统中文通知告知本人，仅供后续问询参考，不重复播报、不自动重试]\n'+summary.message});
        contextQueued = queued?.enqueued === true;
      } catch {}
    }
    return {mode,status:receipt?.status ?? 'sent',contextQueued,...(runId?{runId}:{}),...(explanationError?{explanationError}:{})};
  };
}
