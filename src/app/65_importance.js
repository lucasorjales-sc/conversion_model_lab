/* ==========================================================================
   65 · FEATURE IMPORTANCE (Segment Diagnostics)
   SHAP-based global importance for the active segment (the global filters and
   cohorts), cohort comparison against the global baseline, single-observation
   explanations, and feature dependence. Calculations live in 62_shap.js.
   ========================================================================== */
const fiState = () => (S.ui.fi ||= { sub: 'global', mode: 'abs', topN: 15, cohorts: [], hidden: [], pick: 'top', seed: 1, search: '', rid: null, dep: null, saving: false });
TIPS.shap_abs = 'Mean |SHAP|: the average size of a feature\'s contribution to individual predictions, in either direction. It ranks how much the model relies on the feature in this segment; it is not a causal effect.';
TIPS.shap_signed = 'Mean SHAP (signed): the average contribution, keeping direction. It is how far the feature moves this segment\'s average prediction away from the model\'s baseline; ups and downs cancel.';
TIPS.shap_base = 'Baseline (expected value): the model\'s average output over the explainer\'s background data. Each prediction = baseline + the sum of its SHAP values.';
TIPS.shap_up = 'Average of the positive contributions (rows where the feature pushed the prediction up), over all rows. Pushes up + |pushes down| = mean |SHAP|.';
TIPS.shap_down = 'Average of the negative contributions (rows where the feature pushed the prediction down), over all rows.';

async function importanceView(body, v) {
  const F = fiState();
  if (!S.shap) { html(body, shapMissingHTML()); wireCopy(body); return; }
  html(body, `<div id="fi-seg">${computing('Checking SHAP values…')}</div>
    <div class="subnav" style="margin-top:24px">${segHTML('fisub', [{ v: 'global', label: 'Importance' }, { v: 'compare', label: 'Compare cohorts' }, { v: 'row', label: 'Individual prediction' }, { v: 'dep', label: 'Feature dependence' }], F.sub)}</div>
    <div id="fi-body"></div>`);
  bindSeg(body, 'fisub', s => { F.sub = s; fiBody(v); });
  let chk, agg;
  try { chk = await shapCheck(); if (stale(v)) return; agg = await shapAgg(curSeg()); if (stale(v)) return; }
  catch (e) { console.error(e); html($('#fi-seg'), callout('bad', `SHAP values could not be read: ${esc(e.message)}`)); return; }
  renderSegBanner(chk, agg, v);
  await fiBody(v);
}
async function fiBody(v) {
  const F = fiState(), host = $('#fi-body'); if (!host) return;
  html(host, computing());
  try {
    const chk = await shapCheck(), agg = await shapAgg(curSeg()); if (stale(v)) return;
    if (!agg.n) { html(host, empty('No rows with SHAP values in this segment', `The segment has ${fmtInt(S.pop.n)} rows, but none has a complete set of SHAP values. Widen the filters, or export SHAP values for these rows.`)); return; }
    if (F.sub === 'global') return fiGlobal(host, chk, agg, v);
    if (F.sub === 'compare') return fiCompare(host, chk, agg, v);
    if (F.sub === 'row') return fiRow(host, chk, agg, v);
    return fiDependence(host, chk, agg, v);
  } catch (e) { console.error(e); if (!stale(v)) html(host, callout('bad', `This view could not be computed: ${esc(e.message)}`)); }
}
const unitsOf = chk => chk.units;
const fmtOut = x => (fin(x) ? (Math.abs(x) >= 100 ? fmtNum(x, 1) : x.toFixed(3)) : '—');

/* ------------------------------------------------------- segment banner */
function renderSegBanner(chk, agg, v) {
  const F = fiState(), seg = curSeg(), host = $('#fi-seg'); if (!host) return;
  const cov = div(agg.n, S.pop.n);
  const status = chk.match
    ? statusPill('good', `Adds up to ${chk.match.label} (${chk.units})`)
    : chk.monotone ? statusPill('info', 'Explains the ranking, not the score scale') : statusPill('warn', 'Additivity not confirmed');
  html(host, `<section class="card fi-banner">
      <div class="fi-banner-main">
        <div class="eyebrow">Analysing</div>
        <div class="fi-seg-name">${segEmpty(seg) ? 'Full evaluation population' : [...seg.filters.map(f => `<span class="ctx-chip accent">${esc(filterText(f))}</span>`), ...seg.cohorts.map(c => `<span class="ctx-chip accent">Cohort <b>${esc(c.name)}</b></span>`)].join('')}</div>
        <div class="fi-seg-stats"><b>${fmtInt(agg.n)}</b> predictions with SHAP values · <b>${fmtInt(agg.clients)}</b> clients · <b>${fmtInt(agg.pos)}</b> positive rows
          <span class="faint">· ${cov !== null && cov < 0.999 ? `${fmtPct(cov)} of the ${fmtInt(S.pop.n)} rows in this segment have SHAP values` : 'every row in this segment has SHAP values'} · ${S.settings.d0} → ${S.settings.d1}</span></div>
        ${agg.n < 200 ? `<div style="margin-top:10px">${callout('warn', `Only ${fmtInt(agg.n)} predictions: averages in this segment are noisy. Intervals are shown; treat small differences as noise.`)}</div>` : ''}
      </div>
      <div class="fi-banner-side">
        ${status}
        <div class="fi-banner-actions">
          <button class="btn sm" id="fi-filters">${FILTER_ICON} ${segEmpty(seg) ? 'Filter a segment' : 'Edit filters'}</button>
          <button class="btn sm ${segEmpty(seg) ? '' : 'primary'}" id="fi-save" ${segEmpty(seg) ? 'disabled data-tip="Apply filters first: the current segment is the whole evaluation population (the global baseline)."' : ''}>Save as cohort…</button>
        </div>
        <form id="fi-save-form" class="fi-save-form ${F.saving ? '' : 'hidden'}"><input type="text" id="fi-save-name" maxlength="60" placeholder="Cohort name" aria-label="Cohort name"><button class="btn sm primary" type="submit">Save</button><button class="btn sm" type="button" id="fi-save-cancel">Cancel</button></form>
      </div>
    </section>
    <div style="margin-top:12px">${disc('About these SHAP values', shapAboutHTML(chk), { cls: 'line', sub: `${fmtInt(S.shap.cols.length)} features · ${chk.units} · ${fmtPct(div(chk.cov.full, chk.cov.n))} of rows explained` })}</div>`);
  $('#fi-filters').onclick = () => openFilters();
  const form = $('#fi-save-form'), name = $('#fi-save-name');
  $('#fi-save').onclick = () => { F.saving = true; form.classList.remove('hidden'); name.value = suggestCohortName(seg); name.select(); name.focus(); };
  $('#fi-save-cancel').onclick = () => { F.saving = false; form.classList.add('hidden'); };
  form.onsubmit = e => {
    e.preventDefault();
    const nm = name.value.trim() || suggestCohortName(seg);
    F.cohorts.push({ id: Date.now(), name: nm, filters: seg.filters, cohorts: seg.cohorts, text: segText(seg), n: agg.n });
    F.saving = false; F.hidden = F.hidden.filter(x => x !== 'cur');
    toast(`Saved cohort “${nm}”. Compare it with the global baseline under Compare cohorts.`);
    F.sub = 'compare'; importanceView($('#sg-body'), v);
  };
}
function suggestCohortName(seg) { const t = segText(seg); return t.length > 40 ? t.slice(0, 38) + '…' : t; }
function shapAboutHTML(chk) {
  const X = S.shap, c = chk.cov;
  const add = chk.match
    ? `<b>Additivity holds.</b> Baseline + the sum of SHAP values reproduces <b>${chk.match.label}</b> on the ${chk.match.link === 'logit' ? 'log-odds' : 'original'} scale for 99% of rows to within ${fmtNum(chk.match.err, 4)}. Values are in <b>${chk.units}</b>.${chk.baseSource === 'inferred' ? ` The file has no base-value column; the baseline (${fmtOut(chk.base)}) was inferred from additivity, because logit(score) − ΣSHAP is the same for every row.` : ''}`
    : chk.monotone
      ? `<b>The values explain the ranking, not the score's scale.</b> PREDICTED_SCORE never decreases as baseline + ΣSHAP increases (a monotone transform; rank correlation ${fmtNum(chk.rankCorr, 4)}, below 1 only because of tied scores) but does not equal it — typically SHAP explains the raw model output and the score was calibrated afterwards. Importance and directions are valid for the ranking; the model-output figures are in the explainer's units, not probabilities.`
      : `<b>Additivity could not be confirmed.</b> Baseline + ΣSHAP does not reproduce PREDICTED_SCORE${S.roles.prob ? ' or PREDICTED_PROBABILITY' : ''}${fin(chk.rankCorr) ? ` and only partly follows its ranking (rank correlation ${fmtNum(chk.rankCorr, 3)})` : ''}. The values may come from a different model version or different rows. Check the export before relying on them.`;
  return `<div class="methodology">
    <p>${add}</p>
    <ul>
      <li><b>Source:</b> ${fmtInt(X.cols.length)} columns named like <span class="mono">${esc(X.cols[0].src)}</span>${X.hasBase ? `, baseline from <span class="mono">${esc(X.baseSrc)}</span>` : ''}. ${X.cols.filter(x => !x.valueCol).length ? `${plural(X.cols.filter(x => !x.valueCol).length, 'feature')} without its own value column in the file (contributions shown, values not): ${X.cols.filter(x => !x.valueCol).slice(0, 6).map(x => `<span class="mono">${esc(x.feature)}</span>`).join(', ')}${X.cols.filter(x => !x.valueCol).length > 6 ? '…' : ''}.` : 'Every feature\'s own value is in the file.'}</li>
      <li><b>Coverage:</b> ${fmtInt(c.full)} of ${fmtInt(c.n)} valid rows (${fmtPct(div(c.full, c.n))}) have a complete set${c.partial ? `; ${fmtInt(c.partial)} rows with only some values are left out` : ''}. Rows without SHAP values are never filled in.</li>
      <li><b>Grain:</b> SHAP explains one prediction (one client-date row), so every average here is over rows. A client scored on more dates weighs more.</li>
      <li><b>Intervals:</b> 95%, client-clustered (a client's rows are not independent).</li>
      <li><b>Reading it:</b> SHAP describes how the <i>model</i> uses each feature, relative to the baseline (its average output over the explainer's background data, usually the training set). It is not causal: correlated features share credit, and a feature can matter to the model without driving conversion.</li>
    </ul></div>`;
}

