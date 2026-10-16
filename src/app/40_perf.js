/* ==========================================================================
   40 · MODEL PERFORMANCE
   Overall / daily / weekly / monthly × client-date rows / unique clients / episodes.
   Every number comes from the engine (one ranking implementation).
   ========================================================================== */
const KS = [0.01, 0.05, 0.10, 0.20, 0.30];
const bootN = n => (n > 2e6 ? 50 : n > 5e5 ? 100 : 200);
const GRAIN_OPTS = [{ v: 'row', label: 'Client-date rows', tip: TIPS.grain_row }, { v: 'client', label: 'Unique clients', tip: TIPS.grain_client }, { v: 'episode', label: 'Client episodes', tip: TIPS.grain_episode }];
const unitWord = g => ({ row: 'rows', client: 'clients', episode: 'episodes' }[g]);
/** Period words spelled out explicitly (never built by appending “ly” to the noun). */
const PERIOD_ADJ = { day: 'daily', week: 'weekly', month: 'monthly', daily: 'daily', weekly: 'weekly', monthly: 'monthly' };
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);

const METHOD = {
  ranking: `<div class="methodology">
    <h4>Ranking order and ties</h4><p>Records are sorted by PREDICTED_SCORE, highest first. Records with exactly the same score are ordered by a fixed hash of (CLIENT_ID, DATE_T), then by row. The order is identical every time the file is loaded, so every top-X audience has an exact, reproducible size: <code>K = ceil(X × N)</code>. The capacity table reports how many records share the score at each cutoff; only the tie-break decides which of those are in the audience. ROC-AUC and PR-AUC treat tied scores as a single threshold (ties share credit), so they never depend on the tie-break.</p>
    <h4>Definitions and denominators</h4><ul>
      <li><b>Precision@X</b> = true positives in the top X% ÷ records in the top X% (K).</li>
      <li><b>Recall@X</b> = true positives in the top X% ÷ all positive records in the evaluation population.</li>
      <li><b>Lift@X</b> = Precision@X ÷ prevalence of the same evaluation population (the baseline is always the population being ranked).</li>
      <li><b>PR-AUC</b> (average precision) = Σ over distinct score thresholds of precision × increase in recall. A random ranking scores the prevalence, so read it as a multiple of prevalence.</li>
      <li><b>ROC-AUC</b> = probability a random positive record outranks a random negative one (ties = ½).</li>
      <li><b>Gains curve</b>: share of positives captured (recall) against share of records targeted.</li></ul>
    <h4>Evaluation grain</h4><ul>
      <li><b>Client-date rows</b>: every eligible row is a record. One converter is positive on several consecutive dates (overlapping 14-day windows), so recall counts client-days, not people.</li>
      <li><b>Unique clients</b>: one index record per client — the client's <i>first</i> eligible prediction date in the window (or in each period). Its own label is the outcome within the horizon after that date. This is a prospective cohort design; the maximum score across the window is never used.</li>
      <li><b>Client episodes</b>: like unique clients, but a client who purchased and later re-entered the eligible population starts a new episode at its first row after the purchase.</li></ul>
    <h4>Uncertainty</h4><p>Precision, recall and prevalence intervals use a client-clustered ratio variance (a client's repeated rows are not independent), converted to an effective sample size for a Wilson interval. Lift intervals divide the precision interval by the prevalence (prevalence treated as fixed). Pooled ROC-AUC and PR-AUC intervals come from a client-block bootstrap: each resample gives every client a Poisson(1) weight, so all of a client's rows move together. All intervals are 95%.</p></div>`,
  periods: `<div class="methodology">
    <h4>How periods are formed</h4><p>Periods group records by DATE_T (the prediction date) as a calendar date — no timezone conversion. Daily = one calendar date; weekly = Monday–Sunday (ISO weeks, labelled by the Monday); monthly = calendar month. Every metric is computed independently inside each period: its own ranking, its own top 10%, its own prevalence. For unique clients and episodes the index record is the client's first eligible record <i>within that period</i>.</p>
    <h4>Mean period vs pooled</h4><p><b>Mean period performance</b> is the unweighted mean of the period values where the metric is defined (periods without positives, or without negatives, are excluded and counted). <b>Pooled</b> computes the metric once over all records in the same window. They answer different questions and are not interchangeable: pooled lets high-scoring periods take more than their share of the top 10%; the mean gives every period equal weight.</p>
    <h4>Reliability</h4><p>A period with fewer positives than the minimum (Evaluation settings) is flagged <i>low-confidence</i>: its values are shown (hollow markers) but are noisy. Intervals use the client-clustered method described under Ranking. To tell real degradation from population change, compare Precision@10% with prevalence and Lift@10%: if precision falls while lift holds, the change is mostly a change in the base rate, not in ranking quality.</p>
    <h4>Score drift (PSI)</h4><p>The Population Stability Index compares each period's score distribution with the reference period(s), using the reference deciles as bins. It describes change <i>within the uploaded file</i>; it says nothing about drift against the training data, which is not available here.</p></div>`,
  calibration: `<div class="methodology">
    <h4>When calibration is computed</h4><p>Only for valid probabilities: a mapped PREDICTED_PROBABILITY column, or a PREDICTED_SCORE explicitly declared to be a calibrated probability at upload. Rows whose probability is missing or outside [0, 1] are excluded from these metrics and counted. The app never fits a calibrator on the evaluation rows.</p>
    <h4>Metrics</h4><ul>
      <li><b>Reliability diagram</b>: records sorted by predicted probability and cut into equal-count bins (or fixed probability bands); each point is the bin's mean predicted probability vs its observed conversion rate, with a client-clustered 95% interval.</li>
      <li><b>Brier score</b> = mean (p − y)². Reference = prevalence × (1 − prevalence), the score of always predicting the prevalence.</li>
      <li><b>Log loss</b> = mean −[y·log p + (1−y)·log(1−p)], with p clipped to [1e−15, 1 − 1e−15].</li>
      <li><b>Calibration slope</b> b and <b>intercept</b> from logistic recalibration logit P(y) = a + b·logit(p) (IRLS). <b>Calibration-in-the-large</b> is a with b fixed at 1. Ideal: slope 1, intercept 0.</li>
      <li><b>Mean predicted ÷ observed</b>: 1 = right on average.</li>
      <li><b>ECE</b> = count-weighted mean |mean predicted − observed| across the equal-count bins. It depends on the number of bins and is biased upward with few positives per bin; use it as a summary, not a test.</li></ul>
    <p>Point estimates for the summary metrics are reported without intervals. Rows of the same client are not independent; the per-bin intervals account for that.</p></div>`,
};

RENDER.perf = async (el, v) => {
  const U = (S.ui.perf ||= { sub: 'ranking', calBins: 10, calMode: 'quantile', calLog: true, pg: { type: 'pct', pct: 0.10, n: null, raw: null, prob: null }, refFrom: null, refTo: null });
  const E = S.eval;
  const period = E.gran !== 'overall';
  if (period && U.sub === 'ranking') U.sub = 'time';
  if (!period && U.sub === 'time') U.sub = 'ranking';
  html(el, `
    ${pageHead('Model Performance', 'How well does the model rank future converters?', 'Ranking quality, targeting trade-offs and probability calibration on the evaluation population. Choose how records are counted and whether to evaluate the whole window or each period on its own.')}
    <div class="toolbar">
      <span class="toolbar-label">Granularity</span>${segHTML('gran', [{ v: 'overall', label: 'Overall' }, { v: 'day', label: 'Daily' }, { v: 'week', label: 'Weekly' }, { v: 'month', label: 'Monthly' }], E.gran)}
      <span class="toolbar-label" style="margin-left:12px">Evaluation grain</span>${segHTML('grain', GRAIN_OPTS, E.grain)}
    </div>
    <div id="pf-grainnote"></div>
    <div class="subnav">${segHTML('sub', [{ v: period ? 'time' : 'ranking', label: period ? 'Over time' : 'Ranking' }, { v: 'play', label: 'Threshold & top-X playground' }, { v: 'cal', label: 'Calibration' }], U.sub, 'lg')}</div>
    <div id="pf-body"></div>`);
  bindSeg(el, 'gran', async g => { S.eval.gran = g; S.rendered.exec = null; await renderActive(true); });
  bindSeg(el, 'grain', async g => { S.eval.grain = g; S.rendered.exec = null; S.rendered.seg = null; await renderActive(true); });
  bindSeg(el, 'sub', async s => { U.sub = s; await renderPerfBody(v); });
  await renderPerfBody(v);
};

