import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, block, scan } from './helpers.mjs';
import { projectBiliFile } from '../src/project-json.js';
import { loadConfig, loadSources } from '../src/config.js';
import { SourceReader } from '../src/sources.js';

const readDb = (file,fn) => {const db=new DatabaseSync(file,{readOnly:true}); try{return fn(db);} finally {db.close();}};

test('missing store search/status are truly read-only', async t => {
  const f=fixture(t), rpc=f.worker();
  assert.match(await rpc.request('search',{query:'remember'}),/No memory matches/);
  assert.equal((await rpc.request('stats')).missing,true);
  assert.equal(fs.existsSync(f.dbPath),false);
  assert.deepEqual(fs.readdirSync(f.pi).sort(),['agent']);
  await assert.rejects(rpc.request('scan'),/writes require/);
  assert.equal(fs.existsSync(f.dbPath),false);
});

test('Pi and native DSH ingest shared schema, summary-only, exact cwd attribution', async t => {
  const f=fixture(t),rpc=f.worker();
  f.piFile('pi-a',[block('p1','SQLite 事务 durable ledger Chinese 缓存测试')]);
  f.biliFile('dsh-session-a',[block('b1','Native DSH summaries compatible SQLite',{tier:'2',compressedTokens:'321'})]);
  f.biliFile('unknown-history',[block('b2','Historical project not guessed')]);
  const result=await scan(rpc,{identity:{sessionId:'dsh-session-a',cwd:path.join(f.home,'project-dsh')}});
  assert.equal(result.inserted,3); assert.equal(result.failed,0);
  assert.match(await rpc.request('search',{query:'SQLite'}),/Memory hits: 2/);
  assert.match(await rpc.request('search',{query:'缓存'}),/short-query LIKE/);
  assert.match(await rpc.request('search',{query:'SQLite 事务'}),/mixed trigram/);
  assert.match(await rpc.request('search',{query:'SQLite',project:'project-dsh'}),/Memory hits: 1/);
  assert.match(await rpc.request('search',{query:'raw-only-never-index-73928'}),/No memory matches/);
  assert.match(await rpc.request('search',{query:'original-not-summary-8716'}),/No memory matches/);
  readDb(f.dbPath,db=>{
    const rows=db.prepare('SELECT project,cwd FROM sources ORDER BY project').all();
    assert.ok(rows.some(r=>r.project==='api.example.test' && r.cwd===null));
    assert.ok(rows.some(r=>r.project==='project-dsh' && r.cwd===path.join(f.home,'project-dsh')));
    assert.equal(db.prepare("SELECT msg_ids FROM blocks WHERE block_id='b1'").get().msg_ids,null);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  });
});

test('watermarks, immutable summaries, pointer refresh and force rescan',async t=>{
  const f=fixture(t),rpc=f.worker();
  const file=f.piFile('pi-a',[block('p1','Original retained summary',{effectiveMessageIds:['a']})]);
  assert.equal((await scan(rpc)).inserted,1);
  assert.equal((await scan(rpc)).scanned,0);
  f.write(file,{blocks:[block('p1','Replacement must not overwrite original',{effectiveMessageIds:['b']}),block('p2','second stored')]});
  assert.equal((await scan(rpc,{force:true})).inserted,1);
  readDb(f.dbPath,db=>{
    const row=db.prepare("SELECT summary,msg_ids FROM blocks WHERE block_id='p1'").get();
    assert.equal(row.summary,'Original retained summary'); assert.equal(row.msg_ids,'["b"]');
  });
});

test('prune retains legacy undated blocks and durable tombstones prevent resurrection',async t=>{
  const f=fixture(t),rpc=f.worker();
  f.piFile('pi-a',[block('old','old content',{createdAt:1}),block('undated','undated content',{createdAt:null})]);
  await scan(rpc);
  await assert.rejects(rpc.request('prune',{days:0}),/writes require/);
  const result=await rpc.request('prune',{days:0,writeAuthorized:true});
  assert.equal(result.removedBlocks,1); assert.equal(result.remainingBlocks,1);
  assert.equal((await scan(rpc,{force:true})).inserted,0);
  readDb(f.dbPath,db=>{
    assert.equal(db.prepare('SELECT count(*) c FROM block_tombstones').get().c,1);
    assert.equal(db.prepare('SELECT count(*) c FROM source_watermarks').get().c,1);
  });
});

