/* ==========================================================================
   70 · DATA & EVALUATION VALIDITY
   Does the data support the conclusions shown elsewhere? Checks that can be
   computed from the file are computed; the rest are marked "Not assessed".
   ========================================================================== */
async function validityChecks() {
  const key = `${S.ver}|validity`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = (async () => {
    const st = S.info.st, set = S.settings, W = evalWhere();
    const ev = await q1(`SELECT COUNT(*) AS n, COUNT(DISTINCT client_id) AS clients, SUM(y) AS pos, strftime(MIN(date), '%Y-%m-%d') AS dmin, strftime(MAX(date), '%Y-%m-%d') AS dmax, COUNT(DISTINCT date) AS days FROM data WHERE ${W}`);
    const span = Math.round((Date.parse(ev.dmax) - Date.parse(ev.dmin)) / 864e5) + 1;
    // label maturity heuristic: positive rate in the last `horizon` days vs earlier
    const H = set.horizon;
    const mat = await q1(`SELECT AVG(CASE WHEN date > (SELECT MAX(date) FROM data WHERE ${W}) - ${H} THEN y END) AS late, AVG(CASE WHEN date <= (SELECT MAX(date) FROM data WHERE ${W}) - ${H} THEN y END) AS early,
      COUNT(*) FILTER (WHERE date > (SELECT MAX(date) FROM data WHERE ${W}) - ${H}) AS nlate FROM data WHERE ${W}`);
    const splits = S.roles.split ? await q(`SELECT CAST(${qi(S.roles.split)} AS VARCHAR) AS v, COUNT(*) AS n FROM data WHERE ${W} GROUP BY 1`) : [];
    const vers = S.roles.version ? await q(`SELECT CAST(${qi(S.roles.version)} AS VARCHAR) AS v, COUNT(*) AS n FROM data WHERE ${W} GROUP BY 1`) : [];
    const dupEval = await q1(`SELECT COUNT(*) AS keys FROM (SELECT client_id, date FROM data WHERE ${W} GROUP BY 1, 2 HAVING COUNT(*) > 1)`);
    const rep = await q1(`SELECT AVG(c) AS mean, median(c) AS med, MAX(c) AS mx FROM (SELECT client_id, COUNT(*) AS c FROM data WHERE ${W} GROUP BY 1)`);
    const ov = await q1(`SELECT COUNT(*) AS posRows, COUNT(DISTINCT e.ep) AS eps FROM (SELECT __rid FROM data WHERE ${W}) d JOIN __ep e ON e.rid = d.__rid`);
    const postPurchase = await q1(`SELECT COUNT(*) AS n FROM (SELECT __rid FROM data WHERE ${W}) d JOIN __epi x ON x.rid = d.__rid WHERE x.epi > 0`);
    ev.posClients = (await q1(`SELECT COUNT(DISTINCT client_id) AS n FROM data WHERE ${W} AND y = 1`)).n;
    const C_ = [];
    const add = (group, name, status, evidence, link = null) => C_.push({ group, name, status, evidence, link });
    // ---- data integrity
    const badPct = S.info.invalid / S.info.total;
    add('Data integrity', 'Required fields', S.info.invalid === 0 ? 'good' : badPct < 0.01 ? 'warn' : 'bad',
      S.info.invalid === 0 ? `All ${fmtInt(S.info.total)} rows have a client, a parseable date, a recognised label and a numeric score.` : `${fmtInt(S.info.invalid)} of ${fmtInt(S.info.total)} rows (${fmtPct(badPct)}) are malformed and excluded from every analysis: ${S.info.reasons.map(r => `${esc(r.reason)} ${fmtInt(r.n)}`).join(', ')}.`, 'valid/invalid');
    add('Data integrity', 'Duplicate client-date keys', !S.info.dup.keys ? 'good' : 'warn',
      !S.info.dup.keys ? 'Each client has at most one row per date.' : `${fmtInt(S.info.dup.keys)} client-date keys appear more than once (${fmtInt(S.info.dup.rows)} rows; ${fmtInt(dupEval.keys)} in the evaluation population). They are kept; at row grain they count twice, and the unique-client grain uses the first by file order.`);
    add('Data integrity', 'Score range', S.info.sOut ? 'warn' : 'good', S.info.sOut ? `${fmtInt(S.info.sOut)} scores lie outside [0, 1]. Ranking metrics are unaffected; the score cannot be read as a probability.` : `All scores lie in [${fmtScore(st.smin)}, ${fmtScore(st.smax)}].`);
    if (st.sdistinct <= 1) add('Data integrity', 'Score variation', 'bad', 'PREDICTED_SCORE is constant: every ranking metric is at chance level.');
    if (S.roles.prob) add('Data integrity', 'Probability range', S.info.pOut || S.info.pBad ? 'warn' : 'good', S.info.pOut || S.info.pBad ? `${fmtInt(S.info.pOut + S.info.pBad)} probabilities are non-numeric or outside [0, 1] and ${fmtInt(S.info.pNull)} are missing; those rows are excluded from calibration only.` : `All ${fmtInt(st.pn)} probabilities lie in [0, 1]${S.info.pNull ? `; ${fmtInt(S.info.pNull)} missing` : ''}.`);
    // ---- evaluation design
    if (S.roles.split) {
      const only = splits.length === 1 ? splits[0].v : null;
      add('Evaluation design', 'Untouched temporal test set', only && /test/i.test(only) ? 'warn' : 'bad',
        only ? `The evaluation population contains only split = ${esc(only)}. Whether these rows were truly untouched during training, feature selection and calibration cannot be verified from a predictions file — confirm it in the training pipeline.`
          : `The evaluation population mixes splits (${splits.map(s => `${esc(s.v)}: ${fmtInt(s.n)}`).join(', ')}). Including training or validation rows inflates every metric. Restrict to the test split in Evaluation settings.`, 'settings');
    } else add('Evaluation design', 'Untouched temporal test set', 'na', 'Not assessed: there is no SPLIT column, and a predictions file alone cannot show that these rows were held out from training. Confirm the split in the training pipeline.');
    add('Evaluation design', 'Feature and label leakage', 'na', 'Not assessed: leakage (features computed with information after DATE_T, or the label leaking into features) can only be checked against the feature pipeline. The app excludes outcome-timing columns from its own diagnostics.');
    add('Evaluation design', 'Target construction', S.ep.source === 'estimated' ? 'na' : S.ep.bad || S.ep.beyond ? 'bad' : 'good',
      S.ep.source === 'estimated' ? `Partially assessed: without PURCHASE_DATE or DAYS_TO_CONVERSION the label window cannot be checked against real purchase dates. Purchases are estimated from runs of positive rows (each run spans at most ${H} days).`
        : S.ep.bad ? `${fmtInt(S.ep.bad)} positive rows have a purchase date on or before the prediction date — the label does not match a forward ${H}-day window.`
          : S.ep.beyond ? `${fmtInt(S.ep.beyond)} positive rows have a purchase more than ${H} days after the prediction date — inconsistent with the stated horizon.`
            : `Every positive row's purchase falls 1–${H} days after its prediction date (${S.ep.source}).`);
    add('Evaluation design', 'Mature outcome labels', set.labelsThrough ? 'good' : (fin(mat.late) && fin(mat.early) && mat.early > 0 && mat.late < 0.6 * mat.early ? 'warn' : 'na'),   // heuristic evidence only: never a hard failure
      set.labelsThrough ? `Only rows with DATE_T + ${H} ≤ ${set.labelsThrough} are evaluated, so every label's window has closed.`
        : fin(mat.late) && fin(mat.early) && mat.early > 0 && mat.late < 0.6 * mat.early ? `Not confirmed, and suspicious: the positive rate in the last ${H} days of the window (${fmtPct(mat.late)}) is ${fmtPct(1 - mat.late / mat.early, 0)} lower than before (${fmtPct(mat.early)}), the pattern expected when recent labels are still open (it can also reflect a change in population mix). Set “Labels observed through” to settle it.`
          : `Not assessed: the date through which purchases were observed is unknown. The positive rate in the last ${H} days (${fmtPct(mat.late)}) vs earlier (${fmtPct(mat.early)}) shows no obvious truncation. Set “Labels observed through” in Evaluation settings to enforce maturity.`, 'settings');
    add('Evaluation design', 'Repeated client-date observations', 'info', `Clients appear on ${fmtNum(rep.mean, 1)} dates on average (median ${fmtInt(rep.med)}, max ${fmtInt(rep.mx)}). Row-level metrics therefore weight frequently scored clients more, and rows are not independent: every interval in the app is clustered by client.`);
    add('Evaluation design', 'Overlapping outcome windows', 'info', `${fmtInt(ov.posRows)} positive rows point to ${fmtInt(ov.eps)} distinct purchases (${fmtNum(div(ov.posRows, ov.eps), 1)} rows per purchase) because consecutive dates share the same ${H}-day window. Row-level recall counts client-days; campaign capture counts each purchase once.`);
    add('Evaluation design', 'Consistent eligibility definition', postPurchase.n ? 'warn' : 'na', postPurchase.n ? `${fmtInt(postPurchase.n)} rows are dated after the client's own purchase (re-entry into the population). Use the “client episodes” grain to treat each eligibility episode separately; confirm that post-purchase clients are meant to be eligible.` : 'Not assessed beyond re-entry: the eligibility rules used to build the scoring population are not in the file. No rows are dated after the client\'s own purchase.');
    if (S.roles.version) add('Evaluation design', 'Single model version', vers.length === 1 ? 'good' : 'bad', vers.length === 1 ? `All evaluated rows come from model version ${esc(vers[0].v)}.` : `The evaluation population mixes ${vers.length} model versions. Pick one in Evaluation settings.`, 'settings');
    add('Evaluation design', 'Sampling', S.roles.prob || S.probFromScore ? 'na' : 'na', 'Not assessed: if negatives were downsampled when building this file, prevalence, precision and calibration are inflated relative to production; ranking order and ROC-AUC are not. Columns such as a sampling weight are excluded from analysis rather than applied.');
    add('Evaluation design', 'Long-term stability vs training', 'na', `Not assessed: the file covers ${fmtInt(span)} days of predictions and has no training-period reference. Stability is evaluated only within this window (Model Performance › Weekly / Monthly).`);
    return { ev, span, mat, checks: C_ };
  })();
  S.cache.set(key, p); return p;
}

