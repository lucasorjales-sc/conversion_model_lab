/* ==========================================================================
   80 · EXECUTIVE REPORT
   Every statement here is generated from results computed by the other tabs'
   functions. Readiness uses transparent, editable criteria — never one metric.
   ========================================================================== */
const TH_DEFAULT = { minEvents: 100, insufficientEvents: 30, liftPass: 2.0, recallMult: 2.0, cvMax: 0.35, minWeeks: 4, calLo: 0.8, calHi: 1.25 };
const STATUS_TEXT = {
  pilot: { label: 'Pilot candidate', kind: 'good' },
  promising: { label: 'Promising', kind: 'info' },
  investigate: { label: 'Needs investigation', kind: 'warn' },
  notready: { label: 'Not ready for use', kind: 'bad' },
  insufficient: { label: 'Insufficient evidence to assess', kind: 'na' },
};
const CRIT_LABEL = { good: 'Meets criterion', warn: 'Concern', bad: 'Fails', na: 'Not assessed', info: 'Information' };

async function gatherEvidence(v) {
  const grain = S.eval.grain === 'episode' ? 'client' : S.eval.grain;
  const ev = { grain };
  ev.M = await engCached('metrics', { grain: S.eval.grain, gran: 'overall', ks: KS, withCalibration: false }, 'Computing ranking metrics…'); if (stale(v)) return null;
  ev.B = await engCached('bootstrap', { grain: S.eval.grain, ks: KS, B: bootN(ev.M.n) }, 'Bootstrapping intervals…'); if (stale(v)) return null;
  ev.W = await engCached('metrics', { grain: S.eval.grain, gran: 'week', ks: KS, minPos: S.settings.minPos }, 'Computing weekly metrics…'); if (stale(v)) return null;
  ev.cal = S.hasProb ? await engCached('calibration', { grain: S.eval.grain, bins: 10, mode: 'quantile' }, 'Computing calibration…') : null; if (stale(v)) return null;
  ev.seg = S.core.segs.some(s => !s.hidden) ? await segmentData(grain, 10) : null; if (stale(v)) return null;
  ev.V = await validityChecks(); if (stale(v)) return null;
  ev.sim = await ensureSimulation(v); if (stale(v)) return null;
  return ev;
}

