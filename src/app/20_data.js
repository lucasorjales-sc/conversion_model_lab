/* ==========================================================================
   20 · DATA: UPLOAD → MAPPING → VALIDATION → DISCOVERY → ENGINE EXTRACT
   The uploaded file is read by DuckDB-WASM inside this tab. Nothing is sent
   anywhere. Malformed rows are never repaired or dropped silently: they are
   counted by reason, kept for inspection, and excluded from analysis.
   ========================================================================== */
const isNumericType = t => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL)/i.test(t);
const isTextType = t => /^(VARCHAR|ENUM)/i.test(t);
const isBoolType = t => /^BOOLEAN/i.test(t);
const isDateType = t => /^(DATE|TIMESTAMP)/i.test(t);
const POS_DEFAULT = /^(1|1\.0+|true|t|yes|y)$/i;
const NEG_DEFAULT = /^(0|0\.0+|false|f|no|n)$/i;

/** Single-file entry point (kept for console use); uploads go through loadFiles (15_workspace.js). */
async function loadFile(file) { return loadFiles([file]); }

/* Synthetic demo data (generated in the browser; clearly labelled DEMO everywhere).
   Client-level latent propensity, irregular scoring every 2 days, purchase date drives the 14-day label.
   The score is an explicit model: logit = intercept + one additive term per feature column in the file (DEMO_TERMS),
   so its SHAP values are exact (interventional SHAP of an additive model = term − its mean over the background,
   here the validation split). Planted weaknesses for the diagnostics: dormant clients and the 'aggregator' channel
   (whose visits are not recorded) are under-scored; market MIA is over-predicted; app opens jump after day 120
   (a product release), so scores drift up while conversion does not. */
const DEMO_TERMS = {
  classes_30d: '0.24 * LEAST(classes_30d, 14)',
  visits_7d: '0.62 * LEAST(visits_7d, 6)',
  days_since_first_class: '-0.22 * ln(1 + days_since_first_class)',
  credits_remaining: '0.05 * credits_remaining',
  app_opens_7d: '0.11 * LEAST(app_opens_7d, 10)',
  market: `CASE market WHEN 'MIA' THEN 0.8 WHEN 'NYC' THEN 0.1 ELSE 0 END`,
  channel: `CASE channel WHEN 'aggregator' THEN -0.35 WHEN 'referral' THEN 0.2 ELSE 0 END`,
  lifecycle_stage: `CASE lifecycle_stage WHEN 'New Client' THEN 0.3 WHEN 'Lapsed Member' THEN -0.45 ELSE 0 END`,
};
const DEMO_INTERCEPT = -7.6;
function demoSQL(nRows) {
  const nClients = Math.round(nRows / 12);
  return `
SELECT setseed(0.42);
CREATE OR REPLACE TABLE __c AS
SELECT c,
  ['DC','NYC','LA','CHI','ATX','MIA'][1+floor(random()*6)::INT] AS market,
  CASE WHEN u_t < 0.5 THEN 'new' WHEN u_t < 0.8 THEN 'pack' ELSE 'lapsed' END AS client_type,
  CASE WHEN u_ch < 0.15 THEN 'aggregator' ELSE ['organic','paid_social','referral'][1+floor(random()*3)::INT] END AS channel,
  sqrt(-2*ln(1-random()))*cos(2*pi()*random()) AS z,
  floor(random()*157)::INT AS start_day,
  random() AS u_conv, random() < 0.15 AS dormant, 1+floor(random()*30)::INT AS conv_off
FROM (SELECT range AS c, random() AS u_t, random() AS u_ch FROM range(${nClients}));
CREATE OR REPLACE TABLE __c2 AS
SELECT *, (u_conv < 1/(1+exp(-(-6.25 + 1.5*z + CASE client_type WHEN 'new' THEN 0.4 WHEN 'lapsed' THEN 0.3 ELSE -0.3 END)))) AS converts FROM __c;
CREATE TABLE __demo AS
WITH r AS (
  SELECT c.*, k, start_day + 2*k AS dnum, CASE WHEN converts THEN conv_off - 2*k END AS dtc
  FROM __c2 c, range(12) t(k)
), s AS (
  SELECT *, COALESCE(dtc BETWEEN 1 AND 14, false)::INT AS y,
    sqrt(-2*ln(1-random()))*cos(2*pi()*random()) AS e1, sqrt(-2*ln(1-random()))*cos(2*pi()*random()) AS e2,
    random() AS u1, random() AS u2, random() AS u3,
    CASE WHEN dtc BETWEEN 0 AND 20 THEN (20 - dtc) / 20.0 ELSE 0 END AS bump
  FROM r WHERE dtc IS NULL OR dtc >= 1
), f AS (
SELECT 'C' || lpad(c::VARCHAR, 6, '0') AS client_id,
  (DATE '2025-01-01' + dnum::INT) AS date_t,
  y AS conversion_target,
  market, channel,
  CASE client_type WHEN 'new' THEN 'New Client' WHEN 'pack' THEN 'Non-member Client' ELSE 'Lapsed Member' END AS lifecycle_stage,
  market || '-S' || (c % 4)::VARCHAR AS primary_studio_id,
  CASE WHEN y=1 THEN dtc END AS days_to_conversion,
  market || '-' || strftime(DATE '2025-01-01' + dnum::INT, '%m%d') || '-' || lpad((floor(u1*45))::INT::VARCHAR,2,'0') AS class_id,
  market || '-coach' || (floor(u1*45)::INT % 9) AS coach_id,
  CASE client_type WHEN 'new' THEN 1 + 2*k + floor(u2*5)::INT WHEN 'pack' THEN 20 + 2*k + floor(u2*60)::INT ELSE 120 + 2*k + floor(u2*200)::INT END AS days_since_first_class,
  CASE WHEN dormant THEN 0 ELSE greatest(1, round(4 + 2.5*z + 0.6*e1 + CASE WHEN dtc BETWEEN 0 AND 20 THEN 3 ELSE 0 END))::INT END AS classes_30d,
  CASE WHEN dormant OR channel = 'aggregator' THEN 0 ELSE greatest(0, round(0.8 + 0.6*z + 0.8*e2 + 3.4*bump))::INT END AS visits_7d,
  floor(u3*4)::INT + CASE WHEN dnum >= 120 THEN 3 ELSE 0 END AS app_opens_7d,
  CASE WHEN client_type='pack' THEN floor(u2*10)::INT ELSE 0 END AS credits_remaining,
  CASE WHEN dnum < 120 THEN 'validation' ELSE 'test' END AS split,
  CASE WHEN client_type = 'new' AND k <= 3 THEN 1 ELSE 0 END AS in_existing_rules
FROM s)
SELECT *, 1/(1+exp(-(${DEMO_INTERCEPT} + ${Object.values(DEMO_TERMS).join(' + ')}))) AS predicted_score FROM f;
DROP TABLE __c;
DROP TABLE __c2`;
}
async function loadDemo(nRows = 300000) {
  overlay.show('Generating demo data');
  try {
    overlay.step(8, 'Starting the in-browser database engine…');
    await initDB();
    await resetAll();
    const id = ++WS.seq, table = `__demo_raw${id}`;
    overlay.step(30, `Generating ${nRows.toLocaleString()} synthetic rows…`);
    await exec(demoSQL(nRows));
    overlay.step(45, 'Fitting an isotonic calibration on the validation split only…');
    // Isotonic (pool-adjacent violators over 100 equal-count bins) fitted on split = validation and applied to every row.
    // The test split is never used to fit it, so test-period calibration metrics stay out-of-sample.
    const bins = await q(`SELECT b, MAX(predicted_score) AS hi, COUNT(*) AS n, SUM(conversion_target) AS p FROM (SELECT predicted_score, conversion_target, ntile(100) OVER (ORDER BY predicted_score) AS b FROM __demo WHERE split = 'validation') GROUP BY b ORDER BY b`);
    const blocks = [];
    for (const r of bins) { blocks.push({ n: r.n, p: r.p, hi: r.hi }); while (blocks.length > 1 && blocks[blocks.length - 2].p / blocks[blocks.length - 2].n >= blocks[blocks.length - 1].p / blocks[blocks.length - 1].n) { const b = blocks.pop(), a = blocks.pop(); blocks.push({ n: a.n + b.n, p: a.p + b.p, hi: b.hi }); } }
    const last = blocks[blocks.length - 1];
    const cases = blocks.slice(0, -1).map(b => `WHEN predicted_score <= ${b.hi} THEN ${b.p / b.n}`).join(' ');
    overlay.step(52, 'Computing exact SHAP values for the demo model…');
    const terms = Object.entries(DEMO_TERMS);
    const bg = await q1(`SELECT ${terms.map(([, t], k) => `AVG(${t}) AS m${k}`).join(', ')} FROM __demo WHERE split = 'validation'`);
    const base = DEMO_INTERCEPT + terms.reduce((a, _, k) => a + bg['m' + k], 0);
    await q(`CREATE TABLE ${table} AS SELECT *, ${cases ? `CASE ${cases} ELSE ${last.p / last.n} END` : `${last.p / last.n}`} AS predicted_probability,
      ${terms.map(([f, t], k) => `(${t}) - ${bg['m' + k]} AS ${qi('shap__' + f)}`).join(', ')}, ${base} AS shap_base_value FROM __demo`);
    await q('DROP TABLE __demo');
    const cols = (await q(`DESCRIBE ${table}`)).map(d => ({ name: d.column_name, type: d.column_type }));
    const entry = { id, name: `DEMO DATA (${nRows.toLocaleString()} synthetic rows)`, size: 0, reg: table, reader: table, cols, sig: colsSig(cols), isDemo: true, mapping: null, saved: null, summary: null, error: null };
    WS.files.push(entry);
    overlay.hide();
    await beginMapping(entry, null);
  } catch (e) { overlay.hide(); showUploadError(`Demo generation failed: ${esc(e.message || e)}`); }
}

