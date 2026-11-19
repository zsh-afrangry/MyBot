// Offline ACP protocol fixture. It owns only descendants created by this test process.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const [mode, gateDir] = process.argv.slice(2);
let child, pending, permissionId, resumed = false;
const send = frame => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...frame}) + '\n');
const reply = (id, result = {}) => send({id, result});
readline.createInterface({input: process.stdin}).on('line', line => {
  const frame = JSON.parse(line), p = frame.params;
  if (frame.id === permissionId && !frame.method) {reply(pending, {stopReason: frame.result.outcome.optionId === 'allowed' ? 'end_turn' : 'cancelled'}); return;}
  if (frame.method === 'initialize') reply(frame.id, {protocolVersion: 1});
  else if (frame.method === 'session/new') reply(frame.id, {sessionId: 'offline-session'});
  else if (frame.method === 'session/resume') {resumed = true; reply(frame.id);}
  else if (frame.method === 'session/set_config_option' || frame.method === 'session/close') reply(frame.id);
  else if (frame.method === 'session/prompt') {
    pending = frame.id;
    if (mode === '--completion-fixture' || mode === '--project-registry-fixture') {
      const phase = resumed ? 'resume' : 'start';
      const finish = () => {
        if (!fs.existsSync(path.join(gateDir, phase))) {setTimeout(finish, 25); return;}
        if (mode === '--project-registry-fixture') fs.writeFileSync('value.mjs', 'export const value = 2;\n');
        const update = value => send({method: 'session/update', params: {sessionId: p.sessionId, update: value}});
        update({sessionUpdate: 'tool_call', toolCallId: 'fixture-command', kind: 'execute', title: 'fixture command', status: 'in_progress'});
        update({sessionUpdate: 'tool_call_update', toolCallId: 'fixture-command', status: 'completed',
          content: [{type: 'content', content: {type: 'text', text: 'fixture execution ' + phase}}]});
        reply(pending, {stopReason: 'end_turn'});
      };
      finish();
    } else if (p.prompt[0].text === 'WAIT' || p.prompt[0].text.includes('FIXTURE_WAIT')) {
      child = spawn(process.execPath, ['-e', "const fs=require('fs'); setInterval(()=>fs.appendFileSync(process.argv[1],'x'),25)", process.env.FIXTURE_HEARTBEAT], {stdio: 'ignore'});
      send({method: 'session/update', params: {sessionId: p.sessionId, update: {sessionUpdate: 'tool_call', toolCallId: 'own-child', kind: 'execute', rawInput: {fixture: true}}}});
    } else {
      send({method: 'session/update', params: {sessionId: p.sessionId, update: {sessionUpdate: 'tool_call', toolCallId: 'permission-tool', rawInput: {fixture: true}}}});
      permissionId = 'server-permission'; send({id: permissionId, method: 'session/request_permission', params: {sessionId: p.sessionId, toolCallId: 'permission-tool', options: [{kind: 'allow_once', optionId: 'allowed'}, {kind: 'reject_once', optionId: 'rejected'}]}});
    }
  } else if (frame.method === 'session/cancel' && !process.env.FIXTURE_IGNORE_CANCEL) {child?.kill('SIGTERM'); reply(pending, {stopReason: 'cancelled'});}
}).on('close', () => {child?.kill('SIGTERM'); process.exit(0);});
