// Bound assistant explanation with tool execution disabled. Generation failure is not a notification.
import {createAssistantComposer} from '../../packages/response-core/index.js';
export function createFailureNotifier({runtime, config, authorize, sendText, timeoutMs = 45000}) {
  const compose = createAssistantComposer({runtime,config,timeoutMs});
  return async (summary,key,request,signal) => {
    const check = () => {signal?.throwIfAborted();authorize(request,'chat.use');authorize(request,'qq.notify');};
    const {text,runId} = await compose({facts:summary,request,signal,check,sourceTool:'kurumi_translate',required:[summary.jobId],
      instructions:'说明失败阶段、原因、已知用量/上限和下一步；区分本地单篇上限与上游余额，不猜余额或承诺重试成功。有译文但投递未知不能说翻译失败。保留真实任务ID便于追问。简短中文。'});
    check();
    // A lost receipt may mean accepted: never generate/send a second message here.
    const receipt = await sendText({to:request.to,text,key:'paper-notice:'+key,signal});
    return {mode:'assistant',status:receipt?.status ?? 'sent',contextQueued:false,runId};
  };
}