function assessReadiness(ev) {
  const T = (S.ui.execTh ||= { ...TH_DEFAULT });
  const M = ev.M, B = ev.B, c10 = M.capacity[2], c5 = M.capacity[1], c20 = M.capacity[3];
  const crit = [];
  const add = (id, name, status, evidence, go, why = '') => crit.push({ id, name, status, evidence, go, why });
  // C1 data & evaluation validity
  const vbad = ev.V.checks.filter(c => c.status === 'bad'), vwarn = ev.V.checks.filter(c => c.status === 'warn'), vna = ev.V.checks.filter(c => c.status === 'na');
  add('validity', 'Data and evaluation validity', vbad.length ? 'bad' : vwarn.length ? 'warn' : 'good',
    vbad.length ? `Failed: ${vbad.map(c => c.name.toLowerCase()).join('; ')}.` : vwarn.length ? `Concerns: ${vwarn.map(c => c.name.toLowerCase()).join('; ')}. ${vna.length} checks cannot be verified from the file.` : `All computable checks pass. ${vna.length} checks cannot be verified from the file (e.g. ${vna.slice(0, 2).map(c => c.name.toLowerCase()).join(', ')}).`,
    'valid', 'Any failed validity check means the metrics may not describe real performance.');
  // C2 evidence volume (distinct conversion events at this grain)
  const events = S.eval.grain === 'row' ? M.episodes : M.pos;
  add('volume', 'Enough conversion events', events < T.insufficientEvents ? 'bad' : events < T.minEvents ? 'warn' : 'good',
    `${fmtInt(events)} distinct ${S.eval.grain === 'row' ? 'purchases' : 'converting ' + unitWord(S.eval.grain)} in the evaluation population (criterion: ≥ ${T.minEvents}; below ${T.insufficientEvents} is insufficient).`, 'perf', 'Interval width and the stability of every rate depend on the number of distinct conversions, not on the number of rows.');
  // C3 ranking vs baseline
  const liftLo = c10.liftLo, aucLo = B?.auc?.lo, apMult = div(M.ap, M.prev);
  const signal = fin(liftLo) && liftLo > 1 && (!fin(aucLo) || aucLo > 0.5);
  add('ranking', 'Ranking better than the baseline', !signal ? 'bad' : liftLo >= T.liftPass && apMult >= T.liftPass ? 'good' : 'warn',
    `Lift@10% ${fmtX(c10.lift, 2)} (95% CI ${fmtX(c10.liftLo, 2)}–${fmtX(c10.liftHi, 2)}); PR-AUC ${fmtNum(M.ap)} = ${fmtX(apMult, 1)} the prevalence of ${fmtPct(M.prev)}; ROC-AUC ${fmtNum(M.auc)}${fin(aucLo) ? ` (95% CI ${fmtNum(aucLo)}–${fmtNum(B.auc.hi)})` : ''}. Criterion: lower bound of Lift@10% ≥ ${T.liftPass}× and PR-AUC ≥ ${T.liftPass}× prevalence; fails if the interval includes 1× (no better than random).`,
    'perf/curves', 'A model must concentrate conversions clearly above what random selection achieves, with an interval that excludes chance.');
  // C4 realistic capacities
  const capOK = fin(c10.recall) && c10.recall >= T.recallMult * 0.10 && fin(c20.liftLo) && c20.liftLo > 1 && fin(c5.liftLo) && c5.liftLo > 1;
  const capBad = fin(c10.recHi) && c10.recHi <= 0.10;
  add('capacity', 'Useful at realistic audience sizes', capBad ? 'bad' : capOK ? 'good' : 'warn',
    `Top 5%: precision ${fmtPct(c5.precision)}, recall ${fmtPct(c5.recall)}, lift ${fmtX(c5.lift, 1)}. Top 10%: ${fmtPct(c10.precision)}, ${fmtPct(c10.recall)}, ${fmtX(c10.lift, 1)}. Top 20%: ${fmtPct(c20.precision)}, ${fmtPct(c20.recall)}, ${fmtX(c20.lift, 1)}. Criterion: the top 10% captures at least ${T.recallMult}× its share of conversions (≥ ${fmtPct(T.recallMult * 0.1, 0)}), and lift at 5% and 20% stays above 1× at the lower bound.`,
    'perf/capacity', 'Marketing contacts a fixed share of clients; performance must hold across the audience sizes it can afford.');
  // C5 temporal stability
  const P = ev.W.periods, strong = P.filter(p => p.estimable && !p.lowPos);
  if (strong.length < T.minWeeks) add('stability', 'Stable across weeks', 'na', `Only ${strong.length} week${strong.length === 1 ? '' : 's'} with at least ${S.settings.minPos} positives (criterion needs ≥ ${T.minWeeks}). A longer test window is needed to judge stability.`, 'perf', 'A single short window cannot show whether performance holds as populations and seasons change.');
  else {
    const lifts = strong.map(p => p.lift10).filter(fin), m = lifts.reduce((a, b) => a + b, 0) / lifts.length, sdv = Math.sqrt(lifts.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, lifts.length - 1)), cv = m ? sdv / m : null;
    const minL = Math.min(...lifts), bad = strong.filter(p => fin(p.lift10Hi) && p.lift10Hi < 1);
    add('stability', 'Stable across weeks', bad.length ? 'bad' : cv > T.cvMax || minL < 0.5 * c10.lift ? 'warn' : 'good',
      `Weekly Lift@10% across ${strong.length} weeks: mean ${fmtX(m, 2)}, range ${fmtX(minL, 2)}–${fmtX(Math.max(...lifts), 2)}, coefficient of variation ${fmtPct(cv, 0)}. ${bad.length ? `${bad.length} week(s) significantly below 1×.` : ''} Criterion: no week significantly below 1×, variation ≤ ${fmtPct(T.cvMax, 0)}, and no week below half the pooled lift.`,
      'perf', 'Stable weekly lift shows the ranking holds up from week to week rather than reflecting one good period.');
  }
  // C6 calibration
  if (!ev.cal) add('calibration', 'Probability calibration', 'na', 'Not applicable: no valid probabilities. Use the model for ranking only (top-X audiences); its scores must not be read as conversion probabilities for budgeting.', 'perf', 'Calibration matters only if predicted probabilities feed forecasts or economic decisions.');
  else add('calibration', 'Probability calibration', ev.cal.ratio >= T.calLo && ev.cal.ratio <= T.calHi && ev.cal.slope >= T.calLo && ev.cal.slope <= T.calHi ? 'good' : 'warn',
    `Mean predicted ÷ observed ${fmtX(ev.cal.ratio, 2)}, calibration slope ${fmtNum(ev.cal.slope, 2)}, Brier ${fmtNum(ev.cal.brier, 5)} (reference ${fmtNum(ev.cal.brierRef, 5)}). Criterion: both within ${T.calLo}–${T.calHi}. A miscalibrated model can still rank well; it only matters if probabilities are used directly.`, 'perf', 'Forecasts of conversions or budgets built from probabilities need the probabilities to be right on average.');
  // C7 segment failure modes
  if (!ev.seg) add('segments', 'No severe segment failure modes', 'na', 'No segment columns in the file.', 'seg', '');
  else {
    const flagged = ev.seg.rows.filter(r => r.eligible && ((fin(r.recall) && fin(r.recHi) && fin(ev.seg.overall.recall) && r.recall < 0.67 * ev.seg.overall.recall && r.recHi < ev.seg.overall.recall) || (fin(r.liftHi) && r.liftHi < 1)));
    const elig = ev.seg.rows.filter(r => r.eligible).length;
    add('segments', 'No severe segment failure modes', flagged.length ? 'warn' : elig ? 'good' : 'na',
      flagged.length ? `${flagged.length} of ${elig} adequately sized segment values are served clearly worse than average: ${flagged.slice(0, 4).map(r => `${esc(r.colLabel)} = ${esc(r.val)} (recall ${fmtPct(r.recall)} vs ${fmtPct(ev.seg.overall.recall)})`).join('; ')}${flagged.length > 4 ? '…' : ''}.`
        : elig ? `None of ${elig} adequately sized segment values is served significantly worse than average at the top 10%.` : 'No segment value is large enough to assess.', 'seg', 'A model that works on average can still systematically miss a studio, channel or lifecycle stage.');
  }
  // C8 campaign-level comparison
  const sim = ev.sim, res = sim?.r?.results || [];
  const mod = res.find(x => x.kind === 'topx'), rnd = res.find(x => x.kind === 'random'), cur = res.find(x => x.kind === 'current');
  if (!mod || !rnd) add('campaign', 'Beats random targeting in a campaign replay', 'na', 'Not run: include model top-X and random strategies in the Targeting Simulator.', 'sim', '');
  else add('campaign', 'Beats random targeting in a campaign replay', mod.matched.episodesCaptured > rnd.matched.episodesCapturedP95 ? 'good' : mod.matched.episodesCaptured > rnd.matched.episodesCaptured ? 'warn' : 'bad',
    `${sim.custom ? 'Simulated' : 'Default'} ${sim.setup.cadence} campaign: model captured ${fmtInt(mod.matched.episodesCaptured)} purchases vs ${fmtInt(rnd.matched.episodesCaptured)} for random (95th percentile across ${rnd.runs} runs: ${fmtInt(rnd.matched.episodesCapturedP95)}) at the same budget.`, 'sim', 'Retrospective campaign replays include cooldowns, repeat contacts and deduplicated purchases — closer to production than row-level metrics.');
  if (!cur) add('current', 'Compared with the current strategy', 'na', 'Not assessed: the current marketing strategy is not configured (no CURRENT_STRATEGY_FLAG column, and no rule describing it). The app does not invent it.', 'sim', '');
  else add('current', 'Compared with the current strategy', mod && mod.matched.episodesCaptured >= cur.matched.episodesCaptured ? 'good' : 'warn',
    `At the same budget: model ${fmtInt(mod?.matched.episodesCaptured)} vs current strategy ${fmtInt(cur.matched.episodesCaptured)} purchases captured; contact precision ${fmtPct(mod?.matched.precision)} vs ${fmtPct(cur.matched.precision)}.`, 'sim', '');
  add('incremental', 'Incremental impact measured', S.roles.treatment ? 'info' : 'na', S.roles.treatment ? 'A treatment column is present: see the experimental comparison in the Targeting Simulator. Valid only if assignment was randomized.' : 'Not assessed: no randomized treatment/control data. Observed conversions among targeted clients are not evidence that outreach caused them.', 'sim', '');
  // overall status
  const st = id => crit.find(c => c.id === id)?.status;
  const coreFail = ['ranking', 'stability', 'campaign', 'capacity'].some(id => st(id) === 'bad');
  const validityFatal = vbad.some(c => /Required fields|Target construction/.test(c.name)) && (S.info.invalid / S.info.total > 0.05 || /Target/.test(vbad.map(c => c.name).join()));
  let status;
  if (!M.pos || st('volume') === 'bad' || validityFatal) status = 'insufficient';
  else if (coreFail || st('validity') === 'bad') status = 'notready';
  else if (st('ranking') === 'good' && st('capacity') === 'good' && st('stability') === 'good' && st('campaign') === 'good' && st('current') !== 'warn' && st('volume') === 'good') status = 'pilot';
  else if (st('ranking') === 'warn' || ['validity', 'capacity', 'stability', 'segments', 'current', 'volume'].filter(id => st(id) === 'warn').length >= 2) status = 'investigate';
  else status = 'promising';
  return { status, crit, T };
}