test('malformed and encrypted/compressed/non-DSH sources do not advance watermarks',async t=>{
  const f=fixture(t),rpc=f.worker();
  const invalid=f.piFile('broken',[]); f.write(invalid,'{broken');
  const encrypted=f.biliFile('encrypted',[]); f.write(encrypted,'BILIENC1\x00not-json');
  const compressed=f.biliFile('compressed',[]); f.write(compressed,'BILIZSTD1not-json');
  f.biliFile('other-client',[block('o1','do not ingest other client')],{metadata:{pluginAgent:'other'}});
  f.write(path.join(f.biliRoot,'api.example.test_123456789012345678901234.content-store.json'),{state:{blocks:[block('raw','exclude companion')]}});
  const result=await scan(rpc);
  assert.equal(result.inserted,0); assert.equal(result.failed,4);
  const stats=await rpc.request('stats');
  assert.equal(stats.skipped.encrypted,1); assert.equal(stats.skipped.compressed,1); assert.equal(stats.skipped.nonDsh,1);
  readDb(f.dbPath,db=>assert.equal(db.prepare('SELECT count(*) c FROM source_watermarks').get().c,0));
});

test('redaction runs before insertion and before preview of old shared rows',async t=>{
  const f=fixture(t),rpc=f.worker();
  f.piFile('secrets',[block('p1','secretmarker password="hunter-secret-928" api_key=sk-abcdefghijklmnopqrstuvxyz')]);
  await scan(rpc);
  const result=await rpc.request('search',{query:'secretmarker'});
  assert.doesNotMatch(result,/hunter-secret-928|sk-abcdefghijklmnopqrstuvxyz/);
  readDb(f.dbPath,db=>assert.doesNotMatch(db.prepare('SELECT summary FROM blocks').get().summary,/hunter-secret-928/));
  const db=new DatabaseSync(f.dbPath);
  db.prepare('INSERT INTO blocks(source_file,block_id,summary,topic) VALUES(?,?,?,?)').run('old-shared','old','legacysecret password="old-private-credential-921"','legacy');db.close();
  assert.doesNotMatch(await rpc.request('search',{query:'legacysecret'}),/old-private-credential-921/);
});

test('unknown schema is refused without changing the database bytes',async t=>{
  const f=fixture(t),rpc=f.worker();
  const db=new DatabaseSync(f.dbPath);db.exec("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('valuable');");db.close();
  const bytes=fs.readFileSync(f.dbPath);
  await assert.rejects(rpc.request('search',{query:'x'}),/Unsupported memory database schema/);
  await assert.rejects(scan(rpc),/Unsupported memory database schema/);
  assert.deepEqual(fs.readFileSync(f.dbPath),bytes);
  assert.equal(fs.existsSync(f.dbPath+'-wal'),false);
});

test('shared compatible store search/status do not mutate main or WAL files',async t=>{
  const f=fixture(t),writer=f.worker(); f.piFile('one',[block('p','reading-only')]);await scan(writer);await writer.close();
  const before=fs.readFileSync(f.dbPath),names=fs.readdirSync(f.pi).sort();
  const reader=f.worker();await reader.request('stats');await reader.request('search',{query:'reading'});await reader.close();
  assert.deepEqual(fs.readFileSync(f.dbPath),before);
  // SQLite may create transient WAL/SHM for a read-only WAL connection; no logical/index writes.
  assert.deepEqual(fs.readdirSync(f.pi).filter(x=>!x.endsWith('-wal')&&!x.endsWith('-shm')).sort(),names.filter(x=>!x.endsWith('-wal')&&!x.endsWith('-shm')));
});

test('two workers share WAL safely with idempotent ingestion',async t=>{
  const f=fixture(t),a=f.worker(),b=f.worker(); f.piFile('one',Array.from({length:200},(_,i)=>block('p'+i,'concurrent memory '+i)));
  await scan(a);
  const results=await Promise.all([scan(a,{force:true}),scan(b,{force:true}),b.request('search',{query:'concurrent'})]);
  assert.equal(results[0].failed,0);assert.equal(results[1].failed,0);
  assert.equal((await a.request('stats')).blocks,200);
  await a.close();assert.match(await b.request('search',{query:'concurrent'}),/Memory hits/);
});