RENDER.valid = async (el, v) => {
  const st = S.info.st;
  html(el, `
    ${pageHead('Data & Evaluation Validity', 'Does the data support the conclusions?', 'Schema, data quality, evaluation design and metric definitions. Checks that a predictions file cannot prove are marked <b>Not assessed</b>, never “passed”.')}
    <div id="vd-checks">${computing('Running checks…')}</div>
    ${sectionTitle('Upload and schema', 'schema')}
    <div class="grid g2">
      ${card('File', `<dl class="kv">
        <dt>File</dt><dd>${esc(S.file.name)}${S.isDemo ? ' ' + flag('synthetic') : ''}</dd>
        <dt>Rows in file</dt><dd>${fmtInt(S.info.total)}</dd><dt>Valid rows</dt><dd>${fmtInt(st.n)}</dd><dt>Excluded (malformed)</dt><dd>${fmtInt(S.info.invalid)}</dd>
        <dt>Columns</dt><dd>${fmtInt(S.rawCols.length)}</dd><dt>Positive label</dt><dd>${S.posValues.map(esc).join(', ')} <span class="faint">· negative: ${S.negValues.map(esc).join(', ')}</span></dd>
        <dt>Probabilities</dt><dd>${S.roles.prob ? `PREDICTED_PROBABILITY ← ${esc(S.roles.prob)}` : S.probFromScore ? 'PREDICTED_SCORE declared a probability' : 'none (ranking only)'}</dd>
        <dt>Purchase dates</dt><dd>${esc(S.ep.source)}</dd></dl>`, { actions: '<button class="btn sm" id="vd-remap">Change mapping…</button>' })}
      ${card('Column roles', `<table class="plain" style="font-size:13.5px"><tbody>${ROLE_DEFS.map(r => { const col = r.role in CONSUMED ? (r.role === 'prob' && !S.roles.prob ? null : S.roles[r.role]) : S.roles[r.role]; return `<tr><td class="mono" style="font-weight:600">${r.label}</td><td>${col ? `<span class="mono">${esc(r.role in CONSUMED ? S.rawCols.find(c => c.name === col)?.name || col : col)}</span>` : `<span class="dim">${r.req ? 'missing' : 'not mapped'}</span>`}</td></tr>`; }).join('')}</tbody></table>`)}
    </div>
    ${sectionTitle('Data integrity', 'integrity')}
    <div class="tiles" id="vd-tiles"></div>
    <div class="grid g2" style="margin-top:20px">
      ${card('Prediction-date coverage', '<div class="chart sm" id="vd-cov"></div>', { sub: 'Rows per prediction date (all valid rows; the evaluation window is shaded).' })}
      ${card('Positive rate by prediction date', '<div class="chart sm" id="vd-rate"></div>', { sub: `Labels in the last ${S.settings.horizon} days of a file are often incomplete; a drop at the end suggests immature labels.` })}
      ${card('Repeated-client frequency', '<div class="chart sm" id="vd-rep"></div>', { sub: 'Distinct prediction dates per client in the evaluation population.' })}
      ${card('Positive rows per purchase', '<div class="chart sm" id="vd-ovl"></div>', { sub: 'Overlapping outcome windows: one purchase makes several consecutive rows positive.' })}
    </div>
    ${card('Missing values by field', '<div id="vd-miss"></div>', { id: 'missing' })}
    <div class="card" style="margin-top:20px" id="invalid">${disc('Malformed rows (excluded)', '<div id="vd-inv"></div>', { cls: 'line', sub: `${fmtInt(S.info.invalid)} rows`, open: false })}</div>
    ${sectionTitle('Metric methodology', 'methodology')}
    <div class="card">${methodologyAccordion()}</div>
    ${sectionTitle('Self-checks', 'selfchecks', '<button class="btn sm" id="sc-run">Run self-checks</button>')}
    <div class="card"><p class="faint" style="margin:0 0 8px">Invariants that must hold if the calculations are implemented correctly, run on the current data. Independent SQL calculations are compared with the engine.</p><div id="sc-out" class="faint">Not run yet.</div></div>`);
  $('#vd-remap').onclick = async () => { const e = wsActive(); if (e) { e.saved = captureState(); await beginMapping(e, e); } };
  $('#sc-run').onclick = () => runSelfChecks($('#sc-out'));
  if (!S.pop || !S.pop.n) { html($('#vd-checks'), callout('warn', 'The evaluation population is empty under the current settings; population checks are skipped.')); return; }
  const V = await validityChecks(); if (stale(v)) return;
  const groups = [...new Set(V.checks.map(c => c.group))];
  const lab = { good: 'Passed', warn: 'Concern', bad: 'Failed', na: 'Not assessed', info: 'Information' };
  html($('#vd-checks'), groups.map(g => card(g, `<ul class="checks">${V.checks.filter(c => c.group === g).map(c => `<li>${statusPill(c.status, lab[c.status])}<div class="c-body"><b>${esc(c.name)}</b><div class="c-detail">${c.evidence}${c.link === 'settings' ? ` <button class="link-btn" data-open-settings>Evaluation settings</button>` : ''}</div></div></li>`).join('')}</ul>`)).join(''));
  $$('[data-open-settings]').forEach(b => b.onclick = () => openSettings());
  const ev = V.ev;
  html($('#vd-tiles'), [
    tile('Rows evaluated', fmtInt(ev.n), { sub: `of ${fmtInt(st.n)} valid rows · ${fmtInt(S.info.total)} in file` }),
    tile('Distinct clients', fmtInt(ev.clients), { sub: `${fmtNum(div(ev.n, ev.clients), 1)} rows per client` }),
    tile('Positive rows', fmtInt(ev.pos), { sub: `prevalence ${fmtPct(div(ev.pos, ev.n))} (row level)` }),
    tile('Clients with a positive', fmtInt(ev.posClients), { sub: 'distinct clients (not rows)' }),
    tile('Purchases', fmtInt(S.ep.eps), { sub: `${S.ep.source === 'estimated' ? 'estimated dates' : S.ep.source} · whole file` }),
    tile('Prediction dates', fmtInt(ev.days), { sub: `${ev.dmin} → ${ev.dmax} (${fmtInt(V.span)} days)` }),
    tile('Duplicate keys', fmtInt(S.info.dup.keys), { sub: 'client-date pairs repeated' }),
    tile('Malformed rows', fmtInt(S.info.invalid), { sub: S.info.invalid ? 'excluded, listed below' : 'none' }),
  ].join(''));
  const W = evalWhere(), c = C();
  const cov = await q(`SELECT strftime(date, '%Y-%m-%d') AS d, COUNT(*) AS n, AVG(y) AS r, BOOL_OR(${W}) AS inEval FROM data GROUP BY 1 ORDER BY 1`);
  const rep = await q(`SELECT c, COUNT(*) AS k FROM (SELECT client_id, COUNT(DISTINCT date) AS c FROM data WHERE ${W} GROUP BY 1) GROUP BY 1 ORDER BY 1`);
  const ovl = await q(`SELECT c, COUNT(*) AS k FROM (SELECT ep, COUNT(*) AS c FROM __ep GROUP BY 1) GROUP BY 1 ORDER BY 1`);
  if (stale(v)) return;
  const shade = [{ type: 'rect', xref: 'x', yref: 'paper', x0: S.settings.d0, x1: S.settings.d1, y0: 0, y1: 1, fillcolor: rgba(c.s1, 0.06), line: { width: 0 } }];
  plot($('#vd-cov'), [{ x: cov.map(r => r.d), y: cov.map(r => r.n), type: 'bar', marker: { color: cov.map(r => (r.inEval ? c.s1 : c.base)) }, hovertemplate: '%{x}<br>%{y:,} rows<extra></extra>' }], { xaxis: { type: 'date', title: { text: 'Prediction date' } }, yaxis: { title: { text: 'Rows' } }, showlegend: false, shapes: shade, bargap: 0.15 });
  plot($('#vd-rate'), [{ x: cov.map(r => r.d), y: cov.map(r => r.r), mode: 'lines', line: { color: c.s1, width: 2 }, hovertemplate: '%{x}<br>%{y:.2%} positive<extra></extra>' }], { xaxis: { type: 'date', title: { text: 'Prediction date' } }, yaxis: { title: { text: 'Positive rate' }, tickformat: '.1%', rangemode: 'tozero' }, showlegend: false, shapes: shade });
  plot($('#vd-rep'), [{ x: rep.map(r => r.c), y: rep.map(r => r.k), type: 'bar', marker: { color: c.s1 }, hovertemplate: '%{x} dates: %{y:,} clients<extra></extra>' }], { xaxis: { title: { text: 'Prediction dates per client' } }, yaxis: { title: { text: 'Clients' } }, showlegend: false, bargap: 0.15 });
  plot($('#vd-ovl'), [{ x: ovl.map(r => r.c), y: ovl.map(r => r.k), type: 'bar', marker: { color: c.s1 }, hovertemplate: '%{x} positive rows: %{y:,} purchases<extra></extra>' }], { xaxis: { title: { text: 'Positive rows per purchase' } }, yaxis: { title: { text: 'Purchases' } }, showlegend: false, bargap: 0.15 });
  // missing values by field
  const cols = S.schema.cols.filter(cc => !cc.name.startsWith('__'));
  const mv = await q1(`SELECT ${cols.map((cc, i) => `COUNT(*) - COUNT(${qi(cc.name)}) AS m${i}`).join(', ')}, COUNT(*) AS n FROM data`);
  if (stale(v)) return;
  const roleOf = n => { const r = Object.keys(S.roles).find(k => S.roles[k] === n); return r ? ROLE[r]?.label : ({ client_id: 'CLIENT_ID', date: 'DATE_T', y: 'CONVERSION_TARGET', score: 'PREDICTED_SCORE', prob: S.hasProb ? 'PREDICTED_PROBABILITY' : '' })[n] || ''; };
  const treat = n => { const s = S.disc.segments.find(x => x.name === n), f = S.disc.features.find(x => x.name === n), e = S.disc.excluded.find(x => x.name === n); return s ? 'segment' : f ? (f.kind === 'num' ? 'numeric feature' : 'categorical feature') : e ? 'excluded' : roleOf(n) ? 'role' : ''; };
  renderTable($('#vd-miss'), { rows: cols.map((cc, i) => ({ col: cc.name, type: cc.type.toLowerCase(), role: roleOf(cc.name), treat: treat(cc.name), missing: mv['m' + i], share: div(mv['m' + i], mv.n) })).filter(r => !(r.col === 'prob' && !S.hasProb)),
    exportName: 'missing_values', maxRows: 40, sort: { key: 'share', dir: -1 }, note: 'Missing values are reported, never filled in. Required fields cannot be missing in valid rows.',
    columns: [{ key: 'col', label: 'Column', fmt: x => `<span class="mono">${esc(x)}</span>` }, { key: 'role', label: 'Role' }, { key: 'treat', label: 'Used as' }, { key: 'type', label: 'Type' }, { key: 'missing', label: 'Missing', num: true, fmt: fmtInt }, { key: 'share', label: 'Share missing', num: true, fmt: (x, r) => `${fmtPct(x)}${/PURCHASE_DATE|DAYS_TO_CONVERSION/.test(r.role) ? ' <span class="ci-inline">expected for non-converters</span>' : ''}`, cls: r => (r.share > 0.5 && !/PURCHASE_DATE|DAYS_TO_CONVERSION/.test(r.role) ? 'bad' : '') }] });
  if (S.info.invalid) {
    const inv = await q(`SELECT * FROM __invalid LIMIT 2000`);
    renderTable($('#vd-inv'), { rows: inv, exportName: 'malformed_rows', maxRows: 100, columns: Object.keys(inv[0] || {}).slice(0, 14).map(k => ({ key: k, label: k, fmt: x => (x === null ? '<span class="dim">null</span>' : esc(x)) })), note: `${fmtInt(S.info.invalid)} malformed rows; up to 20,000 are kept in memory for inspection (first 14 columns shown, export has all kept rows).` });
  } else html($('#vd-inv'), '<div class="faint">No malformed rows.</div>');
  scrollToSection();
};
function methodologyAccordion() {
  const item = (t, b, id) => disc(t, `<div class="methodology">${b}</div>`, { cls: 'line', id });
  return [
    item('Precision', `<p><b>Precision = true positives ÷ (true positives + false positives)</b> — the share of the selected audience with a positive outcome. Denominator: selected records. At top-X capacity, the first ceil(X × N) records in score order. At row grain a converter can be selected on several dates, each counting as a separate true positive.</p>`, 'm-precision'),
    item('Recall', `<p><b>Recall = true positives ÷ (true positives + false negatives)</b> — the share of all positive records in the evaluation cohort that the selection captured. Denominator: every positive record in the cohort, selected or not. At row grain this counts converter-days; the unique-client grain counts people; campaign capture counts purchases.</p>`, 'm-recall'),
    item('Lift', `<p><b>Lift = precision of the selected group ÷ prevalence of the eligible comparison population.</b> The baseline is always stated next to the number (the evaluation population's prevalence, or the campaign pool's base rate). Lift of 5× means five times the observed conversion rate of the baseline — it does not mean marketing caused five times as many conversions.</p>`, 'm-lift'),
    item('PR-AUC (average precision)', `<p>AP = Σₙ (Rₙ − Rₙ₋₁) Pₙ over distinct score thresholds, i.e. precision averaged over the recall gained at each threshold, with tied scores forming one threshold (identical to scikit-learn's average_precision_score). A random ranking scores the prevalence, so PR-AUC must be read relative to it — and it is not comparable across populations with different prevalence.</p>`, 'm-ap'),
    item('ROC-AUC', `<p>The probability that a randomly chosen positive record scores above a randomly chosen negative one, with ties counted as ½ (Mann–Whitney). Insensitive to prevalence, so it is comparable across segments and periods, but it says little about the very top of the ranking where targeting happens.</p>`, 'm-auc'),
    item('Calibration metrics', `<p>Computed only for valid probabilities. Reliability diagram (mean predicted vs observed per bin), Brier score, log loss, calibration slope and intercept from logistic recalibration, calibration-in-the-large, mean predicted ÷ observed, and ECE with its binning stated. See Model Performance › Calibration for formulas.</p>`, 'm-cal'),
    item('Pooled vs mean period metrics', `<p><b>Pooled</b>: one calculation over every record in the window. <b>Mean period</b>: the metric computed inside each day / week / month, then the unweighted mean of the periods where it is defined, with the number of contributing periods reported. They differ by construction (pooling lets strong periods dominate the top of the ranking) and are never interchangeable.</p>`, 'm-pooled'),
    item('Row-level vs unique-client evaluation', `<p><b>Client-date rows</b>: every eligible row. Repeated rows of one client are not independent, so all intervals are clustered by client. <b>Unique clients</b>: one index record per client — the first eligible prediction date in the window (or in each period) — with its own outcome label. Never built by dropping duplicate IDs or by taking the maximum score. <b>Client episodes</b>: as unique clients, restarting after each purchase if the client re-enters the population.</p>`, 'm-grain'),
    item('Campaign-level conversion capture', `<p>In the Targeting Simulator a purchase (conversion episode) is counted once per strategy, however many contacts preceded it and however many overlapping 14-day labels point at it. Contact attempts and unique clients are reported separately. Capture rate = distinct captured purchases ÷ distinct purchases reachable by any strategy; it is never summed across sends.</p>`, 'm-campaign'),
    item('Ties and exact audience sizes', `<p>Records are ordered by score, then by a fixed hash of client ID and date, then by row. Top-X audiences are therefore exact (K = ceil(X × N)) and reproducible; the capacity table reports how many records share the score at each cutoff. AUC and PR-AUC treat tied scores as one threshold and do not depend on the tie-break.</p>`, 'm-ties'),
    item('Uncertainty', `<p>Rates (prevalence, precision, recall, bin rates): ratio-estimator variance clustered by client, converted to an effective sample size for a 95% Wilson interval. Pooled ROC-AUC / PR-AUC: client-block Poisson bootstrap (200 resamples, fewer for very large files). Lift intervals: precision interval ÷ prevalence. Experimental arm differences: Wald interval at the unique-client grain. Small samples are flagged rather than hidden.</p>`, 'm-ci'),
  ].join('');
}

