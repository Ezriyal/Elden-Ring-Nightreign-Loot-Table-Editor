// ---------------------------------------------------------------------------
// core.js — Nightreign regulation.bin reader/patcher for loot rarity.
// Works in browsers (WebCrypto) and Node >= 20 (globalThis.crypto).
// ---------------------------------------------------------------------------
(function (root) {
  "use strict";
  const Zstd = (typeof module !== "undefined" && module.exports) ? require("./zstd.js") : root.Zstd;
  const ZstdWasm = (typeof module !== "undefined" && module.exports) ? require("./zstdwasm.js") : root.ZstdWasm;
  // Same packing as Smithbox / the files the game is known to accept:
  // libzstd level 15, 64 KiB window (so no block holds more than 64 KiB), no size or checksum field.
  const PACK = { level: 15, windowLog: 16 };
  const subtle = (root.crypto || globalThis.crypto).subtle;

  const NR_KEY = hexToBytes("9a8ee90c4c01a43168a17d9d75e4a7d02107ebcf43d5acb0554f941601b57918");
  const RARITY = ["Common", "Uncommon", "Rare", "Legendary"];
  const KIND_NAMES = { 1: "weapon", 2: "talisman", 3: "consumable" };

  function hexToBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  class RegError extends Error { }

  // ---------------- AES-256-CBC (no padding) via WebCrypto ----------------
  let keyPromise = null;
  function aesKey() {
    if (!keyPromise) keyPromise = subtle.importKey("raw", NR_KEY, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
    return keyPromise;
  }
  async function aesDecrypt(data) {
    const key = await aesKey();
    if (data.length < 32) throw new RegError("File is too small to be a regulation.bin.");
    const iv = data.slice(0, 16);
    let ct = data.subarray(16);
    if (ct.length % 16) { const t = new Uint8Array(ct.length + 16 - (ct.length % 16)); t.set(ct); ct = t; }
    // WebCrypto insists on PKCS#7: append a block that decrypts to a full padding block.
    const lastC = ct.slice(ct.length - 16);
    const pad = new Uint8Array(16).fill(16);
    const extra = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: lastC }, key, pad)).subarray(0, 16);
    const ct2 = new Uint8Array(ct.length + 16); ct2.set(ct); ct2.set(extra, ct.length);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, key, ct2));
  }
  async function aesEncrypt(plain) {
    const key = await aesKey();
    const iv = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(16));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, key, plain)); // + PKCS#7 block (like Smithbox output)
    const out = new Uint8Array(16 + ct.length); out.set(iv); out.set(ct, 16);
    return out;
  }

  // ---------------- DCX (ZSTD) ----------------
  function parseDCX(d) {
    const tag = String.fromCharCode(d[0], d[1], d[2], d[3]);
    if (tag !== "DCX\0") throw new RegError("This doesn't look like a Nightreign regulation.bin (decryption produced no DCX header). Make sure you picked regulation.bin from a Nightreign install or mod.");
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const fmt = String.fromCharCode(d[0x28], d[0x29], d[0x2A], d[0x2B]);
    if (fmt !== "ZSTD") throw new RegError(`Unsupported compression "${fmt}" — expected ZSTD (Nightreign).`);
    const hdrSize = dv.getUint32(0x14, false);
    const usize = dv.getUint32(0x1C, false), csize = dv.getUint32(0x20, false);
    const dataStart = hdrSize; // 0x4C
    return { header: d.slice(0, dataStart), usize, csize, payload: d.subarray(dataStart, dataStart + csize) };
  }
  function buildDCX(header, usize, comp) {
    const total = header.length + comp.length;
    const padded = (total + 15) & ~15;
    const out = new Uint8Array(padded);
    out.set(header); out.set(comp, header.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0x1C, usize, false);
    dv.setUint32(0x20, comp.length, false);
    return out;
  }

  // ---------------- BND4 ----------------
  function revBits(b) { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; }
  function readBND4(b) {
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "BND4") throw new RegError("Decompressed data is not a BND4 archive.");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b[9] !== 0) throw new RegError("Big-endian BND4 not supported.");
    const bitBig = !(b[10] !== 0);
    const count = dv.getInt32(0x0C, true);
    const version = String.fromCharCode(...b.subarray(0x18, 0x20)).replace(/\0+$/, "");
    const fhSize = Number(dv.getBigInt64(0x20, true));
    const unicode = b[0x30] !== 0;
    const raw = b[0x31];
    const reverse = bitBig || ((raw & 1) !== 0 && (raw & 0x80) === 0);
    const fmt = reverse ? raw : revBits(raw);
    const hasIds = !!(fmt & 2), hasNames = !!(fmt & 0xC), longOff = !!(fmt & 0x10), hasComp = !!(fmt & 0x20);
    const files = [];
    let p = 0x40;
    for (let i = 0; i < count; i++) {
      const flags = b[p];
      let q = p + 8;
      const size = Number(dv.getBigInt64(q, true)); q += 8;
      if (hasComp) q += 8;
      let off;
      if (longOff) { off = Number(dv.getBigInt64(q, true)); q += 8; } else { off = dv.getUint32(q, true); q += 4; }
      if (hasIds) q += 4;
      let name = "";
      if (hasNames) {
        const no = dv.getUint32(q, true); q += 4;
        if (unicode) { let e = no; while (b[e] || b[e + 1]) e += 2; name = new TextDecoder("utf-16le").decode(b.subarray(no, e)); }
        else { let e = no; while (b[e]) e++; name = new TextDecoder("latin1").decode(b.subarray(no, e)); }
      }
      if (flags & 0x01 && !(flags & 0x40)) { /* compressed entries are not used in regulation */ }
      files.push({ name, base: name.split(/[\\/]/).pop().replace(/\.param$/i, ""), offset: off, size, flags });
      p += fhSize;
    }
    return { version, files };
  }

  // ---------------- PARAM ----------------
  class ParamView {
    constructor(buf, offset, size, name) {
      this.buf = buf; this.base = offset; this.size = size; this.name = name;
      const dv = this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.rowCount = dv.getUint16(offset + 0x0A, true);
      this.dataVersion = dv.getInt16(offset + 0x08, true);
      const f2d = buf[offset + 0x2D];
      if (!(f2d & 0x04)) throw new RegError(`${name}: unexpected param format.`);
      let typeOff = 0;
      if (f2d & 0x80) {
        typeOff = Number(dv.getBigInt64(offset + 0x10, true));
        let e = offset + typeOff; while (buf[e]) e++;
        this.paramType = new TextDecoder("latin1").decode(buf.subarray(offset + typeOff, e));
      } else {
        let e = offset + 0x0C; while (buf[e] && e < offset + 0x2C) e++;
        this.paramType = new TextDecoder("latin1").decode(buf.subarray(offset + 0x0C, e));
      }
      const n = this.rowCount;
      this.ids = new Int32Array(n);
      this.offs = new Float64Array(n); // absolute offsets into buf
      for (let i = 0; i < n; i++) {
        const h = offset + 0x40 + i * 0x18;
        this.ids[i] = dv.getInt32(h, true);
        this.offs[i] = offset + Number(dv.getBigInt64(h + 8, true));
      }
      if (n > 1) this.rowSize = this.offs[1] - this.offs[0];
      else if (n === 1 && typeOff) this.rowSize = offset + typeOff - this.offs[0];
      else this.rowSize = 0;
    }
    u8(i, o) { return this.buf[this.offs[i] + o]; }
    u16(i, o) { return this.dv.getUint16(this.offs[i] + o, true); }
    s32(i, o) { return this.dv.getInt32(this.offs[i] + o, true); }
    u32(i, o) { return this.dv.getUint32(this.offs[i] + o, true); }
  }

  const LAYOUT = {
    ItemTableParam: { type: "ITEMTABLE_PARAM_ST", sizes: [36, 32] },
    ItemLotParam_enemy: { type: "ITEMLOT_PARAM_ST", sizes: [224, 216] },
    ItemLotParam_map: { type: "ITEMLOT_PARAM_ST", sizes: [224, 216] },
    EquipParamCustomWeapon: { type: "EQUIP_PARAM_CUSTOM_WEAPON_ST", sizes: [48] },
    EquipParamWeapon: { type: "EQUIP_PARAM_WEAPON_ST", sizes: [680] },
    EquipParamAccessory: { type: "EQUIP_PARAM_ACCESSORY_ST", sizes: [64] },
    EquipParamGoods: { type: "EQUIP_PARAM_GOODS_ST", sizes: [224] },
  };
  // field offsets
  const IT = { cat: 4, id: 8, w: 12, cls: 15 };
  const LOT = { id: 0, cat: 32, w: 64, cumul: 80, flag: 96, num: 138, bits: 146, actA: 152, actB: 184 };
  const OFF_CW_TARGET = 4, OFF_W_RARITY = 576, OFF_ACC_RARITY = 27, OFF_GOODS_RARITY = 120;

  // ---------------- load ----------------
  async function sha256Hex(bytes) {
    const h = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  async function loadRegulation(fileBytes, onStep) {
    const step = onStep || (() => { });
    step("Decrypting");
    const hash = await sha256Hex(fileBytes);
    const plain = await aesDecrypt(fileBytes);
    const dcx = parseDCX(plain);
    step("Decompressing");
    await new Promise((r) => setTimeout(r, 0));
    const bnd = Zstd.decompress(dcx.payload, dcx.usize);
    const { version, files } = readBND4(bnd);
    const params = {};
    for (const f of files) {
      if (LAYOUT[f.base]) params[f.base] = new ParamView(bnd, f.offset, f.size, f.base);
    }
    for (const [name, lay] of Object.entries(LAYOUT)) {
      const p = params[name];
      if (!p) throw new RegError(`regulation.bin has no ${name} — is this really a Nightreign regulation?`);
      if (p.paramType !== lay.type) throw new RegError(`${name} has unexpected type ${p.paramType}.`);
      if (p.rowCount > 1 && !lay.sizes.includes(p.rowSize))
        throw new RegError(`${name} row size ${p.rowSize} isn't one this editor knows (${lay.sizes.join("/")}). The game version (${version}) is probably newer than this tool.`);
    }
    // sanity check rarity column
    const wp = params.EquipParamWeapon;
    let good = 0;
    for (let i = 0; i < wp.rowCount; i++) { const r = wp.u8(i, OFF_W_RARITY); if (r <= 3 || r === 9) good++; }
    if (good < wp.rowCount * 0.95) throw new RegError("EquipParamWeapon rarity values look wrong — unsupported game version.");
    step("Analyzing loot tables");
    await new Promise((r) => setTimeout(r, 0));
    const reg = { hash, version, versionLabel: versionLabel(version), dcxHeader: dcx.header, zstdHead: dcx.payload.slice(0, 6), bnd, files, params, fileSize: fileBytes.length };
    reg.model = analyze(reg);
    return reg;
  }

  function versionLabel(v) {
    if (!/^\d{8}$/.test(v)) return v;
    return `${v[0]}.${v.slice(1, 3)}.${v[3]}`;
  }

  // ---------------- analysis ----------------
  // kinds: 0 none, 1 weapon, 2 talisman, 3 goods, 4 relic, 5 armor, 6 broken
  // rarity buckets: 0..3 = C/U/R/L, 4 = unique(9), 5 = unknown
  const NK = 7, NR = 6, DN = NK * NR;
  function bucket(r) { return r === undefined || r === null ? 5 : (r <= 3 ? r : (r === 9 ? 4 : 5)); }

  function analyze(reg) {
    const P = reg.params;
    const wr = new Map();
    { const p = P.EquipParamWeapon; for (let i = 0; i < p.rowCount; i++) wr.set(p.ids[i], p.u8(i, OFF_W_RARITY)); }
    const cwt = new Map();
    { const p = P.EquipParamCustomWeapon; for (let i = 0; i < p.rowCount; i++) cwt.set(p.ids[i], p.s32(i, OFF_CW_TARGET)); }
    const accr = new Map();
    { const p = P.EquipParamAccessory; for (let i = 0; i < p.rowCount; i++) accr.set(p.ids[i], p.u8(i, OFF_ACC_RARITY)); }
    const goodsr = new Map();
    { const p = P.EquipParamGoods; for (let i = 0; i < p.rowCount; i++) goodsr.set(p.ids[i], p.u8(i, OFF_GOODS_RARITY)); }
    const weaponRarity = (id) => { let r = wr.get(id); if (r === undefined) r = wr.get(id - (id % 100)); return r; };

    // item tables
    const itp = P.ItemTableParam;
    const tables = new Map(); // id -> [rowIndex]
    for (let i = 0; i < itp.rowCount; i++) {
      const id = itp.ids[i];
      let a = tables.get(id); if (!a) { a = []; tables.set(id, a); } a.push(i);
    }
    const memo = new Map();
    const visiting = new Set();
    function leafDist(cat, id) {
      const d = new Float64Array(DN);
      switch (cat) {
        case 0: d[0 * NR + 5] = 1; break;
        case 6: { const t = cwt.get(id); d[1 * NR + bucket(t === undefined ? undefined : weaponRarity(t))] = 1; break; }
        case 2: d[1 * NR + bucket(weaponRarity(id))] = 1; break;
        case 4: d[2 * NR + bucket(accr.get(id))] = 1; break;
        case 1: d[3 * NR + bucket(goodsr.get(id))] = 1; break;
        case 5: d[4 * NR + 5] = 1; break;
        case 3: d[5 * NR + 5] = 1; break;
        case 7: return tableDist(id);
        default: d[6 * NR + 5] = 1;
      }
      return d;
    }
    function tableDist(tid) {
      const m = memo.get(tid); if (m) return m;
      const rows = tables.get(tid);
      const d = new Float64Array(DN);
      if (!rows || visiting.has(tid)) { d[6 * NR + 5] = 1; return d; }
      visiting.add(tid);
      let tot = 0;
      for (const i of rows) tot += itp.u16(i, IT.w);
      if (tot === 0) d[6 * NR + 5] = 1;
      else for (const i of rows) {
        const w = itp.u16(i, IT.w); if (!w) continue;
        const sub = leafDist(itp.s32(i, IT.cat), itp.s32(i, IT.id));
        const f = w / tot;
        for (let k = 0; k < DN; k++) if (sub[k]) d[k] += f * sub[k];
      }
      visiting.delete(tid);
      memo.set(tid, d);
      return d;
    }
    function pure(d) { // -> {kind, rarity} if single kind & single rarity 0..3
      for (let k = 1; k <= 3; k++) {
        for (let r = 0; r < 4; r++) if (d[k * NR + r] >= 0.99) return { kind: k, rarity: r };
      }
      return null;
    }

    // pure weapon pools (for unlocking missing rarities in lots)
    const pureTable = new Map();
    for (const tid of tables.keys()) {
      const pr = pure(tableDist(tid));
      if (pr && pr.kind === 1) pureTable.set(tid, pr.rarity);
    }
    const generic = [null, null, null, null];
    for (let r = 0; r < 4; r++) {
      const pref = 2000001 + r;
      if (pureTable.get(pref) === r && positiveTotal(pref)) { generic[r] = pref; continue; }
      let best = null, bestN = 0;
      for (const [tid, rr] of pureTable) {
        if (rr !== r) continue;
        let n = 0; for (const i of tables.get(tid)) if (itp.u16(i, IT.w)) n++;
        if (n > bestN) { bestN = n; best = tid; }
      }
      generic[r] = best;
    }
    function positiveTotal(tid) { const rows = tables.get(tid); if (!rows) return false; for (const i of rows) if (itp.u16(i, IT.w)) return true; return false; }

    const sites = [];
    // --- lots ---
    for (const [source, pname] of [["enemy", "ItemLotParam_enemy"], ["map", "ItemLotParam_map"]]) {
      const lp = P[pname];
      const hasAct = lp.rowSize >= 224;
      for (let i = 0; i < lp.rowCount; i++) {
        const slots = [];
        for (let k = 0; k < 8; k++) {
          slots.push({ k, id: lp.s32(i, LOT.id + 4 * k), cat: lp.s32(i, LOT.cat + 4 * k), w: lp.u16(i, LOT.w + 2 * k) });
        }
        const classes = slots.map((s) => {
          if (!s.w || s.cat === 0) return null;
          return pure(leafDist(s.cat, s.id));
        });
        for (let kind = 1; kind <= 3; kind++) {
          const comp = [0, 0, 0, 0];
          let n = 0;
          const ents = [];
          let allTables = true;
          let total = 0;
          slots.forEach((s, j) => {
            total += s.w;
            const c = classes[j];
            if (c && c.kind === kind) { comp[c.rarity] += s.w; n++; ents.push({ slot: s.k, w: s.w, r: c.rarity, cat: s.cat, id: s.id }); if (s.cat !== 7) allTables = false; }
          });
          const present = comp.filter((x) => x > 0).length;
          if (present === 0) continue;
          let unlock = null;
          if (kind === 1 && allTables) {
            const empty = slots.filter((s) => s.w === 0 && s.cat === 0 && s.id === 0).map((s) => s.k);
            const empty2 = slots.filter((s) => s.w === 0 && !(s.cat === 0 && s.id === 0)).map((s) => s.k);
            const free = empty.concat(empty2);
            unlock = {};
            for (let r = 0; r < 4; r++) {
              if (comp[r] > 0) continue;
              // sibling by id convention (last digit = rarity + 1), from the heaviest entry
              let src = null;
              const sorted = ents.slice().sort((a, b) => b.w - a.w);
              for (const e of sorted) {
                if (e.id % 10 !== e.r + 1) continue;
                const sib = e.id - (e.r + 1) + (r + 1);
                if (pureTable.get(sib) === r && positiveTotal(sib)) { src = { table: sib, from: e.slot, how: "sibling" }; break; }
              }
              if (!src && generic[r] !== null) src = { table: generic[r], from: sorted[0].slot, how: "general" };
              if (src) unlock[r] = src;
            }
            if (!free.length) unlock = null;
            else unlock.free = free;
          }
          if (present < 2 && !(unlock && Object.keys(unlock).some((k) => k !== "free"))) continue;
          const W = comp[0] + comp[1] + comp[2] + comp[3];
          sites.push({
            key: `${source}:${lp.ids[i]}:${kind}`, source, kind, param: pname, row: i, id: lp.ids[i],
            ents, comp, W, total, other: total - W, unlock, hasAct, single: present < 2,
          });
        }
      }
    }
    // --- item tables (rescale only) ---
    for (const [tid, rows] of tables) {
      const items = rows.map((i) => ({ i, w: itp.u16(i, IT.w), cat: itp.s32(i, IT.cat), id: itp.s32(i, IT.id) }));
      const classes = items.map((e) => (!e.w || e.cat === 0) ? null : pure(leafDist(e.cat, e.id)));
      for (let kind = 1; kind <= 3; kind++) {
        const comp = [0, 0, 0, 0];
        const ents = [];
        let total = 0;
        items.forEach((e, j) => {
          total += e.w;
          const c = classes[j];
          if (c && c.kind === kind) { comp[c.rarity] += e.w; ents.push({ row: e.i, w: e.w, r: c.rarity, cat: e.cat, id: e.id }); }
        });
        const present = comp.filter((x) => x > 0).length;
        if (present < 2) continue;
        const W = comp[0] + comp[1] + comp[2] + comp[3];
        sites.push({ key: `table:${tid}:${kind}`, source: "table", kind, param: "ItemTableParam", id: tid, ents, comp, W, total, other: total - W, unlock: null, single: false });
      }
    }
    // --- groups ---
    const groups = new Map();
    for (const s of sites) {
      s.pct = s.comp.map((c) => (s.W ? (100 * c) / s.W : 0));
      s.sig = sigOf(s.pct);
      const gk = `${s.source}|${s.kind}|${s.sig}`;
      s.group = gk;
      let g = groups.get(gk);
      if (!g) { g = { key: gk, source: s.source, kind: s.kind, sig: s.sig, sites: [] }; groups.set(gk, g); }
      g.sites.push(s);
    }
    for (const g of groups.values()) {
      const avg = [0, 0, 0, 0];
      let unlockable = [0, 0, 0, 0];
      let otherAvg = 0;
      for (const s of g.sites) {
        for (let r = 0; r < 4; r++) avg[r] += s.pct[r] / g.sites.length;
        otherAvg += (s.total ? s.other / s.total : 0) / g.sites.length;
        if (s.unlock) for (let r = 0; r < 4; r++) if (s.unlock[r]) unlockable[r]++;
      }
      g.avg = avg; g.otherAvg = otherAvg; g.unlockable = unlockable;
      g.present = [0, 1, 2, 3].map((r) => g.sites.filter((s) => s.comp[r] > 0).length);
      g.tier = avg[1] / 100 + 2 * avg[2] / 100 + 3 * avg[3] / 100;
    }
    const sortedGroups = [...groups.values()].sort((a, b) => a.source.localeCompare(b.source) || a.kind - b.kind || a.tier - b.tier || b.sites.length - a.sites.length);

    // stats
    let modWeapons = 0;
    const stats = {
      weapons: P.EquipParamWeapon.rowCount, customWeapons: P.EquipParamCustomWeapon.rowCount,
      itemTables: tables.size, lotsEnemy: P.ItemLotParam_enemy.rowCount, lotsMap: P.ItemLotParam_map.rowCount,
      sites: sites.length, groups: sortedGroups.length,
      weaponsByRarity: [0, 0, 0, 0].map((_, r) => { let n = 0; for (const v of wr.values()) if (v === r) n++; return n; }),
      customByRarity: [0, 0, 0, 0].map((_, r) => { let n = 0; for (const t of cwt.values()) if (weaponRarity(t) === r) n++; return n; }),
    };
    return { sites, groups: sortedGroups, groupMap: groups, generic, stats };
  }

  function sigOf(pct) {
    let s = "";
    for (let r = 0; r < 4; r++) if (pct[r] > 0) s += "CURL"[r] + Math.round(pct[r]);
    return s;
  }

  // ---------------- planning & patching ----------------
  // rule: {mode:'keep'|'percent'|'scale', pct:[4], mul:[4], unlock:bool}
  function largestRemainder(reals, total) {
    const fl = reals.map(Math.floor);
    let rem = total - fl.reduce((a, b) => a + b, 0);
    const order = reals.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; k < order.length && rem > 0; k++, rem--) fl[order[k][1]]++;
    return fl;
  }

  function planSite(site, rule) {
    if (!rule || rule.mode === "keep") return null;
    const comp = site.comp;
    const avail = [false, false, false, false];
    const unlockUse = {};
    let target = [0, 0, 0, 0];
    if (rule.mode === "percent") {
      for (let r = 0; r < 4; r++) avail[r] = comp[r] > 0;
      if (rule.unlock && site.unlock) {
        const free = site.unlock.free.slice();
        // unlock most-wanted rarities first
        const want = [0, 1, 2, 3].filter((r) => !avail[r] && site.unlock[r] && rule.pct[r] > 0).sort((a, b) => rule.pct[b] - rule.pct[a]);
        for (const r of want) { if (!free.length) break; unlockUse[r] = { slot: free.shift(), src: site.unlock[r] }; avail[r] = true; }
      }
      for (let r = 0; r < 4; r++) target[r] = avail[r] ? Math.max(0, +rule.pct[r] || 0) : 0;
    } else if (rule.mode === "scale") {
      for (let r = 0; r < 4; r++) target[r] = comp[r] * Math.max(0, +rule.mul[r] || 0);
    }
    const ts = target.reduce((a, b) => a + b, 0);
    if (!(ts > 0)) return null;
    target = target.map((t) => t / ts);
    const W = site.W;
    const perR = largestRemainder(target.map((t) => t * W), W);
    // distribute within rarity
    const newW = new Map(); // ent index -> weight
    for (let r = 0; r < 4; r++) {
      const es = site.ents.map((e, idx) => [e, idx]).filter(([e]) => e.r === r);
      if (!es.length) continue;
      const sum = es.reduce((a, [e]) => a + e.w, 0);
      const shares = largestRemainder(es.map(([e]) => (perR[r] * e.w) / sum), perR[r]);
      es.forEach(([e, idx], j) => newW.set(idx, shares[j]));
    }
    const adds = [];
    for (const [r, u] of Object.entries(unlockUse)) { if (perR[r] > 0) adds.push({ r: +r, slot: u.slot, src: u.src, w: perR[r] }); }
    let changed = adds.length > 0;
    for (const [idx, w] of newW) if (site.ents[idx].w !== w) changed = true;
    if (!changed) return null;
    const newComp = [0, 0, 0, 0];
    site.ents.forEach((e, idx) => { newComp[e.r] += newW.get(idx); });
    for (const a of adds) newComp[a.r] += a.w;
    return { site, newW, adds, newComp, newPct: newComp.map((c) => (100 * c) / W) };
  }

  function categoryOf(site) { return site.kind === 1 ? "weapon-" + site.source : (site.kind === 2 ? "talisman" : "consumable"); }
  function ruleFor(settings, site) {
    if (!settings) return null;
    return (settings.sites && settings.sites[site.key]) || (settings.groups && settings.groups[site.group]) ||
      (settings.categories && settings.categories[categoryOf(site)]) || null;
  }

  function planAll(reg, settings) {
    const plans = [];
    for (const s of reg.model.sites) { const p = planSite(s, ruleFor(settings, s)); if (p) plans.push(p); }
    return plans;
  }

  function applyPlans(reg, plans) {
    const buf = reg.bnd.slice();
    const dv = new DataView(buf.buffer);
    const touched = [];
    for (const pl of plans) {
      const s = pl.site;
      const P = reg.params[s.param];
      if (s.source === "table") {
        pl.newW.forEach((w, idx) => { const off = P.offs[s.ents[idx].row] + IT.w; dv.setUint16(off, w, true); touched.push([off, 2]); });
      } else {
        const base = P.offs[s.row];
        pl.newW.forEach((w, idx) => { const off = base + LOT.w + 2 * s.ents[idx].slot; dv.setUint16(off, w, true); touched.push([off, 2]); });
        for (const a of pl.adds) {
          const k = a.slot, f = a.src.from;
          dv.setInt32(base + LOT.id + 4 * k, a.src.table, true);
          dv.setInt32(base + LOT.cat + 4 * k, 7, true);
          dv.setUint16(base + LOT.w + 2 * k, a.w, true);
          dv.setUint16(base + LOT.cumul + 2 * k, dv.getUint16(base + LOT.cumul + 2 * f, true), true);
          dv.setUint32(base + LOT.flag + 4 * k, 0, true);
          buf[base + LOT.num + k] = buf[base + LOT.num + f] || 1;
          let bits = dv.getUint16(base + LOT.bits, true);
          const luck = (bits >> f) & 1, reset = (bits >> (8 + f)) & 1;
          bits = (bits & ~(1 << k) & ~(1 << (8 + k))) | (luck << k) | (reset << (8 + k));
          dv.setUint16(base + LOT.bits, bits, true);
          if (s.hasAct) {
            dv.setInt32(base + LOT.actA + 4 * k, dv.getInt32(base + LOT.actA + 4 * f, true), true);
            dv.setInt32(base + LOT.actB + 4 * k, dv.getInt32(base + LOT.actB + 4 * f, true), true);
          }
          touched.push([base, P.rowSize]);
        }
      }
    }
    return { buf, touched };
  }

  async function buildRegulation(reg, settings, onProgress) {
    const prog = onProgress || (() => { });
    const plans = planAll(reg, settings);
    const { buf } = applyPlans(reg, plans);
    prog("Compressing", 0);
    const comp = await ZstdWasm.compress(buf, PACK, (p) => prog("Compressing", p));
    const dcx = buildDCX(reg.dcxHeader, buf.length, comp);
    dcx[0x30] = PACK.level; // DCP compression level field, as Smithbox writes it
    prog("Encrypting", 1);
    const enc = await aesEncrypt(dcx);
    // verify round trip
    prog("Verifying", 1);
    const back = await aesDecrypt(enc);
    const d2 = parseDCX(back);
    const bnd2 = Zstd.decompress(d2.payload, d2.usize);
    if (bnd2.length !== buf.length) throw new RegError("Verification failed (size).");
    for (let i = 0; i < buf.length; i++) if (bnd2[i] !== buf[i]) throw new RegError("Verification failed (content).");
    const out = { bytes: enc, plans, rowsChanged: plans.length, sha256: await sha256Hex(enc) };
    return out;
  }

  const api = { categoryOf, ruleFor, loadRegulation, analyze, planSite, planAll, applyPlans, buildRegulation, aesDecrypt, aesEncrypt, parseDCX, buildDCX, readBND4, ParamView, RARITY, KIND_NAMES, RegError, sha256Hex, LOT, IT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LootCore = api;
})(typeof self !== "undefined" ? self : this);
