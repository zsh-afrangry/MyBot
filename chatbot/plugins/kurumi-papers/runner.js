// Fixed Python worker in Bubblewrap. No model-provided commands, URLs or executable paths. docs/22.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export function loadKeys(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('Translation credential file must be owner-only and regular');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = Object.fromEntries(['OPENAI_API_KEY1_014','OPENAI_API_KEY2_030','OPENAI_API_KEY3_040'].filter(k => typeof raw[k] === 'string' && raw[k].trim()).map(k => [k, raw[k].trim()]));
  if (!Object.keys(keys).length) throw Error('No translation credentials configured');
  return keys;
}
export function workerCommand({config, work, cache}) {
  const python = fs.realpathSync(config.python), prefix = path.dirname(path.dirname(python));
  const source = fileURLToPath(new URL('./python', import.meta.url));
  for (const dir of [work, cache]) if (fs.realpathSync(dir) !== path.resolve(dir)) throw Error('Worker directory must not contain symlinks');
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv'];
  for (const dir of ['/usr','/bin','/lib','/lib64','/etc/ssl','/etc/fonts','/usr/share/fonts']) if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
  for (const file of ['/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf']) if (fs.existsSync(file)) args.push('--ro-bind', fs.realpathSync(file), file);
  args.push('--ro-bind', prefix, prefix, '--ro-bind', source, '/app', '--bind', work, '/work', '--bind', cache, '/cache',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/work',
    '--setenv', 'HOME', '/cache', '--setenv', 'XDG_CACHE_HOME', '/cache/.cache', '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'OMP_NUM_THREADS', '2', '--setenv', 'OPENBLAS_NUM_THREADS', '2',
    '--', '/usr/bin/prlimit', '--as=12884901888', '--fsize=104857600', '--cpu=1200', '--', python, '/app/engine.py');
  return {command: '/usr/bin/bwrap', args};
}
export function runTranslation({config, work, cache, profile, pages, sourceLang, targetLang, signal}) {
  signal?.throwIfAborted();
  const {command, args} = workerCommand({config, work, cache});
  const request = {profile, keys: loadKeys(config.credentialsFile), input: '/work/input.pdf', output: '/work',
    cooldownFile: '/cache/credential-cooldowns.json', pages, sourceLang, targetLang,
    maxRequests: config.maxRequests ?? 200, maxReportedTokens: config.maxReportedTokens ?? 150000};
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env: {PATH: '/usr/bin:/bin'}, stdio: ['pipe','pipe','pipe'], detached: true});
    let output = '', killed = false;
    const kill = () => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, (config.timeoutSeconds ?? 1200) * 1000);
    signal?.addEventListener('abort', kill, {once: true}); if (signal?.aborted) kill();
    const collect = part => { output = (output + part.toString()).slice(-32000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) return reject(Object.assign(Error('translation_cancelled'), {code: 'translation_cancelled'}));
      if (killed) return reject(Object.assign(Error('translation_timed_out'), {code: 'translation_timed_out'}));
      if (code !== 0) {
        const failure = output.split('\n').map(line => {try { return JSON.parse(line); } catch { return {}; }}).find(x => x.ok === false);
        return reject(Object.assign(Error(failure?.code ?? 'pdf_worker_failed'), {code: failure?.code ?? 'pdf_worker_failed'}));
      }
      try {
        const result = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
        if (result.ok !== true) throw Error('Invalid worker result');
        const files = {};
        for (const kind of ['mono','dual']) {
          const relative = path.posix.relative('/work', String(result[kind]));
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Output escaped worker');
          const file = path.join(work, relative);
          if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw Error('Invalid worker PDF');
          files[kind] = file;
        }
        resolve({...result, ...files});
      } catch { reject(Object.assign(Error('invalid_worker_result'), {code: 'invalid_worker_result'})); }
    });
  });
}
