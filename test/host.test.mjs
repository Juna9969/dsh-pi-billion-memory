import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const mockBridge=`export class WorkerBridge {
 constructor(options){this.calls=[];this.closed=false;this.ready=Promise.resolve({scanOnStartup:true,scanIntervalSeconds:0,expandEnabled:false,...options});globalThis.__memoryBridges.push(this);}
 async request(op,args,signal){signal?.throwIfAborted();this.calls.push({op,args,signal});return op==='stats'?{blocks:0}:op==='sources'?[]:'fixture result';}
 async close(){this.closed=true;}
}`;
globalThis.__memoryBridges=[];
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='@deepseek-ai/dsh-tools')return {url:'data:text/javascript,export const defineTool = x => x;',shortCircuit:true};
  if(specifier==='./bridge.js' && context.parentURL?.endsWith('/src/host.js'))return {url:'data:text/javascript,'+encodeURIComponent(mockBridge),shortCircuit:true};
  return next(specifier,context);
}});
const {apply,identityOf}=await import('../src/host.js');hooks.deregister();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,{globalMode='read-only',agents=[],...config}={}){
  const tools=new Map(),commands=new Map(),listeners=new Map(),effects=[],resolutions=[],warnings=[];
  const ctx={tools:{register:x=>tools.set(x.name,x)},commands:{register:x=>commands.set(x.name,x)},agents:{list:()=>agents},
    sandboxPolicy:{resolve:args=>{resolutions.push(args);return {mode:args.session?.mode??globalMode};}},
    logger:{warn:x=>warnings.push(x)},on:(name,fn)=>listeners.set(name,fn),effect:fn=>effects.push(fn())};
  apply(ctx,config);const bridge=globalThis.__memoryBridges.at(-1);
  t.after(async()=>{for(const fn of effects)await fn();});
  return {bridge,ctx,tools,commands,listeners,effects,resolutions,warnings,command:(rawInput,agent,signal)=>commands.get('memory').handler({rawInput,agent,signal})};
}
const agent=(id='one',mode='read-only')=>({session:{id,mode,header:{cwd:'C:\\fixture\\'+id}}});

test('read tools register synchronously, no context injection or agent-owned cleanup',async t=>{
  const h=setup(t);assert.deepEqual([...h.tools.keys()],['memory_search']);assert.deepEqual([...h.commands.keys()],['memory']);
  assert.deepEqual([...h.listeners.keys()],['agent/created']);assert.equal(h.commands.get('memory').recordInput,false);
  const tool=h.tools.get('memory_search'),value=await tool.execute({query:'needle'},{agent:agent(),signal:new AbortController().signal});
  assert.equal(value,'fixture result');assert.equal(tool.output.schema.type,'string');assert.deepEqual(tool.output.render({},value),[{type:'text',text:value}]);
  await tick();assert.ok(h.bridge.calls.every(x=>x.op!=='scan'));
});

test('write commands resolve explicit agent policy without overrides; confirmation alone cannot escalate',async t=>{
  const h=setup(t),read=agent(),write=agent('two','danger-full-access');
  assert.equal((await h.command('scan',read)).kind,'error');
  assert.equal((await h.command('prune 30',read)).kind,'success');assert.ok(!h.bridge.calls.some(x=>x.op==='prune'));
  assert.equal((await h.command('prune 30 --confirm',read)).kind,'error');
  assert.equal((await h.command('rescan',write)).kind,'success');
  const scan=h.bridge.calls.find(x=>x.op==='scan');assert.equal(scan.args.force,true);assert.equal(scan.args.writeAuthorized,true);assert.deepEqual(scan.args.identity,identityOf(write));
  assert.equal((await h.command('prune 30 --confirm',write)).kind,'success');assert.equal(h.bridge.calls.find(x=>x.op==='prune').args.days,30);
  assert.ok(h.resolutions.every(x=>!('mode' in x)));assert.ok(h.resolutions.some(x=>x.session===write.session));
  for(const raw of ['prune -1','prune 365001','prune 2 --oops','prune 2 --confirm extra'])assert.equal((await h.command(raw,write)).kind,'error');
});

test('existing agents seed sequentially before automatic scan; new identities observed',async t=>{
  const agents=Array.from({length:150},(_,i)=>agent('session-'+i));const h=setup(t,{globalMode:'danger-full-access',agents});
  await tick();assert.equal(h.bridge.calls.length,151);assert.ok(h.bridge.calls.slice(0,150).every(x=>x.op==='observe'));assert.equal(h.bridge.calls[150].op,'scan');
  h.listeners.get('agent/created')({agent:agent('new')});await tick();assert.equal(h.bridge.calls.at(-1).args.identity.sessionId,'new');
  for(const fn of h.effects)await fn();assert.equal(h.bridge.closed,true);
  const result=await h.command('status',agent());assert.equal(result.kind,'error');
});

test('expansion opt-in and command cancellation stay explicit',async t=>{
  const h=setup(t,{expandEnabled:true});await tick();assert.ok(h.tools.has('memory_expand'));
  const abort=new AbortController();abort.abort(new Error('cancel fixture'));
  assert.equal((await h.command('status',agent(),abort.signal)).kind,'error');
  const status=await h.command('status',agent('write','danger-full-access'));
  assert.equal(status.kind,'success');const value=JSON.parse(status.text);assert.equal(value.automaticWritesAllowed,false);assert.equal(value.currentCommandWritesAllowed,true);
});