/** Drop the active file's analysis tables and per-file state (the registered files stay). */
async function dropActiveData() {
  for (const t of ['data', '__invalid', '__ep', '__epi', '__cli', '__dict', '__pest']) await q(`DROP TABLE IF EXISTS ${t}`);
  S.cache.clear(); S.cohorts = []; S.filters = []; S.ui = {}; S.sim = null; S.rendered = {}; S.core = null; S.pop = null;
  S.shap = null; SHAP.cache.clear(); SHAP.check = null;
}
/** Start a new workspace: forget every registered file. */
async function resetAll() {
  await dropActiveData();
  const t = await q(`SELECT table_type FROM information_schema.tables WHERE table_name = 'raw'`); if (t.length) await q(t[0].table_type === 'VIEW' ? 'DROP VIEW raw' : 'DROP TABLE raw');
  for (const f of WS.files) { if (f.isDemo) await q(`DROP TABLE IF EXISTS ${f.reader}`); else if (f.reg) { try { await DB.db.dropFile(f.reg); } catch (_) { /* gone */ } } }
  for (const x of ['__demo', '__c', '__c2']) await q(`DROP TABLE IF EXISTS ${x}`);
  WS.files = []; WS.active = null; WS.mappingFor = null; WS.returnTo = null;
  S.roles = {}; S.posValues = null; S.negValues = null; S.probFromScore = false; S.eval = { grain: 'row', gran: 'overall' };
}
function showUploadError(msg) { html($('#upload-error'), callout('bad', msg)); $('#upload-error').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

/* --------------------------------------------------------------- mapping */
async function targetValues(col) {
  if (!col) return null;
  // first 300k rows only (fast on very large files); the full validation pass reports any other value as invalid
  const key = `tv|${S.file?.reg}|${col}`; if (S.cache.has(key)) return S.cache.get(key);
  const r = await q(`SELECT lower(trim(CAST(${qi(col)} AS VARCHAR))) AS v, COUNT(*) AS n FROM (SELECT ${qi(col)} FROM raw LIMIT 300000) WHERE ${qi(col)} IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 12`);
  S.cache.set(key, r); return r;
}

async function showMapping(err = '') {
  $('#upload-panel').classList.add('hidden');
  const host = $('#mapping-panel');
  if (!err) html(host, computing(`Reading ${S.file.name}…`));   // never show the previous file's mapping while this one loads
  host.classList.remove('hidden');
  const opts = (sel, req) => `<option value="">${req ? '— choose a column —' : '(not in file)'}</option>` + S.rawCols.map(c => `<option value="${esc(c.name)}" ${sel === c.name ? 'selected' : ''}>${esc(c.name)} · ${esc(c.type.toLowerCase())}</option>`).join('');
  const row = r => `<tr><td><div style="font-weight:600" class="mono">${r.label}</div><div class="faint">${esc(r.desc)}</div></td><td>${r.req ? '<span class="role-req">Required</span>' : '<span class="faint">Optional</span>'}</td><td><select data-role="${r.role}" aria-label="${r.label}">${opts(S.roles[r.role], r.req)}</select></td></tr>`;
  const tv = await targetValues(S.roles.target);
  html(host, `
    <div class="card">
      <div class="card-head"><div class="titles"><h2>Confirm the column mapping</h2><div class="sub">${esc(S.file.name)} · ${fmtInt(S.rawCols.length)} columns detected. Columns were matched by name; check each role. The app never guesses a role from the data.</div></div>
        <div class="actions"><button class="btn" id="map-back">${WS.returnTo ? 'Cancel — keep the current file' : 'Choose other files'}</button></div></div>
      ${err ? callout('bad', err) : ''}
      <table class="plain map-table" style="margin-top:8px"><tbody>${ROLE_DEFS.filter(r => r.req).map(row).join('')}</tbody></table>
      <div style="margin-top:8px">${disc('Optional roles', `<table class="plain map-table"><tbody>${ROLE_DEFS.filter(r => !r.req).map(row).join('')}</tbody></table>
        <p class="faint" style="margin-top:8px">Every other column is analysed automatically: low-cardinality text columns become segments; numeric and categorical columns become features in the explorer and the rule builder. Identifiers, dates and model outputs are excluded with a stated reason.</p>`, { open: true, sub: 'unlock calibration, studio caps, experiments, the current-strategy comparison and more' })}</div>
    </div>
    <div class="grid g2" style="margin-top:20px">
      <div class="card"><h3>Positive outcome label</h3><p class="sub muted small" style="margin:6px 0 12px">Which values of CONVERSION_TARGET mean “converted”, and which mean “did not convert”? Values are listed from the first 300,000 rows; rows with any other value are reported as invalid and excluded.</p><div id="pos-host"></div></div>
      <div class="card"><h3>Is PREDICTED_SCORE a probability?</h3><p class="muted small" style="margin:6px 0 12px">A model score is not automatically a probability. Ranking metrics are valid either way; calibration metrics (Brier, log loss, reliability) are only computed for probabilities.</p>
        <div id="prob-host"></div></div>
    </div>
    ${mappingWorkspaceHTML()}
    <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:24px"><button class="btn primary" id="map-go" style="height:40px;padding:0 24px;font-size:15px">Analyze ${esc(S.file.name)}</button></div>`);
  const renderPos = vals => {
    const ph = $('#pos-host');
    if (!S.roles.target) { html(ph, '<div class="faint">Choose the CONVERSION_TARGET column first.</div>'); return; }
    if (!vals || !vals.length) { html(ph, callout('bad', 'The target column has no non-empty values.')); return; }
    if (vals.length > 10) { html(ph, callout('bad', `The target column has more than 10 distinct values (e.g. ${vals.slice(0, 5).map(v => esc(v.v)).join(', ')}…). It must be a binary outcome.`)); return; }
    const pos = S.posValues || vals.filter(v => POS_DEFAULT.test(v.v)).map(v => v.v);
    const neg = S.negValues || vals.filter(v => NEG_DEFAULT.test(v.v)).map(v => v.v);
    S.posValues = pos; S.negValues = neg;
    const group = (cls, chosen) => `<div class="pill-select">${vals.map(v => `<label><input type="checkbox" class="${cls}" value="${esc(v.v)}" ${chosen.includes(v.v) ? 'checked' : ''}> ${esc(v.v)} <span class="faint">${fmtInt(v.n)}</span></label>`).join('')}</div>`;
    const other = vals.filter(v => !pos.includes(v.v) && !neg.includes(v.v));
    html(ph, `<div class="faint" style="margin-bottom:6px">Positive (converted)</div>${group('pos-cb', pos)}
      <div class="faint" style="margin:14px 0 6px">Negative (did not convert)</div>${group('neg-cb', neg)}
      <p class="faint" style="margin-top:12px">${other.length ? `<b>Not recognised:</b> ${other.map(v => `${esc(v.v)} (${fmtInt(v.n)} rows)`).join(', ')} — these rows will be reported as invalid and excluded, not guessed.` : 'Every value is assigned.'}</p>`);
  };
  const renderProb = () => {
    const pc = S.roles.prob;
    html($('#prob-host'), pc
      ? callout('good', `Probabilities come from <span class="mono">${esc(pc)}</span>. Values outside [0, 1] will be treated as missing and reported. Make sure this calibration was <b>not</b> fitted on these test rows.`)
      : `<label class="inline"><input type="checkbox" id="prob-score" ${S.probFromScore ? 'checked' : ''}> Treat PREDICTED_SCORE as a calibrated probability</label>
         <p class="faint" style="margin-top:10px">Leave unticked unless the score was produced by a calibrated model on data with the production class balance. If the model was trained with negative downsampling, its scores are not calibrated probabilities for this population.</p>`);
    const cb = $('#prob-score'); if (cb) cb.onchange = () => { S.probFromScore = cb.checked; };
  };
  renderPos(tv); renderProb();
  $$('select[data-role]', host).forEach(sel => sel.onchange = async () => {
    S.roles[sel.dataset.role] = sel.value || undefined; if (!sel.value) delete S.roles[sel.dataset.role];
    if (sel.dataset.role === 'target') { S.posValues = null; S.negValues = null; renderPos(await targetValues(sel.value)); }
    if (sel.dataset.role === 'prob') renderProb();
  });
  host.addEventListener('change', async e => {
    const t = e.target; if (!t.classList.contains('pos-cb') && !t.classList.contains('neg-cb')) return;
    if (t.checked) { const other = t.classList.contains('pos-cb') ? '.neg-cb' : '.pos-cb'; $$(other, host).forEach(x => { if (x.value === t.value) x.checked = false; }); }
    S.posValues = $$('.pos-cb:checked', host).map(x => x.value); S.negValues = $$('.neg-cb:checked', host).map(x => x.value);
    renderPos(await targetValues(S.roles.target));
  });
  $('#map-back').onclick = async () => { if (await cancelMapping()) return; host.classList.add('hidden'); $('#upload-panel').classList.remove('hidden'); $('#file-input').value = ''; };
  $('#map-go').onclick = async () => {
    const missing = ROLE_DEFS.filter(r => r.req && !S.roles[r.role]).map(r => r.label);
    if (missing.length) { await showMapping(`Choose a column for: ${missing.join(', ')}.`); return; }
    const used = Object.values(S.roles); if (new Set(used).size !== used.length) { await showMapping('Each column can fill only one role.'); return; }
    const vals = await targetValues(S.roles.target);
    if (!vals || !vals.length || vals.length > 10) { await showMapping('CONVERSION_TARGET must be a binary column (at most 10 distinct values, one or more of them positive).'); return; }
    S.posValues = S.posValues || vals.filter(v => POS_DEFAULT.test(v.v)).map(v => v.v);
    S.negValues = S.negValues || vals.filter(v => NEG_DEFAULT.test(v.v)).map(v => v.v);
    if (!S.posValues.length) { await showMapping('Tick at least one value of CONVERSION_TARGET as the positive outcome.'); return; }
    if (!S.negValues.length) { await showMapping('Tick at least one value of CONVERSION_TARGET as the negative outcome.'); return; }
    host.classList.add('hidden');
    await confirmMapping(!!$('#map-share')?.checked);
  };
}

/** Other files in the workspace, shown under the mapping so the user knows what the mapping will apply to. */
function mappingWorkspaceHTML() {
  const me = wsFile(WS.mappingFor), others = WS.files.filter(f => f !== me);
  if (!me || !others.length) return '';
  const twins = others.filter(f => !f.mapping && f.sig === me.sig);
  return `<div class="card" style="margin-top:20px"><h3>Files in this workspace</h3>
    <p class="muted small" style="margin:6px 0 12px">One file is analysed at a time. You can switch files at any point from the file switcher at the top of the app.</p>
    <table class="plain" style="font-size:13.5px"><tbody>${WS.files.map(f => `<tr><td>${f === me ? '<b>' + esc(f.name) + '</b>' : esc(f.name)}</td><td class="faint">${f.isDemo ? 'synthetic' : (f.size / 1e6).toFixed(1) + ' MB'} · ${fmtInt(f.cols.length)} columns</td>
      <td>${f === me ? statusPill('info', 'Mapping now') : f.mapping ? statusPill('good', 'Mapped') : f.sig === me.sig ? statusPill('na', 'Same columns') : statusPill('warn', 'Different columns')}</td></tr>`).join('')}</tbody></table>
    ${twins.length ? `<label class="inline" style="margin-top:14px"><input type="checkbox" id="map-share" checked> Use this mapping for the ${plural(twins.length, 'other file')} with identical columns</label>` : ''}
    ${others.some(f => !f.mapping && f.sig !== me.sig) ? '<p class="faint" style="margin-top:10px">Files with different columns will ask you to confirm their mapping the first time you select them.</p>' : ''}</div>`;
}

/* ------------------------------------------------------------ build data */
async function buildData() {
  overlay.show(`Validating ${S.file.name}`);
  const col = r => S.rawCols.find(c => c.name === S.roles[r]);
  const R = r => qi(S.roles[r]);
  const txt = x => `CAST(${x} AS VARCHAR)`;
  const dateOf = (c) => isDateType(c.type) ? `CAST(${qi(c.name)} AS DATE)` : `COALESCE(TRY_CAST(${txt(qi(c.name))} AS DATE), TRY_CAST(TRY_CAST(${txt(qi(c.name))} AS TIMESTAMP) AS DATE), TRY_CAST(TRY_STRPTIME(${txt(qi(c.name))}, '%m/%d/%Y') AS DATE))`;
  const numOf = (c) => isNumericType(c.type) ? `CAST(${qi(c.name)} AS DOUBLE)` : isBoolType(c.type) ? `CAST(${qi(c.name)} AS DOUBLE)` : `TRY_CAST(${txt(qi(c.name))} AS DOUBLE)`;
  const dateExpr = dateOf(col('date')), scoreExpr = numOf(col('score'));
  const tnorm = `lower(trim(${txt(R('target'))}))`;
  const yExpr = `CASE WHEN ${tnorm} IN (${S.posValues.map(ql).join(',')}) THEN 1 WHEN ${tnorm} IN (${S.negValues.map(ql).join(',')}) THEN 0 END`;
  const probExpr = S.roles.prob ? numOf(col('prob')) : null;
  const reason = `CASE WHEN ${R('client_id')} IS NULL OR trim(${txt(R('client_id'))}) = '' THEN 'Missing CLIENT_ID'
      WHEN ${R('date')} IS NULL THEN 'Missing DATE_T' WHEN ${dateExpr} IS NULL THEN 'Unparseable DATE_T'
      WHEN ${R('target')} IS NULL THEN 'Missing CONVERSION_TARGET' WHEN ${yExpr} IS NULL THEN 'Unrecognised CONVERSION_TARGET value'
      WHEN ${R('score')} IS NULL THEN 'Missing PREDICTED_SCORE' WHEN ${scoreExpr} IS NULL OR isnan(${scoreExpr}) OR isinf(${scoreExpr}) THEN 'Non-numeric PREDICTED_SCORE' END`;
  overlay.step(15, 'Checking every row (pass 1 of 2)…');
  const reasons = await q(`SELECT COALESCE(r, 'valid') AS reason, COUNT(*) AS n,
      COUNT(*) FILTER (WHERE r IS NULL AND (s < 0 OR s > 1)) AS s_out
      ${probExpr ? `, COUNT(*) FILTER (WHERE r IS NULL AND pr IS NULL AND praw IS NOT NULL) AS p_bad, COUNT(*) FILTER (WHERE r IS NULL AND pr IS NOT NULL AND (pr < 0 OR pr > 1)) AS p_out, COUNT(*) FILTER (WHERE r IS NULL AND praw IS NULL) AS p_null` : ''}
    FROM (SELECT ${reason} AS r, ${scoreExpr} AS s ${probExpr ? `, ${probExpr} AS pr, ${R('prob')} AS praw` : ''} FROM raw) GROUP BY 1`);
  const total = reasons.reduce((a, r) => a + r.n, 0);
  if (!total) { overlay.hide(); throw new Error('The file has no rows.'); }
  const validRow = reasons.find(r => r.reason === 'valid') || { n: 0, s_out: 0 };
  // analysis table: standard names for consumed roles, original names for everything else (renamed on collision)
  overlay.step(40, 'Building the analysis table (pass 2 of 2)…');
  const consumedSrc = new Set(['client_id', 'date', 'target', 'score', 'prob'].map(r => S.roles[r]).filter(Boolean));
  const shapDet = detectShap(S.rawCols);   // SHAP contributions exported with the predictions (62_shap.js)
  for (const c of shapDet.cols) consumedSrc.add(c.src);
  if (shapDet.base) consumedSrc.add(shapDet.base);
  const taken = new Set(['client_id', 'date', 'y', 'score', 'prob', '__rid', '__hb']);
  const others = [];
  for (const c of S.rawCols) {
    if (consumedSrc.has(c.name)) continue;
    let out = c.name === '' ? 'column0' : c.name;
    while (taken.has(out.toLowerCase()) || out.startsWith('__')) out = out + '_x';
    taken.add(out.toLowerCase()); others.push({ name: out, src: c.name, type: c.type });
  }
  // role columns that are not consumed now point at their name in `data`
  for (const r of Object.keys(S.roles)) if (!CONSUMED[r]) { const o = others.find(x => x.src === S.roles[r]); if (o) S.roles[r] = o.name; }
  const probSel = S.roles.prob ? `CASE WHEN ${probExpr} BETWEEN 0 AND 1 THEN ${probExpr} END` : S.probFromScore ? `CASE WHEN ${scoreExpr} BETWEEN 0 AND 1 THEN ${scoreExpr} END` : 'CAST(NULL AS DOUBLE)';
  await q(`CREATE TABLE data AS SELECT CAST(row_number() OVER () AS INTEGER) AS __rid,
      ${txt(R('client_id'))} AS client_id, ${dateExpr} AS date, CAST(${yExpr} AS TINYINT) AS y, ${scoreExpr} AS score, ${probSel} AS prob,
      CAST(hash(${txt(R('client_id'))} || '|' || CAST(${dateExpr} AS VARCHAR)) % 2147483647 AS INTEGER) AS __hb
      ${others.map(o => `, ${qi(o.src)} AS ${qi(o.name)}`).join('')}
      ${shapDet.cols.map((c, k) => `, CAST(${qi(c.src)} AS FLOAT) AS __shap${k}`).join('')}
      ${shapDet.base ? `, CAST(${qi(shapDet.base)} AS DOUBLE) AS __shap_base` : ''}
    FROM raw WHERE (${reason}) IS NULL`);
  S.shap = shapSetup(shapDet, others);
  const nInvalid = total - validRow.n;
  if (nInvalid) {
    overlay.step(55, 'Keeping malformed rows for inspection…');
    await q(`CREATE TABLE __invalid AS SELECT ${reason} AS reason, * FROM raw WHERE (${reason}) IS NOT NULL LIMIT 20000`);
  }
  overlay.step(62, 'Summarising…');
  const st = await q1(`SELECT COUNT(*) AS n, COUNT(DISTINCT client_id) AS clients, strftime(MIN(date), '%Y-%m-%d') AS dmin, strftime(MAX(date), '%Y-%m-%d') AS dmax,
      COUNT(DISTINCT date) AS days, SUM(y) AS pos, AVG(score) AS ms, MIN(score) AS smin, MAX(score) AS smax, COUNT(DISTINCT score) AS sdistinct,
      COUNT(prob) AS pn, AVG(prob) AS mp, COUNT(DISTINCT CASE WHEN y = 1 THEN client_id END) AS posClients FROM data`);
  if (!st.n) { overlay.hide(); throw new Error('No valid rows remain after validation. See the reasons below and check the mapping.'); }
  const dup = await q1(`SELECT COUNT(*) AS keys, COALESCE(SUM(c), 0) AS rows FROM (SELECT client_id, date, COUNT(*) AS c FROM data GROUP BY 1, 2 HAVING COUNT(*) > 1)`);
  S.info = { total, reasons: reasons.filter(r => r.reason !== 'valid').map(r => ({ reason: r.reason, n: r.n })), invalid: nInvalid, st,
    sOut: validRow.s_out || 0, pBad: validRow.p_bad || 0, pOut: validRow.p_out || 0, pNull: validRow.p_null || 0, dup };
  S.hasProb = st.pn > 0 && (!!S.roles.prob || S.probFromScore);
  overlay.step(70, 'Discovering segments and features…');
  await discover(others);
  overlay.step(80, 'Reconstructing conversion episodes (one per purchase)…');
  await buildEpisodes();
  overlay.step(88, 'Loading the analytical engine…');
  await extractCore();
  const sp = S.roles.split ? (await q(`SELECT ${qi(S.roles.split)} AS v, COUNT(*) AS n FROM data GROUP BY 1 ORDER BY 2 DESC`)).map(r => String(r.v)) : [];
  const vers = S.roles.version ? (await q(`SELECT CAST(${qi(S.roles.version)} AS VARCHAR) AS v, COUNT(*) AS n FROM data GROUP BY 1 ORDER BY 2 DESC`)) : [];
  S.splitValues = sp; S.versions = vers;
  S.settings = defaultSettings(st);
  const testSplit = sp.find(v => /^test$/i.test(v)) || sp.find(v => /test/i.test(v));
  if (testSplit) S.settings.split = testSplit;
  restoreSaved();   // switching back to a file restores its own settings, filters and tab state
  overlay.step(96, 'Preparing the evaluation population…');
  await applySettings(false);
  overlay.step(100, 'Done'); overlay.hide();
  enterApp();
}

/* --------------------------------------------------------------- discovery */
const ID_NAME = /(^|_)(id|uuid|guid|key|hash)$/i;
const DERIVED_NAME = /^(prediction|predicted_label|pred_label|predicted_class|neg_sample_rate|sample_weight|weight|weights|row_weight)$/i;
async function discover(others) {
  const st = S.info.st, N = st.n;
  const dcols = await q('DESCRIBE data');
  const typeOf = Object.fromEntries(dcols.map(d => [d.column_name, d.column_type]));
  S.schema = { cols: dcols.map(d => ({ name: d.column_name, type: d.column_type })), typeOf, others };
  const cand = others.map(o => ({ ...o, type: typeOf[o.name] }));
  const parts = cand.map((c, i) => `approx_count_distinct(${qi(c.name)}) AS d${i}, COUNT(${qi(c.name)}) AS nn${i}` +
    (isNumericType(c.type) ? `, MIN(${qi(c.name)})::DOUBLE AS mn${i}, MAX(${qi(c.name)})::DOUBLE AS mx${i}, BOOL_AND(${qi(c.name)}::DOUBLE = floor(${qi(c.name)}::DOUBLE)) AS int${i}` : '') +
    (isTextType(c.type) ? `, AVG(CASE WHEN ${qi(c.name)} IS NULL THEN NULL WHEN TRY_CAST(${qi(c.name)} AS DATE) IS NOT NULL THEN 1.0 ELSE 0 END) AS dt${i}` : ''));
  const stats = cand.length ? await q1(`SELECT ${parts.join(', ')} FROM data`) : {};
  const small = cand.map((c, i) => ({ c, i })).filter(({ i }) => stats['d' + i] <= 2500);
  if (small.length) {
    const ex = await q1(`SELECT ${small.map(({ c, i }) => `COUNT(DISTINCT ${qi(c.name)}) AS e${i}`).join(', ')} FROM data`);
    small.forEach(({ c, i }) => c.distinct = ex['e' + i]);
  }
  const segments = [], features = [], excluded = [];
  const roleOf = name => Object.keys(S.roles).find(r => S.roles[r] === name);
  cand.forEach((c, i) => {
    c.distinct = c.distinct ?? stats['d' + i]; c.nonNull = stats['nn' + i]; c.min = stats['mn' + i]; c.max = stats['mx' + i]; c.isInt = !!stats['int' + i]; c.dateLike = (stats['dt' + i] || 0) > 0.9;
    const role = roleOf(c.name), nm = c.src.toLowerCase();
    const ex = reason => excluded.push({ name: c.name, type: c.type, distinct: c.distinct, reason });
    if (role === 'treatment') return ex('Campaign assignment column (used by the experiment panel, not as a feature).');
    if (role === 'version') return ex('Model version (used as a global filter).');
    if (role === 'purchase_date' || role === 'days_to_conv') return ex('Outcome timing: derived from the label, so using it as a feature or segment would leak the outcome.');
    if (role === 'class_id' || role === 'coach_id') return ex('Class / coach identifier (used by the class-roster simulation only).');
    if (!c.nonNull) return ex('Entirely empty.');
    if (c.distinct <= 1) return ex('Constant: a single value in every row.');
    if (DERIVED_NAME.test(nm)) return ex(/weight|sample_rate/i.test(nm) ? 'Sampling weight / rate, not a client attribute.' : 'Derived from the model output (e.g. a thresholded prediction).');
    if (role === 'studio') {   // studios are segments even with many values
      segments.push({ name: c.name, label: 'Primary studio', role, distinct: c.distinct, type: c.type });
      features.push({ name: c.name, kind: 'cat', distinct: c.distinct, role });
      return;
    }
    const idLike = c.src === '' || /^(column0+|unnamed.*|index|level_0)$/i.test(c.src) || (ID_NAME.test(c.src) && role !== 'lifecycle' && role !== 'product' && role !== 'split' && role !== 'current');
    if (idLike) return ex(c.distinct > 2500 || c.src === '' || /^column0+$/i.test(c.src) ? 'Identifier (row index or ID): one value per record, no segment meaning.' : `Identifier-like column (${fmtInt(c.distinct)} values). Map it as PRIMARY_STUDIO_ID if it is the client's studio.`);
    if (isTextType(c.type) || isBoolType(c.type)) {
      if (c.dateLike) return ex('Date stored as text. Derive a numeric feature (e.g. days since) to explore it.');
      if (c.distinct > 50) return ex(`High-cardinality text (${fmtInt(c.distinct)} values): too sparse for segment analysis.`);
      segments.push({ name: c.name, label: c.name, role, distinct: c.distinct, type: c.type });
      features.push({ name: c.name, kind: 'cat', distinct: c.distinct, role });
      return;
    }
    if (isNumericType(c.type)) {
      if (c.isInt && c.distinct >= 0.95 * N && N > 1000) return ex('Integer with a distinct value in almost every row: looks like an identifier.');
      features.push({ name: c.name, kind: c.distinct <= 12 ? 'cat' : 'num', distinct: c.distinct, role, numeric: true, min: c.min, max: c.max });
      if (role === 'current' || role === 'split') segments.push({ name: c.name, label: c.name, role, distinct: c.distinct, type: c.type });
      return;
    }
    if (isDateType(c.type)) return ex('Date column. Derive a numeric feature (e.g. days since) to explore it.');
    ex(`Unsupported type (${c.type}).`);
  });
  if (S.shap) excluded.push({ name: `${S.shap.cols[0].src}, … (${fmtInt(S.shap.cols.length)} columns)${S.shap.baseSrc ? ` + ${S.shap.baseSrc}` : ''}`, type: 'float', distinct: null, reason: 'SHAP contributions: explain the model output, so they are used by Feature importance, never as features or segments.' });
  S.disc = { segments, features, excluded };
}

/* --------------------------------------------------------------- episodes */
/** One episode per purchase, built from ALL rows (filters never move a purchase date).
    Purchase date: PURCHASE_DATE > DATE_T + DAYS_TO_CONVERSION > estimated as the last date of a run of positive rows + 1
    (a new run starts after a gap longer than the horizon). */
async function buildEpisodes() {
  const H = S.settings?.horizon || 14;
  const exact = S.roles.purchase_date ? `TRY_CAST(${qi(S.roles.purchase_date)} AS DATE)` : S.roles.days_to_conv ? `date + CAST(TRY_CAST(${qi(S.roles.days_to_conv)} AS DOUBLE) AS INTEGER)` : 'CAST(NULL AS DATE)';
  // Estimated purchase date for every positive row (used when no exact date is available).
  // A purchase P makes rows dated P−H … P−1 positive, so one run of positive rows spans at most H−1 days.
  // Runs are split when the gap between positive rows exceeds H OR the run would span H days or more
  // (two purchases close together); P is estimated as the run's last positive date + 1.
  const pos = await q(`SELECT __rid AS rid, client_id, CAST(date_diff('day', DATE '1970-01-01', date) AS INTEGER) AS dn FROM data WHERE y = 1 ORDER BY client_id, date, __rid`);
  const est = new Int32Array(pos.length);
  for (let i = 0; i < pos.length;) {
    let j = i; const start = pos[i].dn;
    while (j + 1 < pos.length && pos[j + 1].client_id === pos[i].client_id && pos[j + 1].dn - pos[j].dn <= H && pos[j + 1].dn - start <= H - 1) j++;
    for (let k = i; k <= j; k++) est[k] = pos[j].dn + 1;
    i = j + 1;
  }
  await q('CREATE OR REPLACE TABLE __pest (rid INTEGER, pest DATE)');
  for (let i = 0; i < pos.length; i += 5000) {
    const vals = [];
    for (let k = i; k < Math.min(pos.length, i + 5000); k++) vals.push(`(${pos[k].rid}, DATE '1970-01-01' + ${est[k]})`);
    await q(`INSERT INTO __pest VALUES ${vals.join(',')}`);
  }
  await q(`CREATE OR REPLACE TABLE __ep AS
    WITH p AS (SELECT d.__rid AS rid, d.client_id, d.date, CAST(${exact.replace(/\bdate\b/g, 'd.date')} AS DATE) AS px, e.pest FROM data d JOIN __pest e ON e.rid = d.__rid WHERE d.y = 1)
    SELECT rid, client_id, COALESCE(px, pest) AS pdate, px IS NULL AS estimated,
      CAST(dense_rank() OVER (ORDER BY client_id, COALESCE(px, pest)) - 1 AS INTEGER) AS ep FROM p`);
  await q('DROP TABLE __pest');
  // eligibility-episode index per row = number of the client's purchases on or before the row date
  await q(`CREATE OR REPLACE TABLE __epi AS SELECT d.__rid AS rid, CAST(COUNT(p.pdate) AS SMALLINT) AS epi
    FROM data d JOIN (SELECT DISTINCT client_id, pdate FROM __ep) p ON p.client_id = d.client_id AND p.pdate <= d.date GROUP BY 1`);
  const r = await q1(`SELECT COUNT(DISTINCT ep) AS eps, COUNT(DISTINCT ep) FILTER (WHERE estimated) AS est,
      COUNT(*) AS posRows, COUNT(DISTINCT client_id) AS clients,
      COUNT(DISTINCT ep) FILTER (WHERE estimated AND pdate - 1 = (SELECT MAX(date) FROM data)) AS censored,
      (SELECT COUNT(*) FROM __ep e JOIN data d ON d.__rid = e.rid WHERE e.pdate <= d.date) AS bad,
      (SELECT COUNT(*) FROM __ep e JOIN data d ON d.__rid = e.rid WHERE e.pdate > d.date + 14) AS beyond
    FROM __ep`);
  const multi = await q1(`SELECT COUNT(*) AS n FROM (SELECT client_id FROM __ep GROUP BY 1 HAVING COUNT(DISTINCT ep) > 1)`);
  const reentry = await q1(`SELECT COUNT(*) AS rows, COUNT(DISTINCT d.client_id) AS clients FROM __epi e JOIN data d ON d.__rid = e.rid WHERE e.epi > 0`);
  S.ep = { source: S.roles.purchase_date ? 'PURCHASE_DATE' : S.roles.days_to_conv ? 'DAYS_TO_CONVERSION' : 'estimated', ...r, multiClients: multi.n, reentryRows: reentry.rows, reentryClients: reentry.clients };
}
const epSourceNote = () => S.ep.source === 'estimated'
  ? `Purchase dates are <b>estimated</b> (no PURCHASE_DATE or DAYS_TO_CONVERSION column): the last date of a run of positive rows + 1 day. They can be later than estimated when the client was not scored every day.`
  : `Purchase dates come from ${S.ep.source}.`;

/* ----------------------------------------------------------- engine core */
async function extractCore() {
  // Memory-lean on purpose: DuckDB-WASM has ~3 GB. Codes come from small dictionary tables joined one column at a
  // time, never from window functions over the full (wide) table.
  const st = S.info.st, d0 = st.dmin;
  const segs = S.disc.segments.slice();
  if (S.roles.treatment && !segs.find(s => s.name === S.roles.treatment)) segs.push({ name: S.roles.treatment, label: 'Treatment group', role: 'treatment', hidden: true });
  if (S.roles.split && !segs.find(s => s.name === S.roles.split)) segs.push({ name: S.roles.split, label: 'Split', role: 'split', hidden: true });
  const V = c => `COALESCE(CAST(${qi(c)} AS VARCHAR), '(missing)')`;
  await q(`CREATE OR REPLACE TABLE __cli AS SELECT client_id, CAST(row_number() OVER (ORDER BY client_id) - 1 AS INTEGER) AS cli FROM (SELECT DISTINCT client_id FROM data)`);
  const cur = S.roles.current ? `CASE WHEN TRY_CAST(d.${qi(S.roles.current)} AS DOUBLE) = 1 OR lower(CAST(d.${qi(S.roles.current)} AS VARCHAR)) IN ('true','yes','y','t') THEN 1
      WHEN TRY_CAST(d.${qi(S.roles.current)} AS DOUBLE) = 0 OR lower(CAST(d.${qi(S.roles.current)} AS VARCHAR)) IN ('false','no','n','f') THEN 0 ELSE -1 END` : '-1';
  const t = await DB.conn.query(`SELECT CAST(date_diff('day', DATE ${ql(d0)}, d.date) AS INTEGER) AS day, c.cli AS cli,
      CAST(d.score AS DOUBLE) AS s, CAST(COALESCE(d.prob, 'NaN'::DOUBLE) AS FLOAT) AS p, CAST(d.y AS TINYINT) AS y,
      CAST(COALESCE(e.ep, -1) AS INTEGER) AS ep, CAST(COALESCE(date_diff('day', DATE ${ql(d0)}, e.pdate), -1) AS INTEGER) AS pday,
      CAST(COALESCE(x.epi, 0) AS SMALLINT) AS epi, CAST(d.__hb AS INTEGER) AS hb, CAST(${cur} AS TINYINT) AS cur
    FROM data d JOIN __cli c ON c.client_id = d.client_id LEFT JOIN __ep e ON e.rid = d.__rid LEFT JOIN __epi x ON x.rid = d.__rid ORDER BY d.__rid`);
  const get = (name, Ctor) => new Ctor(t.getChild(name).toArray());
  const core = { n: t.numRows, d0, day: get('day', Int32Array), cli: get('cli', Int32Array), s: get('s', Float64Array), p: get('p', Float32Array), y: get('y', Int8Array),
    ep: get('ep', Int32Array), pday: get('pday', Int32Array), epi: get('epi', Int16Array), hb: get('hb', Int32Array), cur: get('cur', Int8Array), segs: [] };
  const segLabels = [];
  for (let j = 0; j < segs.length; j++) {
    await q(`CREATE OR REPLACE TABLE __dict AS SELECT v, CAST(row_number() OVER (ORDER BY v) - 1 AS SMALLINT) AS code FROM (SELECT DISTINCT ${V(segs[j].name)} AS v FROM data)`);
    const codes = await qColumn(`SELECT m.code FROM (SELECT __rid, ${V(segs[j].name)} AS v FROM data) d JOIN __dict m ON m.v = d.v ORDER BY d.__rid`, 'code', Int16Array);
    const labels = (await q(`SELECT v FROM __dict ORDER BY code`)).map(r => String(r.v));
    core.segs.push({ name: segs[j].name, codes, nCodes: labels.length });
    segLabels.push(labels);
  }
  await q('DROP TABLE IF EXISTS __dict');
  const cliNames = (await q(`SELECT client_id AS c FROM __cli ORDER BY cli`)).map(r => r.c);
  core.nCli = cliNames.length;
  const transfer = [core.day, core.cli, core.s, core.p, core.y, core.ep, core.pday, core.epi, core.hb, core.cur, ...core.segs.map(s => s.codes)].map(a => a.buffer);
  const info = await eng({ type: 'load', core }, transfer);
  const nDays = Math.round((Date.parse(st.dmax) - Date.parse(d0)) / 864e5) + 1;
  S.core = { d0, d1: st.dmax, nDays, cliNames, segs: segs.map((s, j) => ({ ...s, idx: j, labels: segLabels[j] })), info };
}
const segIdx = name => S.core.segs.find(s => s.name === name)?.idx ?? -1;
const dayIdx = iso => Math.round((Date.parse(iso) - Date.parse(S.core.d0)) / 864e5);
const dayIso = d => new Date(Date.parse(S.core.d0) + d * 864e5).toISOString().slice(0, 10);

/* ---------------------------------------------------- evaluation population */
/** The single SQL definition of the evaluation population (the engine receives it as a mask). */
function evalWhere(set = S.settings, seg = { filters: S.filters, cohorts: S.cohorts }) {
  const p = [`date BETWEEN DATE ${ql(set.d0)} AND DATE ${ql(set.d1)}`];
  if (set.split !== null && S.roles.split) p.push(`CAST(${qi(S.roles.split)} AS VARCHAR) = ${ql(set.split)}`);
  if (set.version !== null && S.roles.version) p.push(`CAST(${qi(S.roles.version)} AS VARCHAR) = ${ql(set.version)}`);
  if (set.labelsThrough) p.push(`date + ${Math.round(set.horizon)} <= DATE ${ql(set.labelsThrough)}`);
  for (const c of seg.cohorts || []) p.push(`(${c.sql})`);
  for (const f of seg.filters || []) p.push(filterSQL(f));
  return p.join(' AND ');
}
/** Evaluation units in SQL (same rules as the engine): rows, or each client's / episode's first eligible row. */
function unitSQL(grain, cols = '*') {
  const W = evalWhere();
  if (grain === 'row') return `SELECT ${cols} FROM data WHERE ${W}`;
  if (grain === 'client') return `SELECT ${cols} FROM data WHERE ${W} QUALIFY row_number() OVER (PARTITION BY client_id ORDER BY date, __rid) = 1`;
  return `SELECT ${cols} FROM (SELECT d.*, COALESCE(x.epi, 0) AS __epi FROM data d LEFT JOIN __epi x ON x.rid = d.__rid) WHERE ${W} QUALIFY row_number() OVER (PARTITION BY client_id, __epi ORDER BY date, __rid) = 1`;
}
async function applySettings(render = true) {
  S.ver++; S.cache.clear(); S.rendered = {}; S.sim = null;
  const mask = await qColumn(`SELECT CAST(CASE WHEN ${evalWhere()} THEN 1 ELSE 0 END AS UTINYINT) AS m FROM data ORDER BY __rid`, 'm', Uint8Array);
  S.pop = await eng({ type: 'mask', mask }, [mask.buffer]);
  if (render) { renderContext(); await renderActive(true); }
}