/* --------------------------------------------------------- global view */
function fiGlobal(host, chk, agg, v) {
  const F = fiState(), c = C(), mode = F.mode, units = unitsOf(chk);
  const all = agg.feats.filter(f => fin(f.abs));
  const N = F.topN === 0 ? all.length : Math.min(F.topN, all.length);
  const shown = mode === 'abs' ? all.slice(0, N) : all.slice().sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed)).slice(0, N).sort((a, b) => b.signed - a.signed);
  const base = fin(agg.meanBase) ? agg.meanBase : chk.base;
  const filtered = S.filters.map(f => S.shap.cols.find(x => x.valueCol === f.col)).filter(Boolean);
  const notes = [];
  if (mode === 'abs') {
    const k = Math.min(3, all.length), top = all.slice(0, k).reduce((a, f) => a + f.share, 0);
    notes.push(`The top ${k} features (${all.slice(0, k).map(f => `<b>${esc(f.feature)}</b>`).join(', ')}) account for ${fmtPct(top)} of the total attribution in this segment. Each bar's length is the mean |SHAP|; its two colours split it into the average push up and the average push down.`);
  } else {
    const ups = all.filter(f => shapSide(f) > 0).sort((a, b) => b.signed - a.signed), downs = all.filter(f => shapSide(f) < 0).sort((a, b) => a.signed - b.signed);
    notes.push(`${ups.length ? `Pushing this segment's predictions up most: ${ups.slice(0, 3).map(f => `<b>${esc(f.feature)}</b> (${fmtPhi(f.signed)})`).join(', ')}.` : 'No feature pushes this segment up by a clear margin.'} ${downs.length ? `Pushing down most: ${downs.slice(0, 3).map(f => `<b>${esc(f.feature)}</b> (${fmtPhi(f.signed)})`).join(', ')}.` : ''}`);
    if (fin(base)) notes.push(`Baseline ${fmtOut(base)} + net feature effects ${fmtPhi(agg.sumSigned)} = average model output ${fmtOut(base + agg.sumSigned)} ${units}${chk.match?.link === 'logit' ? ` (the average log-odds; a typical row's raw probability is about ${fmtPct(sigmoid(base + agg.sumSigned))})` : ''}.`);
    if (segEmpty(curSeg())) notes.push('On the whole population, signed values are usually small: contributions are measured against the baseline, which is itself an average. They become informative for segments — filter one to see why it scores higher or lower than average.');
  }
  if (filtered.length) notes.push(`This segment is defined on ${filtered.map(x => `<b>${esc(x.feature)}</b>`).join(', ')}. Inside it every row has a similar value, so ${filtered.length > 1 ? 'their' : 'its'} contribution mostly reflects the filter itself; compare with care.`);
  html(host, `
    <div class="card">
      <div class="card-head"><div class="titles"><h3>${mode === 'abs' ? 'Feature importance (mean |SHAP|)' : 'Contribution direction (mean SHAP)'} ${tip(mode === 'abs' ? 'shap_abs' : 'shap_signed')}</h3>
        <div class="sub">${mode === 'abs' ? `Ranked by magnitude, regardless of direction · ${units}` : `Ranked from the strongest upward to the strongest downward push · ${units}`} · ${fmtInt(agg.n)} predictions</div></div>
        <div class="actions">${segHTML('fimode', [{ v: 'abs', label: 'Absolute', tip: TIPS.shap_abs }, { v: 'signed', label: 'Signed', tip: TIPS.shap_signed }], mode)}
          <select id="fi-topn" aria-label="Number of features">${[10, 15, 25, 0].map(k => `<option value="${k}" ${k === F.topN ? 'selected' : ''}>${k ? `Top ${k}` : `All ${all.length}`}</option>`).join('')}</select></div></div>
      ${legend(mode === 'abs' ? [['Pushes prediction up', c.up], ['Pushes prediction down', c.down], ['95% interval', c.text3, 'dot']] : [['Net push up', c.up], ['Net push down', c.down]])}
      <div class="chart" id="fi-chart" style="height:${Math.max(260, 70 + shown.length * 26)}px"></div>
    </div>
    <div style="margin-top:16px">${callout('info', notes.join(' '), 'Interpretation.')}</div>
    <div class="card" style="margin-top:20px">${disc('All features', '<div id="fi-tbl"></div>', { cls: 'line', open: false, sub: `${all.length} features · sortable · exportable` })}</div>`);
  const ylab = shown.map(f => f.feature);
  const hov = shown.map(f => [f.abs, f.signed, f.up, f.down, f.rank, f.share]);
  const ht = `<b>%{y}</b><br>mean |SHAP| %{customdata[0]:.4f} (rank %{customdata[4]}, %{customdata[5]:.1%} of total)<br>mean SHAP %{customdata[1]:+.4f}<br>pushes up %{customdata[2]:+.4f} · down %{customdata[3]:+.4f}<extra></extra>`;
  const traces = mode === 'abs' ? [
    { type: 'bar', orientation: 'h', y: ylab, x: shown.map(f => f.up), name: 'Pushes up', marker: { color: c.up }, customdata: hov, hovertemplate: ht },
    { type: 'bar', orientation: 'h', y: ylab, x: shown.map(f => -f.down), name: 'Pushes down', marker: { color: c.down }, customdata: hov, hovertemplate: ht },
    { type: 'scatter', mode: 'markers', y: ylab, x: shown.map(f => f.abs), marker: { size: 1, color: c.text3 }, error_x: { type: 'data', array: shown.map(f => 1.96 * (f.seAbs || 0)), color: c.text3, thickness: 1.2, width: 3 }, hoverinfo: 'skip', showlegend: false },
  ] : [
    { type: 'bar', orientation: 'h', y: ylab, x: shown.map(f => f.signed), marker: { color: shown.map(f => (f.signed >= 0 ? c.up : c.down)) }, customdata: hov, hovertemplate: ht,
      error_x: { type: 'data', array: shown.map(f => 1.96 * (f.seSigned || 0)), color: c.text3, thickness: 1.2, width: 3 } },
  ];
  plot($('#fi-chart'), traces, { barmode: 'stack', showlegend: false, bargap: 0.28, margin: { l: 10, r: 20, t: 8, b: 44 },
    yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: mode === 'abs' ? `Mean |SHAP| (${units})` : `Mean SHAP (${units})` }, zeroline: true, zerolinecolor: c.axis } });
  bindSeg(host, 'fimode', m => { F.mode = m; fiGlobal(host, chk, agg, v); });
  $('#fi-topn').onchange = e => { F.topN = +e.target.value; fiGlobal(host, chk, agg, v); };
  renderTable($('#fi-tbl'), {
    rows: all, exportName: `shap_importance_${slug(segText(curSeg()))}`, maxRows: 200, sort: { key: 'abs', dir: -1 },
    columns: [{ key: 'rank', label: 'Rank', num: true }, { key: 'feature', label: 'Feature', fmt: (x, r) => `<span class="mono">${esc(x)}</span>${r.valueCol ? '' : ' ' + flag('no value column', 'na')}` },
      { key: 'abs', label: 'Mean |SHAP|', tip: 'shap_abs', num: true, fmt: (x, r) => `${fmtNum(x, 4)} ${fmtCI(x - 1.96 * r.seAbs, x + 1.96 * r.seAbs, y => fmtNum(y, 4))}` },
      { key: 'share', label: 'Share', num: true, fmt: x => fmtPct(x) },
      { key: 'signed', label: 'Mean SHAP', tip: 'shap_signed', num: true, fmt: (x, r) => `${dirArrow(shapSide(r))}${fmtPhi(x)} ${fmtCI(x - 1.96 * r.seSigned, x + 1.96 * r.seSigned, fmtPhi)}` },
      { key: 'up', label: 'Pushes up', tip: 'shap_up', num: true, fmt: fmtPhi }, { key: 'down', label: 'Pushes down', tip: 'shap_down', num: true, fmt: fmtPhi }],
    exportRows: data => data.map(r => ({ segment: segText(curSeg()), rank: r.rank, feature: r.feature, mean_abs_shap: r.abs, mean_abs_shap_se: r.seAbs, share_of_total: r.share, mean_shap: r.signed, mean_shap_se: r.seSigned, mean_push_up: r.up, mean_push_down: r.down, units, predictions: agg.n })),
  });
}
const dirArrow = s => (s > 0 ? '<span class="dir up" aria-label="pushes up">▲</span> ' : s < 0 ? '<span class="dir down" aria-label="pushes down">▼</span> ' : '');
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'all';