/* ------------------------------------------------------------ self-checks */
async function runSelfChecks(host) {
  html(host, `<span class="computing"><span class="spinner"></span>Running…</span>`);
  const out = [], ok = (name, pass, detail) => out.push({ name, pass, detail });
  const near = (a, b, tol = 1e-9) => fin(a) && fin(b) && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  try {
    const W = evalWhere();
    const M = await eng({ type: 'metrics', spec: { grain: 'row', gran: 'overall', withCalibration: false } });
    // 1. population size and positives: engine vs SQL
    const sq = await q1(`SELECT COUNT(*) AS n, SUM(y) AS pos FROM data WHERE ${W}`);
    ok('Evaluation population: engine = SQL', M.n === sq.n && M.pos === sq.pos, `engine ${fmtInt(M.n)} rows / ${fmtInt(M.pos)} positive · SQL ${fmtInt(sq.n)} / ${fmtInt(sq.pos)}`);
    // 2. ROC-AUC by independent SQL rank-sum (average ranks for ties)
    const rs = await q1(`SELECT SUM(CASE WHEN y = 1 THEN rk ELSE 0 END) AS rsum, SUM(y) AS P, COUNT(*) - SUM(y) AS N FROM (SELECT y, rank() OVER (ORDER BY score) + (COUNT(*) OVER (PARTITION BY score) - 1) / 2.0 AS rk FROM data WHERE ${W})`);
    const aucSQL = rs.P && rs.N ? (rs.rsum - rs.P * (rs.P + 1) / 2) / (rs.P * rs.N) : null;
    ok('ROC-AUC: engine = SQL rank-sum (Mann–Whitney)', near(M.auc, aucSQL, 1e-7), `engine ${fmtNum(M.auc, 6)} · SQL ${fmtNum(aucSQL, 6)}`);
    // 3. top-10% with the same tie-break computed in SQL
    const t10 = await q1(`SELECT COUNT(*) AS k, SUM(y) AS tp FROM (SELECT y, row_number() OVER (ORDER BY score DESC, __hb, __rid) AS rn, COUNT(*) OVER () AS n FROM data WHERE ${W}) WHERE rn <= CEIL(0.1 * n - 1e-9)`);
    ok('Top 10%: exact size and true positives match SQL', M.capacity[2].sel === t10.k && M.capacity[2].tp === t10.tp, `engine K = ${fmtInt(M.capacity[2].sel)}, TP = ${fmtInt(M.capacity[2].tp)} · SQL K = ${fmtInt(t10.k)}, TP = ${fmtInt(t10.tp)}`);
    // 4. 100% selection: precision = prevalence, lift = 1, recall = 1
    const all = await eng({ type: 'playground', spec: { grain: 'row', rule: { type: 'pct', value: 1 } } });
    ok('Selecting 100%: precision = prevalence, lift = 1, recall = 1', near(all.precision, all.prev) && near(all.lift, 1) && near(all.recall, 1), `precision ${fmtPct(all.precision, 4)} · prevalence ${fmtPct(all.prev, 4)} · lift ${fmtNum(all.lift, 6)} · recall ${fmtNum(all.recall, 6)}`);
    // 5. unique-client grain: one unit per client = SQL first-date rule
    const cu = await eng({ type: 'units', spec: { grain: 'client' } });
    const cs = await q1(`SELECT COUNT(*) AS n, SUM(y) AS pos FROM (${unitSQL('client', 'y')})`);
    ok('Unique-client grain: one index record per client (engine = SQL)', cu.n === cs.n && cu.pos === cs.pos && cu.n === S.pop.clients, `engine ${fmtInt(cu.n)} clients / ${fmtInt(cu.pos)} positive · SQL ${fmtInt(cs.n)} / ${fmtInt(cs.pos)} · distinct clients ${fmtInt(S.pop.clients)}`);
    const eu = await eng({ type: 'units', spec: { grain: 'episode' } });
    const es = await q1(`SELECT COUNT(*) AS n FROM (${unitSQL('episode', 'y')})`);
    ok('Episode grain: engine = SQL', eu.n === es.n, `engine ${fmtInt(eu.n)} · SQL ${fmtInt(es.n)} episodes`);
    // 6. repeated rows do not become unique clients silently
    ok('Row grain is not deduplicated', M.n === S.pop.n && M.n >= cu.n, `${fmtInt(M.n)} rows vs ${fmtInt(cu.n)} unique clients`);
    // 7. weekly: period counts add up to the pooled population (row grain)
    const Wk = await eng({ type: 'metrics', spec: { grain: 'row', gran: 'week' } });
    const sumN = Wk.periods.reduce((a, p) => a + p.n, 0), sumP = Wk.periods.reduce((a, p) => a + p.pos, 0);
    ok('Weekly periods partition the population', sumN === M.n && sumP === M.pos, `Σ weekly rows ${fmtInt(sumN)} = ${fmtInt(M.n)}; Σ positives ${fmtInt(sumP)} = ${fmtInt(M.pos)}`);
    // 8. campaign deduplication invariants
    const camp = await eng({ type: 'campaign', spec: { d0: dayIdx(S.settings.d0), d1: dayIdx(S.settings.d1), cadence: 'daily', freshDays: 0, rescoreEvery: 0, lag: 1, horizon: S.settings.horizon, audience: { type: 'pct', value: 0.1 }, cooldown: 0, maxContacts: 0, suppress: false, randomRuns: 1, locCap: 0, locCol: -1,
      strategies: [{ id: 'topx', kind: 'topx', label: 'top' }] } });
    const m = camp.results[0].matched;
    ok('Campaign: purchases captured ≤ reachable ≤ purchases in file; contacts ≥ unique clients', m.episodesCaptured <= camp.ctx.reachable && camp.ctx.reachable <= S.ep.eps && m.contacts >= m.uniqueClients && m.convClients <= m.uniqueClients,
      `${fmtInt(m.episodesCaptured)} captured ≤ ${fmtInt(camp.ctx.reachable)} reachable ≤ ${fmtInt(S.ep.eps)} purchases; ${fmtInt(m.contacts)} contacts ≥ ${fmtInt(m.uniqueClients)} clients`);
    ok('Campaign: converting contacts ≥ captured purchases (repeat contacts never inflate the count)', m.convContacts >= m.episodesCaptured, `${fmtInt(m.convContacts)} converting contacts → ${fmtInt(m.episodesCaptured)} distinct purchases`);
    // 9. episodes consistent with labels
    ok('Every positive row has a purchase date after its prediction date', !S.ep.bad, S.ep.bad ? `${fmtInt(S.ep.bad)} positive rows have purchase date ≤ prediction date` : `${fmtInt(S.ep.eps)} purchases (${S.ep.source})`);
    // 10. calibration only with valid probabilities
    ok('Calibration is computed only for valid probabilities', S.hasProb ? true : !(await eng({ type: 'calibration', spec: { grain: 'row' } })), S.hasProb ? 'probabilities available (mapped or declared)' : 'no probabilities → calibration returns nothing');
  } catch (e) { out.push({ name: 'Self-check run', pass: false, detail: e.message }); }
  html(host, `<ul class="checks">${out.map(c => `<li>${statusPill(c.pass ? 'good' : 'bad', c.pass ? 'Pass' : 'Fail')}<div class="c-body"><b>${esc(c.name)}</b><div class="c-detail">${esc(c.detail)}</div></div></li>`).join('')}</ul>`);
  return out;
}
