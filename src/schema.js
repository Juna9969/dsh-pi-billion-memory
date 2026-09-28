// Refuse unknown/legacy databases BEFORE journal-mode changes or DDL.
// Supported Pi 0.5.x invariants; no repair, rebuilding or data migration here.
const compact = sql => String(sql || '').replace(/--[^\n]*/g,'').replace(/[\s"`\[\]]/g,'').replace(/ifnotexists/ig,'').replace(/;$/,'').toLowerCase();
export function assertCompatibleSchema(db) {
  const fail = () => { throw new Error('Unsupported memory database schema; refused without rebuilding. Back up and migrate with Pi first.'); };
  if (db.prepare('PRAGMA user_version').get().user_version !== 0) fail();
  const objects = db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  if (!objects.length) return 'empty';
  const expected = {
    sources: {source_file:['TEXT',1],kind:['TEXT',0,1],project:['TEXT',0,1],cwd:['TEXT'],last_mtime_ms:['INTEGER'],last_size:['INTEGER'],first_seen_at:['INTEGER'],updated_at:['INTEGER']},
    blocks: {id:['INTEGER',1],source_file:['TEXT',0,1],kind:['TEXT',0,1],block_id:['TEXT',0,1],run_id:['TEXT'],tier:['INTEGER'],topic:['TEXT'],summary:['TEXT',0,1],ref_start:['TEXT'],ref_end:['TEXT'],compressed_tokens:['INTEGER'],created_at:['INTEGER'],msg_ids:['TEXT']},
    source_watermarks: {source_file:['TEXT',1],last_mtime_ms:['INTEGER',0,1],last_size:['INTEGER',0,1],updated_at:['INTEGER']},
    block_tombstones: {source_file:['TEXT',1,1],block_id:['TEXT',2,1],pruned_at:['INTEGER',0,1]},
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all();
    if (actual.length !== Object.keys(columns).length) fail();
    for (const [name,[type,pk=0,notnull]] of Object.entries(columns)) {
      const col = actual.find(c => c.name === name);
      if (!col || col.type.toUpperCase() !== type || col.pk !== pk || (notnull && !col.notnull)) fail();
    }
    if (/without\s+rowid/i.test(objects.find(o=>o.name===table)?.sql || '')) fail();
  }
  const fts = compact(objects.find(o=>o.name==='blocks_fts')?.sql);
  if (fts !== "createvirtualtableblocks_ftsusingfts5(summary,topic,content='blocks',content_rowid='id',tokenize='trigram')") fail();
  const unique=db.prepare('PRAGMA index_list(blocks)').all().filter(i=>i.unique && !i.partial);
  if (!unique.some(i => {
    const cols=db.prepare('SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(i.name);
    return cols.map(c=>c.name).join(',') === 'source_file,block_id' && cols.every(c=>c.coll === 'BINARY');
  })) fail();
  const triggerSql = {
    blocks_ai: "CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN INSERT INTO blocks_fts(rowid, summary, topic) VALUES (new.id, new.summary, coalesce(new.topic, '')); END",
    blocks_ad: "CREATE TRIGGER blocks_ad AFTER DELETE ON blocks BEGIN INSERT INTO blocks_fts(blocks_fts, rowid, summary, topic) VALUES ('delete', old.id, old.summary, coalesce(old.topic, '')); END",
  };
  const triggers=objects.filter(o=>o.type==='trigger');
  if (triggers.length !== 2 || !triggers.every(t=>t.tbl_name==='blocks' && triggerSql[t.name] && compact(t.sql)===compact(triggerSql[t.name]))) fail();
  return 'compatible';
}