/* -------------------------------------------------------- cohort comparison */
async function fiCompare(host, chk, agg, v) {
  const F = fiState(), c = C(), mode = F.mode, units = unitsOf(chk), seg = curSeg();
  const groups = [{ id: 'base', name: 'Global baseline', text: 'Full evaluation population (no filters or cohorts)', seg: { filters: [], cohorts: [] } }];
  if (!segEmpty(seg) && !F.cohorts.some(k => k.text === segText(seg))) groups.push({ id: 'cur', name: 'Current segment', text: segText(seg), seg, unsaved: true });
  for (const k of F.cohorts) groups.push({ id: String(k.id), name: k.name, text: k.text, seg: { filters: k.filters, cohorts: k.cohorts }, saved: k });
  const active = groups.filter(g => g.id === 'base' || !F.hidden.includes(g.id));
  if (groups.length === 1) {
    html(host, `<div class="card">${empty('No cohorts to compare yet', 'Use <b>Filter a segment</b> above to narrow the population (for example one lifecycle stage, or clients with few recent visits), then <b>Save as cohort…</b>. Each saved cohort is compared with the global baseline and with the others, under the current evaluation settings.')}</div>`);
    return;
  }
  html(host, computing(`Aggregating ${plural(active.length, 'group')}…`));
  const aggs = [];
  for (const g of active) { aggs.push(await shapAgg(g.seg)); if (stale(v)) return; }
  const A = new Map(active.map((g, i) => [g.id, aggs[i]]));
  const baseAgg = A.get('base'), byF = a => new Map(a.feats.map(f => [f.feature, f]));
  const maps = active.map(g => byF(A.get(g.id)));
  // features: the strongest in ANY group, so cohort-specific drivers are not hidden by the baseline ranking
  const score = f => Math.max(...maps.map(m => Math.abs(shapMetric(m.get(f), mode) ?? 0)));
  const feats = S.shap.cols.map(x => x.feature).sort((a, b) => score(b) - score(a));
  const N = Math.min(F.topN || feats.length, feats.length, 20), shown = feats.slice(0, N);
  const palette = [c.base, c.s1, c.s2, c.s3, c.s5, c.s4, c.accent];
  // headline differences per group vs the baseline
  const bmap = maps[0];
  const summaries = active.slice(1).map((g, gi) => {
    const m = maps[gi + 1], a = A.get(g.id), rows = [];
    for (const f of S.shap.cols.map(x => x.feature)) {
      const d = shapDiff(m.get(f), bmap.get(f), mode), sb = shapSide(bmap.get(f)), sc = shapSide(m.get(f));
      rows.push({ f, ...d, flip: sb && sc && sb !== sc });
    }
    // a feature the cohort is filtered on differs by construction: listed separately, never reported as a finding
    const defining = new Set(g.seg.filters.map(f => S.shap.cols.find(x => x.valueCol === f.col)?.feature).filter(Boolean));
    const sig = rows.filter(r => r.sig && !defining.has(r.f)).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const flips = rows.filter(r => r.flip && !defining.has(r.f));
    return { g, a, sig, flips, defining: rows.filter(r => defining.has(r.f)) };
  });
  html(host, `
    <div class="card">
      <div class="card-head"><div class="titles"><h3>${mode === 'abs' ? 'Importance by cohort (mean |SHAP|)' : 'Direction by cohort (mean SHAP)'}</h3>
        <div class="sub">Top ${N} features across all groups · ${units} · each cohort is evaluated under the current evaluation settings</div></div>
        <div class="actions">${segHTML('fimode', [{ v: 'abs', label: 'Absolute', tip: TIPS.shap_abs }, { v: 'signed', label: 'Signed', tip: TIPS.shap_signed }], mode)}</div></div>
      <div class="fi-groups">${groups.map((g, i) => { const on = g.id === 'base' || !F.hidden.includes(g.id); const col = palette[active.indexOf(g)] || c.text3;
        return `<label class="fi-group ${on ? 'on' : ''}" data-tip="${esc(g.text)}"><input type="checkbox" data-grp="${esc(g.id)}" ${on ? 'checked' : ''} ${g.id === 'base' ? 'disabled' : ''}><i style="background:${on ? col : 'transparent'};border-color:${on ? col : c.text3}"></i>${esc(g.name)}${on ? `<span class="faint">${fmtCompact(A.get(g.id).n)}</span>` : ''}</label>`; }).join('')}</div>
      <div class="chart" id="fi-cmp" style="height:${Math.max(320, 80 + N * (14 + 9 * active.length))}px"></div>
    </div>
    <div class="grid ${summaries.length > 1 ? 'g2' : ''}" style="margin-top:20px">${summaries.map(s => cohortSummaryCard(s, mode, units)).join('')}</div>
    <div class="card" style="margin-top:20px">${disc('Difference table', '<div id="fi-cmp-tbl"></div>', { cls: 'line', open: true, sub: `every feature · Δ vs the global baseline · ▲▼ = clearly different (95%)` })}</div>
    <div class="card" style="margin-top:20px">${disc(`Saved cohorts (${F.cohorts.length})`, cohortListHTML(A), { cls: 'line', open: !F.cohorts.length, sub: 'load back into the filters, or delete' })}</div>`);
  plot($('#fi-cmp'), active.map((g, i) => {
    const m = maps[i];
    return { type: 'bar', orientation: 'h', name: g.name, y: shown, x: shown.map(f => shapMetric(m.get(f), mode)), marker: { color: palette[i] },
      error_x: { type: 'data', array: shown.map(f => 1.96 * (shapSE(m.get(f), mode) || 0)), color: c.text3, thickness: 1, width: 2 },
      hovertemplate: `<b>${esc(g.name)}</b><br>%{y}: %{x:.4f}<extra></extra>` };
  }), { barmode: 'group', bargap: 0.25, bargroupgap: 0.06, showlegend: false, margin: { l: 10, r: 20, t: 8, b: 44 },
    yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: mode === 'abs' ? `Mean |SHAP| (${units})` : `Mean SHAP (${units})` }, zeroline: true, zerolinecolor: c.axis } });
  bindSeg(host, 'fimode', m => { F.mode = m; fiCompare(host, chk, agg, v); });
  $$('[data-grp]', host).forEach(cb => cb.onchange = () => { const id = cb.dataset.grp; F.hidden = cb.checked ? F.hidden.filter(x => x !== id) : [...F.hidden, id]; fiCompare(host, chk, agg, v); });
  // difference table: one row per feature
  const rows = S.shap.cols.map(x => x.feature).map(f => {
    const r = { feature: f, base: shapMetric(bmap.get(f), mode), baseRank: bmap.get(f)?.rank, baseSide: shapSide(bmap.get(f)) };
    active.slice(1).forEach((g, gi) => {
      const cf = maps[gi + 1].get(f), d = shapDiff(cf, bmap.get(f), mode);
      r['v' + gi] = shapMetric(cf, mode); r['d' + gi] = d.d; r['s' + gi] = d.sig; r['r' + gi] = cf?.rank; r['f' + gi] = shapSide(cf) && r.baseSide && shapSide(cf) !== r.baseSide; r['side' + gi] = shapSide(cf);
    });
    r.maxAbsD = Math.max(0, ...active.slice(1).map((_, gi) => (r['s' + gi] ? Math.abs(r['d' + gi]) : 0)));
    return r;
  });
  renderTable($('#fi-cmp-tbl'), {
    rows, exportName: 'shap_cohort_comparison', maxRows: 200, sort: { key: 'maxAbsD', dir: -1 },
    columns: [{ key: 'feature', label: 'Feature', fmt: x => `<span class="mono">${esc(x)}</span>` },
      { key: 'base', label: 'Baseline', num: true, fmt: (x, r) => `${mode === 'signed' ? dirArrow(r.baseSide) + fmtPhi(x) : fmtNum(x, 4)} <span class="faint">#${r.baseRank}</span>` },
      ...active.slice(1).flatMap((g, gi) => [
        { key: 'v' + gi, label: g.name, num: true, fmt: (x, r) => `${mode === 'signed' ? dirArrow(r['side' + gi]) + fmtPhi(x) : fmtNum(x, 4)} <span class="faint">#${r['r' + gi] ?? '—'}${rankMove(r.baseRank, r['r' + gi])}</span>${r['f' + gi] ? ' ' + flag('direction flips', 'bad') : ''}` },
        { key: 'd' + gi, label: `Δ ${g.name}`, num: true, fmt: (x, r) => (fin(x) ? `<span class="${r['s' + gi] ? (x > 0 ? 'delta up' : 'delta down') : 'dim'}">${r['s' + gi] ? (x > 0 ? '▲ ' : '▼ ') : ''}${fmtPhi(x)}</span>` : '—') }]),
      { key: 'maxAbsD', label: 'Largest clear Δ', num: true, fmt: x => (x ? fmtNum(x, 4) : '<span class="dim">—</span>') }],
    exportRows: data => data.map(r => { const o = { feature: r.feature, metric: mode === 'abs' ? 'mean_abs_shap' : 'mean_shap', units, baseline: r.base, baseline_rank: r.baseRank };
      active.slice(1).forEach((g, gi) => { o[`${g.name} value`] = r['v' + gi]; o[`${g.name} rank`] = r['r' + gi]; o[`${g.name} delta`] = r['d' + gi]; o[`${g.name} clearly_different`] = r['s' + gi]; o[`${g.name} direction_flips`] = r['f' + gi]; }); return o; }),
  });
  host.querySelectorAll('[data-load]').forEach(b => b.onclick = async () => {
    const k = F.cohorts.find(x => String(x.id) === b.dataset.load); if (!k) return;
    S.filters = k.filters.filter(f => S.disc.features.some(x => x.name === f.col)).map(f => ({ ...f, vals: f.vals ? f.vals.slice() : undefined })); S.cohorts = k.cohorts.slice();
    await busy.wrap(() => applySettings(), 'Applying cohort filters…'); toast(`Filters set to cohort “${k.name}” on every tab.`);
  });
  host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { F.cohorts = F.cohorts.filter(x => String(x.id) !== b.dataset.del); F.hidden = F.hidden.filter(x => x !== b.dataset.del); fiCompare(host, chk, agg, v); });
}
const rankMove = (a, b) => (fin(a) && fin(b) && a !== b ? (b < a ? ` <span class="delta up">↑${a - b}</span>` : ` <span class="delta down">↓${b - a}</span>`) : '');
function cohortSummaryCard({ g, a, sig, flips, defining }, mode, units) {
  const ups = sig.filter(r => r.d > 0).slice(0, 3), downs = sig.filter(r => r.d < 0).slice(0, 3);
  const what = mode === 'abs' ? ['matters more', 'matters less'] : ['pushes up more', 'pushes down more'];
  const li = r => `<li><b>${esc(r.f)}</b> ${fmtPhi(r.d)}${mode === 'abs' && fin(r.ratio) ? ` (${fmtX(r.ratio, 1)} the baseline)` : ''}</li>`;
  return card(esc(g.name), `
    <div class="faint" style="margin:-8px 0 12px">${esc(g.text)} · ${fmtInt(a.n)} predictions · ${fmtInt(a.clients)} clients</div>
    ${a.n < 200 ? callout('warn', 'Small cohort: few differences can be told apart from noise.') : ''}
    ${!sig.length && !flips.length ? `<p class="muted">No feature's ${mode === 'abs' ? 'importance' : 'mean contribution'} differs clearly from the baseline (95%).</p>` : `
    <div class="grid g2" style="gap:12px">
      <div><div class="fi-k up">${what[0]}</div>${ups.length ? `<ul class="fi-list">${ups.map(li).join('')}</ul>` : '<div class="faint">None clearly</div>'}</div>
      <div><div class="fi-k down">${what[1]}</div>${downs.length ? `<ul class="fi-list">${downs.map(li).join('')}</ul>` : '<div class="faint">None clearly</div>'}</div>
    </div>`}
    ${defining.length ? `<p class="faint" style="margin-top:10px">Defines this cohort, so it differs by construction: ${defining.map(r => `<b>${esc(r.f)}</b> ${fmtPhi(r.d)}`).join(', ')}.</p>` : ''}
    ${flips.length ? `<div style="margin-top:12px">${callout('warn', `${flips.slice(0, 4).map(r => `<b>${esc(r.f)}</b>`).join(', ')}${flips.length > 4 ? ` and ${flips.length - 4} more` : ''} push${flips.length === 1 ? 'es' : ''} predictions the opposite way in this cohort compared with the whole population.`, 'Direction flips.')}</div>` : ''}`,
  { sub: '' });
}
function cohortListHTML(A) {
  const F = fiState();
  if (!F.cohorts.length) return '<div class="faint">No saved cohorts yet. Filter a segment, then use <b>Save as cohort…</b> above.</div>';
  return `<table class="plain"><thead><tr><th>Cohort</th><th>Definition</th><th class="num">Predictions now</th><th></th></tr></thead><tbody>${F.cohorts.map(k => {
    const a = A.get(String(k.id));
    return `<tr><td><b>${esc(k.name)}</b></td><td class="faint">${esc(k.text)}</td><td class="num">${a ? fmtInt(a.n) : '<span class="faint">hidden</span>'}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-load="${k.id}" data-tip="Set the global filters to this cohort (every tab)">Load into filters</button> <button class="btn sm" data-del="${k.id}">Delete</button></td></tr>`;
  }).join('')}</tbody></table><p class="faint" style="margin-top:8px">Cohorts store their filter definitions, not their rows: each is re-evaluated under the current evaluation settings, and saved with this file.</p>`;
}

