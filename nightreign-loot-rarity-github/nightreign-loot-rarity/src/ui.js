(function () {
  "use strict";
  const C = window.LootCore;
  const $ = (s, el) => (el || document).querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style") el.setAttribute("style", v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const R = ["Common", "Uncommon", "Rare", "Legendary"];
  const STORE = "nrLootRarity.settings.v1";
  const BUILT = "nrLootRarity.built.v1";
  const fmtN = (n) => Number(n).toLocaleString("en-US");
  function fmtP(v) { if (v > 0 && v < 1) return v.toFixed(1); if (v > 99 && v < 100) return v.toFixed(1); return String(Math.round(v)); }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { } }
  function load(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  const CATS = [
    { key: "weapon-enemy", title: "Enemy and boss drops", desc: "Weapons rolled when enemies and bosses drop loot.", unlock: true, hero: true },
    { key: "weapon-map", title: "Chests and world loot", desc: "Weapons from chests, item pickups and location rewards.", unlock: true, hero: true },
    { key: "weapon-table", title: "Weapon pools", desc: "Rarity rolls inside a loot table after it has been picked, such as shields, staves and seals.", unlock: false },
    { key: "talisman", title: "Talismans", desc: "Talisman rewards that roll a rarity.", unlock: false },
    { key: "consumable", title: "Consumables", desc: "Item tables where consumables of different rarities compete.", unlock: false },
  ];
  const PRESETS = [
    { name: "Original odds", apply: () => ({}) },
    { name: "Better odds", apply: () => ({ "weapon-enemy": { mode: "scale", mul: [0.5, 1, 2, 3] }, "weapon-map": { mode: "scale", mul: [0.5, 1, 2, 3] }, "weapon-table": { mode: "scale", mul: [0.5, 1, 2, 3] }, "talisman": { mode: "scale", mul: [1, 1, 2, 1] } }) },
    { name: "Rare and up", apply: () => ({ "weapon-enemy": { mode: "percent", pct: [0, 20, 60, 20], unlock: true }, "weapon-map": { mode: "percent", pct: [0, 20, 60, 20], unlock: true }, "weapon-table": { mode: "percent", pct: [0, 25, 75, 0] } }) },
    { name: "Mostly legendary", apply: () => ({ "weapon-enemy": { mode: "percent", pct: [0, 0, 40, 60], unlock: true }, "weapon-map": { mode: "percent", pct: [0, 0, 40, 60], unlock: true }, "weapon-table": { mode: "percent", pct: [0, 0, 100, 0] } }) },
  ];

  const state = { reg: null, fileName: "", settings: blank(), plans: [], planBy: new Map(), built: null, views: [], cats: [] };
  function blank() { return { format: "nr-loot-rarity", version: 1, categories: {}, groups: {}, sites: {} }; }

  // ---------------- open file ----------------
  const fileInput = $("#file"), drop = $("#drop");
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  function showError(msg) { const el = $("#error"); el.textContent = msg; el.hidden = !msg; }
  async function openFile(file) {
    showError("");
    const loading = $("#loading");
    if (!window.crypto || !window.crypto.subtle) { showError("This browser blocked the decryption feature the editor needs. Open the editor in Chrome, Edge or Firefox."); return; }
    try {
      loading.textContent = "Reading " + file.name + "…";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const reg = await C.loadRegulation(bytes, (s) => { loading.textContent = s + "…"; });
      state.reg = reg; state.fileName = file.name; state.built = null;
      const saved = load(STORE);
      state.settings = saved && saved.format === "nr-loot-rarity" ? Object.assign(blank(), saved) : blank();
      loading.textContent = "";
      $("#open").hidden = true; $("#app").hidden = false;
      const built = load(BUILT) || [];
      const ours = built.includes(reg.hash) || (reg.zstdHead && reg.zstdHead[4] === 0 && reg.zstdHead[5] === 0x68);
      $("#builtNotice").hidden = !ours;
      renderAll();
    } catch (e) {
      loading.textContent = "";
      console.error(e);
      showError((e && e.message ? e.message : String(e)));
    }
  }

  // ---------------- rendering ----------------
  function siteName(s) {
    const map = s.source === "enemy" ? NAMES.e : s.source === "map" ? NAMES.m : NAMES.t;
    const n = map[s.id];
    if (n) return n;
    return (s.source === "table" ? "Item table " : s.source === "enemy" ? "Enemy lot " : "Map lot ") + s.id;
  }
  function avgOf(sites, after) {
    const a = [0, 0, 0, 0];
    if (!sites.length) return a;
    for (const s of sites) {
      const p = after ? ((state.planBy.get(s.key) || {}).newPct || s.pct) : s.pct;
      for (let r = 0; r < 4; r++) a[r] += p[r] / sites.length;
    }
    return a;
  }
  function round100(v) {
    const t = v.reduce((a, b) => a + b, 0) || 1;
    const raw = v.map((x) => (100 * x) / t);
    const fl = raw.map(Math.floor);
    let rem = 100 - fl.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rem > 0) { fl[i]++; rem--; } });
    return fl;
  }
  function barEl(cls) { return h("div", { class: "bar " + cls, role: "img" }, h("i"), h("i"), h("i"), h("i")); }
  function setBar(el, pct) {
    const is = el.children;
    for (let r = 0; r < 4; r++) is[r].style.width = Math.max(0, pct[r]) + "%";
    el.setAttribute("aria-label", R.map((n, r) => `${n} ${fmtP(pct[r])}%`).join(", "));
  }
  function numsEl() { return h("div", { class: "mixnums" }); }
  function setNums(el, before, after) {
    el.textContent = "";
    for (let r = 0; r < 4; r++) {
      const changed = Math.abs(before[r] - after[r]) >= 0.05;
      if (before[r] < 0.05 && after[r] < 0.05) continue;
      el.append(h("span", null, h("b", { class: "r" + r }, R[r] + " "), changed ? `${fmtP(before[r])}% to ${fmtP(after[r])}%` : `${fmtP(after[r])}%`));
    }
  }

  function renderAll() {
    const reg = state.reg, m = reg.model;
    // file state
    const fs = $("#filestate");
    fs.hidden = false; fs.textContent = "";
    fs.append(h("strong", { text: state.fileName }), `Game data ${reg.versionLabel}`, h("div", { class: "again" }, h("button", { class: "btn small", onclick: () => { $("#open").hidden = false; $("#app").hidden = true; fs.hidden = true; } }, "Open another file")));
    // stats
    const st = $("#stats"); st.textContent = "";
    const rows = [["Game data version", reg.versionLabel], ["Base weapons", fmtN(m.stats.weapons)], ["Weapon variants", fmtN(m.stats.customWeapons)], ["Loot tables that roll rarity", fmtN(m.stats.sites)]];
    for (const [a, b] of rows) st.append(h("span", { text: a }), h("b", { text: b }));
    // categories
    state.views = [];
    state.cats = CATS.map((c) => ({ ...c, sites: m.sites.filter((s) => C.categoryOf(s) === c.key), groups: m.groups.filter((g) => C.categoryOf(g.sites[0]) === c.key) })).filter((c) => c.sites.length);
    renderHero();
    const src = $("#sources");
    src.textContent = "";
    const pre = h("div", { class: "presets" }, h("span", { text: "Quick start:" }));
    for (const p of PRESETS) pre.append(h("button", { class: "btn small", onclick: () => applyPreset(p) }, p.name));
    src.append(pre);
    for (const cat of state.cats) src.append(renderCategory(cat));
    recompute();
  }

  function renderHero() {
    const beams = $("#beams"); beams.textContent = "";
    const heroSites = state.cats.filter((c) => c.hero).flatMap((c) => c.sites);
    $("#heroText").textContent = `Average chance of each rarity when a weapon drops, across ${fmtN(heroSites.length)} enemy, boss and world loot tables.`;
    const els = [];
    for (let r = 0; r < 4; r++) {
      const ghost = h("div", { class: "ghost" }), light = h("div", { class: "light" });
      const pct = h("div", { class: "pct" }), was = h("div", { class: "was" });
      beams.append(h("div", { class: "beam", style: `--col: var(--c${r})` }, h("div", { class: "pillar" }, ghost, light), pct, was, h("div", { class: "nm", text: R[r] })));
      els.push({ ghost, light, pct, was });
    }
    state.views.push(() => {
      const b = avgOf(heroSites, false), a = avgOf(heroSites, true);
      const top = Math.max(...b, ...a, 1);
      for (let r = 0; r < 4; r++) {
        els[r].ghost.style.height = (100 * b[r]) / top + "%";
        els[r].light.style.height = (100 * a[r]) / top + "%";
        els[r].pct.textContent = fmtP(a[r]) + "%";
        els[r].was.textContent = Math.abs(a[r] - b[r]) >= 0.05 ? `was ${fmtP(b[r])}%` : "";
      }
    });
  }

  // a rule editor. level: cat | group | site
  function ruleEditor(opts) {
    const { level, getRule, setRule, base, unlockable, sites } = opts;
    const box = h("div", { class: "ctrl" });
    const modeList = level === "cat" ? [["keep", "Keep"], ["percent", "Set %"], ["scale", "Scale"]]
      : [["inherit", level === "group" ? "Same as above" : "Same as group"], ["keep", "Keep"], ["percent", "Set %"], ["scale", "Scale"]];
    const modes = h("div", { class: "modes", role: "group", "aria-label": "How to change this" });
    const mbtns = modeList.map(([k, label]) => {
      const b = h("button", { type: "button", "aria-pressed": "false", onclick: () => setMode(k) }, label);
      modes.append(b); return [k, b];
    });
    const vals = h("div", { class: "vals" });
    const inputs = [];
    for (let r = 0; r < 4; r++) {
      const id = "in" + Math.random().toString(36).slice(2);
      const inp = h("input", { id, type: "number", min: "0", step: "1", inputmode: "decimal" });
      const unit = h("span", { class: "unit" });
      inp.addEventListener("input", () => {
        const rule = getRule(); if (!rule) return;
        const v = Math.max(0, parseFloat(inp.value));
        const val = isFinite(v) ? v : 0;
        if (rule.mode === "percent") rule.pct[r] = val; else if (rule.mode === "scale") rule.mul[r] = val;
        setRule(rule); scheduleRecompute();
      });
      const wrap = h("div", { class: "val" }, h("label", { for: id, class: "r" + r, text: R[r] }), inp, unit);
      vals.append(wrap); inputs.push({ inp, unit, wrap });
    }
    let unlockBox = null, unlockInput = null;
    if (unlockable) {
      unlockInput = h("input", { type: "checkbox" });
      unlockInput.addEventListener("change", () => { const rule = getRule(); if (!rule) return; rule.unlock = unlockInput.checked; setRule(rule); scheduleRecompute(); });
      unlockBox = h("label", { class: "unlock" }, unlockInput, "Add rarities a table never had");
    }
    const hint = h("p", { class: "hint" });
    box.append(modes, vals);
    if (unlockBox) box.append(unlockBox);
    const outer = h("div", null, box, hint);

    function current() { return getRule(); }
    function setMode(k) {
      if (k === "inherit") { setRule(null); }
      else {
        const prev = getRule();
        const avg = round100(base());
        const rule = prev ? { ...prev, pct: prev.pct ? prev.pct.slice() : avg, mul: prev.mul ? prev.mul.slice() : [1, 1, 1, 1] } : { mode: k, pct: avg, mul: [1, 1, 1, 1], unlock: true };
        if (k === "percent" && (!prev || prev.mode !== "percent")) rule.pct = avg;
        rule.mode = k;
        if (rule.unlock === undefined) rule.unlock = true;
        setRule(rule);
      }
      refresh(); scheduleRecompute();
    }
    function refresh() {
      const rule = current();
      const mode = rule ? rule.mode : (level === "cat" ? "keep" : "inherit");
      for (const [k, b] of mbtns) b.setAttribute("aria-pressed", String(k === mode));
      const avg = base();
      const activeMode = !!(rule && (rule.mode === "percent" || rule.mode === "scale"));
      vals.hidden = !activeMode;
      inputs.forEach(({ inp, unit, wrap }, r) => {
        const active = activeMode;
        inp.disabled = !active;
        wrap.classList.toggle("off", !active);
        if (rule && rule.mode === "percent") { if (document.activeElement !== inp) inp.value = +(+rule.pct[r]).toFixed(2); unit.textContent = "%"; inp.step = "1"; }
        else if (rule && rule.mode === "scale") { if (document.activeElement !== inp) inp.value = +(+rule.mul[r]).toFixed(2); unit.textContent = "×"; inp.step = "0.1"; }
        else { inp.value = fmtP(avg[r]); unit.textContent = "%"; }
      });
      if (unlockBox) {
        unlockBox.hidden = !(rule && rule.mode === "percent");
        unlockInput.checked = !!(rule && rule.unlock);
      }
      updateHint();
    }
    function updateHint() {
      const rule = current();
      hint.textContent = ""; hint.className = "hint";
      if (!rule) return;
      if (rule.mode === "percent") {
        const sum = rule.pct.reduce((a, b) => a + (+b || 0), 0);
        const parts = [];
        if (Math.abs(sum - 100) > 0.01) parts.push(sum > 0 ? `These add up to ${fmtP(sum)}%, so they're used as proportions.` : "Set at least one rarity above 0.");
        const ss = sites();
        const missing = [];
        for (let r = 0; r < 4; r++) {
          if (!(rule.pct[r] > 0)) continue;
          let n = 0;
          for (const s of ss) {
            const ok = s.comp[r] > 0 || (rule.unlock && s.unlock && s.unlock[r] && s.unlock.free && s.unlock.free.length);
            if (!ok) n++;
          }
          if (n) missing.push(`${R[r]} can't appear in ${fmtN(n)} of ${fmtN(ss.length)}`);
        }
        if (missing.length) {
          parts.push(missing.join("; ") + " tables" + (unlockBox && !rule.unlock ? ". Turn on “Add rarities a table never had” to include them." : ", so their share goes to the other rarities."));
          hint.classList.add("warn");
        }
        hint.textContent = parts.join(" ");
      } else if (rule.mode === "scale") {
        hint.textContent = "Multiplies each rarity's weight in every table. Tables keep their own balance, and rarities a table doesn't have stay at 0.";
      } else if (rule.mode === "keep" && level !== "cat") {
        hint.textContent = "These tables stay as they are.";
      }
    }
    state.views.push(refresh);
    refresh();
    return outer;
  }

  function renderCategory(cat) {
    const sec = h("section", { class: "source" });
    const head = h("div", { class: "source-head" },
      h("div", null, h("h3", { text: cat.title }), h("p", { class: "desc", text: cat.desc })),
      h("div", { class: "count", text: `${fmtN(cat.sites.length)} loot tables` }));
    const before = barEl("before"), after = barEl("after"), nums = numsEl();
    const mix = h("div", { class: "mix" }, h("span", { text: "Original" }), before, h("span", { text: "New" }), after, nums);
    state.views.push(() => { const b = avgOf(cat.sites, false), a = avgOf(cat.sites, true); setBar(before, b); setBar(after, a); setNums(nums, b, a); });
    const editor = ruleEditor({
      level: "cat", unlockable: cat.unlock,
      getRule: () => state.settings.categories[cat.key] || null,
      setRule: (r) => { if (r) state.settings.categories[cat.key] = r; else delete state.settings.categories[cat.key]; },
      base: () => avgOf(cat.sites, false), sites: () => cat.sites,
    });
    const more = h("details", { class: "more" }, h("summary", null, `Fine-tune the ${fmtN(cat.groups.length)} table types in this source`));
    let filled = false;
    more.addEventListener("toggle", () => {
      if (!more.open || filled) return;
      filled = true;
      const list = h("div", { class: "groups" });
      for (const g of cat.groups) list.append(renderGroup(cat, g));
      more.append(list);
      runViews();
    });
    sec.append(head, mix, editor, more);
    return sec;
  }

  function mixLabel(pct) {
    const parts = [];
    for (let r = 0; r < 4; r++) if (pct[r] > 0) parts.push(`${R[r]} ${fmtP(pct[r])}%`);
    return parts.join(", ");
  }

  function renderGroup(cat, g) {
    const el = h("div", { class: "group" });
    const names = [];
    for (const s of g.sites) { const n = (s.source === "enemy" ? NAMES.e : s.source === "map" ? NAMES.m : NAMES.t)[s.id]; if (n && !names.includes(n)) names.push(n); if (names.length >= 3) break; }
    const share = 100 * (1 - g.otherAvg);
    const metaBits = [];
    if (names.length) metaBits.push("Includes " + names.join(", ") + (g.sites.length > names.length ? " and more" : ""));
    if (share < 99.5) metaBits.push(`Weapons are ${fmtP(share)}% of what these tables drop; the rest stays unchanged`);
    const after = barEl("after"), nums = numsEl();
    state.views.push(() => { const b = avgOf(g.sites, false), a = avgOf(g.sites, true); setBar(after, a); setNums(nums, b, a); });
    const listBtn = h("button", { class: "btn quiet small", type: "button" }, `List ${fmtN(g.sites.length)} tables`);
    const head = h("div", { class: "ghead" },
      h("div", null, h("div", { class: "gtitle" }, mixLabel(g.avg), h("span", { class: "n", text: `${fmtN(g.sites.length)} ${g.sites.length === 1 ? "table" : "tables"}` })), metaBits.length ? h("div", { class: "gmeta", text: metaBits.join(". ") + "." }) : null),
      listBtn);
    const editor = ruleEditor({
      level: "group", unlockable: cat.unlock && g.sites.some((s) => s.unlock),
      getRule: () => state.settings.groups[g.key] || null,
      setRule: (r) => { if (r) state.settings.groups[g.key] = r; else delete state.settings.groups[g.key]; },
      base: () => avgOf(g.sites, false), sites: () => g.sites,
    });
    const sitesBox = h("div", { class: "sites", hidden: true });
    let filled = false;
    listBtn.addEventListener("click", () => {
      sitesBox.hidden = !sitesBox.hidden;
      listBtn.textContent = sitesBox.hidden ? `List ${fmtN(g.sites.length)} tables` : "Hide tables";
      if (!filled) { filled = true; for (const s of g.sites) sitesBox.append(renderSite(cat, s)); runViews(); }
    });
    el.append(head, h("div", { class: "mix" }, after, nums), editor, sitesBox);
    return el;
  }

  function renderSite(cat, s) {
    const row = h("div", { class: "site" });
    const bar = barEl("after");
    const txt = h("span", { class: "gmeta" });
    const editBtn = h("button", { class: "btn quiet small sedit", type: "button" }, "Edit");
    let editorEl = null;
    editBtn.addEventListener("click", () => {
      if (!editorEl) {
        editorEl = ruleEditor({
          level: "site", unlockable: !!s.unlock,
          getRule: () => state.settings.sites[s.key] || null,
          setRule: (r) => { if (r) state.settings.sites[s.key] = r; else delete state.settings.sites[s.key]; },
          base: () => s.pct, sites: () => [s],
        });
        row.append(editorEl);
        editBtn.textContent = "Close";
        runViews();
      } else { editorEl.hidden = !editorEl.hidden; editBtn.textContent = editorEl.hidden ? "Edit" : "Close"; }
    });
    const named = !!(s.source === "enemy" ? NAMES.e : s.source === "map" ? NAMES.m : NAMES.t)[s.id];
    row.append(h("div", { class: "sname", title: siteName(s) }, siteName(s), named ? h("span", { class: "sid", text: `#${s.id}` }) : null, h("div", null, txt)), bar, editBtn);
    state.views.push(() => {
      const p = state.planBy.get(s.key);
      const a = p ? p.newPct : s.pct;
      setBar(bar, a);
      txt.textContent = p ? `Was ${mixLabel(s.pct)}. Now ${mixLabel(a)}.` : mixLabel(s.pct);
    });
    return row;
  }

  // ---------------- recompute ----------------
  let timer = null;
  function scheduleRecompute() { clearTimeout(timer); timer = setTimeout(recompute, 90); }
  function runViews() { for (const v of state.views) v(); }
  function recompute() {
    if (!state.reg) return;
    state.plans = C.planAll(state.reg, state.settings);
    state.planBy = new Map(state.plans.map((p) => [p.site.key, p]));
    runViews();
    const n = state.plans.length, gained = state.plans.filter((p) => p.adds.length).length;
    $("#summary").textContent = n ? `${fmtN(n)} of ${fmtN(state.reg.model.sites.length)} loot tables will change.${gained ? ` ${fmtN(gained)} of them gain a rarity they never had.` : ""}` : "Nothing changed yet. Pick a quick start or set your own odds.";
    $("#buildBtn").disabled = !n;
    store(STORE, state.settings);
    if (state.built) {
      state.built = null;
      $("#saveBox").hidden = true;
      setStatus("Settings changed since the last build. Build again to save them.", "");
    }
  }
  function applyPreset(p) {
    const cats = p.apply();
    state.settings = blank();
    for (const [k, v] of Object.entries(cats)) state.settings.categories[k] = Object.assign({ pct: [25, 25, 25, 25], mul: [1, 1, 1, 1], unlock: true }, v);
    renderAll();
  }

  // ---------------- build & save ----------------
  function setStatus(text, cls) { const el = $("#buildStatus"); el.textContent = text; el.className = "status" + (cls ? " " + cls : ""); }
  $("#buildBtn").addEventListener("click", async () => {
    const btn = $("#buildBtn"), prog = $("#progress"), bar = prog.firstElementChild;
    btn.disabled = true; prog.hidden = false; bar.style.width = "0%"; $("#saveBox").hidden = true;
    try {
      const res = await C.buildRegulation(state.reg, state.settings, (stage, p) => {
        setStatus(stage === "Compressing" ? `Compressing ${Math.round(p * 100)}%` : stage + "…", "");
        bar.style.width = Math.round((stage === "Compressing" ? p * 0.9 : 0.95) * 100) + "%";
      });
      bar.style.width = "100%";
      state.built = res;
      setStatus(`Built and checked: ${(res.bytes.length / 1048576).toFixed(1)} MB, ${fmtN(res.rowsChanged)} loot tables changed.`, "good");
      $("#saveBox").hidden = false;
      $("#hash").textContent = "SHA-256 " + res.sha256;
      const built = load(BUILT) || []; built.push(res.sha256); store(BUILT, built.slice(-50));
    } catch (e) {
      console.error(e);
      setStatus("Build failed: " + (e && e.message ? e.message : e), "bad");
    } finally {
      btn.disabled = !state.plans.length;
      setTimeout(() => { prog.hidden = true; }, 600);
    }
  });
  $("#saveBtn").addEventListener("click", async () => {
    if (!state.built) return;
    const blob = new Blob([state.built.bytes], { type: "application/octet-stream" });
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: "regulation.bin", types: [{ description: "Nightreign regulation", accept: { "application/octet-stream": [".bin"] } }] });
        const w = await handle.createWritable(); await w.write(blob); await w.close();
        setStatus("Saved. Put it in your loot-rarity folder if you haven't already, then launch the game with ME3.", "good");
        return;
      } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = h("a", { href: URL.createObjectURL(blob), download: "regulation.bin" });
    document.body.append(a); a.click(); a.remove();
    setStatus("Downloaded regulation.bin. Move it into your loot-rarity folder, then launch the game with ME3.", "good");
  });

  // ---------------- settings files ----------------
  $("#saveSettings").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.settings, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "loot-rarity-settings.json" });
    document.body.append(a); a.click(); a.remove();
  });
  $("#loadSettingsFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (s.format !== "nr-loot-rarity") throw new Error("That file isn't a Loot rarity settings file.");
      state.settings = Object.assign(blank(), s);
      renderAll();
      setStatus("Settings loaded.", "good");
    } catch (err) { setStatus(err.message, "bad"); }
  });
  $("#resetAll").addEventListener("click", () => { state.settings = blank(); renderAll(); setStatus("All loot tables are back to their original odds.", ""); });
})();
