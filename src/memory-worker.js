import { parentPort, workerData } from 'node:worker_threads';
import { MemoryEngine, safeText } from './engine.js';
let engine;
let queue = Promise.resolve();
try {
  engine = new MemoryEngine(workerData.options, workerData.env, workerData.home);
  parentPort.postMessage({ ready: true, config: await engine.execute('config') });
} catch (error) {
  parentPort.postMessage({ ready: false, error: safeText(error.message) });
  parentPort.close();
}
if (engine) parentPort.on('message', message => {
  queue = queue.then(async () => {
    if (message.op === 'close') { engine.close(); parentPort.postMessage({ id: message.id, value: true }); parentPort.close(); return; }
    const flag = new Int32Array(message.cancel);
    const check = () => { if (Atomics.load(flag,0)) throw new Error('Memory operation cancelled'); };
    try {
      const value = await engine.execute(message.op, message.args, check);
      check(); parentPort.postMessage({ id: message.id, value });
    } catch (error) { parentPort.postMessage({ id: message.id, error: safeText(error.message) }); }
  }).catch(error => { parentPort.postMessage({ fatal: safeText(error.message) }); });
});
