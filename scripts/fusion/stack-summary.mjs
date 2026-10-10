// Compact presentation only; health.mjs remains the authoritative full probe.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const [file]=process.argv.slice(2);
let health;
try{health=JSON.parse(fs.readFileSync(file,'utf8'));}catch{console.error('✗ 无法读取健康检查结果；使用 ./Start-DSH.sh --verbose 查看详情。');process.exit(1);}
const sockets=spawnSync('ss',['-H','-ltn'],{encoding:'utf8'});
const ports=new Set((sockets.stdout??'').split('\n').map(line=>line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]));
let ok=health.ok===true;
function row(label,port,good,success='运行中'){
 console.log(`${good?'✓':'✗'} ${label.padEnd(23)} ${String(port??'').padEnd(5)} ${good?success:'未就绪'}`);
 if(!good)ok=false;
}
const active=name=>health.services?.[name]?.ActiveState==='active';
row('DSH Web',3080,active('dsh-web')&&ports.has('3080'));
row('Kurumi Fusion',18890,active('kurumi-fusion')&&health.gateway&&ports.has('18890'));
row('SnowLuma WebUI',3082,active('snowluma')&&ports.has('3082'));
row('SnowLuma OneBot HTTP',3083,ports.has('3083')&&health.qq?.good);
row('SnowLuma OneBot WS',3084,ports.has('3084')&&health.channel?.some(c=>c.running&&c.connected),'已连接');
row('QQ 客户端',null,active('snowluma-qq')&&health.qq?.online,'在线');
const oldStopped=['qq-bridge','openclaw-gateway'].every(n=>health.services?.[n]?.ActiveState==='inactive');
if(!oldStopped){console.log('✗ 旧助手未确认停止');ok=false;}
for(const issue of health.issues??[])console.log(`  原因：${issue}`);
console.log(ok?'启动成功：DSH 与融合助手已就绪，旧助手已停止（QQ 传输由脚本外管理）。':'启动未完全就绪：使用 ./Start-DSH.sh --verbose 查看详情。');
if(!ok){console.log('日志：journalctl --user -u kurumi-fusion -u snowluma -u snowluma-qq -n 50');console.log('DSH 日志：journalctl -u dsh-web -n 50');process.exitCode=1;}