test('bounded selective reader projects only known summary fields across UTF-8 chunk boundary',t=>{
  const f=fixture(t);
  const file=f.biliFile('unicode',[block('b1','汉字😀\\escaped\ntext')],{messages:[{content:'x'.repeat(65500)+'😀汉字'.repeat(30000)}]});
  const value=projectBiliFile(file);
  assert.equal(value.payload.state.blocks[0].summary,'汉字😀\\escaped\ntext');
  assert.deepEqual(Object.keys(value.payload).sort(),['metadata','state']);
  assert.throws(()=>projectBiliFile(file,{maxBytes:100}),/byte limit/);
  assert.throws(()=>projectBiliFile(file,{checkCancelled:()=>{throw Error('cancel fixture');}}),/cancel fixture/);
  f.write(file,{id:'legacy',state:{blocks:[]},metadata:{pluginAgent:'dsh'}});
  assert.deepEqual(projectBiliFile(file).payload.state.blocks,[]);
});

test('source allowlist narrows files and never follows symlink children',async t=>{
  const f=fixture(t),file=f.piFile('nested/yes',[block('a','allowed')]);
  f.piFile('other/no',[block('b','excluded')]);
  const cfg=loadConfig({dshEnabled:false},{},f.home),reader=new SourceReader(cfg);
  const source={id:'pi',root:f.piRoot,adapter:'pi-sidecar',pattern:'nested/*.jsonl.acp.json',enabled:true};
  assert.deepEqual((await reader.list(source)).files,[file]);
  const link=path.join(f.piRoot,'linked');fs.symlinkSync(path.join(f.piRoot,'nested'),link,'junction');
  const all=await reader.list({...source,pattern:'**/*.jsonl.acp.json'});
  assert.equal(all.files.length,2);assert.ok(all.files.every(x=>!x.includes('linked')));
  await assert.rejects(reader.check(path.join(link,'yes.jsonl.acp.json')),/not admitted/);
});

test('invalid allowlist fails closed; explicit disabled Bili root is authoritative',t=>{
  const f=fixture(t),cfg=loadConfig({dshSessionsRoot:f.biliRoot},{},f.home);
  f.write(cfg.sourcesPath,'{invalid');assert.throws(()=>loadSources(cfg),/scan refused/);
  f.write(cfg.sourcesPath,JSON.stringify({id:'bili-off',adapter:'bili-session',root:f.biliRoot,pattern:'**/*.json',enabled:false}));
  const sources=loadSources(cfg);assert.equal(sources.length,1);assert.equal(sources[0].enabled,false);
});

test('expansion is opt-in, Pi-only, explicit selection and current allowlist checked',async t=>{
  const f=fixture(t),off=f.worker();f.piFile('expand',[block('p1','expandable summary',{effectiveMessageIds:['raw']})]);
  f.biliFile('dsh-expand',[block('b1','DSH no raw access')]);await scan(off);
  await assert.rejects(off.request('expand',{block:'p1'}),/disabled/);await off.close();
  const on=f.worker({expandEnabled:true});
  const manifest=await on.request('expand',{block:'p1'});assert.doesNotMatch(manifest,/raw-only-never-index-73928/);
  await assert.rejects(on.request('expand',{block:'p1',mode:'full'}),/explicit/);
  assert.match(await on.request('expand',{block:'p1',mode:'full',select:[1]}),/raw-only-never-index-73928/);
  assert.match(await on.request('expand',{block:'b1'}),/only Pi/);
  f.write(path.join(f.pi,'pi-billion-memory.sources.jsonl'),'');
  await assert.rejects(on.request('expand',{block:'p1'}),/not admitted/);
});

test('pre-cancelled request does not write and worker closes cleanly',async t=>{
  const f=fixture(t),rpc=f.worker();const controller=new AbortController();controller.abort(Error('user stop'));
  await assert.rejects(rpc.request('scan',{writeAuthorized:true},controller.signal),/user stop/);
  assert.equal(fs.existsSync(f.dbPath),false);await rpc.close();
  await assert.rejects(rpc.request('stats'),/closed/);
});