function headline(status, ev) {
  const c10 = ev.M.capacity[2], uw = unitWord(S.eval.grain);
  const sig = `The top 10% of ${uw} by score converted at ${fmtX(c10.lift, 1)} the average rate and contained ${fmtPct(c10.recall)} of all conversions.`;
  return {
    pilot: `The model is a candidate for a controlled pilot. ${sig} It held up week to week and beat random targeting in a campaign replay. Its incremental value is unproven until a randomized holdout measures it.`,
    promising: `The retrospective evaluation is promising but incomplete. ${sig} Some evidence a pilot decision needs is missing or weak — see the open criteria below.`,
    investigate: `The model shows signal, but there are concerns to resolve before a pilot. ${sig}`,
    notready: `The model is not ready for use. At least one core criterion fails: the ranking is not reliably better than random, is unstable across weeks, or loses to random targeting in a campaign replay.`,
    insufficient: `There is not enough valid evidence to assess the model. Too few conversions, or data problems, prevent a reliable judgement.`,
  }[status];
}

function findings(ev, R) {
  const out = [], M = ev.M, c10 = M.capacity[2], uw = unitWord(S.eval.grain);
  // 1 ranking
  const rank = R.crit.find(c => c.id === 'ranking');
  out.push({ kind: rank.status, title: rank.status === 'bad' ? 'Ranking is not reliably better than random' : 'The model concentrates conversions at the top of its ranking',
    text: `The top 10% of ${uw} converted at ${fmtPct(c10.precision)} vs ${fmtPct(M.prev)} overall (${fmtX(c10.lift, 1)} lift) and captured ${fmtPct(c10.recall)} of conversions. PR-AUC is ${fmtNum(M.ap)}, ${fmtX(div(M.ap, M.prev), 1)} a random ranking.`,
    why: `<dl class="kv"><dt>Grain</dt><dd>${grainLabel(S.eval.grain)}</dd><dt>Evaluation records</dt><dd>${fmtInt(M.n)} (${fmtInt(M.pos)} positive)</dd><dt>Lift@10% 95% CI</dt><dd>${fmtX(c10.liftLo, 2)} – ${fmtX(c10.liftHi, 2)}</dd><dt>ROC-AUC</dt><dd>${fmtNum(M.auc)} ${ev.B ? `(CI ${fmtNum(ev.B.auc.lo)}–${fmtNum(ev.B.auc.hi)})` : ''}</dd><dt>Precision@5% / 20%</dt><dd>${fmtPct(M.capacity[1].precision)} / ${fmtPct(M.capacity[3].precision)}</dd></dl>`, go: 'perf/capacity' });
  // 2 where it performs well / weak
  if (ev.seg) {
    const o = ev.seg.overall, el = ev.seg.rows.filter(r => r.eligible && fin(r.recall));
    const strong = el.filter(r => fin(r.recLo) && r.recLo > o.recall).sort((a, b) => b.recall - a.recall).slice(0, 3);
    const weak = el.filter(r => fin(r.recHi) && r.recHi < o.recall).sort((a, b) => a.recall - b.recall).slice(0, 3);
    if (strong.length) out.push({ kind: 'good', title: 'Where it performs best', text: `Conversions are caught more often than average in ${strong.map(r => `<b>${esc(r.colLabel)} = ${esc(r.val)}</b> (recall@10% ${fmtPct(r.recall)})`).join(', ')}, against ${fmtPct(o.recall)} overall.`,
      why: `Segments whose 95% recall interval lies entirely above the overall recall, among values with ≥ ${fmtInt(segState().minN)} records and ≥ ${segState().minPos} positives. Differences describe where the model works, not why.`, go: 'seg' });
    if (weak.length) out.push({ kind: 'warn', title: 'Where performance is weak', text: `The model misses more conversions in ${weak.map(r => `<b>${esc(r.colLabel)} = ${esc(r.val)}</b> (recall@10% ${fmtPct(r.recall)}${fin(r.aucIn) ? `, within-segment ROC-AUC ${fmtNum(r.aucIn, 2)}` : ''})`).join(', ')}.`,
      why: 'Segment values whose recall interval lies entirely below the overall recall. Open Segment Diagnostics › Where it\'s wrong for the error-analysis trees and the false-negative browser.', go: 'seg' });
    if (!strong.length && !weak.length) out.push({ kind: 'info', title: 'No segment stands out', text: 'No adequately sized segment value differs from the overall recall beyond its confidence interval. This is inconclusive rather than proof of uniform performance: small segments cannot be assessed.', why: '', go: 'seg' });
  }
  // 3 time
  const stab = R.crit.find(c => c.id === 'stability');
  out.push({ kind: stab.status, title: stab.status === 'na' ? 'Stability over time cannot be judged yet' : stab.status === 'good' ? 'Performance is consistent week to week' : 'Performance varies across weeks', text: stab.evidence,
    why: `Weekly metrics are computed inside each ISO week (Monday start) at the ${grainLabel(S.eval.grain).toLowerCase()} grain. Mean of weekly ROC-AUC ${fmtNum(ev.W.summary.auc.mean)} vs pooled ${fmtNum(ev.W.pooled.auc)}; weekly prevalence ranges ${fmtPct(ev.W.summary.prev.min)}–${fmtPct(ev.W.summary.prev.max)}.`, go: 'perf' });
  // 4 vs strategies
  const camp = R.crit.find(c => c.id === 'campaign'), cur = R.crit.find(c => c.id === 'current');
  out.push({ kind: camp.status === 'good' && cur.status !== 'warn' ? 'good' : camp.status === 'bad' ? 'bad' : 'warn', title: 'Model targeting vs existing approaches', text: `${camp.evidence} ${cur.status === 'na' ? 'The current strategy has not been configured, so it is not compared.' : cur.evidence}`,
    why: 'Matched budgets, same eligible pool, same cooldown and suppression, purchases counted once each. These are historical observed conversions, not incremental conversions.', go: 'sim' });
  // 5 calibration
  const cal = R.crit.find(c => c.id === 'calibration');
  if (ev.cal) out.push({ kind: cal.status, title: cal.status === 'good' ? 'Probabilities are well calibrated' : 'Probabilities are miscalibrated', text: cal.evidence, why: 'Calibration was evaluated on the probabilities provided; the app never fits a calibrator on the evaluation rows.', go: 'perf' });
  // 6 warnings
  const warns = ev.V.checks.filter(c => c.status === 'bad' || c.status === 'warn');
  if (warns.length) out.push({ kind: warns.some(c => c.status === 'bad') ? 'bad' : 'warn', title: 'Evaluation warnings', text: warns.map(c => `<b>${esc(c.name)}</b>: ${c.evidence}`).join('<br>'), why: '', go: 'valid' });
  return out;
}

