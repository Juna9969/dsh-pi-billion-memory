import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, block, scan } from './helpers.mjs';
import { loadConfig, loadSources } from '../src/config.js';
import { SourceReader } from '../src/sources.js';
import { assertCompatibleSchema } from '../src/schema.js';
import { MemoryDb, configureNative, configureForTests, closeNative, loadSqlite } from '../vendor/extension.js';
import { attribution } from '../src/attribution.js';

const inspect = (file,fn) => {const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();}};

test('fake HOME expands shared config, options and allowlist without escape',t=>{
  const f=fixture(t);
  f.write(path.join(f.pi,'pi-billion-memory.json'),{dbPath:'~/.pi/custom.db',sourcesPath:'~/.pi/custom.sources',logPath:'~/.pi/custom.log'});
  const cfg=loadConfig({dshSessionsRoot:'~/bili'},{},f.home);
  assert.equal(cfg.dbPath,path.join(f.pi,'custom.db'));
  assert.equal(cfg.logPath,path.join(f.pi,'custom.log'));
  f.write(cfg.sourcesPath,JSON.stringify({id:'pi',adapter:'pi-sidecar',root:'~/.pi/agent/sessions',pattern:'**/*.jsonl.acp.json',opencodeDb:'~/.pi/custom-oc.db'}));
  const [source]=loadSources(cfg);
  assert.equal(source.root,f.piRoot);assert.equal(source.opencodeDb,path.join(f.pi,'custom-oc.db'));
  assert.equal(loadConfig({dbPath:'~/override.db'},{},f.home).dbPath,path.join(f.home,'override.db'));
});

test('Windows case and junction aliases cannot bypass disabled/narrowed Bili root',t=>{
  const f=fixture(t),cfg=loadConfig({dshSessionsRoot:f.biliRoot},{},f.home);
  const alias=path.join(f.home,'alias');fs.symlinkSync(f.biliRoot,alias,'junction');
  for (const root of [alias,...(process.platform==='win32'?[f.biliRoot.toUpperCase()]:[])]) {
    f.write(cfg.sourcesPath,JSON.stringify({id:'explicit',root,adapter:'bili-session',pattern:'narrow/*.json',enabled:false}));
    const sources=loadSources(cfg);assert.equal(sources.length,1);assert.equal(sources[0].enabled,false);
  }
});

test('interval bounds prevent Node timer overflow',t=>{
  const f=fixture(t);
  for(const n of [-1,1,9,2147484,Number.MAX_SAFE_INTEGER,Infinity,1.5]) assert.throws(()=>loadConfig({scanIntervalSeconds:n},{},f.home),/scanIntervalSeconds/);
  for(const n of [0,10,2147483]) assert.equal(loadConfig({scanIntervalSeconds:n},{},f.home).scanIntervalSeconds,n);
});

test('malformed and empty allowlists do not initialize any native or shared database',async t=>{
  const f=fixture(t),rpc=f.worker({dshEnabled:false});
  const file=path.join(f.pi,'pi-billion-memory.sources.jsonl');f.write(file,'{broken');
  const before=fs.readdirSync(f.pi).sort();
  await assert.rejects(scan(rpc),/scan refused/);assert.deepEqual(fs.readdirSync(f.pi).sort(),before);
  f.write(file,'');assert.equal((await scan(rpc)).sources,0);assert.deepEqual(fs.readdirSync(f.pi).sort(),before);
});

test('full topic is redacted before truncation for every adapter',async t=>{
  const f=fixture(t),rpc=f.worker();
  const topic='-----BEGIN PRIVATE KEY-----\n'+'ABCD1234'.repeat(100)+'\n-----END PRIVATE KEY-----';
  f.piFile('pem',[block('pi','pemmarker',{topic})]);f.biliFile('pem',[block('bili','pemmarker',{topic})]);
  const ocRoot=path.join(f.home,'oc');f.write(path.join(ocRoot,'ses_pem.json'),{prune:{messages:{blocksById:{oc:{summary:'pemmarker',topic}}}}});
  f.write(path.join(f.pi,'pi-billion-memory.sources.jsonl'),[
    {id:'pi',adapter:'pi-sidecar',root:f.piRoot,pattern:'**/*.jsonl.acp.json'},
    {id:'oc',adapter:'opencode-acp',root:ocRoot,pattern:'ses_*.json'},
  ].map(JSON.stringify).join('\n'));
  assert.equal((await scan(rpc)).inserted,3);
  inspect(f.dbPath,db=>{for(const row of db.prepare('SELECT topic FROM blocks').all()) assert.doesNotMatch(row.topic,/ABCD1234/);});
  assert.doesNotMatch(await rpc.request('search',{query:'pemmarker'}),/ABCD1234/);
});

