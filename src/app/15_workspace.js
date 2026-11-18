/* ==========================================================================
   15 · WORKSPACE: several prediction files, one active at a time
   Every uploaded file is registered with DuckDB (read from disk on demand, so
   registering costs no memory). Only the ACTIVE file is materialised into the
   analysis tables; switching rebuilds the whole analysis from the selected file.
   Each file remembers its own column mapping and its own settings / filters /
   tab state, restored when you switch back.
   ========================================================================== */
const WS = { files: [], active: null, seq: 0 };
const wsFile = id => WS.files.find(f => f.id === id) || null;
const wsActive = () => wsFile(WS.active);
const colsSig = cols => cols.map(c => `${c.name}:${c.type}`).join('|');

/** Register one uploaded file: pin column types from a full scan, describe the columns. */
async function registerFile(file) {
  const id = ++WS.seq;
  const lower = file.name.toLowerCase();
  const isParquet = lower.endsWith('.parquet') || lower.endsWith('.pq');
  const reg = `f${id}` + (isParquet ? '.parquet' : lower.endsWith('.gz') ? '.csv.gz' : '.csv');
  try { await DB.db.dropFile(reg); } catch (_) { /* not registered */ }
  await DB.db.registerFileHandle(reg, file, DB.duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  // Types are inferred from the WHOLE file once, then pinned: a malformed value deep in the file makes that column
  // text (reported later as invalid rows) instead of aborting every scan with a conversion error.
  let reader = `read_parquet(${ql(reg)})`;
  if (!isParquet) {
    const sniff = await q(`DESCRIBE SELECT * FROM read_csv(${ql(reg)}, auto_detect=true, sample_size=-1)`);
    reader = `read_csv(${ql(reg)}, auto_detect=true, types={${sniff.map(c => `${ql(c.column_name)}: ${ql(c.column_type)}`).join(', ')}})`;
  }
  const desc = await q(`DESCRIBE SELECT * FROM ${reader}`);
  const cols = desc.map(d => ({ name: d.column_name, type: d.column_type }));
  const entry = { id, name: file.name, size: file.size, reg, reader, cols, sig: colsSig(cols), isDemo: false, mapping: null, saved: null, summary: null, error: null };
  WS.files.push(entry);
  return entry;
}

/** Point the `raw` view at a file and load its identity into S (used by mapping and build). */
async function useRaw(entry) {
  const t = await q(`SELECT table_type FROM information_schema.tables WHERE table_name = 'raw'`);
  if (t.length) await q(t[0].table_type === 'VIEW' ? 'DROP VIEW raw' : 'DROP TABLE raw');
  await q(`CREATE VIEW raw AS SELECT * FROM ${entry.reader}`);
  S.file = { id: entry.id, name: entry.name, size: entry.size, reg: entry.reg };
  S.isDemo = entry.isDemo;
  S.rawCols = entry.cols.slice();
}
/** Role guesses by column name (always confirmed by the user before first use). */
function autoRoles(cols) {
  const byLower = new Map(); for (const c of cols) { const l = c.name.toLowerCase(); if (!byLower.has(l)) byLower.set(l, c.name); }
  const roles = {};
  for (const r of ROLE_DEFS) { const hit = r.aliases.map(a => byLower.get(a)).find(Boolean); if (hit && !Object.values(roles).includes(hit)) roles[r.role] = hit; }
  return roles;
}

/** Upload screen: start a new workspace with one or more files. */
async function loadFiles(fileList) {
  const files = [...fileList]; if (!files.length) return;
  overlay.show(files.length > 1 ? `Opening ${files.length} files` : `Opening ${files[0].name}`);
  try {
    overlay.step(6, 'Starting the in-browser database engine…');
    await initDB();
    await resetAll();
    for (let k = 0; k < files.length; k++) {
      overlay.step(10 + Math.round(80 * k / files.length), `Reading ${files[k].name} (${k + 1} of ${files.length}, ${(files[k].size / 1e6).toFixed(1)} MB)…`);
      try { await registerFile(files[k]); }
      catch (e) { WS.files.push({ id: ++WS.seq, name: files[k].name, size: files[k].size, error: String(e.message || e), cols: [], sig: '' }); }
    }
    const first = WS.files.find(f => !f.error);
    overlay.hide();
    const bad = WS.files.filter(f => f.error);
    if (!first) { showUploadError(`None of the files could be read: ${bad.map(f => `${esc(f.name)} (${esc(f.error)})`).join('; ')}. Check that they are comma-separated CSVs (or Parquet) with a header row.`); return; }
    if (bad.length) toast(`${bad.length} file${bad.length > 1 ? 's' : ''} could not be read and ${bad.length > 1 ? 'were' : 'was'} skipped: ${bad.map(f => f.name).join(', ')}.`, 7000);
    WS.files = WS.files.filter(f => !f.error);
    await beginMapping(first, null);
  } catch (e) { overlay.hide(); showUploadError(`The file could not be read: ${esc(e.message || e)}. Check that it is a comma-separated CSV (or Parquet) with a header row.`); }
}

/** Add files to the current workspace (from the file switcher). */
async function addFiles(fileList) {
  const files = [...fileList]; if (!files.length) return;
  const added = [];
  await busy.wrap(async () => {
    for (const f of files) {
      try {
        const e = await registerFile(f);
        const twin = WS.files.find(x => x !== e && x.mapping && x.sig === e.sig);
        if (twin) e.mapping = cloneMapping(twin.mapping);   // identical columns: reuse the confirmed mapping
        added.push(e);
      } catch (err) { toast(`${f.name} could not be read: ${err.message || err}`, 7000); }
    }
  }, `Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
  if (added.length) { toast(`Added ${plural(added.length, 'file')}. Select one in the file switcher to analyse it.`); renderContext(); openFileMenu(); }
}
const cloneMapping = m => ({ roles: { ...m.roles }, posValues: m.posValues.slice(), negValues: m.negValues.slice(), probFromScore: m.probFromScore });

/**
 * Show the mapping screen for an entry. `returnTo` is the entry to go back to if the user cancels
 * (switching from inside the app); null on first upload.
 */
async function beginMapping(entry, returnTo) {
  WS.mappingFor = entry.id; WS.returnTo = returnTo ? returnTo.id : null;
  if (returnTo) WS.snapshot = { roles: { ...S.roles }, posValues: S.posValues, negValues: S.negValues, probFromScore: S.probFromScore, rawCols: S.rawCols, file: S.file, isDemo: S.isDemo };
  await useRaw(entry);
  if (entry.mapping) { S.roles = { ...entry.mapping.roles }; S.posValues = entry.mapping.posValues.slice(); S.negValues = entry.mapping.negValues.slice(); S.probFromScore = entry.mapping.probFromScore; }
  else { S.roles = autoRoles(entry.cols); S.posValues = null; S.negValues = null; S.probFromScore = false; }
  $('#app').classList.add('hidden'); $('#onboard').classList.remove('hidden');
  await showMapping();
}
/** Cancel a mapping started from the app: restore the active file untouched. */
async function cancelMapping() {
  const back = wsFile(WS.returnTo);
  if (!back) return false;
  const s = WS.snapshot;
  await useRaw(back);
  Object.assign(S, { roles: s.roles, posValues: s.posValues, negValues: s.negValues, probFromScore: s.probFromScore, rawCols: s.rawCols, file: s.file, isDemo: s.isDemo });
  WS.mappingFor = null; WS.returnTo = null;
  $('#mapping-panel').classList.add('hidden'); $('#onboard').classList.add('hidden'); $('#app').classList.remove('hidden');
  return true;
}
/** Called by the mapping screen once the user confirms: remember the mapping, share it with identical files, build. */
async function confirmMapping(shareWithTwins) {
  const entry = wsFile(WS.mappingFor);   // the file being left had its state captured by switchFile
  entry.mapping = { roles: { ...S.roles }, posValues: S.posValues.slice(), negValues: S.negValues.slice(), probFromScore: S.probFromScore };
  if (shareWithTwins) for (const f of WS.files) if (f !== entry && !f.mapping && f.sig === entry.sig) f.mapping = cloneMapping(entry.mapping);
  WS.mappingFor = null; WS.returnTo = null;
  await activate(entry, true);
}

/** Capture the active file's analysis state so switching back restores it. */
function captureState() {
  return { settings: { ...S.settings }, filters: S.filters.map(f => ({ ...f, vals: f.vals ? f.vals.slice() : undefined })), cohorts: S.cohorts.slice(), eval: { ...S.eval }, ui: S.ui };
}
/** Applied inside buildData, after the defaults are known and before the population is computed. */
function restoreSaved() {
  const e = wsActive(); const sv = e && e.saved; if (!sv) return;
  const st = S.info.st, set = { ...S.settings, ...sv.settings };
  if (!(set.d0 >= st.dmin && set.d0 <= st.dmax)) set.d0 = st.dmin;
  if (!(set.d1 >= st.dmin && set.d1 <= st.dmax)) set.d1 = st.dmax;
  if (set.split !== null && !S.splitValues.includes(set.split)) set.split = S.settings.split;
  S.settings = set;
  S.filters = (sv.filters || []).filter(f => S.disc.features.some(x => x.name === f.col));
  S.cohorts = sv.cohorts || [];
  S.eval = { ...S.eval, ...sv.eval };
  S.ui = sv.ui || {};
}

/** Make an entry the active file: rebuild every analysis table from it. */
async function activate(entry, fresh = false) {
  const prev = wsActive();
  if (!fresh && prev && prev !== entry) prev.saved = captureState();
  WS.active = entry.id;
  if (!fresh) {
    await useRaw(entry);
    const m = entry.mapping;
    S.roles = { ...m.roles }; S.posValues = m.posValues.slice(); S.negValues = m.negValues.slice(); S.probFromScore = m.probFromScore;
  }
  await dropActiveData();
  try {
    await buildData();   // ends by entering the app
    entry.summary = { rows: S.info.st.n, clients: S.info.st.clients, dmin: S.info.st.dmin, dmax: S.info.st.dmax, pos: S.info.st.pos, invalid: S.info.invalid };
    entry.error = null;
    document.title = `${entry.name} · Conversion Model Lab`;
    renderContext();
  } catch (e) {
    console.error(e); overlay.hide();
    entry.error = String(e.message || e);
    if (prev && prev !== entry) { toast(`${entry.name} could not be analysed (${entry.error}). Returning to ${prev.name}.`, 8000); await activate(prev); }
    else { $('#app').classList.add('hidden'); $('#onboard').classList.remove('hidden'); await showMapping(`Building the analysis table failed: ${esc(entry.error)}`); }
  }
}
/** Switch the analysis to another file (from the file switcher). */
async function switchFile(id) {
  const target = wsFile(id), cur = wsActive();
  if (!target || target === cur) return;
  closeFileMenu();
  if (!target.mapping) { if (cur) cur.saved = captureState(); await beginMapping(target, cur); return; }
  await activate(target);
  toast(`Now analysing ${target.name}.`);
}
async function removeFile(id) {
  const e = wsFile(id); if (!e || e.id === WS.active) return;
  if (e.isDemo) await q(`DROP TABLE IF EXISTS ${e.reader}`); else { try { await DB.db.dropFile(e.reg); } catch (_) { /* already gone */ } }
  WS.files = WS.files.filter(f => f !== e);
  renderContext(); openFileMenu();
}

/* ---------------------------------------------------------- file switcher UI */
const FILE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 1.5H4a1.5 1.5 0 00-1.5 1.5v10A1.5 1.5 0 004 14.5h8a1.5 1.5 0 001.5-1.5V5.5l-4-4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.5 1.5v4h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
function fileChipHTML() {
  const e = wsActive(); if (!e) return '';
  const k = WS.files.indexOf(e) + 1, n = WS.files.length;
  return `<button class="ctx-chip file-chip" id="ctx-file" aria-haspopup="menu" data-tip="The file the whole analysis is built from. Click to switch files or add more.">${FILE_ICON}<span class="fc-name">${esc(e.name)}</span>${n > 1 ? `<span class="fc-count">${k} of ${n}</span>` : ''}<span class="fc-caret" aria-hidden="true">${ICON.chev}</span></button>`;
}
function closeFileMenu() { const m = $('#file-menu'); if (m) { m.classList.add('closing'); setTimeout(() => m.remove(), 180); } document.removeEventListener('mousedown', fileMenuOutside, true); document.removeEventListener('keydown', fileMenuKey); }
function fileMenuOutside(e) { if (!e.target.closest('#file-menu') && !e.target.closest('#ctx-file')) closeFileMenu(); }
function fileMenuKey(e) { if (e.key === 'Escape') closeFileMenu(); }
function openFileMenu() {
  $('#file-menu')?.remove();
  const chip = $('#ctx-file'); if (!chip) return;
  const r = chip.getBoundingClientRect();
  const m = document.createElement('div'); m.id = 'file-menu'; m.className = 'file-menu'; m.setAttribute('role', 'menu');
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 440)) + 'px'; m.style.top = (r.bottom + 8) + 'px';
  const row = f => {
    const active = f.id === WS.active;
    const status = active ? statusPill('good', 'Active') : f.mapping ? statusPill('info', 'Ready') : statusPill('warn', 'Confirm mapping');
    const meta = f.summary ? `${fmtInt(f.summary.rows)} rows · ${fmtInt(f.summary.clients)} clients · ${f.summary.dmin} → ${f.summary.dmax}` : f.isDemo ? 'Synthetic rows' : `${(f.size / 1e6).toFixed(1)} MB · ${fmtInt(f.cols.length)} columns · not analysed yet`;
    return `<div class="fm-row ${active ? 'on' : ''}" role="menuitemradio" aria-checked="${active}" tabindex="0" data-switch="${f.id}">
      <span class="fm-radio" aria-hidden="true"></span>
      <div class="fm-main"><div class="fm-name">${esc(f.name)}</div><div class="fm-meta">${meta}${f.error ? ` · <span style="color:var(--bad)">${esc(f.error)}</span>` : ''}</div></div>
      ${status}${active ? '' : `<button class="icon-btn fm-rm" data-remove="${f.id}" aria-label="Remove ${esc(f.name)} from the workspace" data-tip="Remove from the workspace" style="width:28px;height:28px">${ICON.close}</button>`}</div>`;
  };
  m.innerHTML = `<div class="fm-head"><b>Prediction files</b><span class="faint">One file is analysed at a time; switching rebuilds every tab from it.</span></div>
    <div class="fm-list">${WS.files.map(row).join('')}</div>
    <div class="fm-foot"><button class="btn sm" id="fm-add">+ Add files…</button><input type="file" id="fm-input" accept=".csv,.parquet,.pq,.csv.gz,.tsv,.txt" multiple hidden>
      <span class="faint">Each file keeps its own settings and filters.</span></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]'); if (rm) { e.stopPropagation(); removeFile(+rm.dataset.remove); return; }
    const sw = e.target.closest('[data-switch]'); if (sw) { switchFile(+sw.dataset.switch); return; }
    if (e.target.closest('#fm-add')) $('#fm-input', m).click();
  });
  m.addEventListener('keydown', e => { if (e.key === 'Enter') { const sw = e.target.closest('[data-switch]'); if (sw) switchFile(+sw.dataset.switch); } });
  $('#fm-input', m).onchange = ev => { const fl = ev.target.files; closeFileMenu(); addFiles(fl); };
  setTimeout(() => { document.addEventListener('mousedown', fileMenuOutside, true); document.addEventListener('keydown', fileMenuKey); }, 0);
  ($('.fm-row.on', m) || $('.fm-row', m))?.focus();
}