function nextSteps(R, ev) {
  const s = [], st = id => R.crit.find(c => c.id === id)?.status;
  if (st('validity') !== 'good') s.push('Resolve the data and evaluation-validity issues listed under Data & Evaluation Validity.');
  if (!S.settings.labelsThrough) s.push('Confirm label maturity: set the date through which purchases were observed so immature outcome windows are excluded.');
  if (!S.roles.split) s.push('Confirm in the training pipeline that these rows were never used for training, feature selection or calibration (no SPLIT column to check).');
  if (st('volume') !== 'good') s.push('Extend the test window to accumulate more conversions before drawing conclusions.');
  if (st('stability') === 'na') s.push('Evaluate a longer test period (at least four weeks with enough conversions each) to judge stability.');
  if (st('segments') === 'warn') s.push('Investigate the under-served segments in Segment Diagnostics before including them in a pilot, or pilot them separately.');
  if (st('current') === 'na') s.push('Describe the current marketing strategy (flag column or rule) so the model is compared with what marketing does today.');
  if (st('calibration') === 'warn') s.push('Do not use the predicted probabilities for budgeting until they are recalibrated on non-test data; top-X targeting is unaffected.');
  s.push('Run a controlled pilot with a randomized holdout in every targeted group, so the incremental effect of outreach is measured rather than assumed.');
  return s;
}