async function renderPerfBody(v) {
  const U = S.ui.perf, E = S.eval, body = $('#pf-body');
  const gi = await engCached('units', { grain: E.grain }, 'Counting evaluation units…'); if (stale(v)) return;
  html($('#pf-grainnote'), callout('neutral', `<b>${grainLabel(E.grain)}.</b> ${TIPS['grain_' + E.grain]} ${E.grain !== 'row' ? `Here: ${fmtInt(gi.n)} ${unitWord(E.grain)} from ${fmtInt(S.pop.n)} eligible rows.` : `Here: ${fmtInt(gi.n)} rows from ${fmtInt(S.pop.clients)} clients.`}`));
  if (U.sub === 'ranking') return perfOverall(body, v);
  if (U.sub === 'time') return perfPeriods(body, v);
  if (U.sub === 'play') return perfPlayground(body, v);
  return perfCalibration(body, v);
}

/** Confusion matrix: counts and % of all records, with the rates that follow from it. */
function confusionMatrixHTML({ tp, fp, fn, tn, unit = 'records', selLabel = 'Selected (targeted)', notLabel = 'Not selected' }) {
  const N = tp + fp + fn + tn, P = tp + fn, K = tp + fp;
  const cell = (cls, key, n, desc) => `<td class="cell ${cls}"><div class="k">${key}</div><div class="n">${fmtInt(n)}</div><div class="p">${fmtPct(div(n, N))} of all ${unit}</div><div class="d">${desc}</div></td>`;
  const rate = (label, val, formula) => `<div class="r"><span>${label}<small>${formula}</small></span><span>${val}</span></div>`;
  return `<div class="cm-wrap"><div style="overflow-x:auto"><table class="cmx" aria-label="Confusion matrix">
      <thead><tr><th></th><th class="axis" colspan="2">What the model did</th><th></th></tr>
        <tr><th class="axis" style="text-align:right">What happened</th><th>${esc(selLabel)}</th><th>${esc(notLabel)}</th><th>Total</th></tr></thead>
      <tbody>
        <tr><th class="rowh">Converted</th>${cell('ok', 'True positive', tp, 'converter we would reach')}${cell('err', 'False negative', fn, 'converter we would miss')}<td class="tot"><b>${fmtInt(P)}</b><br>${fmtPct(div(P, N))}</td></tr>
        <tr><th class="rowh">Did not convert</th>${cell('err', 'False positive', fp, 'contact with no purchase')}${cell('ok', 'True negative', tn, 'correctly left out')}<td class="tot"><b>${fmtInt(N - P)}</b><br>${fmtPct(div(N - P, N))}</td></tr>
        <tr><th class="rowh">Total</th><td class="tot"><b>${fmtInt(K)}</b><br>${fmtPct(div(K, N))}</td><td class="tot"><b>${fmtInt(N - K)}</b><br>${fmtPct(div(N - K, N))}</td><td class="tot"><b>${fmtInt(N)}</b><br>100%</td></tr>
      </tbody></table></div>
    <div class="cm-rates">
      ${rate('Precision', fmtPct(div(tp, K)), 'TP ÷ (TP + FP) — share of the selection that converted')}
      ${rate('Recall', fmtPct(div(tp, P)), 'TP ÷ (TP + FN) — share of converters reached')}
      ${rate('False positive rate', fmtPct(div(fp, fp + tn)), 'FP ÷ (FP + TN) — non-converters selected')}
      ${rate('Prevalence', fmtPct(div(P, N)), '(TP + FN) ÷ all — the base rate')}
      ${rate('Accuracy', fmtPct(div(tp + tn, N)), '(TP + TN) ÷ all — misleading for rare events: selecting nobody scores ' + fmtPct(div(N - P, N)))}
    </div></div>`;
}

