// Applies the pinned dispatch cancellation fix to an explicitly selected, stopped SDK installation.
import fs from 'node:fs';
import path from 'node:path';
import {openClawDigest,readOpenClawPatch} from './lib/openclaw-release.mjs';

const [flag,root,...extra] = process.argv.slice(2);
if (flag !== '--sdk' || !path.isAbsolute(root ?? '') || extra.length) {
  throw Error('Usage: node scripts/fusion/patch-openclaw.mjs --sdk <absolute SDK directory>');
}

const patch = readOpenClawPatch(root);
if (!patch) throw Error('This OpenClaw release does not have a dispatch cancellation patch');
if (patch.digest === patch.patched) {
  console.log('OpenClaw dispatch cancellation patch already applied');
} else {
  if (patch.digest !== patch.original) throw Error('OpenClaw patch input does not match the approved upstream file');
  const original = [
    'const trackDispatchLifecycleWork = (t, n = "owner") => {',
    '\t\tconst r = readReplySourceInput(e.replyOptions);',
    '\t\tif (r && (n === "owner" || !r.claim?.operation)) trackSessionControllerSourceWork(r, t.catch((e) => {',
    '\t\t\tif (!(e instanceof DispatchSessionRefreshRequiredError) && (!r.abortSignal.aborted || e !== r.abortSignal.reason)) throw e;',
    '\t\t}));',
    '\t\tconst i = d[n];',
    '\t\tconst a = t.then(() => {}, () => {});',
  ].join('\n');
  // The reply operation can be aborted before the input is retired. Match the
  // reason of the operation which owned this work when it was registered.
  const fixed = [
    'const trackDispatchLifecycleWork = (work, n = "owner") => {',
    '\t\tconst r = readReplySourceInput(e.replyOptions);',
    '\t\tconst ownerSignal = t?.abortSignal;',
    '\t\tif (r && (n === "owner" || !r.claim?.operation)) trackSessionControllerSourceWork(r, work.catch((e) => {',
    '\t\t\tif (e instanceof DispatchSessionRefreshRequiredError) return;',
    '\t\t\tif (r.abortSignal.aborted && e === r.abortSignal.reason) return;',
    '\t\t\tif (ownerSignal?.aborted && e === ownerSignal.reason) return;',
    '\t\t\tthrow e;',
    '\t\t}));',
    '\t\tconst i = d[n];',
    '\t\tconst a = work.then(() => {}, () => {});',
  ].join('\n');
  const source = patch.source.replace(original,fixed);
  if (openClawDigest(source) !== patch.patched) throw Error('OpenClaw patch output does not match the approved fix');

  const staging = fs.mkdtempSync(path.join(path.dirname(patch.file),'.dispatch-abort-'));
  try {
    const staged = path.join(staging,path.basename(patch.file));
    fs.writeFileSync(staged,source,{flag:'wx'});
    fs.chmodSync(staged,fs.statSync(patch.file).mode & 0o777);
    if (readOpenClawPatch(root).digest !== patch.original) throw Error('OpenClaw patch target changed while staging');
    fs.renameSync(staged,patch.file);
  } finally {
    fs.rmSync(staging,{recursive:true,force:true});
  }
  console.log('Applied OpenClaw 2026.11.8 dispatch cancellation patch');
}
