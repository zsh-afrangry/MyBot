// The runner closes IPC on timeout or interruption. Abort polling as well as
// shutting down resources in separate process groups.
const controller = new AbortController();
export const scenarioSignal = controller.signal;
export function scenarioProgress(step, state, phase = 'check') {
  if (process.connected) process.send({type:'scenario-progress',step,state,phase}, () => {});
}
if (typeof process.send === 'function') {
  if (process.connected) {
    process.once('disconnect', () => controller.abort(Error('Scenario interrupted')));
    process.channel.unref();
  } else {
    controller.abort(Error('Scenario interrupted'));
  }
}

export function closeOnScenarioDisconnect(close) {
  const stop = () => {void Promise.resolve().then(close).catch(() => {process.exitCode = 1;});};
  if (scenarioSignal.aborted) {stop(); return () => {};}
  scenarioSignal.addEventListener('abort', stop, {once: true});
  return () => scenarioSignal.removeEventListener('abort', stop);
}
