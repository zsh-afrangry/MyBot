// Operator CLI. inspect is local-only; json sends no account data; pcap posts the exact approved file to e7bot.top/captures.
// Writes only two private Excel files into a new, operator-selected output directory. Never sends to QQ.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {assertCaptureApproval, loadE7BotMetadata, readAccountJson, readCapture, submitAndroidCapture} from '../plugins/kurumi-e7/account/source.js';
import {AccountExportError, projectAccount} from '../plugins/kurumi-e7/account/projection.js';
import {writeAccountWorkbooks} from '../plugins/kurumi-e7/account/workbooks.js';

const help = `用法：node chatbot/scripts/e7-account-export.mjs <模式> [选项]
  inspect --pcap <文件>   在本机检查 PCAP，打印包数、时段、大小和确认用的 SHA-256。
  json --equips <文件> --units <文件> --out <新目录>   读取本地数组，生成两份 Excel。
  pcap --pcap <文件> --approve-sha256 <SHA-256> --out <新目录>   明确同意将上述摘要对应的原始 PCAP 发送至 e7bot.top 后再执行。
json / pcap 默认只从 E7Bot 读取公开图鉴；加 --manifest <文件> --metadata <gzip 文件> 可使用同一版本的本地图鉴。`;
const keys = {
  inspect: ['pcap'], json: ['equips', 'units', 'out', 'manifest', 'metadata'],
  pcap: ['pcap', 'approve-sha256', 'out', 'manifest', 'metadata'],
};
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const invalid = message => {throw new AccountExportError(message);};
const under = (base, file) => {
  const relative = path.relative(base, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

async function newOutput(input) {
  const abs = path.resolve(input), parent = await fs.realpath(path.dirname(abs));
  const target = path.join(parent, path.basename(abs));
  const state = path.join(os.homedir(), '.openclaw-fusion');
  const realState = await fs.realpath(state).catch(() => state);
  if (under(realState, target) || (under(repoRoot, target) && !under(path.join(repoRoot, 'test-output'), target))) {
    invalid('请选择仓库和运行目录以外的新目录；测试产物可放在 test-output 下');
  }
  const exists = await fs.lstat(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (exists) invalid('输出目录已经存在，请另选一个新目录');
  return target;
}

async function main([mode, ...argv]) {
  if (mode === '--help' || mode === '-h' || mode == null) {console.log(help); return;}
  if (!Object.hasOwn(keys, mode)) invalid('未知模式。用 --help 查看用法');
  const {values} = parseArgs({args: argv, options: Object.fromEntries(keys[mode].map(k => [k, {type: 'string', multiple: true}]))});
  if (Object.values(values).some(items => items.length !== 1 || !items[0])) invalid('每个选项需要一个非空值');
  const args = Object.fromEntries(Object.entries(values).map(([k, [v]]) => [k, v]));
  if (mode === 'inspect') {
    if (!args.pcap) invalid('inspect 需要 --pcap');
    const {name, facts} = await readCapture(args.pcap);
    console.log(JSON.stringify({file: name, ...facts, destinationIfApproved: 'e7bot.top'}));
    return;
  }
  if (!args.out || (mode === 'json' ? !args.equips || !args.units : !args.pcap || !args['approve-sha256'])) invalid('必填选项不足。用 --help 查看用法');
  const output = await newOutput(args.out);
  const capture = mode === 'pcap' ? await readCapture(args.pcap) : null;
  if (capture) assertCaptureApproval(capture, args['approve-sha256']);
  let raw = capture ? null : {equips: await readAccountJson(args.equips), units: await readAccountJson(args.units)};
  const metadata = await loadE7BotMetadata({manifestFile: args.manifest, metadataFile: args.metadata});
  raw ??= await submitAndroidCapture(capture, args['approve-sha256']);
  const account = projectAccount(raw, metadata);
  await writeAccountWorkbooks(output, account);
  console.log(JSON.stringify({output, graph: account.metadataVersion, ...account.summary}));
}

try {await main(process.argv.slice(2));}
catch (error) {
  const note = error instanceof AccountExportError ? error.message :
    error?.code?.startsWith('ERR_PARSE_ARGS') ? '命令选项有误。用 --help 查看用法' :
      error?.name === 'TimeoutError' ? 'E7Bot 请求超时，请先核对外部请求状态' :
        '导出未完成，请核对输入和目标目录，以及 E7Bot 可用性。';
  console.error(note);
  process.exitCode = 1;
}
