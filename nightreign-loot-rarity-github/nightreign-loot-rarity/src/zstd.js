// ---------------------------------------------------------------------------
// zstd.js — small, dependency-free Zstandard decoder (RFC 8878): raw/RLE/
// compressed blocks, Huffman literals incl. treeless + 4 streams, FSE/RLE/
// predefined/repeat sequence tables. Compression is done by libzstd itself
// (zstdwasm.js), because the game only accepts files packed the way libzstd does.
// ---------------------------------------------------------------------------
(function (root) {
  "use strict";

  // ---------- shared tables ----------
  const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
  const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
  const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
  const LL_DEFAULT_LOG = 6, ML_DEFAULT_LOG = 6, OF_DEFAULT_LOG = 5;
  const MAX_LL = 35, MAX_ML = 52, MAX_OF = 31;

  function highbit(v) { return 31 - Math.clz32(v); }

  class ZstdError extends Error { }
  function fail(msg) { throw new ZstdError("zstd: " + msg); }

  // ---------- FSE (shared) ----------
  function spreadSymbols(norm, tableLog) {
    const size = 1 << tableLog, mask = size - 1;
    const symbols = new Uint8Array(size);
    let high = size - 1;
    for (let s = 0; s < norm.length; s++) if (norm[s] === -1) symbols[high--] = s;
    const step = (size >> 1) + (size >> 3) + 3;
    let pos = 0;
    for (let s = 0; s < norm.length; s++) {
      for (let i = 0; i < norm[s]; i++) {
        symbols[pos] = s;
        do { pos = (pos + step) & mask; } while (pos > high);
      }
    }
    if (pos !== 0) fail("bad FSE distribution");
    return { symbols, high };
  }

  function buildDTable(norm, tableLog) {
    const size = 1 << tableLog;
    const { symbols } = spreadSymbols(norm, tableLog);
    const next = new Int32Array(norm.length);
    for (let s = 0; s < norm.length; s++) next[s] = norm[s] === -1 ? 1 : norm[s];
    const sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Int32Array(size);
    for (let u = 0; u < size; u++) {
      const s = symbols[u];
      const ns = next[s]++;
      const nbBits = tableLog - highbit(ns);
      sym[u] = s; nb[u] = nbBits; base[u] = (ns << nbBits) - size;
    }
    return { log: tableLog, sym, nb, base };
  }

  function rleDTable(symbol) {
    return { log: 0, sym: Uint8Array.of(symbol), nb: Uint8Array.of(0), base: Int32Array.of(0) };
  }

  // forward bit reader (LSB first) for FSE table descriptions
  function readNCount(src, pos, end, maxSymbol, maxLog) {
    let bitPos = pos * 8;
    const limit = end * 8;
    function peek(n) { // up to 16 bits
      let v = 0;
      for (let i = 0; i < n; i++) {
        const b = bitPos + i;
        const bit = b < limit ? (src[b >> 3] >> (b & 7)) & 1 : 0;
        v |= bit << i;
      }
      return v;
    }
    const tableLog = peek(4) + 5; bitPos += 4;
    if (tableLog > maxLog) fail("FSE table log too large");
    let remaining = (1 << tableLog) + 1;
    let threshold = 1 << tableLog;
    let nbBits = tableLog + 1;
    const norm = [];
    let symbol = 0;
    let prev0 = false;
    while (remaining > 1 && symbol <= maxSymbol) {
      if (prev0) {
        let n0 = symbol;
        for (;;) {
          const r = peek(2); bitPos += 2;
          n0 += r;
          if (r !== 3) break;
        }
        if (n0 > maxSymbol + 1) fail("bad zero run");
        while (symbol < n0) norm[symbol++] = 0;
        if (symbol > maxSymbol) break;
      }
      const max = (2 * threshold - 1) - remaining;
      let count;
      const low = peek(nbBits - 1);
      if (low < max) { count = low; bitPos += nbBits - 1; }
      else {
        count = peek(nbBits);
        if (count >= threshold) count -= max;
        bitPos += nbBits;
      }
      count--;
      remaining -= count < 0 ? -count : count;
      norm[symbol++] = count;
      prev0 = count === 0;
      while (remaining < threshold) { nbBits--; threshold >>= 1; }
    }
    if (remaining !== 1) fail("corrupted FSE table");
    while (norm.length && norm[norm.length - 1] === 0) norm.pop();
    const bytes = ((bitPos - pos * 8) + 7) >> 3;
    return { norm, tableLog, size: bytes };
  }

  // backward bit reader
  class BackReader {
    constructor(src, start, end) {
      if (end <= start) fail("empty bitstream");
      const last = src[end - 1];
      if (last === 0) fail("bitstream missing end mark");
      this.src = src; this.start = start;
      this.pos = (end - start - 1) * 8 + highbit(last); // number of usable bits
    }
    read(n) {
      if (n === 0) return 0;
      if (n > 24) { const hi = this.read(n - 16); return hi * 65536 + this.read(16); }
      let p = this.pos - n;
      this.pos = p;
      if (p < 0) { // reading past the beginning: missing low bits are zero
        const avail = n + p;
        if (avail <= 0) return 0;
        const v = this._get(0, avail);
        return v << (-p);
      }
      return this._get(p, n);
    }
    _get(p, n) {
      const src = this.src, i = this.start + (p >> 3), sh = p & 7;
      const v = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> sh;
      return v & ((1 << n) - 1);
    }
    overflow() { return this.pos < 0; }
  }

  // ---------- Huffman decoding ----------
  function decodeHuffTable(src, pos) {
    const hb = src[pos];
    let weights;
    let size;
    if (hb >= 128) {
      const n = hb - 127;
      weights = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const b = src[pos + 1 + (i >> 1)];
        weights[i] = (i & 1) ? (b & 15) : (b >> 4);
      }
      size = 1 + ((n + 1) >> 1);
    } else {
      const end = pos + 1 + hb;
      const nc = readNCount(src, pos + 1, end, 255, 6);
      const dt = buildDTable(nc.norm, nc.tableLog);
      const br = new BackReader(src, pos + 1 + nc.size, end);
      const out = [];
      let s1 = br.read(dt.log), s2 = br.read(dt.log);
      for (;;) {
        out.push(dt.sym[s1]); s1 = dt.base[s1] + br.read(dt.nb[s1]);
        if (br.overflow()) { out.push(dt.sym[s2]); break; }
        out.push(dt.sym[s2]); s2 = dt.base[s2] + br.read(dt.nb[s2]);
        if (br.overflow()) { out.push(dt.sym[s1]); break; }
        if (out.length > 255) fail("too many huffman weights");
      }
      weights = Uint8Array.from(out);
      size = 1 + hb;
    }
    // implied last weight
    let total = 0;
    for (let i = 0; i < weights.length; i++) if (weights[i]) total += 1 << (weights[i] - 1);
    if (total === 0) fail("empty huffman table");
    const maxBits = highbit(total) + 1;
    const rest = (1 << maxBits) - total;
    if (rest & (rest - 1)) fail("bad huffman weights");
    const lastW = highbit(rest) + 1;
    const all = new Uint8Array(weights.length + 1);
    all.set(weights); all[weights.length] = lastW;
    if (maxBits > 11) fail("huffman max bits > 11");
    // build decode table
    const tsize = 1 << maxBits;
    const sym = new Uint8Array(tsize), nb = new Uint8Array(tsize);
    const rankCount = new Int32Array(maxBits + 2);
    for (let s = 0; s < all.length; s++) rankCount[all[s]]++;
    const rankStart = new Int32Array(maxBits + 2);
    let next = 0;
    for (let w = 1; w <= maxBits; w++) { rankStart[w] = next; next += rankCount[w] << (w - 1); }
    for (let s = 0; s < all.length; s++) {
      const w = all[s];
      if (!w) continue;
      const len = 1 << (w - 1);
      const bits = maxBits + 1 - w;
      const st = rankStart[w];
      for (let i = st; i < st + len; i++) { sym[i] = s; nb[i] = bits; }
      rankStart[w] += len;
    }
    return { table: { maxBits, sym, nb }, size };
  }

  function huffDecodeStream(t, src, start, end, out, op, count) {
    const br = new BackReader(src, start, end);
    const mb = t.maxBits, sym = t.sym, nb = t.nb;
    for (let i = 0; i < count; i++) {
      // peek maxBits
      let p = br.pos - mb, v;
      if (p >= 0) v = br._get(p, mb);
      else { const a = mb + p; v = a > 0 ? (br._get(0, a) << (-p)) : 0; }
      out[op + i] = sym[v];
      br.pos -= nb[v];
    }
    if (br.pos !== 0) fail("huffman stream not fully consumed");
  }

  // ---------- decoder ----------
  function decompress(src, expectedSize) {
    const chunks = [];
    let total = 0;
    let pos = 0;
    let out = expectedSize ? new Uint8Array(expectedSize) : null;
    while (pos < src.length) {
      const magic = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      if ((magic & 0xFFFFFFF0) === 0x184D2A50) { // skippable
        const sz = (src[pos + 4] | (src[pos + 5] << 8) | (src[pos + 6] << 16) | (src[pos + 7] << 24)) >>> 0;
        pos += 8 + sz; continue;
      }
      if (magic !== 0xFD2FB528) {
        if (total > 0) break; // trailing padding after a frame
        fail("bad magic");
      }
      const r = decodeFrame(src, pos + 4, out, total);
      pos = r.pos; out = r.out; total = r.total;
    }
    if (expectedSize && total !== expectedSize) fail(`size mismatch ${total} != ${expectedSize}`);
    return out.length === total ? out : out.slice(0, total);
  }

  function decodeFrame(src, pos, out, op) {
    const fhd = src[pos++];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (fhd & 8) fail("reserved bit set");
    let windowSize = 0;
    if (!single) {
      const wd = src[pos++];
      const exp = wd >> 3, mant = wd & 7;
      const base = 2 ** (10 + exp);
      windowSize = base + (base / 8) * mant;
    }
    const dictSize = [0, 1, 2, 4][dictFlag];
    if (dictSize) {
      let id = 0; for (let i = 0; i < dictSize; i++) id |= src[pos + i] << (8 * i);
      if (id) fail("dictionaries not supported");
      pos += dictSize;
    }
    const fcsSize = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let fcs = -1;
    if (fcsSize) {
      fcs = 0; for (let i = 0; i < fcsSize; i++) fcs += src[pos + i] * 2 ** (8 * i);
      if (fcsSize === 2) fcs += 256;
      pos += fcsSize;
    }
    if (single) windowSize = fcs;
    const need = fcs >= 0 ? op + fcs : op + (1 << 20);
    if (!out) out = new Uint8Array(Math.max(need, 1 << 16));
    else if (out.length < need && fcs >= 0) { const n = new Uint8Array(need); n.set(out.subarray(0, op)); out = n; }

    const st = { rep: [1, 4, 8], huf: null, ll: null, of: null, ml: null };
    const frameStart = op;
    for (;;) {
      const bh = src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16);
      pos += 3;
      const last = bh & 1, type = (bh >> 1) & 3, bsize = bh >>> 3;
      // ensure capacity for at most 128 KiB
      if (op + Math.max(bsize, 131072) > out.length) {
        let cap = out.length * 2; while (cap < op + 131072 + bsize) cap *= 2;
        const n = new Uint8Array(cap); n.set(out.subarray(0, op)); out = n;
      }
      if (type === 0) { out.set(src.subarray(pos, pos + bsize), op); op += bsize; pos += bsize; }
      else if (type === 1) { out.fill(src[pos], op, op + bsize); op += bsize; pos += 1; }
      else if (type === 2) { op = decodeBlock(src, pos, pos + bsize, out, op, st, frameStart); pos += bsize; }
      else fail("reserved block type");
      if (last) break;
    }
    if (checksum) pos += 4;
    if (fcs >= 0 && op - frameStart !== fcs) fail("frame content size mismatch");
    return { pos, out, total: op };
  }

  function decodeBlock(src, pos, end, out, op, st, frameStart) {
    // ---- literals ----
    const b0 = src[pos];
    const ltype = b0 & 3, sf = (b0 >> 2) & 3;
    let lits, litLen;
    if (ltype === 0 || ltype === 1) {
      let rs, hs;
      if (sf === 0 || sf === 2) { rs = b0 >> 3; hs = 1; }
      else if (sf === 1) { rs = (b0 >> 4) | (src[pos + 1] << 4); hs = 2; }
      else { rs = (b0 >> 4) | (src[pos + 1] << 4) | (src[pos + 2] << 12); hs = 3; }
      pos += hs;
      if (ltype === 0) { lits = src.subarray(pos, pos + rs); pos += rs; }
      else { lits = new Uint8Array(rs).fill(src[pos]); pos += 1; }
      litLen = rs;
    } else {
      let rs, cs, hs, streams;
      const b1 = src[pos + 1], b2 = src[pos + 2], b3 = src[pos + 3], b4 = src[pos + 4];
      if (sf === 0 || sf === 1) {
        streams = sf === 0 ? 1 : 4; hs = 3;
        const v = b0 | (b1 << 8) | (b2 << 16);
        rs = (v >> 4) & 0x3FF; cs = (v >> 14) & 0x3FF;
      } else if (sf === 2) {
        streams = 4; hs = 4;
        const v = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
        rs = (v >>> 4) & 0x3FFF; cs = (v >>> 18) & 0x3FFF;
      } else {
        streams = 4; hs = 5;
        const v = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
        rs = (v >>> 4) & 0x3FFFF; cs = ((v >>> 22) | (b4 << 10)) & 0x3FFFF;
      }
      pos += hs;
      const lend = pos + cs;
      let p = pos;
      if (ltype === 2) { const h = decodeHuffTable(src, p); st.huf = h.table; p += h.size; }
      else if (!st.huf) fail("treeless literals without previous table");
      lits = new Uint8Array(rs); litLen = rs;
      if (streams === 1) huffDecodeStream(st.huf, src, p, lend, lits, 0, rs);
      else {
        const s1 = src[p] | (src[p + 1] << 8), s2 = src[p + 2] | (src[p + 3] << 8), s3 = src[p + 4] | (src[p + 5] << 8);
        p += 6;
        const seg = (rs + 3) >> 2;
        const a = p, b = a + s1, c = b + s2, d = c + s3;
        huffDecodeStream(st.huf, src, a, b, lits, 0, seg);
        huffDecodeStream(st.huf, src, b, c, lits, seg, seg);
        huffDecodeStream(st.huf, src, c, d, lits, 2 * seg, seg);
        huffDecodeStream(st.huf, src, d, lend, lits, 3 * seg, rs - 3 * seg);
      }
      pos = lend;
    }
    // ---- sequences ----
    let nbSeq = src[pos++];
    if (nbSeq === 0) {
      out.set(lits.subarray(0, litLen), op);
      return op + litLen;
    }
    if (nbSeq >= 128) {
      if (nbSeq < 255) nbSeq = ((nbSeq - 128) << 8) + src[pos++];
      else { nbSeq = src[pos] + (src[pos + 1] << 8) + 0x7F00; pos += 2; }
    }
    const modes = src[pos++];
    const llMode = modes >> 6, ofMode = (modes >> 4) & 3, mlMode = (modes >> 2) & 3;
    function table(mode, prev, def, defLog, maxSym, maxLog) {
      if (mode === 0) return buildDTable(def, defLog);
      if (mode === 1) { const s = src[pos++]; if (s > maxSym) fail("bad rle symbol"); return rleDTable(s); }
      if (mode === 2) {
        const nc = readNCount(src, pos, end, maxSym, maxLog);
        pos += nc.size;
        return buildDTable(nc.norm, nc.tableLog);
      }
      if (!prev) fail("repeat mode without previous table");
      return prev;
    }
    st.ll = table(llMode, st.ll, LL_DEFAULT, LL_DEFAULT_LOG, MAX_LL, 9);
    st.of = table(ofMode, st.of, OF_DEFAULT, OF_DEFAULT_LOG, MAX_OF, 8);
    st.ml = table(mlMode, st.ml, ML_DEFAULT, ML_DEFAULT_LOG, MAX_ML, 9);
    const LLt = st.ll, OFt = st.of, MLt = st.ml;
    const br = new BackReader(src, pos, end);
    let sLL = br.read(LLt.log), sOF = br.read(OFt.log), sML = br.read(MLt.log);
    const rep = st.rep;
    let lp = 0;
    for (let i = 0; i < nbSeq; i++) {
      const ofCode = OFt.sym[sOF], mlCode = MLt.sym[sML], llCode = LLt.sym[sLL];
      if (ofCode > MAX_OF || mlCode > MAX_ML || llCode > MAX_LL) fail("bad sequence code");
      const ov = (ofCode === 0 ? 1 : 2 ** ofCode + br.read(ofCode));
      const ml = ML_BASE[mlCode] + br.read(ML_BITS[mlCode]);
      const ll = LL_BASE[llCode] + br.read(LL_BITS[llCode]);
      let off;
      if (ov > 3) { off = ov - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; }
      else {
        let idx = ov - 1 + (ll === 0 ? 1 : 0);
        if (idx === 0) off = rep[0];
        else if (idx === 1) { off = rep[1]; rep[1] = rep[0]; rep[0] = off; }
        else if (idx === 2) { off = rep[2]; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; }
        else { off = rep[0] - 1; if (off === 0) off = 1; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; }
      }
      if (i !== nbSeq - 1) {
        sLL = LLt.base[sLL] + br.read(LLt.nb[sLL]);
        sML = MLt.base[sML] + br.read(MLt.nb[sML]);
        sOF = OFt.base[sOF] + br.read(OFt.nb[sOF]);
      }
      // execute
      if (lp + ll > litLen) fail("literal overrun");
      if (ll) { out.set(lits.subarray(lp, lp + ll), op); op += ll; lp += ll; }
      if (off > op - frameStart) fail("offset beyond frame start");
      let from = op - off;
      if (op + ml > out.length) fail("output overrun");
      if (off >= ml) out.copyWithin(op, from, from + ml);
      else for (let k = 0; k < ml; k++) out[op + k] = out[from + k];
      op += ml;
    }
    if (br.pos !== 0) fail("sequence bitstream not fully consumed (" + br.pos + ")");
    if (lp < litLen) { out.set(lits.subarray(lp, litLen), op); op += litLen - lp; }
    return op;
  }

  const api = { decompress, ZstdError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Zstd = api;
})(typeof self !== "undefined" ? self : this);
