import { Worker } from 'node:worker_threads';
export class WorkerBridge {
  constructor(options = {}, internals = {}) {
    this.pending = new Map(); this.sequence = 0; this.closed = false; this.exited = false;
    this.worker = new Worker(internals.url || new URL('./memory-worker.js', import.meta.url), { workerData: { options, home: internals.home, env: internals.env }, execArgv: [] });
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.ready = new Promise((resolve,reject) => { this.resolveReady=resolve; this.rejectReady=reject; });
    this.ready.catch(() => {});
    this.timer = setTimeout(() => { void this.fail(new Error('Memory worker startup timed out')); }, 10000);
    this.worker.on('message', m => {
      if (this.failure) return; // Fatal settlement must wait for quiescence.
      if ('ready' in m) {
        clearTimeout(this.timer);
        if (m.ready) this.resolveReady(m.config); else void this.fail(new Error(m.error));
        return;
      }
      if (m.fatal) { void this.fail(new Error(m.fatal)); return; }
      const pending = this.pending.get(m.id);
      if (!pending) return;
      this.pending.delete(m.id); pending.cleanup();
      if (pending.signal?.aborted) pending.reject(pending.signal.reason ?? new Error('Memory operation cancelled'));
      else if (m.error) pending.reject(new Error(m.error));
      else pending.resolve(m.value);
    });
    this.worker.on('error', e => { void this.fail(e); });
    this.worker.on('exit', code => {
      this.exited = true; this.resolveExit(code);
      this.settle(this.failure || new Error(`Memory worker exited (${code})`));
    });
  }
  settle(error) {
    clearTimeout(this.timer); this.closed = true; this.rejectReady(error);
    for (const p of this.pending.values()) { p.cleanup(); p.reject(error); }
    this.pending.clear();
  }
  fail(error) {
    if (this.stopping) return this.stopping;
    this.failure = error; this.closed = true; clearTimeout(this.timer);
    for (const p of this.pending.values()) Atomics.store(p.flag,0,1);
    this.stopping = (async () => {
      if (!this.exited) await this.worker.terminate();
      await this.exit; this.settle(error);
    })();
    return this.stopping;
  }
  async request(op, args = {}, signal) {
    signal?.throwIfAborted();
    if (signal) {
      let abort;
      try { await Promise.race([this.ready, new Promise((_,reject) => {
        abort = () => reject(signal.reason ?? new Error('Memory operation cancelled'));
        signal.addEventListener('abort',abort,{once:true}); if (signal.aborted) abort();
      })]); } finally { signal.removeEventListener('abort',abort); }
    } else await this.ready;
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Memory worker is closed');
    if (this.pending.size >= 128) throw new Error('Memory worker queue is full');
    return this.dispatch(op, args, signal);
  }
  dispatch(op, args, signal) {
    const id = ++this.sequence, cancel = new SharedArrayBuffer(4), flag = new Int32Array(cancel);
    return new Promise((resolve,reject) => {
      // Once dispatched, cancellation rejects only after acknowledgement or exit.
      const abort = () => Atomics.store(flag,0,1);
      const cleanup = () => signal?.removeEventListener('abort',abort);
      this.pending.set(id, { resolve,reject,cleanup,signal,flag });
      signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
      try { this.worker.postMessage({ id,op,args,cancel }); }
      catch(e) { this.pending.delete(id); cleanup(); reject(e); }
    });
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const p of this.pending.values()) Atomics.store(p.flag,0,1);
    this.closing = (async () => {
      let timer;
      try {
        if (this.exited) return;
        if (this.stopping) { await this.stopping; return; }
        await Promise.race([this.dispatch('close',{}).catch(() => {}), this.exit,
          new Promise(resolve => { timer=setTimeout(resolve,2000); })]);
      } finally { clearTimeout(timer); await this.fail(new Error('Memory plugin disposed')); }
    })();
    return this.closing;
  }
}