/* ---------------------------------------------------- individual prediction */
const PICKS = { top: 'Top scores', missed: 'Missed', fa: 'False alarms', random: 'Random' };   // missed = converters with the lowest scores
async function fiRow(host, chk, agg, v) {
  const F = fiState(), W = shapWhere(curSeg());
  html(host, `<div class="grid fi-row-grid">
      <div class="card fi-picker">
        <h3>Choose a prediction</h3>
        <form id="fi-search-form" class="fi-search"><input type="search" id="fi-search" placeholder="Client ID" value="${esc(F.search)}" aria-label="Find a client by ID"><button class="btn sm" type="submit">Find</button></form>
        <div style="margin:12px 0 10px">${segHTML('fipick', Object.entries(PICKS).map(([k, l]) => ({ v: k, label: l })), F.search ? '' : F.pick, 'fi-pick-seg')}</div>
        <div id="fi-list">${computing()}</div>
      </div>
      <div id="fi-explain">${computing()}</div>
    </div>`);
  bindSeg(host, 'fipick', p => { F.pick = p; F.search = ''; $('#fi-search').value = ''; drawList(); });
  $('#fi-search-form').onsubmit = e => { e.preventDefault(); F.search = $('#fi-search').value.trim(); drawList(); };
  const drawList = async () => {
    const base = `SELECT __rid, client_id, strftime(date, '%Y-%m-%d') AS date, y, score FROM data WHERE ${W}`;
    const sql = F.search ? `${base} AND CAST(client_id AS VARCHAR) = ${ql(F.search)} ORDER BY date LIMIT 60`
      : F.pick === 'missed' ? `${base} AND y = 1 ORDER BY score, __hb, __rid LIMIT 12`
      : F.pick === 'fa' ? `${base} AND y = 0 ORDER BY score DESC, __hb, __rid LIMIT 12`
      : F.pick === 'random' ? `${base} ORDER BY hash(__rid, ${F.seed}) LIMIT 12`
      : `${base} ORDER BY score DESC, __hb, __rid LIMIT 12`;
    const rows = await q(sql); if (stale(v)) return;
    const lh = $('#fi-list'); if (!lh) return;
    if (!rows.length) { html(lh, empty(F.search ? `No predictions with SHAP values for client “${esc(F.search)}” in this segment` : 'No predictions match', F.search ? 'Client IDs must match exactly. The client may be outside the current filters or evaluation window.' : '')); return; }
    if (!rows.some(r => r.__rid === F.rid)) F.rid = F.search || !F.rid ? rows[0].__rid : F.rid;
    html(lh, `<div class="tbl-wrap"><table class="data fi-pick-tbl"><thead><tr><th>Client</th><th>Date</th><th class="num">Score</th><th data-tip="Converted within the outcome horizon">Converted</th></tr></thead><tbody>${rows.map(r => `<tr data-rid="${r.__rid}" class="${r.__rid === F.rid ? 'sel' : ''}" tabindex="0"><td class="mono">${esc(r.client_id)}</td><td>${r.date}</td><td class="num">${fmtScore(r.score)}</td><td>${r.y ? flag('yes', 'good') : '<span class="dim">no</span>'}</td></tr>`).join('')}</tbody></table></div>
      ${F.pick === 'random' && !F.search ? '<button class="link-btn small" id="fi-shuffle" style="margin-top:8px">Shuffle</button>' : ''}`);
    $$('tr[data-rid]', lh).forEach(tr => { const pickRow = () => { F.rid = +tr.dataset.rid; $$('tr.sel', lh).forEach(x => x.classList.remove('sel')); tr.classList.add('sel'); drawExplain(); }; tr.onclick = pickRow; tr.onkeydown = e => { if (e.key === 'Enter') pickRow(); }; });
    const sh = $('#fi-shuffle'); if (sh) sh.onclick = () => { F.seed++; drawList(); };
    drawExplain();
  };
  const drawExplain = async () => {
    const eh = $('#fi-explain'); if (!eh || F.rid === null) return;
    const rid = F.rid;
    const [r, pct] = await Promise.all([shapRow(rid, chk), q1(`SELECT COUNT(*) FILTER (WHERE score > (SELECT score FROM data WHERE __rid = ${Math.round(rid)})) / COUNT(*) AS p FROM data WHERE ${W}`)]);
    if (stale(v) || F.rid !== rid || !$('#fi-explain')) return;
    if (!r) { html(eh, empty('This prediction is no longer available')); return; }
    renderExplanation(eh, r, pct.p, chk, agg);
  };
  await drawList();
}
function renderExplanation(host, r, pct, chk, agg) {
  const c = C(), units = unitsOf(chk), K = 12;
  const top = r.contribs.slice(0, K), rest = r.contribs.slice(K), restSum = rest.reduce((a, x) => a + x.phi, 0);
  const hasBase = fin(r.base), start = hasBase ? r.base : 0, out = start + r.sum;
  const lab = x => { let t = x.valueCol ? `${x.feature} = ${fmtVal(x.value)}` : x.feature; if (t.length > 40) t = t.slice(0, 38) + '…'; return `${t}  <b>${fmtPhi(x.phi)}</b>`; };
  const ys = [`${hasBase ? 'Baseline' : 'Start (baseline not in file)'}  <b>${fmtOut(start)}</b>`, ...top.map(lab), ...(rest.length ? [`${plural(rest.length, 'other feature')}  <b>${fmtPhi(restSum)}</b>`] : []), `Model output  <b>${fmtOut(out)}</b>`];
  const xs = [start, ...top.map(x => x.phi), ...(rest.length ? [restSum] : []), out];
  const measure = ['absolute', ...top.map(() => 'relative'), ...(rest.length ? ['relative'] : []), 'total'];
  const link = chk.match?.link, target = chk.match?.target;
  const targetVal = target === 'prob' ? r.prob : r.score;
  const recon = link === 'logit' ? sigmoid(out) : link === 'id' ? out : null;
  const typical = new Map(agg.feats.map(f => [f.feature, f]));
  html(host, `<div class="card">
      <div class="card-head"><div class="titles"><h3>Why the model scored <span class="mono">${esc(r.client_id)}</span> on ${r.date}</h3>
        <div class="sub">Each bar moves the prediction from the baseline to the model output · ${units}</div></div>
        <div class="actions"><button class="btn sm" id="fi-row-export">${ICON.download} Export</button></div></div>
      <div class="tiles">
        ${tile('PREDICTED_SCORE', fmtScore(r.score), { size: 'md', sub: !fin(pct) ? '' : pct < 0.5 ? `top ${fmtPct(Math.max(pct, 1e-4), pct < 0.01 ? 2 : 1)} of this segment` : `bottom ${fmtPct(Math.max(1 - pct, 1e-4), 1 - pct < 0.01 ? 2 : 1)} of this segment` })}
        ${tile('Outcome', r.y ? 'Converted' : 'Did not convert', { size: 'md', sub: `within ${S.settings.horizon} days`, hl: !!r.y })}
        ${tile('Model output from SHAP', hasBase ? fmtOut(out) : `${fmtPhi(r.sum)}`, { size: 'md', tipKey: 'shap_base', sub: hasBase ? `baseline ${fmtOut(r.base)} ${fmtPhi(r.sum)} · ${units}` : 'sum of contributions (no baseline)' })}
        ${recon !== null ? tile(link === 'logit' ? 'As a probability' : 'Reconstructed', fmtPct(recon, 2), { size: 'md', sub: `${chk.match.label} = ${target === 'prob' ? fmtPct(targetVal, 2) : fmtScore(targetVal)} · ${Math.abs(recon - targetVal) < 1e-3 ? 'matches' : `differs by ${fmtNum(Math.abs(recon - targetVal), 4)}`}` }) : ''}
      </div>
      ${legend([['Pushes up', c.up], ['Pushes down', c.down], ['Baseline and output', c.text3]])}
      <div class="chart" id="fi-wf" style="height:${Math.max(320, 80 + ys.length * 28)}px"></div>
      ${recon === null ? `<p class="chart-note">${chk.monotone ? 'These values explain the model\'s raw output, which ranks rows exactly like PREDICTED_SCORE but is on a different scale (for example before calibration).' : 'Baseline + contributions could not be matched to PREDICTED_SCORE for this file; see “About these SHAP values”.'}</p>` : ''}
    </div>
    <div class="card" style="margin-top:20px">${disc('Every feature for this prediction', '<div id="fi-row-tbl"></div>', { cls: 'line', sub: `${r.contribs.length} features, by size of contribution` })}</div>`);
  plot($('#fi-wf'), [{ type: 'waterfall', orientation: 'h', y: ys, x: xs, measure, base: 0,
    text: xs.map((x, i) => (measure[i] === 'relative' ? fmtPhi(x) : fmtOut(i === xs.length - 1 ? out : x))), textposition: 'none',
    connector: { line: { color: c.grid, width: 1 } },
    increasing: { marker: { color: c.up } }, decreasing: { marker: { color: c.down } }, totals: { marker: { color: c.text3 } },
    hovertemplate: '%{y}<br>%{text}<extra></extra>' }],
  { showlegend: false, margin: { l: 10, r: 40, t: 8, b: 44 }, yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: `Model output (${units})` }, zeroline: false } });
  const rows = r.contribs.map((x, i) => ({ rank: i + 1, feature: x.feature, value: x.valueCol ? fmtVal(x.value) : '—', phi: x.phi, absPhi: Math.abs(x.phi), typical: typical.get(x.feature)?.abs, typSigned: typical.get(x.feature)?.signed }));
  renderTable($('#fi-row-tbl'), {
    rows, maxRows: 300, sort: { key: 'absPhi', dir: -1 },
    columns: [{ key: 'feature', label: 'Feature', fmt: x => `<span class="mono">${esc(x)}</span>` }, { key: 'value', label: 'Value' },
      { key: 'phi', label: 'SHAP', num: true, fmt: x => `<span class="delta ${x > 0 ? 'up' : x < 0 ? 'down' : ''}">${fmtPhi(x)}</span>` },
      { key: 'typical', label: 'Segment mean |SHAP|', tip: 'shap_abs', num: true, fmt: x => fmtNum(x, 4) },
      { key: 'typSigned', label: 'Segment mean SHAP', tip: 'shap_signed', num: true, fmt: fmtPhi }],
  });
  $('#fi-row-export').onclick = () => download(`shap_${slug(r.client_id)}_${r.date}.csv`, toCSV(r.contribs.map(x => ({ client_id: r.client_id, date: r.date, outcome: r.y, predicted_score: r.score, baseline: r.base, model_output: hasBase ? out : null, units, feature: x.feature, value: x.valueCol ? x.value : null, shap: x.phi }))));
}

