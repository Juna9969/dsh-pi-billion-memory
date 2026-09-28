import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { assertCompatibleSchema } from '../src/schema.js';

/** Online snapshot; no summary output. The destination must be a new, trusted local file. */
export async function backupMemory(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) throw new Error('Backup destination must differ from source');
  const db = new DatabaseSync(source, { readOnly: true });
  let reserved = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');
    if (assertCompatibleSchema(db) !== 'compatible') throw new Error('No compatible memory index to back up');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Exclusive reservation prevents an accidental overwrite of an existing backup.
    const fd = fs.openSync(destination, 'wx', 0o600); fs.closeSync(fd); reserved = true;
    await backup(db, destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      assertCompatibleSchema(copy);
      const check = copy.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('Backup integrity check failed');
      return { destination, bytes: fs.statSync(destination).size, integrity: 'ok',
        ...copy.prepare('SELECT (SELECT count(*) FROM blocks) blocks, (SELECT count(*) FROM sources) sources, (SELECT count(*) FROM block_tombstones) tombstones').get() };
    } finally { copy.close(); }
  } catch (error) {
    // Keep a failed partial artifact for inspection; never delete or overwrite user files.
    if (reserved) throw new Error('Backup did not complete; preserve or remove the partial destination before retrying', { cause: error });
    throw error;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) { console.error('Usage: node scripts/backup.mjs SOURCE.db NEW-BACKUP.db'); process.exitCode = 2; }
  else try { console.log(JSON.stringify(await backupMemory(process.argv[2], process.argv[3]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
