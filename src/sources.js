import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectBiliFile } from './project-json.js';
import { loadSources } from './config.js';

const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function globRegex(pattern) {
  return new RegExp('^' + pattern.replace(/\\/g, '/').split('/').map((part, i, all) => {
    if (part === '**') return i === all.length - 1 ? '.*' : '(?:[^/]+/)*';
    return part.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (i === all.length - 1 ? '' : '/');
  }).join('') + '$');
}
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

export class SourceReader {
  constructor(cfg) { this.cfg = cfg; this.admitted = new Map(); this.identities = new Map(); this.reasons = {}; this.cancel = () => {}; }
  sources() { return loadSources(this.cfg); }
  observe(identity) {
    if (!identity || typeof identity.sessionId !== 'string' || identity.sessionId.length > 256 || typeof identity.cwd !== 'string' || !path.isAbsolute(identity.cwd)) return;
    const old = this.identities.get(identity.sessionId);
    if (old && old.workspaceCwd !== identity.cwd) return; // Never overwrite ambiguous attribution.
    this.identities.set(identity.sessionId, { workspaceCwd: identity.cwd, observedAt: Date.now(), attributionMethod: 'exact-dsh-session-header' });
  }
  async list(source) {
    const files = [], errors = [];
    const root = path.resolve(source.root);
    let realRoot;
    try { realRoot = fs.realpathSync.native(root); }
    catch (e) { if (e.code !== 'ENOENT') errors.push(e); return { files, errors }; }
    const regex = globRegex(source.pattern);
    let entries = 0;
    const walk = async (dir, prefix = '', depth = 0) => {
      this.cancel();
      if (depth > 64) throw new Error('Source depth limit reached');
      for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (++entries > 200000 || files.length >= 20000) throw new Error('Source scan limit reached');
        if (ent.isSymbolicLink()) continue;
        const rel = prefix + ent.name;
        if (source.adapter === 'pi-sidecar' && this.cfg.excludeDirs.includes(ent.name)) continue;
        const file = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (source.pattern.includes('/') || source.pattern.includes('\\')) await walk(file, rel + '/', depth + 1); }
        else if (ent.isFile() && regex.test(rel)) {
          if (source.adapter === 'pi-sidecar' && !file.endsWith('.jsonl.acp.json')) continue;
          if (source.adapter === 'opencode-acp' && !/^ses_[^/\\]+\.json$/.test(ent.name)) continue;
          if (source.adapter === 'bili-session' && !/^(?:.+_)?[a-f\d]{24}\.json$/i.test(ent.name)) continue;
          this.admitted.set(file, { source, root, realRoot }); files.push(file);
        }
      }
    };
    try { await walk(root); } catch(e) { errors.push(e); }
    return { files, errors };
  }
  checkSync(file, admission = this.admitted.get(file)) {
    if (!admission) throw new Error('Source not admitted by current allowlist');
    const {root, realRoot} = admission;
    if (!within(root, file)) throw new Error('Source outside allowlist');
    let current = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink child skipped');
    }
    if (path.relative(fs.realpathSync.native(root),realRoot) !== '') throw new Error('Allowlist root changed');
    const real = fs.realpathSync.native(file);
    if (!within(realRoot, real)) throw new Error('Source escaped allowlisted root');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Source exceeds file/byte limits');
    return stat;
  }
  async check(file, admission) { return this.checkSync(file, admission); }
  withFile(file, admission, read) {
    this.cancel();
    const before = this.checkSync(file, admission);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!sameFile(before,opened) || !sameFile(opened,this.checkSync(file,admission))) throw new Error('Source changed before read');
      const result = read(fd,opened);
      this.cancel();
      if (!sameFile(opened,fs.fstatSync(fd)) || !sameFile(opened,this.checkSync(file,admission))) throw new Error('Source changed while being read; retry later');
      return result;
    } finally { fs.closeSync(fd); }
  }
  readCapped(file, maxBytes, admission = this.admitted.get(file), firstLine = false) {
    return this.withFile(file,admission,(fd,stat) => {
      const chunks = []; let size = 0;
      const chunk = Buffer.allocUnsafe(Math.min(65536,maxBytes));
      while (size < Math.min(maxBytes,stat.size)) {
        this.cancel();
        const n = fs.readSync(fd,chunk,0,Math.min(chunk.length,maxBytes-size),null);
        if (!n) break;
        const end = firstLine ? chunk.subarray(0,n).indexOf(10) : -1;
        const part = chunk.subarray(0,end < 0 ? n : end + 1);
        chunks.push(Buffer.from(part)); size += part.length;
        if (end >= 0) break;
      }
      return { buffer:Buffer.concat(chunks,size), totalBytes:stat.size };
    });
  }
  async read(file, kind) {
    this.cancel();
    try {
      const admission = this.admitted.get(file);
      const value = kind === 'bili'
        ? this.withFile(file,admission,fd => projectBiliFile(fd, { checkCancelled: this.cancel }))
        : JSON.parse(this.readCapped(file,128 * 1024 * 1024,admission).buffer.toString('utf8'));
      if (kind === 'bili' && this.admitted.get(file)?.source.dshOnly && value.payload?.metadata?.pluginAgent !== 'dsh') throw new Error('Non-DSH Bili source skipped');
      this.cancel(); return value;
    } catch(e) {
      const reason = /Encrypted/.test(e.message) ? 'encrypted' : /Compressed Bili/.test(e.message) ? 'compressed' : /Non-DSH/.test(e.message) ? 'nonDsh' : 'invalidOrUnreadable';
      this.reasons[reason] = (this.reasons[reason] || 0) + 1;
      throw e;
    }
  }
  async readHeader(sessionFile) {
    const admission = this.admitted.get(sessionFile + '.acp.json');
    try {
      const text = this.readCapped(sessionFile,1024 * 1024,admission,true).buffer.toString('utf8');
      const header = JSON.parse(text.split('\n',1)[0]);
      return typeof header.cwd === 'string' && path.isAbsolute(header.cwd) ? header.cwd : null;
    }
    catch { return null; }
  }
  resolveMeta(data, file, kind) {
    if (kind !== 'bili' || data.payload?.metadata?.pluginAgent !== 'dsh' || typeof data.id !== 'string') return null;
    const suffix = createHash('sha256').update(data.id).digest('hex').slice(0,24) + '.json';
    if (!path.basename(file).endsWith(suffix)) return null;
    const identity = this.identities.get(data.id);
    return identity ? { cwd: identity.workspaceCwd, project: path.basename(identity.workspaceCwd) } : null;
  }
  needsMetadataRefresh(file,kind,stored) {
    if (kind !== 'bili') return false;
    for (const [id,info] of this.identities) {
      if (stored?.cwd === info.workspaceCwd) continue;
      if (path.basename(file).endsWith(createHash('sha256').update(id).digest('hex').slice(0,24)+'.json')) return true;
    }
    return false;
  }
  hooks() { return { statSource: f => this.checkSync(f), needsMetadataRefresh: (f,k,s) => this.needsMetadataRefresh(f,k,s), loadSources: () => this.sources(), listSourceFiles: s => this.list(s), readSource: (f,k) => this.read(f,k),
    readHeader: f => this.readHeader(f), resolveMeta: (d,f,k) => this.resolveMeta(d,f,k), checkCancelled: () => this.cancel() }; }
  async authorizeExpansion(file) {
    this.admitted.clear();
    for (const source of this.sources().filter(s => s.enabled && s.adapter === 'pi-sidecar')) await this.list(source);
    const admission = this.admitted.get(file);
    await this.check(file, admission);
    const session = file.slice(0, -'.acp.json'.length);
    // The bound reader handles a disappeared raw session as a missing manifest.
    return session;
  }
}