/* ------------------------------------------------------------ overall */
async function perfOverall(body, v) {
  const E = S.eval;
  html(body, computing('Ranking the evaluation population…'));
  const M = await engCached('metrics', { grain: E.grain, gran: 'overall', ks: KS, withCalibration: false }, 'Computing ranking metrics…'); if (stale(v)) return;
  if (!M.n) { html(body, empty('No evaluation records')); return; }
  const single = !M.pos || M.pos === M.n;
  const c10 = M.capacity[2];
  const uw = unitWord(E.grain);
  html(body, `
    ${single ? callout('bad', `The evaluation population has ${M.pos ? 'no negative' : 'no positive'} records, so ranking metrics are undefined.`) : ''}
    <div class="tiles" id="pf-tiles"></div>
    <div class="chart-note" id="pf-boot"><span class="computing"><span class="spinner"></span>Computing bootstrap intervals for ROC-AUC and PR-AUC…</span></div>
    ${sectionTitle('Ranking curves', 'curves')}
    <div class="grid g2">
      ${card('Precision–recall curve', '<div class="chart" id="pf-pr"></div>', { sub: `Dashed line: prevalence ${fmtPct(M.prev)} (what a random ranking achieves). Precision on a log scale.`, tipKey: 'pr_auc' })}
      ${card('ROC curve', '<div class="chart" id="pf-roc"></div>', { sub: 'Dashed diagonal: random ranking.', tipKey: 'roc_auc' })}
      ${card('Cumulative gains', '<div class="chart" id="pf-gain"></div>', { sub: `Share of positive ${uw} captured when targeting the top X% of ${uw}.`, tipKey: 'recall' })}
      ${card('Lift by decile', '<div class="chart" id="pf-lift"></div>', { sub: `Bars: lift <i>inside</i> each tenth of the ranking (D2 = ${uw} ranked 10–20%). Line: lift of the whole top X% — the number in the capacity table below. Both ÷ prevalence; 1× = random.`, tipKey: 'lift' })}
    </div>
    ${sectionTitle('Targeting capacity', 'capacity')}
    ${card('', `<div id="pf-cap"></div>`, { sub: '' })}
    ${card('Confusion matrix', '<div id="pf-cm"></div>', { id: 'confusion', sub: `Targeting the top X% of ${uw} by score: how the selection splits into converters reached, converters missed, wasted contacts and correctly skipped ${uw}.`, actions: segHTML('cmk', KS.map(k => ({ v: String(k), label: 'Top ' + fmtPct(k, 0) })), String(S.ui.perf.cmK || 0.1)) })}
    <div class="card" style="margin-top:20px">
      ${disc('Decile table', '<div id="pf-dec"></div>', { cls: 'line', sub: 'equal-count tenths of the ranking' })}
      ${disc('Score distribution by outcome', '<div class="chart" id="pf-hist"></div><div class="chart-note">Each class is normalised to its own total so the rare positive class is visible.</div>', { cls: 'line' })}
      ${disc('Methodology: ranking metrics, ties and intervals', METHOD.ranking, { cls: 'line', id: 'method-ranking' })}
    </div>`);
  const drawTiles = (B) => {
    const ci = (c, f) => (c && fin(c.lo) ? `95% CI ${f(c.lo)} – ${f(c.hi)}` : '');
    html($('#pf-tiles'), [
      tile('PR-AUC', fmtNum(M.ap), { tipKey: 'pr_auc', ci: B ? ci(B.ap, x => fmtNum(x)) : '', sub: M.prev ? `${fmtX(div(M.ap, M.prev), 1)} the prevalence` : '', hl: true }),
      tile('ROC-AUC', fmtNum(M.auc), { tipKey: 'roc_auc', ci: B ? ci(B.auc, x => fmtNum(x)) : '', sub: 'random = 0.500' }),
      tile('Precision@10%', fmtPct(c10.precision), { tipKey: 'precision', ci: ci({ lo: c10.precLo, hi: c10.precHi }, fmtPct), sub: `${fmtInt(c10.tp)} of ${fmtInt(c10.sel)} ${uw}` }),
      tile('Recall@10%', fmtPct(c10.recall), { tipKey: 'recall', ci: ci({ lo: c10.recLo, hi: c10.recHi }, fmtPct), sub: `of ${fmtInt(M.pos)} positive ${uw}` }),
      tile('Lift@10%', fmtX(c10.lift, 1), { tipKey: 'lift', ci: ci({ lo: c10.liftLo, hi: c10.liftHi }, x => fmtX(x, 1)), sub: 'vs the population prevalence' }),
      tile('Prevalence', fmtPct(M.prev), { tipKey: 'prevalence', ci: ci({ lo: M.prevLo, hi: M.prevHi }, fmtPct), sub: `${fmtInt(M.pos)} positive of ${fmtInt(M.n)} ${uw}` }),
      tile('Clients', fmtInt(M.clients), { tipKey: 'clients', sub: `${fmtInt(M.convClients)} with a positive record` }),
      tile('Purchases', fmtInt(M.episodes), { tipKey: 'episodes', sub: S.ep.source === 'estimated' ? 'dates estimated' : `from ${S.ep.source}` }),
    ].join(''));
  };
  drawTiles(null);
  const c = C();
  if (!single) {
    const cv = M.curve;
    plot($('#pf-pr'), [
      { x: cv.map(p => p.tpr), y: cv.map(p => p.prec), mode: 'lines', name: 'Model', line: { color: c.s1, width: 2 }, customdata: cv.map(p => [p.s, p.n]), hovertemplate: 'recall %{x:.1%}<br>precision %{y:.2%}<br>score ≥ %{customdata[0]:.4g}<br>%{customdata[1]:,} targeted<extra></extra>' },
      { x: [0, 1], y: [M.prev, M.prev], mode: 'lines', name: `Random (${fmtPct(M.prev)})`, line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    ], { xaxis: { title: { text: 'Recall' }, range: [0, 1], tickformat: '.0%' }, yaxis: { title: { text: 'Precision (log scale)' }, type: 'log', tickformat: '.1~%' } });
    plot($('#pf-roc'), [
      { x: [0, ...cv.map(p => p.fpr)], y: [0, ...cv.map(p => p.tpr)], mode: 'lines', name: 'Model', line: { color: c.s1, width: 2 }, hovertemplate: 'false positive rate %{x:.1%}<br>true positive rate %{y:.1%}<extra></extra>' },
      { x: [0, 1], y: [0, 1], mode: 'lines', name: 'Random', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    ], { xaxis: { title: { text: 'False positive rate' }, range: [0, 1], tickformat: '.0%' }, yaxis: { title: { text: 'True positive rate (recall)' }, range: [0, 1.02], tickformat: '.0%' }, showlegend: false });
    plot($('#pf-gain'), [
      { x: [0, ...cv.map(p => p.share)], y: [0, ...cv.map(p => p.tpr)], mode: 'lines', name: 'Model', line: { color: c.s1, width: 2 }, hovertemplate: 'top %{x:.1%} targeted<br>%{y:.1%} of positives captured<extra></extra>' },
      { x: [0, 1], y: [0, 1], mode: 'lines', name: 'Random', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    ], { xaxis: { title: { text: `Share of ${uw} targeted (by score)` }, range: [0, 1], tickformat: '.0%' }, yaxis: { title: { text: 'Share of positives captured' }, range: [0, 1.02], tickformat: '.0%' }, showlegend: false });
    const cumL = []; { let cp = 0, cn = 0; for (const d of M.deciles) { cp += d.pos; cn += d.n; cumL.push(div(div(cp, cn), M.prev)); } }
    M.deciles.forEach((d, i) => { d.cumLift = cumL[i]; });
    plot($('#pf-lift'), [
      { x: M.deciles.map(d => 'D' + d.decile), y: M.deciles.map(d => d.lift), type: 'bar', name: 'Lift within the decile', marker: { color: rgba(c.s1, 0.55) }, customdata: M.deciles.map(d => [d.n, d.pos, d.rate, (d.decile - 1) * 10, d.decile * 10]), hovertemplate: 'ranked %{customdata[3]}–%{customdata[4]}%: lift %{y:.2f}×<br>rate %{customdata[2]:.2%}<br>%{customdata[1]:,} positive of %{customdata[0]:,}<extra></extra>', width: 0.55 },
      { x: M.deciles.map(d => 'D' + d.decile), y: cumL, mode: 'lines+markers', name: 'Cumulative lift of the top X%', line: { color: c.s2, width: 2 }, marker: { size: 8, color: c.s2, line: { color: c.surface, width: 2 } }, customdata: M.deciles.map(d => d.decile * 10), hovertemplate: 'top %{customdata}%: cumulative lift %{y:.2f}× (as in the capacity table)<extra></extra>' },
      { x: ['D1', 'D10'], y: [1, 1], mode: 'lines', name: 'Random (1×)', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip', showlegend: false },
    ], { yaxis: { title: { text: 'Lift vs prevalence' }, rangemode: 'tozero' }, xaxis: { title: { text: 'Decile of the ranking (D1 = highest scores)' } }, legend: { orientation: 'h', y: 1.16, x: 0 } });
  } else ['#pf-pr', '#pf-roc', '#pf-gain', '#pf-lift'].forEach(s => html($(s), empty('Undefined', 'Needs both positive and negative records.')));
  // capacity table
  const capRows = M.capacity.map(r => ({ ...r, pct: r.k, tiesInfo: r.ties }));
  renderTable($('#pf-cap'), {
    rows: capRows, exportName: `targeting_capacity_${E.grain}`, maxRows: 10, sort: { key: 'pct', dir: 1 },
    note: `Cumulative: each row covers everyone in the top X% (top 20% includes the top 10%), unlike the per-decile bars above. Denominators: ${fmtInt(M.n)} ${uw}, ${fmtInt(M.pos)} positive; prevalence ${fmtPct(M.prev)} is the lift baseline.`,
    columns: [
      { key: 'pct', label: 'Top', num: true, fmt: x => fmtPct(x, 0) },
      { key: 'sel', label: `Selected ${uw}`, num: true, fmt: fmtInt, tip: 'topx' },
      { key: 'tp', label: 'True positives', num: true, fmt: fmtInt },
      { key: 'fp', label: 'False positives', num: true, fmt: fmtInt },
      { key: 'fn', label: 'False negatives', num: true, fmt: fmtInt },
      { key: 'precision', label: 'Precision', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.precLo, r.precHi, fmtPct)}`, tip: 'precision' },
      { key: 'recall', label: 'Recall', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.recLo, r.recHi, fmtPct)}`, tip: 'recall' },
      { key: 'lift', label: 'Cumulative lift', num: true, fmt: (x, r) => `${fmtX(x, 1)} ${fmtCI(r.liftLo, r.liftHi, y => fmtX(y, 1))}`, tip: 'lift' },
      { key: 'selClients', label: 'Distinct clients', num: true, fmt: fmtInt, tip: 'clients' },
      { key: 'capClients', label: 'Converting clients captured', num: true, fmt: (x) => `${fmtInt(x)} <span class="ci-inline">of ${fmtInt(M.convClients)}</span>`, tip: 'converters' },
      { key: 'capEpisodes', label: 'Purchases captured', num: true, fmt: x => `${fmtInt(x)} <span class="ci-inline">of ${fmtInt(M.episodes)}</span>`, tip: 'episodes' },
      { key: 'tiesInfo', label: 'Tied at cutoff', num: true, nosort: true, fmt: t => t && t.tiedTotal > 1 ? `${fmtInt(t.tiedSelected)} of ${fmtInt(t.tiedTotal)} in` : '<span class="dim">none</span>', tip: 'ties' },
    ],
    exportRows: data => data.map(r => ({ top_pct: r.k, selected: r.sel, true_positives: r.tp, false_positives: r.fp, false_negatives: r.fn, precision: r.precision, precision_ci_low: r.precLo, precision_ci_high: r.precHi,
      recall: r.recall, recall_ci_low: r.recLo, recall_ci_high: r.recHi, lift: r.lift, lift_ci_low: r.liftLo, lift_ci_high: r.liftHi, distinct_clients: r.selClients, converting_clients_captured: r.capClients,
      purchases_captured: r.capEpisodes, tied_at_cutoff: r.ties?.tiedTotal, tied_selected: r.ties?.tiedSelected, population: M.n, positives: M.pos, prevalence: M.prev, grain: E.grain })),
  });
  const drawCM = k => { const r = M.capacity.find(x => x.k === +k) || c10; html($('#pf-cm'), confusionMatrixHTML({ tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, unit: uw, selLabel: `In top ${fmtPct(r.k, 0)}`, notLabel: 'Below the cutoff' })); };
  drawCM(S.ui.perf.cmK || 0.1);
  bindSeg(body, 'cmk', k => { S.ui.perf.cmK = +k; drawCM(k); });
  renderTable($('#pf-dec'), {
    rows: M.deciles, exportName: `deciles_${E.grain}`, maxRows: 10, sort: { key: 'decile', dir: 1 },
    columns: [{ key: 'decile', label: 'Decile', num: true }, { key: 'n', label: uw, num: true, fmt: fmtInt }, { key: 'pos', label: 'Positives', num: true, fmt: fmtInt },
      { key: 'rate', label: 'Conversion rate', num: true, fmt: x => fmtPct(x) }, { key: 'lift', label: 'Lift within decile', num: true, fmt: x => fmtX(x, 2) }, { key: 'cumLift', label: 'Cumulative lift (top X%)', num: true, fmt: x => fmtX(x, 2) }, { key: 'cumRecall', label: 'Cumulative recall', num: true, fmt: x => fmtPct(x) },
      { key: 'meanS', label: 'Mean score', num: true, fmt: fmtScore }, { key: 'smin', label: 'Min score', num: true, fmt: fmtScore }, { key: 'smax', label: 'Max score', num: true, fmt: fmtScore }],
  });
  if (M.hist) {
    const h = M.hist, t0 = h.neg.reduce((a, b) => a + b, 0) || 1, t1 = h.pos.reduce((a, b) => a + b, 0) || 1;
    plot($('#pf-hist'), [
      { x: h.centers, y: h.neg.map(x => x / t0), mode: 'lines', line: { shape: 'hvh', color: c.s1, width: 2 }, fill: 'tozeroy', fillcolor: rgba(c.s1, 0.1), name: `Did not convert (${fmtInt(t0)})`, hovertemplate: 'score ≈ %{x:.3g}<br>%{y:.2%} of class<extra></extra>' },
      { x: h.centers, y: h.pos.map(x => x / t1), mode: 'lines', line: { shape: 'hvh', color: c.s2, width: 2 }, fill: 'tozeroy', fillcolor: rgba(c.s2, 0.1), name: `Converted (${fmtInt(t1)})`, hovertemplate: 'score ≈ %{x:.3g}<br>%{y:.2%} of class<extra></extra>' },
    ], { xaxis: { title: { text: `PREDICTED_SCORE${h.log ? ' (log scale)' : ''}` }, type: h.log ? 'log' : 'linear' }, yaxis: { title: { text: 'Share of class' }, tickformat: '.0%' } });
  }
  // bootstrap intervals (async; tiles update when done)
  const B = await engCached('bootstrap', { grain: E.grain, ks: KS, B: bootN(M.n) }, 'Bootstrapping intervals…'); if (stale(v)) return;
  drawTiles(B);
  html($('#pf-boot'), `ROC-AUC and PR-AUC intervals: ${B.B} client-block bootstrap resamples. Rate intervals: client-clustered Wilson. ${goLink('perf/method-ranking', 'Method')}`);
}

/* ------------------------------------------------------------ periods */
async function perfPeriods(body, v) {
  const E = S.eval, U = S.ui.perf;
  html(body, computing(`Evaluating each ${E.gran === 'day' ? 'day' : E.gran} separately…`));
  const spec = { grain: E.grain, gran: E.gran, ks: KS, minPos: S.settings.minPos, refPeriods: U.refRange ? range(U.refRange[0], U.refRange[1]) : null };
  const R = await engCached('metrics', spec, 'Computing period metrics…'); if (stale(v)) return;
  const P = R.periods, Sm = R.summary, pooled = R.pooled;
  if (!P.length) { html(body, empty('No periods in the evaluation window')); return; }
  const pw = { day: 'day', week: 'week', month: 'month' }[E.gran], uw = unitWord(E.grain);
  const lowN = P.filter(p => p.lowPos).length, noEst = P.filter(p => !p.estimable).length;
  const cap10 = pooled.capacity[2];
  const sumRows = [
    { m: 'Prevalence', k: 'prev', f: x => fmtPct(x), pooled: pooled.prev, tip: 'prevalence' },
    { m: 'PR-AUC', k: 'ap', f: x => fmtNum(x), pooled: pooled.ap, tip: 'pr_auc' },
    { m: 'ROC-AUC', k: 'auc', f: x => fmtNum(x), pooled: pooled.auc, tip: 'roc_auc' },
    { m: 'Precision@10%', k: 'prec10', f: x => fmtPct(x), pooled: cap10.precision, tip: 'precision' },
    { m: 'Recall@10%', k: 'rec10', f: x => fmtPct(x), pooled: cap10.recall, tip: 'recall' },
    { m: 'Lift@10%', k: 'lift10', f: x => fmtX(x, 2), pooled: cap10.lift, tip: 'lift' },
    { m: 'Mean score', k: 'meanScore', f: fmtScore, pooled: pooled.meanScore },
    ...(S.hasProb ? [{ m: 'Brier score', k: 'brier', f: x => fmtNum(x, 4), pooled: null, tip: 'brier' }, { m: 'Mean predicted ÷ observed', k: 'calRatio', f: x => fmtX(x, 2), pooled: null, tip: 'cal_ratio' }] : []),
    { m: 'Score PSI vs reference', k: 'psi', f: x => fmtNum(x, 3), pooled: null, tip: 'psi' },
  ].map(r => ({ ...r, ...Sm[r.k] }));
  html(body, `
    ${noEst || lowN ? callout('warn', `${noEst ? `${plural(noEst, pw)} ${noEst === 1 ? 'has' : 'have'} no positive (or no negative) ${uw}: ranking metrics are <b>not estimable</b> there and are excluded from period means (counts shown). ` : ''}${lowN ? `${plural(lowN, pw)} ${lowN === 1 ? 'has' : 'have'} fewer than ${S.settings.minPos} positives: values are shown with hollow markers and are <b>low-confidence</b>.` : ''} No period is dropped silently.`) : ''}
    ${card(`Average ${PERIOD_ADJ[pw]} performance vs pooled`, '<div id="pf-sum"></div>', { sub: `Mean of ${PERIOD_ADJ[pw]} values is the primary “average period performance”. Pooled = one calculation over the same window. They are not interchangeable.`, tipKey: 'mean_period' })}
    <div id="pf-interp"></div>
    ${sectionTitle(`Trends by ${pw}`, 'trends', `<span class="faint">Shaded band = 95% interval · hollow marker = low-confidence · gaps = not estimable</span>`)}
    <div class="grid g2">
      ${card('Precision@10% and prevalence', '<div class="chart sm" id="pt-prec"></div>', { sub: `Top 10% of each ${pw}'s own ranking. Prevalence is that ${pw}'s base rate.` })}
      ${card('Lift@10%', '<div class="chart sm" id="pt-lift"></div>', { sub: `Precision@10% ÷ that ${pw}'s prevalence. 1× = random.` })}
      ${card('Recall@10%', '<div class="chart sm" id="pt-rec"></div>', { sub: `Share of that ${pw}'s positives in its top 10%.` })}
      ${card('PR-AUC and prevalence', '<div class="chart sm" id="pt-ap"></div>', { sub: 'The prevalence line is the PR-AUC of a random ranking in that period.' })}
      ${card('ROC-AUC', '<div class="chart sm" id="pt-auc"></div>', { sub: '0.5 = random.' })}
      ${card(`Sample size per ${pw}`, '<div class="chart sm" id="pt-n"></div>', { sub: `Positive ${uw} per ${pw}; hover for totals and distinct clients.` })}
      ${S.hasProb ? card('Mean predicted probability vs observed rate', '<div class="chart sm" id="pt-cal"></div>', { sub: 'Calibration-in-the-large by period.' }) + card('Brier score', '<div class="chart sm" id="pt-brier"></div>', { sub: 'Lower is better; compare with prevalence × (1 − prevalence).' }) : ''}
      ${card('Score distribution shift (PSI)', `<div class="form-row" style="margin-bottom:8px"><span class="faint">Reference</span><select id="pt-ref-a">${P.map(p => `<option value="${p.g}">${esc(p.label)}</option>`).join('')}</select><span class="faint">to</span><select id="pt-ref-b">${P.map(p => `<option value="${p.g}">${esc(p.label)}</option>`).join('')}</select></div><div class="chart sm" id="pt-psi"></div>`, { sub: 'Within this file only — not drift against training data.', tipKey: 'psi' })}
    </div>
    <div class="card" style="margin-top:20px">
      ${disc(`${capFirst(PERIOD_ADJ[pw])} performance table`, '<div id="pf-ptbl"></div>', { cls: 'line', sub: `${plural(P.length, pw)} · export available` })}
      ${disc('Methodology: periods, mean vs pooled, reliability', METHOD.periods, { cls: 'line', id: 'method-periods' })}
    </div>`);
  renderTable($('#pf-sum'), {
    rows: sumRows, exportName: `period_summary_${E.gran}_${E.grain}`, maxRows: 20,
    columns: [{ key: 'm', label: 'Metric', fmt: (x, r) => `${esc(x)} ${r.tip ? tip(r.tip) : ''}` },
      { key: 'mean', label: `Mean of ${pw}s`, num: true, fmt: (x, r) => `<b>${r.f(x)}</b>` }, { key: 'median', label: 'Median', num: true, fmt: (x, r) => r.f(x) },
      { key: 'sd', label: 'Std. dev.', num: true, fmt: (x, r) => r.f(x) }, { key: 'min', label: 'Range', num: true, fmt: (x, r) => fin(x) ? `${r.f(x)} – ${r.f(r.max)}` : '—' },
      { key: 'count', label: `${pw}s used`, num: true, fmt: (x, r) => `${fmtInt(x)} of ${fmtInt(r.of)}` },
      { key: 'meanStrong', label: `Mean, ≥${S.settings.minPos} positives`, num: true, fmt: (x, r) => `${r.f(x)} <span class="ci-inline">n=${fmtInt(r.countStrong)}</span>` },
      { key: 'pooled', label: 'Pooled (same window)', num: true, fmt: (x, r) => r.f(x) }],
    exportRows: data => data.map(r => ({ metric: r.m, mean_of_periods: r.mean, median: r.median, sd: r.sd, min: r.min, max: r.max, periods_used: r.count, periods_total: r.of, mean_high_confidence: r.meanStrong, periods_high_confidence: r.countStrong, pooled: r.pooled, granularity: E.gran, grain: E.grain })),
  });
  // interpretation: is variation in precision explained by prevalence?
  const cv = k => { const s = Sm[k]; return s.mean ? s.sd / s.mean : null; };
  const cvP = cv('prec10'), cvL = cv('lift10'), cvPrev = cv('prev');
  const minL = Sm.lift10.min, below1 = P.filter(p => fin(p.lift10) && p.lift10 <= 1).length;
  const lines = [];
  if (fin(cvP) && fin(cvL) && fin(cvPrev)) lines.push(`Across ${plural(Sm.prec10.count, pw)}, Precision@10% varies by ${fmtPct(cvP, 0)} (coefficient of variation), prevalence by ${fmtPct(cvPrev, 0)} and Lift@10% by ${fmtPct(cvL, 0)}. ${cvL < cvP * 0.75 ? 'Lift is steadier than precision, so much of the movement in precision follows changes in the base rate rather than in ranking quality.' : cvL > cvP * 1.25 ? 'Lift moves more than precision: ranking quality itself varies between periods.' : 'Lift and precision vary by similar amounts; the evidence does not separate base-rate changes from ranking changes.'}`);
  if (fin(minL)) lines.push(`The weakest ${pw} has Lift@10% of ${fmtX(minL, 2)}${below1 ? `; ${plural(below1, pw)} at or below 1× (no better than random)` : ''}.`);
  if (lowN) lines.push(`Treat swings in the ${plural(lowN, 'low-confidence period')} as noise unless they persist.`);
  html($('#pf-interp'), lines.length ? callout('info', lines.join(' '), 'Reading the trend.') : '');
  // charts
  const c = C(), isDay = E.gran === 'day';
  const x = P.map(p => isDay ? p.start : p.label);
  const xa = { type: isDay ? 'date' : 'category', title: { text: isDay ? 'Prediction date' : E.gran === 'week' ? 'Week starting (Monday)' : 'Month' } };
  const mk = (col) => ({ size: 7, color: P.map(p => p.lowPos ? c.surface : col), line: { color: col, width: 2 } });
  const band = (lo, hi, col) => [
    { x, y: P.map(p => p[hi]), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, connectgaps: false },
    { x, y: P.map(p => p[lo]), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(col, 0.13), hoverinfo: 'skip', showlegend: false, connectgaps: false },
  ];
  const line = (k, name, col, fmtH, extra = {}) => ({ x, y: P.map(p => p[k]), mode: 'lines+markers', name, line: { color: col, width: 2 }, marker: mk(col), connectgaps: false,
    customdata: P.map(p => [p.n, p.pos, p.clients, p.lowPos ? ' · low-confidence' : '']), hovertemplate: `%{x}<br>${name}: %{y:${fmtH}}<br>%{customdata[0]:,} ${uw}, %{customdata[1]:,} positive%{customdata[3]}<extra></extra>`, ...extra });
  const L = (ytitle, extra = {}) => ({ margin: { l: 56, r: 12, t: 24, b: 48 }, xaxis: xa, yaxis: { title: { text: ytitle }, ...extra }, legend: { orientation: 'h', y: 1.18, x: 0 } });
  plot($('#pt-prec'), [...band('prec10Lo', 'prec10Hi', c.s1), line('prec10', 'Precision@10%', c.s1, '.2%'), line('prev', 'Prevalence', c.base, '.2%', { line: { color: c.base, width: 1.5, dash: 'dash' }, marker: { size: 0 } })], L('Rate', { tickformat: '.1%', rangemode: 'tozero' }));
  plot($('#pt-lift'), [...band('lift10Lo', 'lift10Hi', c.s1), line('lift10', 'Lift@10%', c.s1, '.2f'), { x: [x[0], x[x.length - 1]], y: [1, 1], mode: 'lines', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip', showlegend: false }], { ...L('Lift (×)', { rangemode: 'tozero' }), showlegend: false });
  plot($('#pt-rec'), [...band('rec10Lo', 'rec10Hi', c.s1), line('rec10', 'Recall@10%', c.s1, '.1%')], { ...L('Recall', { tickformat: '.0%', range: [0, 1.02] }), showlegend: false });
  plot($('#pt-ap'), [line('ap', 'PR-AUC', c.s1, '.3f'), line('prev', 'Prevalence (random PR-AUC)', c.base, '.2%', { line: { color: c.base, width: 1.5, dash: 'dash' }, marker: { size: 0 } })], L('Average precision', { rangemode: 'tozero' }));
  plot($('#pt-auc'), [line('auc', 'ROC-AUC', c.s1, '.3f'), { x: [x[0], x[x.length - 1]], y: [0.5, 0.5], mode: 'lines', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip', showlegend: false }], { ...L('ROC-AUC'), showlegend: false });
  plot($('#pt-n'), [{ x, y: P.map(p => p.pos), type: 'bar', name: 'Positive', marker: { color: P.map(p => p.lowPos || !p.estimable ? rgba(c.s4, 0.9) : c.s1) }, customdata: P.map(p => [p.n, p.clients, p.lowPos ? 'low-confidence' : p.estimable ? '' : 'not estimable']), hovertemplate: `%{x}<br>%{y:,} positive ${uw}<br>%{customdata[0]:,} ${uw} · %{customdata[1]:,} clients<br>%{customdata[2]}<extra></extra>` },
    { x: [x[0], x[x.length - 1]], y: [S.settings.minPos, S.settings.minPos], mode: 'lines', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip', name: `Minimum ${S.settings.minPos}` }], { ...L(`Positive ${uw}`, { rangemode: 'tozero' }), showlegend: false, bargap: 0.35 });
  if (S.hasProb) {
    plot($('#pt-cal'), [line('meanP', 'Mean predicted', c.predicted, '.2%'), line('prev', 'Observed rate', c.actual, '.2%')], L('Rate', { tickformat: '.1%', rangemode: 'tozero' }));
    plot($('#pt-brier'), [line('brier', 'Brier', c.s1, '.4f')], { ...L('Brier score', { rangemode: 'tozero' }), showlegend: false });
  }
  const refA = $('#pt-ref-a'), refB = $('#pt-ref-b');
  const rr = U.refRange || [0, 0]; refA.value = rr[0]; refB.value = rr[1];
  const onRef = async () => { let a = +refA.value, b = +refB.value; if (a > b) [a, b] = [b, a]; U.refRange = [a, b]; await perfPeriods(body, v); };
  refA.onchange = onRef; refB.onchange = onRef;
  plot($('#pt-psi'), [line('psi', 'PSI', c.s1, '.3f')], { ...L('PSI', { rangemode: 'tozero' }), showlegend: false,
    shapes: [0.1, 0.25].map((yv, i) => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: yv, y1: yv, line: { color: i ? c.bad : c.warn, dash: 'dot', width: 1.5 } })) });
  // table
  renderTable($('#pf-ptbl'), {
    rows: P, exportName: `period_metrics_${E.gran}_${E.grain}`, maxRows: 400, sort: { key: 'start', dir: 1 }, rowClass: r => (r.lowPos || !r.estimable ? 'flagged' : ''),
    columns: [{ key: 'label', label: isDay ? 'Date' : E.gran === 'week' ? 'Week of' : 'Month' }, { key: 'n', label: uw, num: true, fmt: fmtInt }, { key: 'clients', label: 'Clients', num: true, fmt: fmtInt },
      { key: 'pos', label: 'Positives', num: true, fmt: fmtInt }, { key: 'prev', label: 'Prevalence', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.prevLo, r.prevHi, fmtPct)}` },
      { key: 'ap', label: 'PR-AUC', num: true, fmt: x => fmtNum(x) }, { key: 'auc', label: 'ROC-AUC', num: true, fmt: x => fmtNum(x) },
      { key: 'prec10', label: 'Precision@10%', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.prec10Lo, r.prec10Hi, fmtPct)}` },
      { key: 'rec10', label: 'Recall@10%', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.rec10Lo, r.rec10Hi, fmtPct)}` },
      { key: 'lift10', label: 'Lift@10%', num: true, fmt: x => fmtX(x, 2) }, ...(S.hasProb ? [{ key: 'brier', label: 'Brier', num: true, fmt: x => fmtNum(x, 4) }, { key: 'calRatio', label: 'Pred ÷ obs', num: true, fmt: x => fmtX(x, 2) }] : []),
      { key: 'psi', label: 'PSI', num: true, fmt: (x, r) => r.isRef ? '<span class="dim">ref</span>' : fmtNum(x, 3) },
      { key: 'lowPos', label: 'Reliability', fmt: (x, r) => !r.estimable ? flag('not estimable', 'na', 'not_estimable') : x ? flag('low-confidence', '', 'low_pos') : '' }],
    exportRows: data => data.map(r => { const o = { ...r }; delete o.g; return { granularity: E.gran, grain: E.grain, ...o }; }),
  });
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/* ------------------------------------------------------------ playground */
async function perfPlayground(body, v) {
  const E = S.eval, U = S.ui.perf, pg = U.pg;
  const M = await engCached('metrics', { grain: E.grain, gran: 'overall', ks: KS, withCalibration: false }, 'Computing ranking metrics…'); if (stale(v)) return;
  const qs = await scoreQuantiles(E.grain); if (stale(v)) return;
  if (pg.raw === null) pg.raw = qs.raw90;
  if (pg.prob === null && S.hasProb) pg.prob = qs.prob90;
  if (pg.n === null) pg.n = Math.max(1, Math.round(M.n * 0.05));
  const uw = unitWord(E.grain);
  html(body, `
    ${callout('info', `<b>Top-X</b> (capacity) rules guarantee the audience size: every run contacts exactly ceil(X × N) ${uw}. <b>Fixed thresholds</b> select everyone at or above a score, so the audience grows and shrinks as the score distribution moves. The default threshold is the score that selects about 10% of ${uw} — not 0.5: conversion is rare and a threshold should follow capacity and economics.`)}
    <div class="card" style="margin-top:20px">
      <div class="toolbar" style="margin-bottom:12px">${segHTML('pgt', [{ v: 'pct', label: 'Top X%' }, { v: 'n', label: 'Top N' }, { v: 'raw', label: 'Raw-score threshold' }, { v: 'prob', label: 'Probability threshold', disabled: !S.hasProb, tip: S.hasProb ? '' : 'No valid probabilities in this file.' }], pg.type)}</div>
      <div id="pg-ctl"></div>
    </div>
    <div class="tiles" id="pg-tiles" style="margin-top:20px"></div>
    ${card('Confusion matrix', '<div id="pg-cm"></div>', { sub: `How the current rule splits the ${uw}: counts and share of all ${uw}.` })}
    <div class="grid g2" style="margin-top:20px">
      ${card('Precision vs audience size', '<div class="chart sm" id="pg-prec"></div>', { sub: 'Precision of the top X% for every X. The dot is the current rule.' })}
      ${card('Conversion capture vs audience size', '<div class="chart sm" id="pg-rec"></div>', { sub: 'Recall of the top X% for every X. The dot is the current rule.' })}
    </div>
    ${card('Audience share by week: this rule vs top-X at the same overall share', '<div class="chart sm" id="pg-week"></div><div id="pg-week-note" class="chart-note"></div>', { sub: 'A top-X rule keeps the share constant; a fixed threshold lets it drift with the scores.', id: 'pg-weekcard' })}`);
  const ctl = $('#pg-ctl');
  const drawCtl = () => {
    if (pg.type === 'pct') html(ctl, `<div class="form-row"><div class="pill-select">${KS.map(k => `<label><input type="radio" name="pg-k" value="${k}" ${Math.abs(pg.pct - k) < 1e-9 ? 'checked' : ''}> Top ${fmtPct(k, 0)}</label>`).join('')}</div>
      <label class="inline">Custom <input type="number" id="pg-pct" min="0.01" max="100" step="0.5" value="${+(pg.pct * 100).toFixed(2)}">%</label></div>`);
    else if (pg.type === 'n') html(ctl, `<div class="form-row"><label class="inline">Top <input type="number" id="pg-n" min="1" max="${M.n}" step="1" value="${pg.n}" style="width:120px"> ${uw} <span class="faint">of ${fmtInt(M.n)}</span></label></div>`);
    else {
      const isP = pg.type === 'prob', val = isP ? pg.prob : pg.raw, lo = isP ? qs.probMin : qs.rawMin, hi = isP ? qs.probMax : qs.rawMax;
      html(ctl, `<div class="form-row"><label class="inline">${isP ? 'Probability' : 'Raw score'} ≥ <input type="number" id="pg-thr" step="any" min="${lo}" max="${hi}" value="${+(+val).toPrecision(4)}" style="width:130px"></label>
        <span class="faint">${isP ? 'Calibrated probability threshold.' : 'Raw-score threshold — not a probability.'} Range in data ${fmtScore(lo)} – ${fmtScore(hi)}.</span></div>
        <input type="range" id="pg-slider" min="0" max="1000" step="1" value="${qs.toSlider(val, isP)}" aria-label="Threshold" style="margin-top:12px">
        <div class="faint" style="display:flex;justify-content:space-between"><span>everyone</span><span>slider is on the score quantile scale</span><span>nobody</span></div>`);
    }
    $$('input[name=pg-k]', ctl).forEach(r => r.onchange = () => { pg.pct = +r.value; drawCtl(); run(); });
    const pct = $('#pg-pct', ctl); if (pct) pct.oninput = debounce(() => { const x = +pct.value; if (x > 0 && x <= 100) { pg.pct = x / 100; $$('input[name=pg-k]', ctl).forEach(r => r.checked = Math.abs(+r.value - pg.pct) < 1e-9); run(); } }, 250);
    const nn = $('#pg-n', ctl); if (nn) nn.oninput = debounce(() => { const x = Math.round(+nn.value); if (x >= 1) { pg.n = x; run(); } }, 250);
    const th = $('#pg-thr', ctl), sl = $('#pg-slider', ctl);
    if (th) {
      const isP = pg.type === 'prob';
      th.oninput = debounce(() => { const x = +th.value; if (Number.isFinite(x)) { if (isP) pg.prob = x; else pg.raw = x; sl.value = qs.toSlider(x, isP); run(); } }, 250);
      sl.oninput = () => { const x = qs.fromSlider(+sl.value, isP); if (isP) pg.prob = x; else pg.raw = x; th.value = +(+x).toPrecision(4); runFast(); };
    }
  };
  bindSeg(body, 'pgt', t => { pg.type = t; drawCtl(); run(); });
  const c = C(), cv = M.curve;
  const run = async () => {
    const rule = pg.type === 'pct' ? { type: 'pct', value: pg.pct } : pg.type === 'n' ? { type: 'n', value: pg.n } : pg.type === 'raw' ? { type: 'raw', value: pg.raw } : { type: 'prob', value: pg.prob };
    const r = await engCached('playground', { grain: E.grain, rule, periodGran: 'week' }, 'Applying the rule…'); if (stale(v)) return;
    html($('#pg-tiles'), [
      tile('Audience', fmtInt(r.K), { sub: `${fmtPct(r.share)} of ${fmtInt(r.N)} ${uw}${r.minSelScore !== null && (pg.type === 'pct' || pg.type === 'n') ? ` · score ≥ ${fmtScore(r.minSelScore)}` : ''}`, hl: true }),
      tile('Precision', fmtPct(r.precision), { tipKey: 'precision', ci: fmtCIplain(r.precLo, r.precHi, fmtPct) }),
      tile('Recall (capture)', fmtPct(r.recall), { tipKey: 'recall', ci: fmtCIplain(r.recLo, r.recHi, fmtPct), sub: `${fmtInt(r.tp)} of ${fmtInt(r.P)} positive ${uw}` }),
      tile('Lift', fmtX(r.lift, 2), { tipKey: 'lift', sub: `vs prevalence ${fmtPct(r.prev)}` }),
      tile('Distinct clients selected', fmtInt(r.selClients), { tipKey: 'clients' }),
      tile('Converting clients captured', fmtInt(r.capClients), { tipKey: 'converters', sub: `of ${fmtInt(r.convClients)} (${fmtPct(div(r.capClients, r.convClients))})` }),
      tile('Purchases captured', fmtInt(r.capEpisodes), { tipKey: 'episodes', sub: `of ${fmtInt(r.episodes)} (${fmtPct(div(r.capEpisodes, r.episodes))})` }),
    ].join('') + (r.excludedNoProb ? `<div class="faint" style="grid-column:1/-1">${fmtInt(r.excludedNoProb)} ${uw} without a valid probability are never selected by a probability threshold.</div>` : ''));
    html($('#pg-cm'), confusionMatrixHTML({ tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, unit: uw, selLabel: pg.type === 'raw' || pg.type === 'prob' ? 'Above the threshold' : 'Selected', notLabel: pg.type === 'raw' || pg.type === 'prob' ? 'Below the threshold' : 'Not selected' }));
    const dot = (yv, name) => ({ x: [r.share], y: [yv], mode: 'markers', name, marker: { size: 11, color: c.s2, line: { color: c.surface, width: 2 } }, hovertemplate: `current rule<br>%{x:.2%} targeted<br>%{y:.2%}<extra></extra>` });
    plot($('#pg-prec'), [{ x: cv.map(p => p.share), y: cv.map(p => p.prec), mode: 'lines', line: { color: c.s1, width: 2 }, name: 'Top X%', hovertemplate: 'top %{x:.2%}<br>precision %{y:.2%}<extra></extra>' }, dot(r.precision, 'Current rule'),
      { x: [0, 1], y: [M.prev, M.prev], mode: 'lines', line: { color: c.base, dash: 'dash', width: 1.5 }, name: 'Prevalence', hoverinfo: 'skip' }],
      { xaxis: { title: { text: `Share of ${uw} targeted (log scale)` }, type: 'log', tickformat: '.1~%' }, yaxis: { title: { text: 'Precision' }, tickformat: '.1~%', rangemode: 'tozero' }, showlegend: false });
    plot($('#pg-rec'), [{ x: [0, ...cv.map(p => p.share)], y: [0, ...cv.map(p => p.tpr)], mode: 'lines', line: { color: c.s1, width: 2 }, name: 'Top X%', hovertemplate: 'top %{x:.1%}<br>capture %{y:.1%}<extra></extra>' }, dot(r.recall, 'Current rule')],
      { xaxis: { title: { text: `Share of ${uw} targeted` }, tickformat: '.0%', range: [0, 1] }, yaxis: { title: { text: 'Share of positives captured' }, tickformat: '.0%', range: [0, 1.02] }, showlegend: false });
    const W = r.perPeriod;
    plot($('#pg-week'), [
      { x: W.map(w => w.label), y: W.map(w => w.share), type: 'bar', name: pg.type === 'raw' || pg.type === 'prob' ? 'This threshold' : 'This rule', marker: { color: c.s1 }, width: 0.5, customdata: W.map(w => [w.sel, w.n, w.prec]), hovertemplate: 'week of %{x}<br>%{y:.2%} of the pool selected<br>%{customdata[0]:,} of %{customdata[1]:,}<br>precision %{customdata[2]:.2%}<extra></extra>' },
      { x: W.map(w => w.label), y: W.map(w => div(w.topxSel, w.n)), mode: 'lines+markers', name: `Top ${fmtPct(r.share)} each week`, line: { color: c.base, width: 2 }, marker: { size: 7, color: c.base, line: { color: c.surface, width: 2 } }, customdata: W.map(w => [w.topxSel, w.topxPrec]), hovertemplate: 'week of %{x}<br>top-X: %{customdata[0]:,} selected<br>precision %{customdata[1]:.2%}<extra></extra>' },
    ], { xaxis: { type: 'category', title: { text: 'Week starting (Monday)' } }, yaxis: { title: { text: 'Share of the week\'s records selected' }, tickformat: '.1~%', rangemode: 'tozero' }, bargap: 0.4 });
    const shares = W.map(w => w.share);
    html($('#pg-week-note'), W.length > 1 ? `Weekly audience share under this rule ranges ${fmtPct(Math.min(...shares))} – ${fmtPct(Math.max(...shares))} (top-X per week stays at ${fmtPct(r.share)}). Weekly audiences are evaluated on each week's records; a client can appear in several weeks at row grain.` : '');
  };
  const runFast = debounce(run, 120);
  drawCtl(); await run();
}
const fmtCIplain = (lo, hi, f) => (fin(lo) && fin(hi) ? `95% CI ${f(lo)} – ${f(hi)}` : '');
/** Score quantiles for slider mapping (cached per grain). */
async function scoreQuantiles(grain) {
  const key = `${S.ver}|qs|${grain}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const ps = Array.from({ length: 1001 }, (_, i) => i / 1000);
  const r = await q1(`SELECT quantile_disc(score, [${ps.join(',')}]) AS qr ${S.hasProb ? `, quantile_disc(prob, [${ps.join(',')}]) AS qp` : ''} FROM (${unitSQL(grain, 'score, prob')})`);
  const qr = r.qr || [], qp = r.qp || [];
  const toS = (x, arr) => { let lo = 0, hi = arr.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
  const out = { raw90: qr[900], prob90: qp[900] ?? null, rawMin: qr[0], rawMax: qr[1000], probMin: qp[0] ?? 0, probMax: qp[1000] ?? 1,
    toSlider: (x, isP) => toS(x, isP ? qp : qr), fromSlider: (i, isP) => (isP ? qp : qr)[clamp(i, 0, 1000)] };
  S.cache.set(key, out); return out;
}

/* ------------------------------------------------------------ calibration */
async function perfCalibration(body, v) {
  const E = S.eval, U = S.ui.perf;
  if (!S.hasProb) {
    html(body, `${card('Probability calibration is not available', `
      <p class="muted">This file has no valid probabilities: no PREDICTED_PROBABILITY column was mapped, and PREDICTED_SCORE was not declared a calibrated probability at upload.</p>
      <p class="muted">Ranking evaluation (PR-AUC, ROC-AUC, precision / recall / lift at capacity) is fully valid on raw scores. Calibration — whether a predicted 5% really means 5 of 100 convert — is not interpretable for a raw score: a model trained with negative downsampling, for example, produces scores several times the true rate while ranking perfectly well.</p>
      ${fin(S.info.st.ms) && S.info.st.pos ? `<p class="muted">For reference only: the mean raw score is ${fmtPct(S.info.st.ms)} against an observed positive rate of ${fmtPct(S.info.st.pos / S.info.st.n)} (${fmtX(S.info.st.ms / (S.info.st.pos / S.info.st.n), 1)}). This is not a calibration metric.</p>` : ''}
      <p class="muted">To enable this section, upload a file with a PREDICTED_PROBABILITY column produced by a calibrator fitted on separate (non-test) data. The app will not fit a calibrator on the evaluation rows.</p>`)}
      <div class="card" style="margin-top:20px">${disc('Methodology: calibration metrics', METHOD.calibration, { cls: 'line' })}</div>`);
    return;
  }
  html(body, computing('Computing calibration…'));
  const cal = await engCached('calibration', { grain: E.grain, bins: U.calBins, mode: U.calMode }, 'Computing calibration…'); if (stale(v)) return;
  if (!cal || !cal.n) { html(body, empty('No records with a valid probability in the evaluation population.')); return; }
  const src = S.roles.prob ? `PREDICTED_PROBABILITY (<span class="mono">${esc(S.roles.prob)}</span>)` : 'PREDICTED_SCORE, declared a calibrated probability at upload';
  const verdict = r => (fin(r) ? (r > 1.25 ? 'over-predicts on average' : r < 0.8 ? 'under-predicts on average' : 'about right on average') : '');
  html(body, `
    ${callout('neutral', `Probabilities: ${src}. ${S.isDemo ? 'Demo data: the probability was fitted on the validation split only, so these test-split metrics are out-of-sample. ' : 'If this calibration was fitted on these same evaluation rows, the results below are in-sample and optimistic. '}${cal.missing ? `${fmtInt(cal.missing)} ${unitWord(E.grain)} without a valid probability are excluded.` : ''}`)}
    <div class="tiles" style="margin-top:20px">
      ${tile('Mean predicted ÷ observed', fmtX(cal.ratio, 2), { tipKey: 'cal_ratio', sub: `${fmtPct(cal.meanP)} predicted vs ${fmtPct(cal.rate)} observed · ${verdict(cal.ratio)}`, hl: true })}
      ${tile('Calibration slope', fmtNum(cal.slope, 2), { tipKey: 'cal_slope', sub: fin(cal.slope) ? (cal.slope < 0.8 ? 'predictions too extreme' : cal.slope > 1.25 ? 'predictions too timid' : 'spread about right') : 'did not converge' })}
      ${tile('Calibration-in-the-large', fmtNum(cal.citl, 2), { tipKey: 'citl', sub: 'intercept with slope fixed at 1; 0 = ideal' })}
      ${tile('Brier score', fmtNum(cal.brier, 5), { tipKey: 'brier', sub: `reference ${fmtNum(cal.brierRef, 5)} (always predict prevalence)` })}
      ${tile('Log loss', fmtNum(cal.logloss, 4), { tipKey: 'logloss' })}
      ${tile('ECE', fmtNum(cal.ece, 5), { tipKey: 'ece', sub: `${cal.mode === 'bands' ? 'probability bands' : U.calBins + ' equal-count bins'} · binning-dependent` })}
    </div>
    <div class="card" style="margin-top:20px">
      <div class="card-head"><div class="titles"><h3>Reliability diagram</h3><div class="sub">Mean predicted probability vs observed conversion rate per bin, with client-clustered 95% intervals. On the diagonal = calibrated.</div></div>
        <div class="actions">${segHTML('calmode', [{ v: 'quantile', label: 'Equal-count bins' }, { v: 'bands', label: 'Probability bands' }], U.calMode)}
          <select id="cal-bins" ${U.calMode === 'bands' ? 'disabled' : ''} aria-label="Number of bins">${[10, 20, 50].map(b => `<option ${b === U.calBins ? 'selected' : ''}>${b}</option>`).join('')}</select>
          <label class="inline small"><input type="checkbox" id="cal-log" ${U.calLog ? 'checked' : ''}> log axes</label></div></div>
      <div class="grid g2"><div><div class="chart" id="cal-rel"></div></div><div><div class="chart" id="cal-dist"></div></div></div>
      <div class="chart-note" id="cal-note"></div>
    </div>
    ${card('Calibration bins', '<div id="cal-tbl"></div>', { sub: 'Row and unique-client counts, positives, mean predicted vs observed rate.' })}
    <div class="card" style="margin-top:20px">${disc('Methodology: calibration metrics', METHOD.calibration, { cls: 'line', id: 'method-calibration' })}</div>`);
  bindSeg(body, 'calmode', async m => { U.calMode = m; await perfCalibration(body, v); syncSegs(body); });
  $('#cal-bins').onchange = async e => { U.calBins = +e.target.value; await perfCalibration(body, v); syncSegs(body); };
  $('#cal-log').onchange = async e => { U.calLog = e.target.checked; await perfCalibration(body, v); syncSegs(body); };
  const c = C(), bins = cal.bins, logAx = U.calLog;
  const pts = logAx ? bins.filter(b => b.rate > 0 && b.meanP > 0) : bins;
  const mx = Math.max(...bins.map(b => Math.max(b.meanP, b.hi ?? b.rate))), mn = logAx ? Math.min(...pts.map(b => Math.min(b.meanP, b.rate))) * 0.8 : 0;
  plot($('#cal-rel'), [
    { x: [mn || 1e-5, mx], y: [mn || 1e-5, mx], mode: 'lines', name: 'Perfect calibration', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    { x: pts.map(b => b.meanP), y: pts.map(b => b.rate), mode: 'lines+markers', name: 'Model', line: { color: c.s1, width: 2 }, marker: { size: 9, color: c.s1, line: { color: c.surface, width: 2 } },
      error_y: { type: 'data', symmetric: false, array: pts.map(b => fin(b.hi) ? b.hi - b.rate : 0), arrayminus: pts.map(b => fin(b.lo) ? b.rate - b.lo : 0), color: rgba(c.s1, 0.5), thickness: 1.2, width: 3 },
      customdata: pts.map(b => [b.n, b.pos, b.clients, b.bin]), hovertemplate: 'bin %{customdata[3]}<br>predicted %{x:.2%}<br>observed %{y:.2%}<br>%{customdata[0]:,} records · %{customdata[2]:,} clients · %{customdata[1]:,} positive<extra></extra>' },
  ], { xaxis: { title: { text: 'Mean predicted probability' }, type: logAx ? 'log' : 'linear', tickformat: '.1~%' }, yaxis: { title: { text: 'Observed conversion rate' }, type: logAx ? 'log' : 'linear', tickformat: '.1~%' }, showlegend: false });
  plot($('#cal-dist'), [{ x: bins.map(b => b.bin), y: bins.map(b => b.n), type: 'bar', marker: { color: c.s1 }, width: 0.6, customdata: bins.map(b => [b.pmin, b.pmax, b.rate]), hovertemplate: 'bin %{x}: %{y:,} records<br>p from %{customdata[0]:.2%} to %{customdata[1]:.2%}<br>observed %{customdata[2]:.2%}<extra></extra>' }],
    { xaxis: { title: { text: cal.mode === 'bands' ? 'Probability band' : 'Bin (equal-count, ascending probability)' }, tickvals: bins.map(b => b.bin), ticktext: bins.map(b => cal.mode === 'bands' ? `${fmtPct(b.band[0], 1)}–${fmtPct(b.band[1], 0)}` : String(b.bin)) }, yaxis: { title: { text: 'Records' } }, showlegend: false });
  html($('#cal-note'), `${logAx && pts.length < bins.length ? `${bins.length - pts.length} bin(s) with zero conversions are hidden on log axes (they are in the table). ` : ''}Right: how many records fall in each bin — the distribution of predicted probabilities.`);
  renderTable($('#cal-tbl'), {
    rows: bins, exportName: `calibration_bins_${E.grain}`, maxRows: 60, sort: { key: 'bin', dir: 1 },
    columns: [{ key: 'bin', label: 'Bin', num: true }, { key: 'pmin', label: 'Probability range', num: true, fmt: (x, r) => r.band ? `${fmtPct(r.band[0], 1)} – ${fmtPct(r.band[1], 1)}` : `${fmtPct(x)} – ${fmtPct(r.pmax)}` },
      { key: 'n', label: 'Rows', num: true, fmt: fmtInt }, { key: 'clients', label: 'Clients', num: true, fmt: fmtInt }, { key: 'pos', label: 'Positives', num: true, fmt: fmtInt },
      { key: 'meanP', label: 'Mean predicted', num: true, fmt: x => fmtPct(x) }, { key: 'rate', label: 'Observed rate', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.lo, r.hi, fmtPct)}` },
      { key: 'gap', label: 'Predicted − observed', num: true, fmt: x => fin(x) ? (x >= 0 ? '+' : '−') + fmtPct(Math.abs(x)) : '—', cls: r => (fin(r.lo) && (r.meanP < r.lo || r.meanP > r.hi) ? 'bad' : '') }],
    note: 'Red: mean predicted lies outside the observed rate\'s 95% interval.',
  });
}
