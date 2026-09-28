// Separate native metadata store: never add native tables to the shared Pi DB.
// SQLite transactions merge concurrent workers/processes without temporary-file races.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const ddl = 'CREATE TABLE attribution(session_id TEXT PRIMARY KEY,cwd TEXT NOT NULL,observed_at INTEGER NOT NULL)';
function validate(db, emptyAllowed) {
  const objects = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  if (!objects.length && emptyAllowed) { db.exec(ddl); return; }
  if (objects.length !== 1 || objects[0].name !== 'attribution' || objects[0].sql !== ddl) throw new Error('Unsupported native attribution schema; refused');
}
export function attribution(file, identities, check = () => {}) {
  const writing = Boolean(identities);
  if (!writing && !fs.existsSync(file)) return [];
  if (writing) fs.mkdirSync(path.dirname(file),{recursive:true});
  const db = new DatabaseSync(file,{readOnly:!writing});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (writing) {
      db.exec('BEGIN IMMEDIATE'); validate(db,true);
      const insert = db.prepare('INSERT OR IGNORE INTO attribution VALUES(?,?,?)');
      for (const [id,info] of identities) {
        check(); insert.run(id,info.workspaceCwd,info.observedAt);
      }
      check(); db.exec('COMMIT');
      if (process.platform !== 'win32') fs.chmodSync(file,0o600);
    } else { db.exec('PRAGMA query_only=ON'); validate(db,false); }
    return db.prepare('SELECT session_id,cwd,observed_at FROM attribution ORDER BY observed_at DESC LIMIT 10000').all()
      .filter(r=>typeof r.session_id==='string' && r.session_id.length<=256 && typeof r.cwd==='string' && path.isAbsolute(r.cwd))
      .map(r=>[r.session_id,{workspaceCwd:r.cwd,observedAt:r.observed_at,attributionMethod:'exact-dsh-session-header'}]);
  } finally { db.close(); }
}
