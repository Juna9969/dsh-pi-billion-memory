import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeCfg, sanitizeSource } from '../vendor/extension.js';

export function expandHome(value, home = os.homedir()) {
  return value === '~' ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value;
}
export function loadConfig(options = {}, env = process.env, home = os.homedir()) {
  const pi = path.join(home, '.pi');
  const configPath = path.resolve(expandHome(options.configPath || path.join(pi, 'pi-billion-memory.json'), home));
  let shared = {};
  try {
    if (fs.statSync(configPath).size > 1024 * 1024) throw new Error('Memory config exceeds limit');
    shared = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!shared || Array.isArray(shared) || typeof shared !== 'object') throw new Error('Invalid memory config');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const sanitize = value => sanitizeCfg(Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, ['dbPath','sourcesPath','logPath'].includes(k) && typeof v === 'string' ? expandHome(v,home) : v])));
  const cfg = { dbPath: path.join(pi, 'pi-billion-memory.db'), sourcesPath: path.join(pi, 'pi-billion-memory.sources.jsonl'),
    logPath: path.join(pi, 'pi-billion-memory.log'), maxSummaryChars: 20000, excludeDirs: [], debug: false,
    scanOnStartup: true, expandEnabled: false, expandMaxChars: 40000, expandMaxMessages: 200, expandMaxReadBytes: 32 * 1024 * 1024,
    ...sanitize(shared), ...sanitize(options) };
  for (const key of ['dbPath','sourcesPath','logPath']) {
    cfg[key] = expandHome(cfg[key], home);
    if (!path.isAbsolute(cfg[key])) throw new Error(`Memory ${key} must be absolute`);
  }
  cfg.maxSummaryChars = Math.min(cfg.maxSummaryChars, 1000000);
  cfg.expandMaxChars = Math.min(cfg.expandMaxChars, 100000);
  cfg.expandMaxMessages = Math.min(cfg.expandMaxMessages, 1000);
  cfg.expandMaxReadBytes = Math.min(cfg.expandMaxReadBytes, 128 * 1024 * 1024);
  const root = expandHome(options.dshSessionsRoot || env.BILI_SESSIONS_DIR ||
    path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'billion-context', 'sessions'), home);
  if (!path.isAbsolute(root)) throw new Error('DSH Bili sessions root must be absolute');
  const scanIntervalSeconds = options.scanIntervalSeconds ?? 60;
  if (!Number.isInteger(scanIntervalSeconds) || scanIntervalSeconds < 0 || scanIntervalSeconds > 2147483 || (scanIntervalSeconds > 0 && scanIntervalSeconds < 10)) throw new Error('scanIntervalSeconds must be 0 or between 10 and 2147483');
  return { ...cfg, configPath, home, dshSessionsRoot: root, dshEnabled: options.dshEnabled !== false,
    scanIntervalSeconds, attributionPath: path.join(pi, 'pi-billion-memory.dsh-attribution.db') };
}

function rootKey(root) {
  let resolved = path.resolve(root);
  try { resolved = fs.realpathSync(resolved); } catch { /* missing paths still compare lexically */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function loadSources(cfg) {
  let text;
  let sources;
  try {
    if (fs.statSync(cfg.sourcesPath).size > 1024 * 1024) throw new Error('Sources allowlist exceeds limit');
    text = fs.readFileSync(cfg.sourcesPath, 'utf8');
    sources = [];
    for (const line of text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'))) {
      const raw = JSON.parse(line);
      if (raw && typeof raw === 'object') for (const k of ['root','opencodeDb']) if (typeof raw[k] === 'string') raw[k] = expandHome(raw[k],cfg.home);
      const source = sanitizeSource(raw);
      if (!source || !path.isAbsolute(source.root) || source.pattern.split(/[/\\]/).some(x => x === '..' || x === '.')) throw new Error('Invalid memory source allowlist entry');
      sources.push(source);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Memory source allowlist unreadable/invalid; scan refused');
    sources = [
      { id: 'pi', adapter: 'pi-sidecar', root: path.join(cfg.home, '.pi', 'agent', 'sessions'), pattern: '**/*.jsonl.acp.json', enabled: true },
      { id: 'opencode', adapter: 'opencode-acp', root: path.join(cfg.home, '.local', 'share', 'opencode', 'storage', 'plugin', 'acp'), pattern: 'ses_*.json', enabled: true, opencodeDb: path.join(cfg.home, '.local', 'share', 'opencode', 'opencode.db') },
    ];
  }
  // A separate native-only default; never rewrite the shared Pi allowlist.
  // Any explicit Bili root in that file is authoritative, including enabled:false.
  if (cfg.dshEnabled && !sources.some(s => s.adapter === 'bili-session' && rootKey(s.root) === rootKey(cfg.dshSessionsRoot))) {
    sources.push({ id: 'dsh-bili', adapter: 'bili-session', root: cfg.dshSessionsRoot, pattern: '**/*.json', enabled: true, dshOnly: true });
  }
  return sources;
}