test('guard rejects versioned empty, view-only and each critical schema mutation',async t=>{
  const f=fixture(t),rpc=f.worker();await scan(rpc);await rpc.close();
  const sql=inspect(f.dbPath,db=>db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'blocks_fts_*'").all().map(x=>x.sql).join(';\n'));
  const probes=[
    'PRAGMA user_version=5', 'CREATE VIEW unrelated AS SELECT 1',
    sql.replace('INTEGER PRIMARY KEY AUTOINCREMENT','TEXT PRIMARY KEY'),
    sql.replace('UNIQUE(source_file, block_id)',"UNIQUE(block_id, source_file)"),
    sql.replace('UNIQUE(source_file, block_id)','CHECK(1)')+';CREATE UNIQUE INDEX partial ON blocks(source_file,block_id) WHERE created_at>0',
    sql.replace("content_rowid='id'","content_rowid='block_id'"),
    sql.replace('summary, topic,\n', 'topic, summary,\n'),
    sql.replace(/CREATE TRIGGER blocks_ai[\s\S]*?END/, 'CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN SELECT 1; END'),
    sql+';CREATE TRIGGER extra AFTER INSERT ON sources BEGIN DELETE FROM blocks; END',
    sql.replace('msg_ids           TEXT','msg_ids           INTEGER'),
  ];
  for (const [i,probe] of probes.entries()) {
    const db=new DatabaseSync(':memory:');try{db.exec(probe);assert.throws(()=>assertCompatibleSchema(db),/Unsupported memory database schema/,'mutation '+i);}finally{db.close();}
  }
  const db=new DatabaseSync(':memory:');try{db.exec(sql);assert.equal(assertCompatibleSchema(db),'compatible');}finally{db.close();}
});

test('bound reader refuses replacement during open without consuming the substituted file',async t=>{
  const f=fixture(t),file=f.piFile('victim',[block('safe','safe')]);
  const reader=new SourceReader(loadConfig({dshEnabled:false},{},f.home));await reader.list(reader.sources()[0]);
  const original=fs.openSync;let read=false;
  const replace=path.join(f.home,'off-root.json');f.write(replace,{blocks:[block('secret','off-root secret')]});
  fs.openSync=function(name,...rest){return original.call(this,name===file?replace:name,...rest);};
  try {assert.throws(()=>reader.withFile(file,reader.admitted.get(file),()=>{read=true;}),/Source changed before read/);assert.equal(read,false);}
  finally {fs.openSync=original;}
});

test('late exact identity refreshes metadata without replacing immutable summary',async t=>{
  const f=fixture(t),rpc=f.worker(),file=f.biliFile('late',[block('b','retained late summary')]);
  await scan(rpc);assert.equal(inspect(f.dbPath,db=>db.prepare('SELECT cwd FROM sources WHERE source_file=?').get(file).cwd),null);
  await rpc.request('observe',{identity:{sessionId:'late',cwd:path.join(f.home,'late-project')}});
  assert.equal((await scan(rpc)).inserted,0);
  assert.match(await rpc.request('search',{query:'retained',project:'late-project'}),/Memory hits: 1/);
});

test('separate attribution DB merges simultaneous worker snapshots and preserves first mapping',async t=>{
  const f=fixture(t),a=f.worker(),b=f.worker();
  await Promise.all([scan(a,{identity:{sessionId:'a',cwd:path.join(f.home,'A')}}),scan(b,{identity:{sessionId:'b',cwd:path.join(f.home,'B')}})]);
  const target=path.join(f.pi,'pi-billion-memory.dsh-attribution.db');
  assert.deepEqual(attribution(target).map(x=>x[0]).sort(),['a','b']);
  attribution(target,new Map([['a',{workspaceCwd:path.join(f.home,'wrong'),observedAt:Date.now()}],['c',{workspaceCwd:f.home,observedAt:Date.now()}]]));
  const saved=new Map(attribution(target));assert.equal(saved.size,3);assert.equal(saved.get('a').workspaceCwd,path.join(f.home,'A'));
});

test('stale scan cannot roll back newer committed watermark or message references',async t=>{
  const f=fixture(t),file=f.piFile('cas',[block('p','old summary',{effectiveMessageIds:['old']})]);
  const cfg=loadConfig({dshEnabled:false},{},f.home),reader=new SourceReader(cfg);await reader.list(reader.sources()[0]);
  configureForTests(cfg);configureNative(cfg,reader.hooks());await loadSqlite();const memory=new MemoryDb(f.dbPath);memory.open();
  f.cleanup(()=>{memory.close();closeNative();});
  const db=memory.db,oldExec=db.exec.bind(db);let injected=false;
  db.exec=sql=>{if(sql==='BEGIN IMMEDIATE' && !injected){injected=true;db.prepare('INSERT INTO source_watermarks VALUES(?,?,?,?)').run(file,200,2000,123);db.prepare('INSERT INTO blocks(source_file,block_id,summary,msg_ids) VALUES(?,?,?,?)').run(file,'p','new summary','["new"]');}return oldExec(sql);};
  const result=await memory.ingestSourceFile(file,{kind:'pi'},true);
  assert.equal(result.ok,false);assert.match(result.error,/Source ledger changed/);
  assert.equal(db.prepare('SELECT msg_ids FROM blocks').get().msg_ids,'["new"]');
  assert.equal(db.prepare('SELECT last_mtime_ms FROM source_watermarks').get().last_mtime_ms,200);
});

test('cancelled ingest and prune rollback the current transaction',async t=>{
  const f=fixture(t),file=f.piFile('cancel',[block('p','cancelled',{createdAt:1})]);
  const cfg=loadConfig({dshEnabled:false},{},f.home),reader=new SourceReader(cfg);await reader.list(reader.sources()[0]);
  configureForTests(cfg);configureNative(cfg,reader.hooks());await loadSqlite();const memory=new MemoryDb(f.dbPath);memory.open();
  f.cleanup(()=>{memory.close();closeNative();});
  let active=false;reader.cancel=()=>{if(active && memory.db.prepare('SELECT count(*) n FROM blocks').get().n>0) throw Error('cancel rollback');};
  active=true;assert.equal((await memory.ingestSourceFile(file,{kind:'pi'},true)).ok,false);assert.equal(memory.db.prepare('SELECT count(*) n FROM blocks').get().n,0);
  active=false;assert.equal((await memory.ingestSourceFile(file,{kind:'pi'},true)).ok,true);
  reader.cancel=()=>{if(memory.db.prepare('SELECT count(*) n FROM block_tombstones').get().n>0)throw Error('cancel prune');};
  assert.throws(()=>memory.prune(0),/cancel prune/);assert.equal(memory.db.prepare('SELECT count(*) n FROM blocks').get().n,1);assert.equal(memory.db.prepare('SELECT count(*) n FROM block_tombstones').get().n,0);
});

test('missing raw Pi session returns a missing manifest; withdrawn allowlist still refuses',async t=>{
  const f=fixture(t),rpc=f.worker({expandEnabled:true}),sidecar=f.piFile('gone',[block('p','missing raw',{effectiveMessageIds:['raw']})]);await scan(rpc);
  fs.unlinkSync(sidecar.slice(0,-'.acp.json'.length));
  assert.match(await rpc.request('expand',{block:'p'}),/missing|unavailable/i);
  f.write(path.join(f.pi,'pi-billion-memory.sources.jsonl'),'');
  await assert.rejects(rpc.request('expand',{block:'p'}),/not admitted/);
});
