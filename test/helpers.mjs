import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkerBridge } from '../src/bridge.js';
export function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-test-'));
  const pi = path.join(home,'.pi'); fs.mkdirSync(pi,{recursive:true});
  const piRoot = path.join(pi,'agent','sessions'); fs.mkdirSync(piRoot,{recursive:true});
  const biliRoot = path.join(home,'bili'); fs.mkdirSync(biliRoot,{recursive:true});
  const config = { scanOnStartup:false, scanIntervalSeconds:0, dshSessionsRoot:biliRoot, ...options };
  const workers=[], cleanups=[];
  const worker = (over = {}) => { const rpc=new WorkerBridge({...config,...over},{home,env:{}}); workers.push(rpc); return rpc; };
  t.after(async () => { await Promise.all(workers.map(w=>w.close())); for (const cleanup of cleanups.reverse()) await cleanup(); fs.rmSync(home,{recursive:true,force:true}); });
  const write = (file,value) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value)); return file; };
  return {home,pi,piRoot,biliRoot,worker,write,cleanup:fn=>cleanups.push(fn),dbPath:path.join(pi,'pi-billion-memory.db'),
    piFile:(name,blocks,header={cwd:path.join(home,'project-a')}) => {
      const session=write(path.join(piRoot,name+'.jsonl'), JSON.stringify(header)+'\n'+JSON.stringify({type:'message',id:'raw',message:{role:'user',content:[{type:'text',text:'raw-only-never-index-73928'}]}})+'\n');
      return write(session+'.acp.json',{blocks});
    },
    biliFile:(id,blocks,extra={}) => write(path.join(biliRoot,'anthropic','api.example.test_'+createHash('sha256').update(id).digest('hex').slice(0,24)+'.json'),
      {version:3,id,payload:{metadata:{pluginAgent:'dsh'},state:{blocks},messages:[{content:'raw-only-never-index-73928'}],blockContents:{b1:'original-not-summary-8716'},...extra}}),
  };
}
export const block = (id,summary,extra={}) => ({blockId:id,summary,tier:1,topic:'fixture',createdAt:Date.now()-10000,compressedTokens:100,...extra});
export const scan = (rpc,args={}) => rpc.request('scan',{writeAuthorized:true,...args});
