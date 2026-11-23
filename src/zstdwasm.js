// JS glue for nrzstd.wasm (libzstd 1.5.7 compressor). Works in browsers and Node.
(function (root) {
  "use strict";
  let wasmBytes = null; // set by setBinary (browser build embeds base64)
  function setBinary(bytes) { wasmBytes = bytes; }
  async function instantiate() {
    if (!wasmBytes) throw new Error("zstd module missing");
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return instance.exports;
  }
  // Compress like Smithbox / the game's own tools: one zstd frame, no content size, no checksum.
  async function compress(input, opts, onProgress) {
    const level = (opts && opts.level) || 15, windowLog = (opts && opts.windowLog) || 16;
    const ex = await instantiate();
    ex.nr_reset();
    const CH = 1 << 20, OUT = 2 << 20;
    const cctx = ex.nr_create(level, windowLog);
    if (!cctx) throw new Error("zstd: could not create compressor");
    if (ex.nr_is_error(ex.nr_pledge(cctx, BigInt(input.length)))) throw new Error("zstd: could not set size");
    const inPtr = ex.nr_alloc(CH), outPtr = ex.nr_alloc(OUT), posPtr = ex.nr_alloc(8);
    if (!inPtr || !outPtr || !posPtr) throw new Error("zstd: out of memory");
    const chunks = []; let total = 0;
    const mem = () => new Uint8Array(ex.memory.buffer);
    const u32 = () => new Uint32Array(ex.memory.buffer);
    function drain() {
      const n = u32()[(posPtr >> 2) + 1];
      if (n) { chunks.push(mem().slice(outPtr, outPtr + n)); total += n; u32()[(posPtr >> 2) + 1] = 0; }
    }
    function check(r) { if (ex.nr_is_error(r)) { const p = ex.nr_error_name(r); let s = ""; const m = mem(); for (let i = p; m[i]; i++) s += String.fromCharCode(m[i]); throw new Error("zstd: " + s); } return r; }
    for (let off = 0; off < input.length; off += CH) {
      const len = Math.min(CH, input.length - off);
      mem().set(input.subarray(off, off + len), inPtr);
      u32()[posPtr >> 2] = 0; u32()[(posPtr >> 2) + 1] = 0;
      do { check(ex.nr_stream(cctx, inPtr, len, outPtr, OUT, posPtr, 0)); drain(); } while (u32()[posPtr >> 2] < len);
      if (onProgress) { onProgress((off + len) / input.length); await new Promise((r) => setTimeout(r, 0)); }
    }
    let r;
    do { u32()[posPtr >> 2] = 0; r = check(ex.nr_stream(cctx, inPtr, 0, outPtr, OUT, posPtr, 1)); drain(); } while (r !== 0);
    const out = new Uint8Array(total); let q = 0; for (const c of chunks) { out.set(c, q); q += c.length; }
    return out;
  }
  async function version() { const ex = await instantiate(); const v = ex.nr_version(); return `${(v / 10000) | 0}.${((v / 100) | 0) % 100}.${v % 100}`; }
  const api = { setBinary, compress, version };
  if (typeof module !== "undefined" && module.exports) {
    try { wasmBytes = require("fs").readFileSync(require("path").join(__dirname, "nrzstd.wasm")); } catch (e) { }
    module.exports = api;
  } else root.ZstdWasm = api;
})(typeof self !== "undefined" ? self : this);
