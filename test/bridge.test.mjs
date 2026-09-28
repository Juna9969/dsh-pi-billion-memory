import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WorkerBridge } from '../src/bridge.js';

function mock(t,body) {
  const url=new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';${body}`));
  const rpc=new WorkerBridge({}, {url});t.after(()=>rpc.close());return rpc;
}
const ready=`parentPort.postMessage({ready:true,config:{}});`;

test('fatal request rejects only after worker exit and dead close does not wait',async t=>{
  const rpc=mock(t,ready+`parentPort.on('message',m=>{parentPort.postMessage({fatal:'fixture fatal'});for(;;){};});`);
  await assert.rejects(rpc.request('probe'),/fixture fatal/);
  assert.equal(rpc.exited,true);assert.equal(rpc.pending.size,0);
  await rpc.close();assert.equal(rpc.exited,true);
});

test('active abort waits for quiescent acknowledgement rather than immediate rejection',async t=>{
  const rpc=mock(t,ready+`parentPort.on('message',m=>{if(m.op==='close'){parentPort.postMessage({id:m.id,value:null});return;}const flag=new Int32Array(m.cancel);parentPort.postMessage({started:true});while(!Atomics.load(flag,0)){};setTimeout(()=>parentPort.postMessage({id:m.id,value:'ack'}),20);});`);
  const abort=new AbortController();let settled=false;
  const started=new Promise(resolve=>rpc.worker.on('message',m=>{if(m.started)resolve();}));
  const result=rpc.request('probe',{},abort.signal).finally(()=>{settled=true;});
  const assertion=assert.rejects(result,/test cancel/);
  await started;abort.abort(new Error('test cancel'));await Promise.resolve();assert.equal(settled,false);
  await assertion;assert.equal(rpc.pending.size,0);
});

test('abort while waiting for readiness never dispatches',async t=>{
  const rpc=mock(t,`setTimeout(()=>parentPort.postMessage({ready:true,config:{}}),50);parentPort.on('message',m=>parentPort.postMessage({id:m.id,value:null}));`);
  const abort=new AbortController(),result=rpc.request('probe',{},abort.signal);abort.abort(new Error('startup cancel'));
  await assert.rejects(result,/startup cancel/);assert.equal(rpc.sequence,0);await rpc.ready;
});

test('queue is bounded and plugin close cancels, drains, then terminates',async t=>{
  const rpc=mock(t,ready+`const pending=[];parentPort.on('message',m=>{if(m.op==='close'){for(const p of pending)parentPort.postMessage({id:p.id,error:Atomics.load(new Int32Array(p.cancel),0)?'cancelled':'not cancelled'});parentPort.postMessage({id:m.id,value:null});}else pending.push(m);});`);
  await rpc.ready;
  const calls=Array.from({length:128},()=>rpc.request('queued').then(()=>assert.fail('must cancel'),e=>e.message));
  await Promise.resolve();await assert.rejects(rpc.request('overflow'),/queue is full/);
  await rpc.close();assert.equal(rpc.exited,true);assert.equal(rpc.pending.size,0);
  assert.ok((await Promise.all(calls)).every(x=>x==='cancelled'));
  await assert.rejects(rpc.request('late'),/closed/);
});

test('unexpected worker exit rejects pending and settles once',async t=>{
  const rpc=mock(t,ready+`parentPort.on('message',()=>process.exit(7));`);
  await assert.rejects(rpc.request('exit'),/exited \(7\)/);assert.equal(rpc.exited,true);await rpc.close();
});