RENDER.exec = async (el, v) => {
  html(el, `${pageHead('Executive Report', 'Is the conversion model ready for a controlled pilot?', '')}<div id="ex-body">${computing('Assembling the evidence from every tab…')}</div>`);
  const ev = await gatherEvidence(v); if (!ev || stale(v)) return;
  const R = assessReadiness(ev), M = ev.M, c10 = M.capacity[2], ST = STATUS_TEXT[R.status], uw = unitWord(S.eval.grain);
  S.ui.lastExec = { ev, R };
  const sim = ev.sim, res = sim?.r?.results || [], mod = res.find(x => x.kind === 'topx'), rnd = res.find(x => x.kind === 'random'), cur = res.find(x => x.kind === 'current');
  const F = findings(ev, R), steps = nextSteps(R, ev);
  const lim = ev.V.checks.filter(c => c.status !== 'good' && c.status !== 'info');
  const E = simState().econ, econ = mod ? econOf(mod.matched, E) : null;
  html($('#ex-body'), `
    <div class="toolbar"><span class="toolbar-label">Evaluation grain</span>${segHTML('exgrain', GRAIN_OPTS, S.eval.grain)}<span class="grow"></span>
      <button class="btn sm" id="ex-export">${ICON.download} Export report</button><button class="btn sm" id="ex-json">${ICON.download} Settings &amp; results (JSON)</button></div>
    <section class="card verdict">
      <div>${statusPill(ST.kind, ST.label, true)}
        <div class="headline">${headline(R.status, ev)}</div>
        <div class="basis"><b>${esc(S.file.name)}</b> · ${grainLabel(S.eval.grain)} · ${S.settings.d0} → ${S.settings.d1} · ${fmtInt(M.n)} ${uw}, ${fmtInt(S.pop.clients)} clients${S.settings.split ? ` · split ${esc(S.settings.split)}` : ''}${S.filters.length ? ` · filtered: ${esc(S.filters.map(filterText).join('; '))}` : ''}${S.cohorts.length ? ` · cohort ${esc(S.cohorts.map(c => c.name).join(', '))}` : ''}${S.isDemo ? ' · DEMO DATA' : ''}. Readiness combines ${R.crit.length} criteria below; no single metric decides it.</div></div>
    </section>
    ${sectionTitle('Model overview', 'overview', `<span class="faint">${grainLabel(S.eval.grain)} · pooled over the window</span>`)}
    <div class="tiles">
      ${tile('PR-AUC', fmtNum(M.ap), { tipKey: 'pr_auc', sub: `${fmtX(div(M.ap, M.prev), 1)} the prevalence`, ci: ev.B ? fmtCIplain(ev.B.ap.lo, ev.B.ap.hi, x => fmtNum(x)) : '' })}
      ${tile('ROC-AUC', fmtNum(M.auc), { tipKey: 'roc_auc', ci: ev.B ? fmtCIplain(ev.B.auc.lo, ev.B.auc.hi, x => fmtNum(x)) : '' })}
      ${tile('Precision@10%', fmtPct(c10.precision), { tipKey: 'precision', ci: fmtCIplain(c10.precLo, c10.precHi, fmtPct) })}
      ${tile('Recall@10%', fmtPct(c10.recall), { tipKey: 'recall', ci: fmtCIplain(c10.recLo, c10.recHi, fmtPct) })}
      ${tile('Lift@10%', fmtX(c10.lift, 1), { tipKey: 'lift', ci: fmtCIplain(c10.liftLo, c10.liftHi, x => fmtX(x, 1)), hl: true })}
      ${tile('Conversion prevalence', fmtPct(M.prev), { tipKey: 'prevalence', sub: `${fmtInt(M.pos)} positive ${uw}` })}
      ${tile('Evaluated', fmtCompact(M.n) + ' ' + uw, { size: 'md', sub: `${fmtInt(S.pop.clients)} distinct clients · ${fmtInt(M.episodes)} purchases` })}
      ${tile('Date range', `${S.settings.d0.slice(5)} → ${S.settings.d1.slice(5)}`, { size: 'md', sub: `${S.settings.d0.slice(0, 4)} · ${fmtInt(ev.V.span)} days` })}
    </div>
    <p class="chart-note">These metrics describe retrospective ranking quality. They do not by themselves establish readiness — see the criteria below.</p>
    ${sectionTitle('Readiness assessment', 'readiness')}
    <div class="card">
      <table class="criteria"><tbody>${R.crit.map(c => `<tr><td class="c-name">${esc(c.name)}</td><td class="c-status">${statusPill(c.status, CRIT_LABEL[c.status])}</td><td><div class="c-evidence">${c.evidence}</div>${c.go ? `<div style="margin-top:4px">${goLink(c.go, 'View evidence →')}</div>` : ''}</td></tr>`).join('')}</tbody></table>
      ${disc('How the overall status is decided', `<div class="methodology">
        <ul><li><b>Insufficient evidence to assess</b> — no positives, fewer than ${R.T.insufficientEvents} distinct conversion events, or the target construction / required fields fail validation.</li>
          <li><b>Not ready for use</b> — any of ranking-vs-baseline, realistic-capacity, weekly stability or the campaign replay fails, or a validity check fails.</li>
          <li><b>Pilot candidate</b> — ranking, capacity, stability, enough events and the campaign replay all meet their criteria, and the model does not lose to the current strategy where it is configured.</li>
          <li><b>Needs investigation</b> — the ranking signal is only moderate, or two or more criteria raise concerns.</li>
          <li><b>Promising</b> — otherwise: the evidence that exists is favourable but some criteria cannot be assessed yet.</li></ul>
        <p>Every status describes a <i>retrospective</i> evaluation. None of them establishes incremental marketing value; that requires a randomized holdout.</p>
        <h4>Thresholds (editable)</h4>
        <div class="form-grid" style="margin-top:8px">
          <label class="field"><span class="lab">Min. conversion events</span><input type="number" data-th="minEvents" value="${R.T.minEvents}"></label>
          <label class="field"><span class="lab">Insufficient below</span><input type="number" data-th="insufficientEvents" value="${R.T.insufficientEvents}"></label>
          <label class="field"><span class="lab">Lift / PR-AUC multiple</span><input type="number" step="0.1" data-th="liftPass" value="${R.T.liftPass}"></label>
          <label class="field"><span class="lab">Recall@10% multiple of 10%</span><input type="number" step="0.1" data-th="recallMult" value="${R.T.recallMult}"></label>
          <label class="field"><span class="lab">Max weekly lift variation (CV)</span><input type="number" step="0.05" data-th="cvMax" value="${R.T.cvMax}"></label>
          <label class="field"><span class="lab">Min. weeks</span><input type="number" data-th="minWeeks" value="${R.T.minWeeks}"></label>
        </div><p class="faint">Defaults reflect common practice for rare-event targeting models; they are judgement calls, shown so they can be challenged. Changes apply to this report only.</p></div>`, { cls: 'line', id: 'criteria-method' })}
    </div>
    ${sectionTitle('Key findings', 'findings')}
    <div class="card">${F.map(f => `<div class="finding"><div class="f-head">${statusPill(f.kind === 'info' ? 'info' : f.kind, { good: 'Strength', warn: 'Concern', bad: 'Problem', na: 'Open', info: 'Note' }[f.kind] || 'Note')}<div style="flex:1"><div class="f-title">${f.title}</div><div class="f-text">${f.text}</div>
      ${f.why || f.go ? disc('Why this conclusion?', `${f.why || ''}${f.go ? `<p style="margin-top:8px">${goLink(f.go, 'Open the detailed evidence →')}</p>` : ''}`) : ''}</div></div></div>`).join('')}</div>
    ${sectionTitle('Business opportunity', 'opportunity', goLink('sim', 'Adjust the scenario →'))}
    ${mod ? `<div class="card">
      <p class="muted" style="margin:0 0 14px">${sim.custom ? 'Scenario from the Targeting Simulator' : '<b>Default scenario</b> (the Targeting Simulator has not been customised)'}: ${esc(sim.setup.cadence)} sends from ${esc(sim.r.sends[0])} to ${esc(sim.r.sends[sim.r.sends.length - 1])}, ${sim.setup.audType === 'pct' ? `top ${sim.setup.audPct}% of the eligible pool` : `${fmtInt(sim.setup.audN)} clients`} per send, ${sim.setup.cooldown}-day cooldown.</p>
      <div class="tiles">
        ${tile('Unique clients targeted', fmtInt(mod.matched.uniqueClients), { tipKey: 'unique_clients' })}
        ${tile('Contact attempts', fmtInt(mod.matched.contacts), { tipKey: 'contacts', sub: `${fmtNum(mod.matched.contactsPerClient, 2)} per client` })}
        ${tile('Observed purchases among targeted', fmtInt(mod.matched.episodesCaptured), { tipKey: 'captured', sub: `${fmtPct(mod.matched.capture)} of reachable purchases`, hl: true })}
        ${tile('Historical conversion rate', fmtPct(mod.matched.clientRate), { tipKey: 'client_rate', sub: `lift ${fmtX(mod.matched.lift, 1)} vs the eligible pool` })}
        ${cur ? tile('Current strategy, same budget', fmtInt(cur.matched.episodesCaptured), { sub: `purchases · ${fmtPct(cur.matched.clientRate)} client conversion rate` }) : tile('Current strategy', 'Not configured', { size: 'sm', sub: 'define it in the simulator to compare' })}
        ${rnd ? tile('Random, same budget', fmtInt(rnd.matched.episodesCaptured), { sub: `purchases (5th–95th pct. ${fmtInt(rnd.matched.episodesCapturedP5)}–${fmtInt(rnd.matched.episodesCapturedP95)})` }) : ''}
        ${econ && econ.anyCost ? tile('Contact + offer cost', fmtMoney(econ.totalCost), { sub: 'from your assumptions' }) : ''}
        ${econ && fin(econ.breakEven) ? tile('Break-even incremental share', fmtPct(econ.breakEven), { sub: 'of captured purchases must be caused by outreach' }) : ''}
      </div>
      ${callout('warn', `<b>Observed ≠ incremental.</b> These ${fmtInt(mod.matched.episodesCaptured)} purchases were made by clients the model would have contacted; many of them would likely have converted without any contact. ${S.roles.treatment ? 'See the experimental comparison for a causal estimate.' : 'No experiment in this file measures how many were caused by outreach.'}${econ && fin(econ.scenarioNet) ? ` Under your assumed ${E.incr}% incremental share, scenario net value is ${fmtMoney(econ.scenarioNet)} — an assumption, not a result.` : econ && econ.anyCost ? '' : ' Cost and value estimates appear here once assumptions are entered in the simulator.'}`)}
    </div>` : card('', empty('No campaign scenario', 'Include the model top-X strategy in the Targeting Simulator.'))}
    ${sectionTitle('Limitations and recommendation', 'recommendation')}
    <div class="grid g2">
      ${card('Recommendation', `<p style="font-size:15px;line-height:1.55;margin:0 0 14px">${recommendation(R.status)}</p><ol class="next-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>`)}
      ${card('Material limitations and missing evidence', `<ul class="checks">${lim.map(c => `<li>${statusPill(c.status, { warn: 'Concern', bad: 'Failed', na: 'Not assessed' }[c.status] || 'Note')}<div class="c-body"><b>${esc(c.name)}</b><div class="c-detail">${c.evidence}</div></div></li>`).join('') || '<li class="faint">No open limitations from the computable checks.</li>'}
        <li>${statusPill('na', 'Not assessed')}<div class="c-body"><b>Causal / incremental effect of outreach</b><div class="c-detail">Historical lift shows who converts, not who converts because they were contacted.</div></div></li></ul>`)}
    </div>`);
  bindSeg(el, 'exgrain', async g => { S.eval.grain = g; S.rendered.perf = null; await renderActive(true); });
  $$('[data-th]', el).forEach(inp => inp.onchange = () => { const x = +inp.value; if (Number.isFinite(x) && x >= 0) { S.ui.execTh[inp.dataset.th] = x; S.ui.scrollTo = 'criteria-method'; renderActive(true); } });
  $('#ex-export').onclick = () => exportReport(ev, R, F, steps, lim);
  $('#ex-json').onclick = () => download('conversion_model_lab_results.json', JSON.stringify(resultsJSON(ev, R), null, 2), 'application/json');
};
function recommendation(status) {
  return {
    pilot: '<b>Proceed to a controlled pilot.</b> Start with a fixed top-X audience per send (not a probability threshold), keep a randomized holdout in every targeted group, and pre-register the success metric: the difference in conversion between contacted and held-out clients.',
    promising: '<b>Close the open items, then pilot.</b> The evidence available is favourable, but criteria marked “Not assessed” or “Concern” must be resolved before a pilot decision; most need more data or configuration rather than a new model.',
    investigate: '<b>Investigate before piloting.</b> Resolve the concerns below; if they persist, consider retraining or restricting the pilot to the segments where the model works.',
    notready: '<b>Do not use the model for targeting yet.</b> At least one core criterion fails. Use the diagnostics to find out why before investing in a pilot.',
    insufficient: '<b>Collect more evidence.</b> The current file cannot support a judgement either way; extend the test window or fix the data problems listed.',
  }[status];
}
function settingsSnapshot() {
  return { file: S.file?.name, demo_data: S.isDemo, generated_at: new Date().toISOString(), evaluation_window: [S.settings.d0, S.settings.d1], split: S.settings.split, model_version: S.settings.version ?? (S.versions?.length === 1 ? S.versions[0].v : null),
    target_definition: `CONVERSION_TARGET (${S.roles.target ? 'from ' + S.rawCols.find(c => c.name === S.roles.target)?.name : ''}) positive values [${(S.posValues || []).join(', ')}] = converted within ${S.settings.horizon} days after DATE_T`,
    outcome_horizon_days: S.settings.horizon, labels_observed_through: S.settings.labelsThrough, evaluation_grain: S.eval.grain, time_aggregation: S.eval.gran, min_positives_per_period: S.settings.minPos,
    probabilities: S.roles.prob ? `PREDICTED_PROBABILITY ← ${S.roles.prob}` : S.probFromScore ? 'PREDICTED_SCORE declared a probability' : 'none (ranking only)', purchase_dates: S.ep?.source,
    cohort_filters: S.cohorts.map(c => ({ name: c.name, rule: c.text })), feature_filters: S.filters.map(f => ({ feature: f.col, rule: filterText(f) })), tie_break: 'score desc, then fixed hash of (CLIENT_ID, DATE_T), then row', week_start: 'Monday (ISO)', timezone: 'calendar dates as given in DATE_T (no conversion)' };
}
function resultsJSON(ev, R) {
  const M = ev.M;
  return { settings: settingsSnapshot(), status: STATUS_TEXT[R.status].label, criteria: R.crit.map(c => ({ criterion: c.name, status: CRIT_LABEL[c.status], evidence: c.evidence.replace(/<[^>]+>/g, '') })), thresholds: R.T,
    pooled: { records: M.n, positives: M.pos, prevalence: M.prev, roc_auc: M.auc, roc_auc_ci: ev.B?.auc, pr_auc: M.ap, pr_auc_ci: ev.B?.ap, capacity: M.capacity.map(c => ({ top: c.k, selected: c.sel, tp: c.tp, fp: c.fp, fn: c.fn, precision: c.precision, recall: c.recall, lift: c.lift })) },
    weekly: ev.W.periods.map(p => ({ week: p.label, records: p.n, positives: p.pos, prevalence: p.prev, roc_auc: p.auc, pr_auc: p.ap, precision_10: p.prec10, recall_10: p.rec10, lift_10: p.lift10, low_confidence: p.lowPos, estimable: p.estimable })),
    calibration: ev.cal ? { brier: ev.cal.brier, logloss: ev.cal.logloss, slope: ev.cal.slope, intercept: ev.cal.intercept, ratio: ev.cal.ratio, ece: ev.cal.ece } : null,
    campaign: ev.sim ? { setup: ev.sim.setup, rule: ev.sim.ruleText, current_strategy: ev.sim.currentText, strategies: ev.sim.r.results.map(r => ({ strategy: r.label, matched: stripSeries(r.matched), natural: r.natural ? stripSeries(r.natural) : null })) } : null };
}
const stripSeries = m => { const o = { ...m }; delete o.series; return o; };

function exportReport(ev, R, F, steps, lim) {
  const M = ev.M, c = M.capacity, ST = STATUS_TEXT[R.status], snap = settingsSnapshot(), sim = ev.sim;
  const strip = h => String(h).replace(/<button[^>]*>.*?<\/button>/g, '');
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conversion model — executive report</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;max-width:900px;margin:40px auto;padding:0 20px}h1{font-size:32px;letter-spacing:-.02em;margin:0 0 6px}h2{font-size:21px;margin:32px 0 10px;letter-spacing:-.01em}
table{border-collapse:collapse;width:100%;font-size:13.5px;font-variant-numeric:tabular-nums}td,th{padding:7px 10px;border-bottom:1px solid #e5e5ea;text-align:left;vertical-align:top}th{color:#515154;font-weight:600}
.pill{display:inline-block;padding:3px 12px;border-radius:99px;font-weight:600;background:#f2f2f5}.muted{color:#6e6e73}.note{background:#fff4e5;border-radius:10px;padding:12px 14px;margin:12px 0}@media print{body{margin:0}}</style></head><body>
<p class="muted">Conversion Model Lab · generated ${new Date().toLocaleString()}${S.isDemo ? ' · <b>DEMO DATA (synthetic)</b>' : ''}</p>
<h1>Conversion model — executive report</h1><p><span class="pill">${esc(ST.label)}</span></p><p>${strip(headline(R.status, ev))}</p>
<h2>Evaluation basis</h2><table>${row('File', esc(snap.file))}${row('Evaluation window', `${snap.evaluation_window[0]} → ${snap.evaluation_window[1]}`)}${row('Split', esc(snap.split ?? 'not filtered'))}${row('Model version', esc(snap.model_version ?? 'not provided'))}
${row('Target definition', esc(snap.target_definition))}${row('Labels observed through', esc(snap.labels_observed_through ?? 'not assessed'))}${row('Evaluation grain', esc(grainLabel(snap.evaluation_grain)))}${row('Time aggregation', esc(granLabel(snap.time_aggregation)) + ' (headline metrics are pooled; stability uses weekly periods)')}
${row('Probabilities', esc(snap.probabilities))}${row('Purchase dates', esc(snap.purchase_dates))}${row('Feature filters', esc(snap.feature_filters.map(x => x.rule).join('; ') || 'none'))}${row('Cohort filters', esc(snap.cohort_filters.map(x => x.name).join(', ') || 'none'))}${row('Records evaluated', `${fmtInt(M.n)} ${unitWord(S.eval.grain)} · ${fmtInt(S.pop.clients)} clients · ${fmtInt(M.pos)} positive`)}</table>
<h2>Key metrics</h2><table><tr><th>Metric</th><th>Value</th><th>Definition</th></tr>
${row('PR-AUC', `${fmtNum(M.ap)} (${fmtX(div(M.ap, M.prev), 1)} prevalence) ${ev.B ? `95% CI ${fmtNum(ev.B.ap.lo)}–${fmtNum(ev.B.ap.hi)}` : ''}`).replace('</td></tr>', `</td><td>${esc(TIPS.pr_auc)}</td></tr>`)}
${row('ROC-AUC', `${fmtNum(M.auc)} ${ev.B ? `95% CI ${fmtNum(ev.B.auc.lo)}–${fmtNum(ev.B.auc.hi)}` : ''}`).replace('</td></tr>', `</td><td>${esc(TIPS.roc_auc)}</td></tr>`)}
${row('Prevalence', fmtPct(M.prev)).replace('</td></tr>', `</td><td>${esc(TIPS.prevalence)}</td></tr>`)}
${c.map(x => row(`Top ${fmtPct(x.k, 0)}`, `precision ${fmtPct(x.precision)} · recall ${fmtPct(x.recall)} · lift ${fmtX(x.lift, 2)} (${fmtInt(x.sel)} selected)`).replace('</td></tr>', `</td><td>${x.k === 0.1 ? esc(TIPS.lift) : ''}</td></tr>`)).join('')}</table>
<h2>Readiness criteria</h2><table><tr><th>Criterion</th><th>Status</th><th>Evidence</th></tr>${R.crit.map(x => `<tr><td>${esc(x.name)}</td><td>${CRIT_LABEL[x.status]}</td><td>${strip(x.evidence)}</td></tr>`).join('')}</table>
<h2>Key findings</h2>${F.map(f => `<p><b>${strip(f.title)}.</b> ${strip(f.text)}</p>`).join('')}
${sim ? `<h2>Targeting scenario</h2><p class="muted">${esc(sim.setup.cadence)} sends ${esc(sim.r.sends[0])} → ${esc(sim.r.sends[sim.r.sends.length - 1])}; ${sim.setup.audType === 'pct' ? `top ${sim.setup.audPct}% of the eligible pool` : `${fmtInt(sim.setup.audN)} clients`} per send; cooldown ${sim.setup.cooldown} days; max contacts ${sim.setup.maxContacts || 'unlimited'}; suppression after purchase ${sim.setup.suppress ? 'on' : 'off'}; outcome = purchase ${sim.setup.lag}–${sim.setup.horizon} days after the send.${sim.ruleText ? ` Feature rule: ${esc(sim.ruleText)}.` : ''}${sim.currentText ? ` Current strategy: ${esc(sim.currentText)}.` : ' Current strategy: not configured.'}</p>
<table><tr><th>Strategy (matched budget)</th><th>Contacts</th><th>Unique clients</th><th>Purchases captured</th><th>Contact precision</th><th>Client conversion rate</th></tr>${sim.r.results.map(r => `<tr><td>${esc(r.label)}</td><td>${fmtInt(r.matched.contacts)}</td><td>${fmtInt(r.matched.uniqueClients)}</td><td>${fmtInt(r.matched.episodesCaptured)}</td><td>${fmtPct(r.matched.precision)}</td><td>${fmtPct(r.matched.clientRate)}</td></tr>`).join('')}</table>
<div class="note"><b>Observed ≠ incremental.</b> Purchases captured are historical conversions among clients a strategy would have contacted; they do not show how many conversions outreach caused. A randomized holdout is needed for that.</div>` : ''}
<h2>Recommendation</h2><p>${recommendation(R.status)}</p><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
<h2>Limitations and missing evidence</h2><ul>${lim.map(x => `<li><b>${esc(x.name)}</b> (${CRIT_LABEL[x.status]}): ${strip(x.evidence)}</li>`).join('')}<li><b>Causal effect of outreach</b> (Not assessed): historical lift shows who converts, not who converts because they were contacted.</li></ul>
<h2>Method notes</h2><p class="muted">Ranking: score descending, ties ordered by a fixed hash of client and date, exact top-K = ceil(X × N). Unique-client grain: each client's first eligible prediction date. Intervals: client-clustered Wilson for rates; client-block bootstrap for AUC metrics. Weekly periods start on Monday; dates are used as given. Readiness thresholds: ${esc(JSON.stringify(R.T))}.</p>
</body></html>`;
  download('executive_report.html', doc, 'text/html');
  toast('Executive report downloaded (self-contained HTML; open it in any browser or print to PDF).');
}