/* ------------------------------------------------------- feature dependence */
async function fiDependence(host, chk, agg, v) {
  const F = fiState(), c = C(), units = unitsOf(chk), W = shapWhere(curSeg());
  if (!F.dep || !shapByFeature(F.dep)) F.dep = agg.feats[0].feature;
  const sc = shapByFeature(F.dep), fs = agg.feats.find(f => f.feature === F.dep), vc = sc.valueCol;
  const meta = vc ? featMeta(vc) : null;
  const numeric = vc && (meta ? meta.numeric && meta.kind === 'num' : isNumericType(S.schema.typeOf[vc] || ''));
  html(host, `<div class="card">
      <div class="form-grid wide">
        <label class="field"><span class="lab">Feature (by importance in this segment)</span><select id="fi-dep">${agg.feats.map(f => `<option value="${esc(f.feature)}" ${f.feature === F.dep ? 'selected' : ''}>#${f.rank} ${esc(f.feature)}</option>`).join('')}</select></label>
      </div>
      <div class="fi-dep-stats faint">Mean |SHAP| ${fmtNum(fs.abs, 4)} (rank ${fs.rank} of ${agg.feats.length}) · mean SHAP ${fmtPhi(fs.signed)} · ${units}${vc && meta ? ` · ${goLink('seg', 'Open in Feature explorer')}` : ''}</div>
    </div>
    <div id="fi-dep-body" style="margin-top:20px">${computing('Binning…')}</div>`);
  $('#fi-dep').onchange = e => { F.dep = e.target.value; fiDependence(host, chk, agg, v); };
  const gl = $('.fi-dep-stats a', host); if (gl) gl.addEventListener('click', () => { const U = segState(); U.fx.feat = vc; U.fx.type = 'auto'; U.fx.edges = ''; U.sub = 'features'; S.rendered.seg = null; }, true);
  const body = $('#fi-dep-body');
  if (!vc) {
    const h = await q(`SELECT ${sc.col} AS s FROM data WHERE ${W} ORDER BY hash(__rid) LIMIT 20000`); if (stale(v)) return;
    html(body, `${callout('info', `The file has SHAP values for <b>${esc(F.dep)}</b> but not a column with the feature's own values, so contributions cannot be related to values. Add a column named <span class="mono">${esc(F.dep)}</span> to the export to unlock this view.`)}
      ${card(`Distribution of SHAP values for ${esc(F.dep)}`, '<div class="chart sm" id="fi-dep-a"></div>', { sub: `${fmtInt(h.length)} sampled predictions · ${units}` })}`);
    plot($('#fi-dep-a'), [{ type: 'histogram', x: h.map(x => x.s), marker: { color: c.s1 }, nbinsx: 60, hovertemplate: '%{x}<br>%{y} predictions<extra></extra>' }], { xaxis: { title: { text: `SHAP (${units})` } }, yaxis: { title: { text: 'Predictions' } }, bargap: 0.04 });
    return;
  }
  const xExpr = numeric ? `TRY_CAST(${qi(vc)} AS DOUBLE)` : `COALESCE(CAST(${qi(vc)} AS VARCHAR), '(missing)')`;
  const pop = `SELECT __rid, client_id, y, score, prob, ${xExpr} AS __x, ${sc.col} AS __s FROM data WHERE ${W}`;
  let groupExpr, labels, edges = null;
  if (numeric) {
    edges = await quantileEdges(pop, 10); if (stale(v)) return;
    groupExpr = binCase(edges);
  } else {
    const top = await q(`SELECT __x AS v, COUNT(*) AS n FROM (${pop}) GROUP BY 1 ORDER BY n DESC`); if (stale(v)) return;
    const keep = top.slice(0, 15).map(t => t.v);
    groupExpr = top.length > 15 ? `CASE WHEN __x IN (${keep.map(ql).join(',')}) THEN __x ELSE 'Other (${top.length - 15} values)' END` : '__x';
  }
  const [stats, sh, smp, cr] = await Promise.all([
    groupStats(pop, groupExpr),
    q(`SELECT ${groupExpr} AS g, AVG(__s) AS ms, quantile_cont(__s, [0.1, 0.9]) AS qs ${numeric ? ', AVG(__x) AS mx, MIN(__x) AS xlo, MAX(__x) AS xhi' : ''} FROM (${pop}) GROUP BY 1`),
    numeric ? q(`SELECT __x AS x, __s AS s, y FROM (${pop}) WHERE __x IS NOT NULL ORDER BY hash(__rid) LIMIT 4000`) : Promise.resolve([]),
    numeric ? q1(`SELECT corr(__x, __s) AS r FROM (${pop})`) : Promise.resolve({}),
  ]);
  if (stale(v) || !$('#fi-dep-body')) return;
  finishGroups(stats, 100);
  const shM = new Map(sh.map(r => [String(r.g), r]));
  let rows = stats.map(r => ({ ...r, ...shM.get(String(r.g)), g: r.g }));
  if (numeric) {
    rows.sort((a, b) => a.g - b.g);
    rows.forEach(r => { r.label = r.g === -1 ? 'Missing' : r.xlo === r.xhi ? fmtT(r.xlo) : `${fmtT(r.xlo)} – ${fmtT(r.xhi)}`; });   // observed value range (lo/hi are the rate CI)
  } else { rows.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)); rows.forEach(r => { r.label = String(r.g); }); }
  const valid = rows.filter(r => r.g !== -1), missing = rows.find(r => r.g === -1);
  // interpretation: does the model's use of the feature agree with the observed pattern?
  const notes = [];
  const pearson = (a, b) => { const n = a.length; if (n < 3) return null; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : null; };
  if (numeric) {
    if (fin(cr.r)) notes.push(Math.abs(cr.r) < 0.1 ? `SHAP values for <b>${esc(F.dep)}</b> barely move with its value (correlation ${fmtNum(cr.r, 2)}): the effect is either flat or depends on other features.` : `Higher <b>${esc(F.dep)}</b> tends to push predictions <b>${cr.r > 0 ? 'up' : 'down'}</b> (correlation between value and SHAP ${fmtNum(cr.r, 2)}).`);
    const cross = valid.findIndex((r, i) => i > 0 && Math.sign(r.ms) !== Math.sign(valid[i - 1].ms) && r.ms !== 0);
    if (cross > 0) notes.push(`The average contribution changes sign between ${esc(valid[cross - 1].label)} and ${esc(valid[cross].label)}.`);
    const idx = valid.map((_, i) => i), rRate = pearson(idx, valid.map(r => r.rate ?? 0)), rShap = pearson(idx, valid.map(r => r.ms ?? 0));
    if (valid.length >= 4 && fin(rRate) && fin(rShap) && Math.abs(rRate) > 0.6 && Math.abs(rShap) > 0.6 && Math.sign(rRate) !== Math.sign(rShap))
      notes.push(`<b>Worth a look:</b> across these bins the observed conversion rate ${rRate > 0 ? 'rises' : 'falls'} while the model's contribution ${rShap > 0 ? 'rises' : 'falls'}. Correlated features can explain this (another feature carries the effect), but it can also point to a learned pattern that does not hold in this segment.`);
  } else if (valid.length > 1) {
    const hi = valid[0], lo = valid[valid.length - 1];
    notes.push(`<b>${esc(hi.label)}</b> pushes predictions up the most (${fmtPhi(hi.ms)} on average) and <b>${esc(lo.label)}</b> the least (${fmtPhi(lo.ms)}).`);
  }
  if (missing) notes.push(`${fmtInt(missing.n)} predictions have no value for this feature; their mean contribution is ${fmtPhi(missing.ms)}.`);
  const xl = valid.map(r => r.label);
  html(body, `<div class="grid g2">
      ${card(`SHAP value by ${esc(F.dep)}`, `${legend(numeric ? [['Converted', c.actual, 'dot'], ['Did not convert', c.base, 'dot'], ['Mean SHAP per bin', c.text]] : [['Mean SHAP (10th–90th percentile)', c.s5, 'dot']])}<div class="chart" id="fi-dep-a" ${numeric ? '' : `style="height:${Math.max(300, 70 + valid.length * 26)}px"`}></div>`,
        { sub: numeric ? `${fmtInt(smp.length)} sampled predictions, coloured by outcome · ${units}` : `every prediction in the segment · ${units}` })}
      ${card(S.hasProb ? `Observed vs predicted conversion by ${esc(F.dep)}` : `Observed conversion by ${esc(F.dep)}`, `${legend(S.hasProb ? [['Observed rate (95% CI)', c.actual], ['Mean predicted probability', c.predicted]] : [['Observed rate (95% CI)', c.actual]])}<div class="chart" id="fi-dep-b" ${numeric ? '' : `style="height:${Math.max(300, 70 + valid.length * 26)}px"`}></div>`,
        { sub: `${numeric ? 'Decile bins' : 'Categories'} · client-date rows · same segment` })}
    </div>
    ${notes.length ? `<div style="margin-top:16px">${callout('info', notes.join(' '), 'Interpretation.')}</div>` : ''}
    <div class="card" style="margin-top:20px">${disc(numeric ? 'Bin statistics' : 'Category statistics', '<div id="fi-dep-tbl"></div>', { cls: 'line', sub: `${valid.length} ${numeric ? 'bins' : 'categories'}${missing ? ' + missing' : ''}` })}</div>`);
  if (numeric) {
    const ptr = (yv, name, color, op) => ({ type: 'scattergl', mode: 'markers', name, x: smp.filter(p => p.y === yv).map(p => p.x), y: smp.filter(p => p.y === yv).map(p => p.s), marker: { size: 4, color, opacity: op }, hovertemplate: `${esc(F.dep)} %{x}<br>SHAP %{y:+.4f}<br>${name}<extra></extra>` });
    plot($('#fi-dep-a'), [ptr(0, 'Did not convert', c.base, 0.35), ptr(1, 'Converted', c.actual, 0.7),
      { type: 'scatter', mode: 'lines+markers', name: 'Mean SHAP', x: valid.map(r => r.mx), y: valid.map(r => r.ms), line: { color: c.text, width: 2 }, marker: { size: 6, color: c.text }, hovertemplate: 'bin mean %{x:.3~f}<br>mean SHAP %{y:+.4f}<extra></extra>' }],
    { showlegend: false, xaxis: { title: { text: F.dep } }, yaxis: { title: { text: `SHAP (${units})` }, zeroline: true, zerolinecolor: c.axis } });
  } else {
    plot($('#fi-dep-a'), [{ type: 'scatter', mode: 'markers', y: xl, x: valid.map(r => r.ms), marker: { size: 10, color: valid.map(r => (r.ms >= 0 ? c.up : c.down)) },
      error_x: { type: 'data', symmetric: false, array: valid.map(r => (r.qs ? r.qs[1] - r.ms : 0)), arrayminus: valid.map(r => (r.qs ? r.ms - r.qs[0] : 0)), color: rgba(c.s5, 0.5), thickness: 1.5, width: 0 },
      customdata: valid.map(r => [r.n, r.qs?.[0], r.qs?.[1]]), hovertemplate: '%{y}<br>mean SHAP %{x:+.4f}<br>10th–90th pct %{customdata[1]:+.4f} – %{customdata[2]:+.4f}<br>%{customdata[0]:,} predictions<extra></extra>' }],
    { showlegend: false, yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: `SHAP (${units})` }, zeroline: true, zerolinecolor: c.axis }, margin: { l: 10, r: 16, t: 8, b: 48 } });
  }
  const rateTraces = numeric ? [
    { x: xl, y: valid.map(r => r.hi), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    { x: xl, y: valid.map(r => r.lo), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(c.actual, 0.13), hoverinfo: 'skip', showlegend: false },
    { x: xl, y: valid.map(r => r.rate), mode: 'lines+markers', name: 'Observed', line: { color: c.actual, width: 2 }, marker: { size: 7, color: valid.map(r => (r.small ? c.surface : c.actual)), line: { color: c.actual, width: 2 } }, customdata: valid.map(r => [r.n, r.pos]), hovertemplate: '%{x}<br>observed %{y:.2%}<br>%{customdata[0]:,} records · %{customdata[1]:,} positive<extra></extra>' },
    ...(S.hasProb ? [{ x: xl, y: valid.map(r => r.meanP), mode: 'lines+markers', name: 'Predicted', line: { color: c.predicted, width: 2 }, marker: { size: 7, color: c.predicted }, hovertemplate: '%{x}<br>mean predicted %{y:.2%}<extra></extra>' }] : []),
  ] : [
    { y: xl, x: valid.map(r => r.rate), mode: 'markers', name: 'Observed', marker: { size: 10, color: valid.map(r => (r.small ? c.surface : c.actual)), line: { color: c.actual, width: 2 } },
      error_x: { type: 'data', symmetric: false, array: valid.map(r => (fin(r.hi) ? r.hi - r.rate : 0)), arrayminus: valid.map(r => (fin(r.lo) ? r.rate - r.lo : 0)), color: rgba(c.actual, 0.55), thickness: 1.5, width: 0 }, customdata: valid.map(r => [r.n, r.pos]), hovertemplate: '%{y}<br>observed %{x:.2%}<br>%{customdata[0]:,} records · %{customdata[1]:,} positive<extra></extra>' },
    ...(S.hasProb ? [{ y: xl, x: valid.map(r => r.meanP), mode: 'markers', name: 'Predicted', marker: { size: 10, symbol: 'diamond', color: c.predicted, line: { color: c.surface, width: 2 } }, hovertemplate: '%{y}<br>mean predicted %{x:.2%}<extra></extra>' }] : []),
  ];
  plot($('#fi-dep-b'), rateTraces, numeric
    ? { showlegend: false, xaxis: { type: 'category', title: { text: `${F.dep} (bin)` }, tickangle: valid.length > 6 ? -30 : 0 }, yaxis: { title: { text: 'Conversion rate' }, tickformat: '.1~%', rangemode: 'tozero' } }
    : { showlegend: false, yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: 'Conversion rate' }, tickformat: '.1~%', rangemode: 'tozero' }, margin: { l: 10, r: 16, t: 8, b: 48 } });
  renderTable($('#fi-dep-tbl'), {
    rows: missing ? [...valid, missing] : valid, exportName: `shap_dependence_${slug(F.dep)}`, maxRows: 100, sort: null,
    columns: [{ key: 'label', label: numeric ? 'Bin' : 'Category' }, { key: 'n', label: 'Records', num: true, fmt: fmtInt }, { key: 'pos', label: 'Positives', num: true, fmt: fmtInt },
      { key: 'rate', label: 'Observed rate', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.lo, r.hi, fmtPct)}` },
      S.hasProb ? { key: 'meanP', label: 'Mean predicted', num: true, fmt: x => fmtPct(x) } : { key: 'meanS', label: 'Mean score', num: true, fmt: fmtScore },
      { key: 'ms', label: 'Mean SHAP', num: true, fmt: x => `<span class="delta ${x > 0 ? 'up' : x < 0 ? 'down' : ''}">${fmtPhi(x)}</span>` },
      { key: 'qs', label: 'SHAP 10th–90th pct', num: true, fmt: x => (x ? `${fmtPhi(x[0])} – ${fmtPhi(x[1])}` : '—') }],
    exportRows: data => data.map(r => ({ feature: F.dep, group: r.label, records: r.n, positives: r.pos, observed_rate: r.rate, ci_low: r.lo, ci_high: r.hi, mean_predicted: r.meanP, mean_score: r.meanS, mean_shap: r.ms, shap_p10: r.qs?.[0], shap_p90: r.qs?.[1], units })),
  });
}

/* ------------------------------------------------------------ no SHAP yet */
const SHAP_SNIPPET = `# Add exact SHAP values to the prediction export.
# Run after the champion is fitted, e.g. inside get_predictions_output():
#     merge_df = add_shap_columns(merge_df)        # before merge_df.to_csv(...)
# Adds one column per model feature, shap__<feature> (contribution to the RAW,
# uncalibrated score, in log-odds for XGBoost / HistGradientBoosting), and
# shap_base_value. Values come from the trained model itself; nothing is approximated.
import numpy as np, pandas as pd, xgboost as xgb

def add_shap_columns(frame, model_name=champion_name, max_clients=None, decimals=5):
    pipe = fitted_models[model_name]
    prep, model = pipe.named_steps["prep"], pipe.named_steps["model"]
    rows = frame.index
    if max_clients:   # optional: explain a client-level sample to keep the file small
        ids = pd.Series(frame["client_id"].unique())
        keep = ids.sample(min(max_clients, len(ids)), random_state=RANDOM_STATE)
        rows = frame.index[frame["client_id"].isin(keep)]
    X = frame.loc[rows, MODEL_FEATURES]
    if isinstance(model, xgb.XGBClassifier):
        # XGBoost's native TreeSHAP: exact and fast; the last column is the expected value
        contrib = model.get_booster().predict(xgb.DMatrix(prep.transform(X)), pred_contribs=True)
        by_feature = _sum_terms_to_features(contrib[:, :-1], prep.get_feature_names_out(), rows)
        base = contrib[:, -1]
    else:
        import shap   # other tree models: your notebook's TreeExplainer helper
        by_feature = _tree_shap_contributions(model_name, X)
        base = np.ravel(shap.TreeExplainer(model).expected_value)[-1]
    out = frame.join(by_feature.round(decimals).add_prefix("shap__"))
    out.loc[rows, "shap_base_value"] = base
    return out`;
function shapMissingHTML() {
  return `<div class="card fi-missing">
      <div class="eyebrow">Feature importance</div>
      <h2 style="margin-top:4px">This file has no SHAP values</h2>
      <p class="lede" style="margin-top:10px">SHAP values say how much each feature pushed each prediction up or down. They are computed from the <b>trained model</b> and the exact inputs it saw, so they cannot be derived from a predictions file, and this app does not approximate them. Export them with the predictions and this view fills in automatically for ${esc(S.file?.name || 'the file')}.</p>
      <div class="grid g3 fi-steps" style="margin-top:22px">
        <div><div class="fi-step">1</div><b>Add the columns</b><p class="muted small">One numeric column per model feature named <span class="mono">shap__&lt;feature&gt;</span> (for example <span class="mono">shap__classes_30d</span>), plus <span class="mono">shap_base_value</span>. Keep the features' own columns so values can be shown next to contributions.</p></div>
        <div><div class="fi-step">2</div><b>Export from the model</b><p class="muted small">The snippet below fits your notebook: it uses XGBoost's built-in TreeSHAP and your <span class="mono">_sum_terms_to_features</span> helper, so one-hot levels and missing-value flags add back up to their source feature.</p></div>
        <div><div class="fi-step">3</div><b>Upload the new file</b><p class="muted small">Use <b>+ Add files…</b> in the file switcher (top left). The app checks the values add up to the model's score, reports coverage and units, and never fills in rows that lack them.</p></div>
      </div>
      <div class="code-block" style="margin-top:22px"><div class="code-head"><span class="mono small">Python · add_shap_columns()</span><button class="btn sm" data-copy>Copy</button></div><pre><code>${esc(SHAP_SNIPPET)}</code></pre></div>
      <div style="margin-top:18px">${disc('File size and other models', `<div class="methodology"><ul>
        <li><b>Size:</b> ~100 extra numeric columns roughly doubles a CSV. Rounding to 5 decimals (the default) keeps additivity within the app's tolerance. To explain a sample instead, pass <span class="mono">max_clients=50_000</span>: other rows are left empty and the app reports the coverage. Parquet output is also accepted and is much smaller.</li>
        <li><b>Calibrated scores:</b> SHAP explains the raw model output. If the file's score is calibrated (isotonic), the app recognises that the values explain the ranking rather than the calibrated scale and says so.</li>
        <li><b>Other column names:</b> <span class="mono">shap_&lt;feature&gt;</span>, <span class="mono">phi_&lt;feature&gt;</span> and <span class="mono">contrib_&lt;feature&gt;</span> are recognised; the baseline may be named <span class="mono">shap_expected_value</span>, <span class="mono">expected_value</span> or <span class="mono">shap_bias</span>. Without a baseline column, it is inferred when additivity allows.</li>
        <li><b>Logistic regression:</b> exact SHAP values (independent features) are β·(x − mean of x over the training rows) for each transformed term, summed back to the source feature.</li>
      </ul></div>`, { cls: 'line' })}</div>
    </div>`;
}
function wireCopy(root) {
  $$('[data-copy]', root).forEach(b => b.onclick = async () => {
    const text = $('code', b.closest('.code-block')).textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('code', b.closest('.code-block'))); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected — press ⌘C'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 2200);
  });
}
