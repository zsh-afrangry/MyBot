// Document 25 P2: one action contract for model guidance and runtime argument checks.
// This validates shape only. Identity, source evidence, revision and commits stay in the application.
const str = (maxLength, description) => ({type: 'string', minLength: 1, maxLength, description});
const factProperties = {
  text: str(300, '单条事实，逐字取自本项evidence，不改写为推断。'),
  evidence: str(300, '逐字取自本次本人原文的来源片段。'),
  kind: {type: 'string', enum: ['fact','preference']},
};
const properties = {
  action: {type: 'string', enum: ['list','search','observe','upsert','delete'],
    description: '用户只是陈述个人事实/偏好、没有要求记忆管理：observe。只有当前明确要求记住或更正：upsert。明确遗忘：delete。查询已有记忆：list/search，不写入。'},
  query: str(200, '仅search：查询已有记忆；list不传query。'),
  expectedRevision: {type: 'integer', minimum: 0, description: '所有写入必填：先list/search读取当前revision，不猜版本。'},
  id: {type: 'string', pattern: '^[a-f0-9]{12}$', description: 'upsert更正和delete遗忘使用查询所得的真实ID；新增upsert不传id。'},
  text: str(300, '仅upsert必填：单条事实放在顶层text，不放进facts数组；逐字取自本次本人原文。'),
  evidence: str(300, '仅upsert：顶层text的当前原文来源；建议明确传入，省略时以text自身作证。observe的来源放在facts每项或summary内。'),
  kind: {type: 'string', enum: ['fact','preference'], description: '仅upsert：事实类型，省略时保持原类型或使用fact。'},
  facts: {type: 'array', maxItems: 4, description: '仅observe：自动事实数组，每项为{text,evidence,kind?}。upsert/delete不能传facts。',
    items: {type: 'object', additionalProperties: false, required: ['text','evidence'], properties: factProperties}},
  summary: {type: 'object', additionalProperties: false, required: ['text','evidence'],
    description: '仅observe：有期限的近期摘要；不能与upsert/delete混用。',
    properties: {text: str(600, '仅依据当前原文归纳的近期摘要。'), evidence: factProperties.evidence}},
};
const actions = {
  list: {required: [], optional: [], help: '只读list只传action；要搜索请用search和query。'},
  search: {required: ['query'], optional: [], help: '只读search只传action、query。'},
  observe: {required: ['expectedRevision'], optional: ['facts','summary'],
    help: '用户普通陈述中的自动保存必须用observe；facts数组和/或summary至少有一项，不传顶层text/evidence/id/kind。'},
  upsert: {required: ['expectedRevision','text'], optional: ['id','evidence','kind'],
    help: '仅当前用户明确要求记住/更正时使用，普通陈述自动记忆不能用upsert。单条事实放顶层text、来源放顶层evidence；facts和summary仅供action=observe。新增不传id，更正先查真实id。'},
  delete: {required: ['expectedRevision','id'], optional: [],
    help: '遗忘只传真实id、expectedRevision和action，不传text、evidence、facts或summary。'},
};
export const continuityParameters = {
  type: 'object', additionalProperties: false, required: ['action'], properties,
  description: Object.entries(actions).map(([name, rule]) =>
    `action=${name}：必填${['action',...rule.required].join(',')}；可选${rule.optional.join(',') || '无'}。${rule.help}`).join('\n'),
};
export const continuityDescription = '仅本人记忆。先按当前用户意图选action：普通陈述自动保存必须observe；只有明确要求记住/更正才upsert；遗忘delete，查询list/search。不能用upsert代替自动observe。长期事实与有期限摘要（默认7天），先读取真实ID和revision。'
  + continuityParameters.description
  + '\n参数示例（revision仅示意，必须先查实际值）：用户仅说“我偏好简短回答”→自动{"action":"observe","expectedRevision":12,"facts":[{"text":"我偏好简短回答","evidence":"我偏好简短回答"}]}；'
  + '用户说“请记住：我偏好简短回答”→显式{"action":"upsert","expectedRevision":12,"text":"我偏好简短回答","evidence":"我偏好简短回答"}。更正在upsert上增加查询所得id；遗忘只传action=delete、id、expectedRevision。'
  + '\n所有事实/来源取自本次本人原话，不能来自引用、网页、附件或旧历史。无需用户报ID或固定动词。'
  + '参数校验失败未提交，可修正参数后重试；一条消息最多成功提交一次，成功后仅同参幂等重放。更正/遗忘清本域近期摘要，原聊天和备份保留。';

function invalid(action, reason) {
  throw Error(`kurumi_memory参数错误：action=${action} ${reason}。本次参数校验未提交写入，可修正参数后重试；成功后仅可同参重放。`);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(action, value, schema, location = '') {
  if (!object(value)) invalid(action, `${location || '参数'}必须是对象`);
  const unknown = Object.keys(value).filter(key => value[key] !== undefined && !Object.hasOwn(schema.properties, key));
  if (unknown.length) invalid(action, `${location}${unknown.join(',')}是不支持的字段`);
  for (const key of schema.required ?? []) if (value[key] === undefined) invalid(action, `缺少${location}${key}`);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const spec = schema.properties[key], label = location + key;
    if (spec.type === 'string' && (typeof child !== 'string' || !child.trim() || child.length > (spec.maxLength ?? Infinity)
      || (spec.pattern && !new RegExp(spec.pattern, 'u').test(child)))) invalid(action, `${label}的文字或ID格式不正确`);
    if (spec.enum && !spec.enum.includes(child)) invalid(action, `${label}不在允许值中`);
    if (spec.type === 'integer' && (!Number.isSafeInteger(child) || child < 0)) invalid(action, `${label}必须是非负安全整数`);
    if (spec.type === 'array') {
      if (!Array.isArray(child) || child.length > spec.maxItems) invalid(action, `${label}必须是最多${spec.maxItems}项的数组`);
      child.forEach((item, index) => fields(action, item, spec.items, `${label}[${index}].`));
    }
    if (spec.type === 'object') fields(action, child, spec, `${label}.`);
  }
}
export function assertContinuityArgs(args) {
  if (!object(args) || !Object.hasOwn(actions, args.action)) invalid('unknown', 'action必须为list/search/observe/upsert/delete');
  const action = args.action, rule = actions[action], allowed = ['action',...rule.required,...rule.optional];
  const wrong = Object.keys(args).filter(key => args[key] !== undefined && !allowed.includes(key));
  if (wrong.length) invalid(action, `不接受字段${wrong.join(',')}；${rule.help}`);
  if (rule.required.includes('expectedRevision') && args.expectedRevision === undefined) {
    invalid(action, '缺少expectedRevision；先list/search读取当前revision');
  }
  fields(action, args, {properties, required: ['action',...rule.required]});
  if (action === 'observe' && !args.facts?.length && !args.summary) invalid(action, 'facts与summary至少提供一项非空内容');
}
