import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, block, scan } from './helpers.mjs';
import { backupMemory } from '../scripts/backup.mjs';

test('online backup includes committed live WAL and refuses overwrite',async t=>{
  const f=fixture(t),rpc=f.worker();f.piFile('backup',[block('b1','private backup fixture')]);await scan(rpc);
  const destination=path.join(f.home,'backups','snapshot.db');
  const result=await backupMemory(f.dbPath,destination);
  assert.equal(result.blocks,1);assert.equal(result.integrity,'ok');
  const copy=new DatabaseSync(destination,{readOnly:true});
  try{assert.equal(copy.prepare('SELECT summary FROM blocks').get().summary,'private backup fixture');}finally{copy.close();}
  const before=fs.readFileSync(destination);
  await assert.rejects(backupMemory(f.dbPath,destination),/EEXIST/);assert.deepEqual(fs.readFileSync(destination),before);
  await assert.rejects(backupMemory(f.dbPath,f.dbPath),/differ/);
});
