// Selective streaming JSON reader. Unselected strings (including conversation text)
// are validated and discarded, never decoded/materialized as message objects.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const BLOCK_FIELDS = ['blockId','runId','tier','topic','summary','startRef','endRef','compressedTokens','createdAt'];
const block = Object.fromEntries(BLOCK_FIELDS.map(k => [k, true]));
const state = { blocks: { '*': block } };
const selection = { id: true, payload: { state, metadata: { pluginAgent: true } }, state, metadata: { pluginAgent: true } };
export function projectBiliFile(file, { maxBytes = 128 * 1024 * 1024, maxSelectedChars = 16 * 1024 * 1024, checkCancelled = () => {} } = {}) {
  // A validated descriptor supplied by SourceReader must never be reopened by path.
  const owned = typeof file !== 'number';
  const fd = owned ? fs.openSync(file, 'r') : file;
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let text = '', at = 0, bytes = 0, kept = 0, done = false, values = 0;
  function peek() {
    while (at >= text.length && !done) {
      checkCancelled();
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      bytes += n;
      if (bytes > maxBytes) throw new Error('Source exceeds byte limit');
      text = n ? decoder.write(buffer.subarray(0,n)) : decoder.end();
      at = 0; done = n === 0;
    }
    return text[at];
  }
  function take() { const c = peek(); if (c !== undefined) at++; return c; }
  function ws() { while (peek() !== undefined && /[\t\n\r ]/.test(peek())) take(); }
  function expect(c) { if (take() !== c) throw new Error('Invalid source JSON'); }
  function string(capture, key = false) {
    expect('"'); let out = ''; let count = 0;
    const append = c => {
      if (!capture) return;
      count += c.length; kept += c.length;
      if (count > (key ? 1024 : 1024 * 1024) || kept > maxSelectedChars) throw new Error('Selected JSON exceeds limit');
      out += c;
    };
    for (;;) {
      const c = take();
      if (c === undefined || c.charCodeAt(0) < 32) throw new Error('Invalid JSON string');
      if (c === '"') return capture ? out : undefined;
      if (c !== '\\') { append(c); continue; }
      const e = take();
      if (e === 'u') {
        let hex = ''; for (let j=0;j<4;j++) { const h=take(); if (!h || !/[0-9a-f]/i.test(h)) throw new Error('Invalid JSON escape'); hex+=h; }
        if (capture) append(String.fromCharCode(parseInt(hex,16)));
      } else {
        const escapes = { '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' };
        if (!Object.hasOwn(escapes,e)) throw new Error('Invalid JSON escape');
        append(escapes[e]);
      }
    }
  }
  function value(sel, depth = 0) {
    if (depth > 128 || ++values > 2000000) throw new Error('Source JSON nesting/item limit');
    ws(); const c = peek();
    if (c === '"') return string(sel === true);
    if (c === '{') {
      take(); ws(); const out = sel && sel !== true ? Object.create(null) : undefined;
      if (peek() === '}') { take(); return out; }
      for (;;) {
        ws(); const key = string(Boolean(out), true); ws(); expect(':');
        const child = out ? (Object.hasOwn(sel,key) ? sel[key] : sel['*']) : undefined;
        const v = value(child, depth + 1);
        if (out && child) out[key] = v;
        ws(); const end=take(); if (end === '}') return out; if (end !== ',') throw new Error('Invalid JSON object');
      }
    }
    if (c === '[') {
      take(); ws(); const child = sel && sel !== true ? sel['*'] : undefined;
      const out = child ? [] : undefined;
      if (peek() === ']') { take(); return out; }
      for (;;) {
        const v=value(child, depth+1); if (out) { if (out.length >= 20000) throw new Error('Too many compression blocks'); out.push(v); }
        ws(); const end=take(); if (end === ']') return out; if (end !== ',') throw new Error('Invalid JSON array');
      }
    }
    if (c === 't' || c === 'f' || c === 'n') {
      const literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      for (const x of literal) expect(x);
      return sel === true ? (literal === 'true' ? true : literal === 'false' ? false : null) : undefined;
    }
    let number=''; while (peek() !== undefined && /[-+0-9.eE]/.test(peek())) { if(number.length>128) throw new Error('Invalid number'); number+=take(); }
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) throw new Error('Invalid JSON value');
    return sel === true ? Number(number) : undefined;
  }
  try {
    const magic=Buffer.alloc(9); fs.readSync(fd,magic,0,9,0);
    if (magic.toString().startsWith('BILIENC1')) throw new Error('Encrypted Bili source skipped: no plaintext export consent');
    if (magic.toString().startsWith('BILIZSTD1')) throw new Error('Compressed Bili source skipped: plain JSON required');
    const result=value(selection); ws(); if(peek() !== undefined) throw new Error('Trailing JSON data');
    if (!result || !(Array.isArray(result.payload?.state?.blocks) || Array.isArray(result.state?.blocks))) throw new Error('Unrecognized Bili compression format');
    if (!result.payload) return { id: result.id, payload: { state: result.state, metadata: result.metadata } };
    return result;
  } finally { if (owned) fs.closeSync(fd); }
}
