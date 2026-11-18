/* ==========================================================================
   50 · TARGETING SIMULATOR
   Campaign-level simulation of model vs existing targeting strategies under the
   same eligibility, cadence, cooldown and outcome rules. Observed outcomes only;
   incremental impact needs a randomized holdout.
   ========================================================================== */
const STRAT_META = {
  topx: { label: 'Model · top X%', color: () => C().s1 },
  current: { label: 'Current strategy', color: () => C().s2 },
  rule: { label: 'Feature rule', color: () => C().s3 },
  threshold: { label: 'Model · threshold', color: () => C().s4 },
  random: { label: 'Random', color: () => C().base },
};
function simState() {
  if (S.ui.sim) return S.ui.sim;
  const nums = S.disc.features.filter(f => f.numeric && f.kind === 'num');
  const sug = nums.find(f => /(class|visit).*(30)/i.test(f.name)) || nums.find(f => /(class|visit)/i.test(f.name)) || nums[0];
  S.ui.sim = {
    sub: 'campaign',
    setup: { d0: S.settings.d0, d1: S.settings.d1, cadence: 'weekly', audType: 'pct', audPct: 10, audN: 500, cooldown: 14, maxContacts: 0, suppress: true, rescore: 0, fresh: null, lag: 1, horizon: S.settings.horizon, locCap: 0, excludeCurrent: false, eligCol: '', eligVals: [] },
    st: {
      topx: { on: true }, threshold: { on: true, tau: null, useProb: false }, random: { on: true, runs: 20 },
      rule: { on: !!sug, within: 'random', conds: sug ? [{ col: sug.name, op: '>=', val: sug.min !== undefined && sug.min <= 1 && sug.max >= 1 ? 1 : null }] : [] },
      current: { on: !!S.roles.current, source: S.roles.current ? 'flag' : 'rule', within: 'random', conds: [] },
    },
    econ: { contact: '', offer: '', margin: '', incr: '' }, exportStrategy: 'topx', bp: null,
  };
  S.ui.simDefault = null;   // snapshot taken once the threshold default is known
  return S.ui.sim;
}
const freshDefault = cad => ({ daily: 0, weekly: 6, monthly: 29 }[cad]);

RENDER.sim = async (el, v) => {
  const U = simState();
  html(el, `
    ${pageHead('Targeting Simulator', 'If we target with the model instead of today\'s strategy, how do reach and historical conversion capture change?', 'A replay of a real contact schedule over the evaluation window: every strategy gets the same eligible population, cadence, cooldown, suppression and outcome window. Results are historical observed conversions, not conversions caused by outreach.',
      `<button class="btn howto-btn" id="sim-howto" aria-haspopup="dialog"><span class="q" aria-hidden="true">?</span>How this works</button>`)}
    <div class="subnav">${segHTML('simsub', [{ v: 'campaign', label: 'Campaign comparison' }, { v: 'tiers', label: 'Likelihood tiers' }, { v: 'roster', label: 'Class rosters', disabled: !S.roles.class_id, tip: S.roles.class_id ? '' : 'Needs a CLASS_ID column.' }], U.sub, 'lg')}</div>
    <div id="sim-body"></div>`);
  bindSeg(el, 'simsub', async s => { U.sub = s; await simBody(v); });
  $('#sim-howto').onclick = e => openSimGuide(e.currentTarget);
  await simBody(v);
};
async function simBody(v) {
  const U = simState(), body = $('#sim-body');
  if (U.sub === 'tiers') return tiersView(body, v);
  if (U.sub === 'roster') return rosterView(body, v);
  return campaignView(body, v);
}

/* ------------------------------------------------------------- rule builder */
function ruleSQLFrom(conds) {
  const parts = [];
  for (const c of conds) {
    if (!c.col) continue;
    const f = S.disc.features.find(x => x.name === c.col); if (!f) continue;
    if (f.numeric && (c.op !== 'in' && c.op !== 'not in')) { if (!fin(+c.val) || c.val === null || c.val === '') continue; parts.push(`TRY_CAST(${qi(c.col)} AS DOUBLE) ${({ '>=': '>=', '<=': '<=', '>': '>', '<': '<', '=': '=', '!=': '<>' })[c.op] || '>='} ${+c.val}`); }
    else { const vals = Array.isArray(c.vals) ? c.vals : []; if (!vals.length) continue; parts.push(`COALESCE(CAST(${qi(c.col)} AS VARCHAR), '(missing)') ${c.op === 'not in' ? 'NOT IN' : 'IN'} (${vals.map(ql).join(',')})`); }
  }
  return parts.length ? parts.join(' AND ') : null;
}
function ruleText(conds) {
  const t = conds.filter(c => c.col).map(c => { const f = S.disc.features.find(x => x.name === c.col); if (!f) return ''; if (f.numeric && c.op !== 'in' && c.op !== 'not in') return fin(+c.val) && c.val !== '' && c.val !== null ? `${c.col} ${c.op} ${c.val}` : ''; return (c.vals || []).length ? `${c.col} ${c.op === 'not in' ? 'not in' : 'in'} {${c.vals.join(', ')}}` : ''; }).filter(Boolean);
  return t.length ? t.join(' AND ') : '';
}
async function catValues(col) {
  const s = S.core.segs.find(x => x.name === col); if (s) return s.labels;
  const key = 'catvals|' + col; if (S.cache.has(key)) return S.cache.get(key);
  const r = (await q(`SELECT COALESCE(CAST(${qi(col)} AS VARCHAR), '(missing)') AS v, COUNT(*) AS n FROM data GROUP BY 1 ORDER BY n DESC LIMIT 60`)).map(x => x.v);
  S.cache.set(key, r); return r;
}
async function ruleBuilderHTML(prefix, conds) {
  const feats = S.disc.features;
  const rows = [];
  for (let i = 0; i < conds.length; i++) {
    const c = conds[i], f = feats.find(x => x.name === c.col);
    const isNum = f && f.numeric && c.op !== 'in' && c.op !== 'not in';
    const opts = f && f.numeric ? ['>=', '<=', '>', '<', '=', '!=', 'in', 'not in'] : ['in', 'not in'];
    if (f && !opts.includes(c.op)) c.op = opts[0];
    let valHTML = '';
    if (f && !isNum) { const vals = await catValues(c.col); c.vals ||= []; valHTML = `<div class="pill-select" style="flex-basis:100%">${vals.map(x => `<label><input type="checkbox" data-rv="${i}" value="${esc(x)}" ${c.vals.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div>`; }
    else if (f) valHTML = `<input type="number" step="any" data-rn="${i}" value="${c.val ?? ''}" placeholder="value" style="width:110px">${fin(f.min) ? `<span class="faint">range ${fmtNum(f.min, 2)} – ${fmtNum(f.max, 2)}</span>` : ''}`;
    rows.push(`<div class="rule-row">${i ? '<span class="faint" style="width:34px">AND</span>' : '<span class="faint" style="width:34px">IF</span>'}
      <select data-rc="${i}" aria-label="Feature"><option value="">— feature —</option>${feats.map(x => `<option value="${esc(x.name)}" ${x.name === c.col ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${f ? `<select data-ro="${i}" aria-label="Operator">${opts.map(o => `<option ${o === c.op ? 'selected' : ''}>${o}</option>`).join('')}</select>` : ''}${valHTML}
      <button class="icon-btn" data-rx="${i}" aria-label="Remove condition" style="width:28px;height:28px">${ICON.close}</button></div>`);
  }
  return `<div data-rb="${prefix}">${rows.join('')}<button class="btn sm ghost" data-radd>+ Add condition</button></div>`;
}
function wireRuleBuilder(root, prefix, conds, onChange) {
  const host = $(`[data-rb="${prefix}"]`, root); if (!host) return;
  host.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.rc !== undefined) { const c = conds[+t.dataset.rc]; c.col = t.value; c.vals = []; c.val = null; const f = S.disc.features.find(x => x.name === c.col); c.op = f && f.numeric ? '>=' : 'in'; onChange(true); }
    else if (t.dataset.ro !== undefined) { const c = conds[+t.dataset.ro], was = c.op; c.op = t.value; if ((was === 'in' || was === 'not in') !== (c.op === 'in' || c.op === 'not in')) { c.vals = []; c.val = null; onChange(true); } else onChange(false); }
    else if (t.dataset.rv !== undefined) { const c = conds[+t.dataset.rv]; c.vals = $$(`input[data-rv="${t.dataset.rv}"]:checked`, host).map(x => x.value); onChange(false); }
  });
  host.addEventListener('input', debounce(e => { const t = e.target; if (t.dataset.rn !== undefined) { conds[+t.dataset.rn].val = t.value === '' ? null : +t.value; onChange(false); } }, 400));
  host.addEventListener('click', e => {
    if (e.target.closest('[data-radd]')) { conds.push({ col: '', op: '>=', val: null, vals: [] }); onChange(true); }
    const x = e.target.closest('[data-rx]'); if (x) { conds.splice(+x.dataset.rx, 1); onChange(true); }
  });
}
async function ensureRuleMask(conds) {
  const sql = ruleSQLFrom(conds); if (!sql) return null;
  const id = 'r' + hashStr(sql);
  const key = `rule|${id}`;
  if (!S.cache.has(key)) {
    const p = (async () => { const m = await qColumn(`SELECT CAST(COALESCE((${sql}), false) AS UTINYINT) AS m FROM data ORDER BY __rid`, 'm', Uint8Array); await eng({ type: 'rule', ruleId: id, mask: m }, [m.buffer]); return id; })();
    S.cache.set(key, p);
  }
  return S.cache.get(key);
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/* -------------------------------------------------------------- campaign view */
async function campaignView(body, v) {
  const U = simState(), st = U.setup, T = U.st;
  if (st.d0 < S.settings.d0 || st.d0 > S.settings.d1) st.d0 = S.settings.d0;
  if (st.d1 > S.settings.d1 || st.d1 < S.settings.d0) st.d1 = S.settings.d1;
  if (st.fresh === null) st.fresh = freshDefault(st.cadence);
  if (T.threshold.tau === null) { const qs = await scoreQuantiles('row'); T.threshold.tau = +(+qs.raw90).toPrecision(3); T.threshold.tauP = S.hasProb ? +(+qs.prob90).toPrecision(3) : null; }
  const studio = S.roles.studio ? S.core.segs.find(s => s.name === S.roles.studio) : null;
  const segs = S.core.segs.filter(s => !s.hidden);
  const eligSeg = segs.find(s => s.name === st.eligCol);
  html(body, `
    <div class="grid g-side">
      <div>
        <div class="card" id="sim-setup">
          <h3>Campaign setup</h3>
          <p class="faint" style="margin:4px 0 14px">Shared by every strategy.</p>
          <div style="display:grid;gap:14px">
            <label class="field"><span class="lab">Cadence</span>${segHTML('cad', [{ v: 'daily', label: 'Daily' }, { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }], st.cadence)}</label>
            <div class="form-grid" style="grid-template-columns:1fr 1fr"><label class="field"><span class="lab">From</span><input type="date" id="cs-d0" min="${S.settings.d0}" max="${S.settings.d1}" value="${st.d0}"></label>
              <label class="field"><span class="lab">To</span><input type="date" id="cs-d1" min="${S.settings.d0}" max="${S.settings.d1}" value="${st.d1}"></label></div>
            <label class="field"><span class="lab">Audience per send ${tipText('Budget per send. Top-X, random and capped rule strategies all contact this many clients per send (matched comparison).')}</span>
              <div class="form-row">${segHTML('aud', [{ v: 'pct', label: '% of pool' }, { v: 'n', label: 'Clients' }], st.audType)}
              ${st.audType === 'pct' ? `<input type="number" id="cs-pct" min="0.1" max="100" step="0.5" value="${st.audPct}"><span class="faint">%</span>` : `<input type="number" id="cs-n" min="1" step="10" value="${st.audN}">`}</div></label>
            <div class="form-grid" style="grid-template-columns:1fr 1fr">
              <label class="field"><span class="lab">Cooldown (days) ${tipText('A client contacted at send t can be contacted again only after t + cooldown.')}</span><input type="number" id="cs-cool" min="0" max="365" value="${st.cooldown}"></label>
              <label class="field"><span class="lab">Max contacts / client ${tipText('Repeat-contact policy: 0 = unlimited (subject to cooldown); 1 = contact each client at most once.')}</span><input type="number" id="cs-max" min="0" max="100" value="${st.maxContacts}"></label></div>
            <label class="inline"><input type="checkbox" id="cs-sup" ${st.suppress ? 'checked' : ''}> Suppress clients after a purchase during the campaign</label>
          </div>
          ${disc('Scoring, outcome and eligibility', `<div style="display:grid;gap:14px">
            <label class="field"><span class="lab">Model rescoring ${tipText('Which prediction is used at each send. The most recent prediction on or before the scoring snapshot is used; future scores are never used.')}</span>
              <select id="cs-rescore"><option value="0" ${st.rescore === 0 ? 'selected' : ''}>Before every send (latest prediction)</option><option value="7" ${st.rescore === 7 ? 'selected' : ''}>Weekly</option><option value="14" ${st.rescore === 14 ? 'selected' : ''}>Every two weeks</option><option value="-1" ${st.rescore === -1 ? 'selected' : ''}>Once, at the first send (frozen)</option></select></label>
            <label class="field"><span class="lab">Score freshness (days) ${tipText('A client is in the pool only if their latest prediction is at most this many days older than the scoring snapshot. Clients without a fresh prediction are treated as not eligible.')}</span><input type="number" id="cs-fresh" min="0" max="90" value="${st.fresh}"></label>
            <div class="form-grid" style="grid-template-columns:1fr 1fr">
              <label class="field"><span class="lab">Contact lag (days)</span><input type="number" id="cs-lag" min="0" max="14" value="${st.lag}"></label>
              <label class="field"><span class="lab">Outcome window (days)</span><input type="number" id="cs-h" min="1" max="60" value="${st.horizon}"></label></div>
            <p class="faint" style="margin:0">A contact at send t is followed by a purchase if the client purchased on t + lag … t + window. Purchases are only visible for clients with a positive row in the file, so windows longer than the label horizon (${S.settings.horizon} days) undercount.</p>
            <label class="field"><span class="lab">Eligible population</span><select id="cs-ecol"><option value="">Everyone with a fresh prediction</option>${segs.map(s => `<option value="${esc(s.name)}" ${st.eligCol === s.name ? 'selected' : ''}>Only some ${esc(s.label)} values…</option>`).join('')}</select></label>
            ${eligSeg ? `<div class="pill-select" id="cs-evals">${eligSeg.labels.map((l, i) => `<label><input type="checkbox" value="${i}" ${st.eligVals.includes(i) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>` : ''}
            ${S.roles.current ? `<label class="inline"><input type="checkbox" id="cs-exc" ${st.excludeCurrent ? 'checked' : ''}> Exclude clients the current strategy already targets</label>` : ''}
            ${studio ? `<label class="field"><span class="lab">Per-studio cap per send (0 = none)</span><input type="number" id="cs-loc" min="0" step="1" value="${st.locCap}"></label>` : ''}
          </div>`, { cls: 'line', sub: '' })}
        </div>
        <div class="card" style="margin-top:20px" id="sim-strats"><h3>Strategies</h3><p class="faint" style="margin:4px 0 14px">Compared on the same pool at every send.</p><div id="strat-list" style="display:grid;gap:12px"></div></div>
        <div class="card" style="margin-top:20px">${disc('Economic assumptions (optional)', `<div style="display:grid;gap:12px">
          <label class="field"><span class="lab">Cost per contact ($)</span><input type="number" id="ec-contact" min="0" step="0.01" value="${U.econ.contact}" placeholder="e.g. 0.50"></label>
          <label class="field"><span class="lab">Offer cost per converting contacted client ($)</span><input type="number" id="ec-offer" min="0" step="1" value="${U.econ.offer}" placeholder="e.g. 20"></label>
          <label class="field"><span class="lab">Contribution margin per conversion ($)</span><input type="number" id="ec-margin" min="0" step="1" value="${U.econ.margin}" placeholder="e.g. 300"></label>
          <label class="field"><span class="lab">Assumed incremental share of captured conversions (%) ${tipText('Scenario input, not a measurement: the share of captured conversions that would not have happened without the contact. Only a randomized holdout can measure it.')}</span><input type="number" id="ec-incr" min="0" max="100" step="1" value="${U.econ.incr}" placeholder="e.g. 10"></label>
        </div>`, { cls: 'line', open: !!(U.econ.contact || U.econ.margin), sub: 'costs and value' })}</div>
      </div>
      <div id="sim-out">${computing('Simulating the campaign…')}</div>
    </div>`);
  // wire setup controls
  const rerun = debounce(() => runCampaign(v), 350);
  bindSeg(body, 'cad', c => { st.cadence = c; st.fresh = freshDefault(c); $('#cs-fresh').value = st.fresh; rerun(); });
  bindSeg(body, 'aud', t => { st.audType = t; campaignView(body, v); });
  const num = (id, k, f = x => x) => { const e = $(id, body); if (e) e.oninput = () => { if (e.value === '' || !Number.isFinite(+e.value)) return; st[k] = f(+e.value); rerun(); }; };
  num('#cs-pct', 'audPct', x => clamp(x, 0.1, 100)); num('#cs-n', 'audN', x => Math.max(1, Math.round(x))); num('#cs-cool', 'cooldown', x => Math.max(0, Math.round(x)));
  num('#cs-max', 'maxContacts', x => Math.max(0, Math.round(x))); num('#cs-fresh', 'fresh', x => Math.max(0, Math.round(x))); num('#cs-lag', 'lag', x => Math.max(0, Math.round(x)));
  num('#cs-h', 'horizon', x => Math.max(1, Math.round(x))); num('#cs-loc', 'locCap', x => Math.max(0, Math.round(x)));
  const dts = () => { let a = $('#cs-d0').value || S.settings.d0, b = $('#cs-d1').value || S.settings.d1; if (a > b) [a, b] = [b, a]; st.d0 = a; st.d1 = b; rerun(); };
  $('#cs-d0').onchange = dts; $('#cs-d1').onchange = dts;
  $('#cs-sup').onchange = e => { st.suppress = e.target.checked; rerun(); };
  $('#cs-rescore').onchange = e => { st.rescore = +e.target.value; rerun(); };
  $('#cs-ecol').onchange = e => { st.eligCol = e.target.value; const s = segs.find(x => x.name === st.eligCol); st.eligVals = s ? s.labels.map((_, i) => i) : []; campaignView(body, v); };
  $('#cs-evals')?.addEventListener('change', () => { st.eligVals = $$('#cs-evals input:checked').map(x => +x.value); rerun(); });
  $('#cs-exc')?.addEventListener('change', e => { st.excludeCurrent = e.target.checked; rerun(); });
  ['contact', 'offer', 'margin', 'incr'].forEach(k => { const e = $('#ec-' + k); e.oninput = debounce(() => { U.econ[k] = e.value; if (S.sim) renderCampaignOut(S.sim, v); }, 300); });
  await drawStrategies(v, rerun);
  await runCampaign(v);
}

async function drawStrategies(v, rerun) {
  const U = simState(), T = U.st, host = $('#strat-list');
  const box = (key, inner, extra = '') => `<div class="strategy ${T[key].on ? '' : 'off'}" data-s="${key}"><div class="s-head"><span class="swatch" style="background:${STRAT_META[key].color()}"></span><span class="s-name">${STRAT_META[key].label}</span>${extra}<label class="inline small"><input type="checkbox" data-on="${key}" ${T[key].on ? 'checked' : ''}> Include</label></div>${inner}</div>`;
  const curInner = S.roles.current
    ? `<div class="form-row small">${segHTML('cursrc', [{ v: 'flag', label: `Flag column (${S.roles.current})` }, { v: 'rule', label: 'Rule' }], T.current.source)}</div>
       ${T.current.source === 'flag' ? `<p class="faint" style="margin-top:8px">Clients whose most recent row has <span class="mono">${esc(S.roles.current)}</span> = 1 at the send.</p>` : await ruleBuilderHTML('cur', T.current.conds)}`
    : `<p class="faint">Not configured: the file has no CURRENT_STRATEGY_FLAG column, and the app does not invent your strategy. Describe it as a rule to include it.</p>${await ruleBuilderHTML('cur', T.current.conds)}`;
  const within = key => `<label class="field" style="margin-top:10px"><span class="lab">If more clients qualify than the budget</span><select data-within="${key}"><option value="random" ${T[key].within === 'random' ? 'selected' : ''}>pick at random</option><option value="score" ${T[key].within === 'score' ? 'selected' : ''}>pick highest model score</option></select></label>`;
  html(host, [
    box('topx', `<p class="faint">The top ${U.setup.audType === 'pct' ? U.setup.audPct + '% of the pool' : fmtInt(U.setup.audN) + ' clients'} by score at each send (exact count; ties by the fixed hash).</p>`),
    box('current', curInner + within('current')),
    box('rule', `${await ruleBuilderHTML('rule', T.rule.conds)}${within('rule')}<p class="faint" style="margin-top:6px">Example rule pre-filled from the file's features; edit freely.</p>`),
    box('threshold', `<div class="form-row small"><label class="inline">${T.threshold.useProb ? 'Probability' : 'Raw score'} ≥ <input type="number" id="st-tau" step="any" value="${T.threshold.useProb ? T.threshold.tauP : T.threshold.tau}" style="width:110px"></label>
      ${S.hasProb ? `<label class="inline"><input type="checkbox" id="st-useprob" ${T.threshold.useProb ? 'checked' : ''}> use probability</label>` : ''}</div>
      <p class="faint" style="margin-top:6px">${T.threshold.useProb ? 'Calibrated probability threshold.' : 'Raw-score threshold — not a probability.'} Natural audience = everyone above it; matched = capped at the budget.</p>`),
    box('random', `<div class="form-row small"><label class="inline">Repeated runs <input type="number" id="st-runs" min="1" max="200" value="${T.random.runs}" style="width:80px"></label></div><p class="faint" style="margin-top:6px">Same budget drawn at random from the eligible pool; mean and 5th–95th percentile across runs.</p>`),
  ].join(''));
  syncSegs(host);
  const redraw = () => drawStrategies(v, rerun);
  host.onchange = e => { const k = e.target.dataset.on; if (k) { T[k].on = e.target.checked; e.target.closest('.strategy').classList.toggle('off', !T[k].on); rerun(); } const w = e.target.dataset.within; if (w) { T[w].within = e.target.value; rerun(); } };
  bindSeg(host, 'cursrc', s => { T.current.source = s; redraw(); rerun(); });
  wireRuleBuilder(host, 'cur', T.current.conds, structural => { if (structural) redraw(); if (!S.roles.current || T.current.source === 'rule') { T.current.on = !!ruleSQLFrom(T.current.conds) || T.current.on; } rerun(); });
  wireRuleBuilder(host, 'rule', T.rule.conds, structural => { if (structural) redraw(); rerun(); });
  const tau = $('#st-tau', host); tau.oninput = debounce(() => { const x = +tau.value; if (!Number.isFinite(x)) return; if (T.threshold.useProb) T.threshold.tauP = x; else T.threshold.tau = x; rerun(); }, 350);
  $('#st-useprob', host)?.addEventListener('change', e => { T.threshold.useProb = e.target.checked; redraw(); rerun(); });
  const runs = $('#st-runs', host); runs.oninput = debounce(() => { T.random.runs = clamp(Math.round(+runs.value || 20), 1, 200); rerun(); }, 350);
}

function campaignSpec() {
  const U = simState(), st = U.setup, T = U.st;
  return {
    d0: dayIdx(st.d0), d1: dayIdx(st.d1), cadence: st.cadence, freshDays: st.fresh, rescoreEvery: st.rescore, lag: st.lag, horizon: st.horizon,
    audience: st.audType === 'pct' ? { type: 'pct', value: st.audPct / 100 } : { type: 'n', value: st.audN },
    cooldown: st.cooldown, maxContacts: st.maxContacts, suppress: st.suppress, excludeCurrent: !!(S.roles.current && st.excludeCurrent),
    eligibleSeg: st.eligCol ? { col: segIdx(st.eligCol), codes: st.eligVals } : null,
    locCap: S.roles.studio ? st.locCap : 0, locCol: S.roles.studio ? segIdx(S.roles.studio) : -1, randomRuns: T.random.runs,
  };
}
async function runCampaign(v, exportStrategy = null) {
  const U = simState(), T = U.st;
  const spec = campaignSpec();
  const strategies = [];
  if (T.topx.on) strategies.push({ id: 'topx', kind: 'topx', label: STRAT_META.topx.label });
  if (T.current.on) {
    if (S.roles.current && T.current.source === 'flag') strategies.push({ id: 'current', kind: 'current', source: 'flag', within: T.current.within, label: STRAT_META.current.label });
    else { const id = await ensureRuleMask(T.current.conds); if (id) strategies.push({ id: 'current', kind: 'current', source: 'rule', ruleId: id, within: T.current.within, label: STRAT_META.current.label }); }
  }
  if (T.rule.on) { const id = await ensureRuleMask(T.rule.conds); if (id) strategies.push({ id: 'rule', kind: 'rule', ruleId: id, within: T.rule.within, label: STRAT_META.rule.label }); }
  if (T.threshold.on) strategies.push({ id: 'threshold', kind: 'threshold', tau: T.threshold.useProb ? T.threshold.tauP : T.threshold.tau, useProb: !!T.threshold.useProb, label: STRAT_META.threshold.label });
  if (T.random.on) strategies.push({ id: 'random', kind: 'random', label: STRAT_META.random.label });
  if (stale(v)) return null;
  if (!strategies.length) { html($('#sim-out'), empty('No strategy selected', 'Include at least one strategy.')); return null; }
  spec.strategies = strategies;
  if (exportStrategy) spec.exportStrategy = exportStrategy;
  const out = $('#sim-out'); if (out && !exportStrategy) out.classList.add('dimmed');
  let r;
  try { r = await busy.wrap(() => eng({ type: 'campaign', spec }), 'Simulating the campaign…'); }
  catch (e) { if (out) { out.classList.remove('dimmed'); html(out, callout('bad', `Simulation failed: ${esc(e.message)}`)); } return null; }
  if (stale(v)) return null;
  if (exportStrategy) return r;
  const snap = JSON.stringify({ setup: U.setup, st: U.st });
  S.ui.simDefault ||= snap;
  S.sim = { r, spec, setup: { ...U.setup }, ruleText: ruleText(T.rule.conds), currentText: S.roles.current && T.current.source === 'flag' ? `${S.roles.current} = 1` : ruleText(T.current.conds), threshold: { tau: T.threshold.useProb ? T.threshold.tauP : T.threshold.tau, useProb: T.threshold.useProb }, at: new Date().toISOString(), ver: S.ver, custom: snap !== S.ui.simDefault };
  if (out) { out.classList.remove('dimmed'); renderCampaignOut(S.sim, v); S.rendered.exec = null; }   // off-page runs (Executive Report) draw nothing
  return r;
}

function econOf(m, E) {
  const cc = +E.contact, oc = +E.offer, mg = +E.margin, inc = +E.incr;
  const has = x => E[x] !== '' && Number.isFinite(+E[x]);
  if (!m) return null;
  const o = {};
  if (has('contact')) o.contactCost = m.contacts * cc;
  if (has('offer')) o.offerCost = m.convClients * oc;
  o.totalCost = (o.contactCost ?? 0) + (o.offerCost ?? 0);
  o.anyCost = has('contact') || has('offer');
  if (has('margin')) { o.observedValue = m.episodesCaptured * mg; o.breakEven = m.episodesCaptured && mg ? o.totalCost / (m.episodesCaptured * mg) : null; }
  if (has('margin') && has('incr')) { o.scenarioValue = m.episodesCaptured * (inc / 100) * mg; o.scenarioNet = o.scenarioValue - o.totalCost; }
  return o;
}

function renderCampaignOut(sim, v) {
  const out = $('#sim-out'); if (!out) return;
  const r = sim.r, U = simState(), st = sim.setup, E = U.econ;
  const res = r.results, rnd = res.find(x => x.kind === 'random');
  if (!r.sends.length) { html(out, empty('No send dates in the selected window', 'Widen the campaign dates.')); return; }
  const cad = { daily: 'day', weekly: 'week', monthly: 'month' }[st.cadence];
  const audTxt = st.audType === 'pct' ? `${st.audPct}% of the eligible pool` : `${fmtInt(st.audN)} clients`;
  const avgPool = r.ctx.pools.reduce((a, b) => a + b, 0) / r.ctx.pools.length;
  const ref = rnd?.matched?.precision;
  const cols = res.map(x => ({ id: x.id, label: x.label, color: STRAT_META[x.kind].color(), m: x.matched, n: x.natural, ov: x.overlapWithModel, random: x.kind === 'random' }));
  const vs = (a) => (fin(a) && fin(ref) && ref > 0 ? a / ref : null);
  const econ = cols.map(c => econOf(c.m, E));
  const anyEcon = econ.some(e => e && (e.anyCost || fin(e.observedValue)));
  const R = (label, f, tipKey, cls = '') => ({ label, tipKey, cls, cells: cols.map((c, i) => f(c.m, c, i)) });
  const rr = (m, c, k, fm) => (c.random && fin(m[k + 'P5']) ? `${fm(m[k])} <span class="ci-inline">${fm(m[k + 'P5'])}–${fm(m[k + 'P95'])}</span>` : fm(m[k]));
  const rows = [
    R('Contact attempts', (m, c) => rr(m, c, 'contacts', fmtInt), 'contacts'),
    R('Unique clients contacted', (m, c) => rr(m, c, 'uniqueClients', fmtInt), 'unique_clients'),
    R('Contacts per client', (m, c) => rr(m, c, 'contactsPerClient', x => fmtNum(x, 2))),
    R('Repeat contacts', (m, c) => rr(m, c, 'repeatContacts', fmtInt)),
    R('Contacts followed by a purchase', (m, c) => rr(m, c, 'convContacts', fmtInt)),
    R('Contact precision', (m, c) => `${fmtPct(m.precision)} ${c.random ? `<span class="ci-inline">${fmtPct(m.precisionP5)}–${fmtPct(m.precisionP95)}</span>` : fmtCI(m.precLo, m.precHi, fmtPct)}`, 'contact_precision', 'hl'),
    R('Clients who purchased after a contact', (m, c) => rr(m, c, 'convClients', fmtInt), 'converters'),
    R('Client conversion rate', (m, c) => `${fmtPct(m.clientRate)} ${c.random ? `<span class="ci-inline">${fmtPct(m.clientRateP5)}–${fmtPct(m.clientRateP95)}</span>` : fmtCI(m.clientRateLo, m.clientRateHi, fmtPct)}`, 'client_rate'),
    R('Purchases captured (deduplicated)', (m, c) => rr(m, c, 'episodesCaptured', fmtInt), 'captured', 'hl'),
    R('Capture rate of reachable purchases', (m, c) => rr(m, c, 'capture', x => fmtPct(x)), 'capture_rate'),
    R('Lift vs eligible pool', (m) => fmtX(m.lift, 2), 'pool_rate'),
    R('Precision vs random', (m, c) => (c.random ? '1.00×' : fmtX(vs(m.precision), 2))),
    R('Budget shortfall', (m, c) => (m.shortfall ? `<span class="flag">${fmtInt(m.shortfall)}</span>` : '0'), 'shortfall'),
    R('Overlap with model top-X', (m, c) => (c.ov ? `${fmtInt(c.ov.both)} clients <span class="ci-inline">Jaccard ${fmtNum(c.ov.jaccard, 2)}</span>` : c.id === 'topx' ? '—' : '—')),
    ...(anyEcon ? [
      R('Contact + offer cost', (m, c, i) => (econ[i]?.anyCost ? fmtMoney(econ[i].totalCost) : '—'), 'Contacts × cost per contact + converting contacted clients × offer cost. Assumption-based.'),
      R('Margin on observed captured conversions', (m, c, i) => (fin(econ[i]?.observedValue) ? fmtMoney(econ[i].observedValue) : '—'), 'Captured purchases × margin. NOT incremental: most of these clients may have bought anyway.'),
      R('Break-even incremental share', (m, c, i) => (fin(econ[i]?.breakEven) ? fmtPct(econ[i].breakEven) : '—'), 'Share of captured conversions that would have to be caused by the contact for value to cover cost.'),
      R('Scenario net value (assumed incremental share)', (m, c, i) => (fin(econ[i]?.scenarioNet) ? fmtMoney(econ[i].scenarioNet) : '—'), 'Captured × assumed incremental share × margin − cost. A scenario, not a measurement.'),
    ] : []),
  ];
  const natural = cols.filter(c => c.n);
  const best = cols.filter(c => !c.random).sort((a, b) => (b.m.episodesCaptured || 0) - (a.m.episodesCaptured || 0))[0];
  const model = cols.find(c => c.id === 'topx'), cur = cols.find(c => c.id === 'current');
  const summary = [];
  if (model && rnd) summary.push(`At the same budget, the model's top-X contacts captured <b>${fmtInt(model.m.episodesCaptured)}</b> purchases vs <b>${fmtInt(rnd.matched.episodesCaptured)}</b> for random targeting (${fmtPct(model.m.precision)} vs ${fmtPct(rnd.matched.precision)} contact precision).`);
  if (model && cur) summary.push(`Against the current strategy at the same budget: <b>${fmtInt(model.m.episodesCaptured)}</b> vs <b>${fmtInt(cur.m.episodesCaptured)}</b> purchases captured${cur.m.shortfall ? ` (the current strategy qualified too few clients for ${fmtInt(cur.m.shortfall)} of its contacts)` : ''}.`);
  if (!cur) summary.push('The current strategy is not configured, so it is not compared.');
  html(out, `
    ${callout('info', `${sim.custom ? '' : '<b>Default scenario.</b> '}${plural(r.sends.length, PERIOD_ADJ[st.cadence] + ' send')} from ${r.sends[0]} to ${r.sends[r.sends.length - 1]}; ${audTxt} per send (≈${fmtInt(avgPool)} eligible per send, ${fmtInt(r.ctx.eligibleClients)} distinct eligible clients); cooldown ${st.cooldown} days${st.maxContacts ? `, at most ${st.maxContacts} contact${st.maxContacts > 1 ? 's' : ''} per client` : ''}${st.suppress ? ', suppression after purchase' : ''}; outcome = purchase ${st.lag}–${st.horizon} days after the send. ${fmtInt(r.ctx.reachable)} purchases were reachable by any strategy.`)}
    ${summary.length ? `<div class="card" style="margin-top:20px"><h3>What changes</h3><p style="margin:8px 0 0;font-size:15px;line-height:1.55">${summary.join(' ')}</p></div>` : ''}
    <div class="card" style="margin-top:20px">
      <div class="card-head"><div class="titles"><h3>Matched-budget comparison</h3><div class="sub">Every strategy contacts up to the same number of clients per send, from the same pool. Purchases are counted once each, however many contacts preceded them.</div></div>
        <div class="actions"><button class="btn sm" id="sim-exp">${ICON.download} Export comparison</button></div></div>
      <div class="tbl-wrap"><table class="data"><thead><tr><th class="nosort">Metric</th>${cols.map(c => `<th class="num nosort"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.color};margin-right:6px"></span>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(x => `<tr ${x.cls === 'hl' ? 'style="font-weight:600"' : ''}><td>${esc(x.label)} ${x.tipKey ? (TIPS[x.tipKey] ? tip(x.tipKey) : tipText(x.tipKey)) : ''}</td>${x.cells.map(cv => `<td class="num">${cv}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="tbl-foot"><span>Random: mean of ${fmtInt(rnd?.runs || 0)} runs with the 5th–95th percentile across runs. Other intervals: 95%, client-clustered (precision) or Wilson (client rate). Pool base rate ${fmtPct(cols[0]?.m.baseRate)}.</span></div>
    </div>
    ${natural.length ? `<div class="card" style="margin-top:20px"><div class="card-head"><div class="titles"><h3>Natural audiences (no budget cap)</h3><div class="sub">Everyone a rule or threshold qualifies, still subject to cooldown and suppression. A larger audience captures more purchases simply by contacting more people — compare precision and cost, not just volume.</div></div></div>
      <div class="tbl-wrap"><table class="data"><thead><tr><th class="nosort">Strategy</th><th class="num nosort">Contacts</th><th class="num nosort">Unique clients</th><th class="num nosort">Avg. per send</th><th class="num nosort">Purchases captured</th><th class="num nosort">Capture rate</th><th class="num nosort">Contact precision</th><th class="num nosort">Lift vs pool</th></tr></thead>
      <tbody>${natural.map(c => `<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.color};margin-right:6px"></span>${esc(c.label)}</td><td class="num">${fmtInt(c.n.contacts)}</td><td class="num">${fmtInt(c.n.uniqueClients)}</td><td class="num">${fmtNum(div(c.n.contacts, c.n.sends), 0)}</td><td class="num">${fmtInt(c.n.episodesCaptured)}</td><td class="num">${fmtPct(c.n.capture)}</td><td class="num">${fmtPct(c.n.precision)} ${fmtCI(c.n.precLo, c.n.precHi, fmtPct)}</td><td class="num">${fmtX(c.n.lift, 2)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="grid g2" style="margin-top:20px">
      ${card('Cumulative purchases captured', '<div class="chart sm" id="sim-capt"></div>', { sub: 'Distinct purchases with a prior contact, by send date (matched budgets).' })}
      ${card('Cumulative unique clients reached', '<div class="chart sm" id="sim-reach"></div>', { sub: 'Distinct clients contacted so far.' })}
    </div>
    ${card('Contact precision by strategy', '<div class="chart xs" id="sim-prec"></div>', { sub: 'Share of contacts followed by a purchase within the outcome window, with 95% intervals (random: 5th–95th percentile across runs).' })}
    ${causalCard()}
    <div id="sim-exp-panel"></div>
    <div class="card" style="margin-top:20px">
      ${disc('Export a targeting audience', `<div class="form-row"><select id="aud-s">${cols.filter(c => !c.random).map(c => `<option value="${c.id}" ${U.exportStrategy === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select><button class="btn sm" id="aud-go">${ICON.download} Download contact list (CSV)</button></div>
        <p class="faint" style="margin-top:8px">One row per simulated contact: client, send date, score used, and whether a purchase followed within the outcome window. Contains client identifiers from your file; it is generated only when you click and is never stored by the app.</p>`, { cls: 'line' })}
      ${disc('Methodology: how the campaign is simulated', SIM_METHOD(), { cls: 'line', id: 'method-sim' })}
    </div>`);
  // charts
  const c = C();
  const series = (key, rk) => cols.map(cc => ({ x: cc.m.series.map(s => s.t), y: cc.m.series.map(s => s[key]), mode: 'lines+markers', name: cc.label, line: { color: cc.color, width: 2, dash: cc.random ? 'dash' : 'solid' }, marker: { size: 6, color: cc.color, line: { color: c.surface, width: 2 } }, hovertemplate: `${esc(cc.label)}<br>%{x}: %{y:,.0f}<extra></extra>` }));
  const bandR = rnd ? [{ x: rnd.matched.series.map(s => s.t), y: rnd.matched.series.map(s => s.cumCaptP95), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false }, { x: rnd.matched.series.map(s => s.t), y: rnd.matched.series.map(s => s.cumCaptP5), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(c.base, 0.15), hoverinfo: 'skip', showlegend: false }] : [];
  const xa = { type: st.cadence === 'monthly' ? 'category' : 'date', title: { text: 'Send date' } };
  plot($('#sim-capt'), [...bandR, ...series('cumCapt')], { xaxis: xa, yaxis: { title: { text: 'Purchases captured' }, rangemode: 'tozero' }, legend: { orientation: 'h', y: 1.2 } });
  plot($('#sim-reach'), series('cumUnique'), { xaxis: xa, yaxis: { title: { text: 'Unique clients contacted' }, rangemode: 'tozero' }, legend: { orientation: 'h', y: 1.2 } });
  plot($('#sim-prec'), [{ y: cols.map(cc => cc.label), x: cols.map(cc => cc.m.precision), type: 'bar', orientation: 'h', marker: { color: cols.map(cc => cc.color) }, width: 0.5,
    error_x: { type: 'data', symmetric: false, array: cols.map(cc => fin(cc.m.precHi) ? cc.m.precHi - cc.m.precision : 0), arrayminus: cols.map(cc => fin(cc.m.precLo) ? cc.m.precision - cc.m.precLo : 0), color: c.text3, thickness: 1.5, width: 4 },
    hovertemplate: '%{y}: %{x:.2%}<extra></extra>' }], { xaxis: { title: { text: 'Contact precision' }, tickformat: '.1~%', rangemode: 'tozero' }, yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, showlegend: false, margin: { l: 140, r: 20, t: 10, b: 44 } });
  // exports
  $('#sim-exp').onclick = () => {
    const keys = ['contacts', 'uniqueClients', 'contactsPerClient', 'repeatContacts', 'convContacts', 'precision', 'precLo', 'precHi', 'convClients', 'clientRate', 'clientRateLo', 'clientRateHi', 'episodesCaptured', 'capture', 'lift', 'baseRate', 'shortfall'];
    const rowsOut = [];
    for (const cc of cols) for (const [mode, m] of [['matched', cc.m], ['natural', cc.n]]) if (m) rowsOut.push({ strategy: cc.label, budget: mode, ...Object.fromEntries(keys.map(k => [k, m[k]])), jaccard_with_model: cc.ov?.jaccard ?? '' });
    const meta = { cadence: st.cadence, from: st.d0, to: st.d1, audience: audTxt, cooldown_days: st.cooldown, max_contacts: st.maxContacts, suppression: st.suppress, rescoring: st.rescore, freshness_days: st.fresh, lag_days: st.lag, outcome_window_days: st.horizon, rule: sim.ruleText, current_strategy: sim.currentText, threshold: sim.threshold.tau };
    download('strategy_comparison.csv', toCSV(rowsOut.map(rw => ({ ...rw, ...Object.fromEntries(Object.entries(meta).map(([k, x]) => ['setting_' + k, x])) }))));
  };
  $('#aud-s').onchange = e => { U.exportStrategy = e.target.value; };
  $('#aud-go').onclick = async () => {
    const res2 = await runCampaign(v, U.exportStrategy); if (!res2 || !res2.audience) { toast('Nothing to export for this strategy.'); return; }
    const names = S.core.cliNames;
    const rowsA = res2.audience.map(([cli, t, s, p, conv]) => ({ client_id: names[cli], send_date: dayIso(t), score_used: s, probability_used: Number.isFinite(p) ? p : '', purchase_within_window: conv }));
    download(`audience_${U.exportStrategy}.csv`, toCSV(rowsA));
    toast(`Exported ${fmtInt(rowsA.length)} contacts.`);
  };
  experimentPanel(v);
}
const causalCard = () => card('What these numbers can and cannot show', `
  <div class="grid g2">
    <div><h4>Measured here (observed, historical)</h4><ul class="small muted" style="padding-left:18px;margin:8px 0">
      <li>Who would have been contacted under each strategy, using only predictions available at each send.</li>
      <li>Whether those clients went on to purchase within the outcome window.</li>
      <li>How concentrated purchases are among contacted clients (precision, lift) and how many were reached (capture).</li></ul></div>
    <div><h4>Not measured (needs an experiment)</h4><ul class="small muted" style="padding-left:18px;margin:8px 0">
      <li>Whether a contact <b>caused</b> any purchase. High-propensity clients often buy anyway; targeting them can show high observed conversion and little incremental value.</li>
      <li>Incremental conversions, incremental revenue or profit. Economic figures above are scenarios built on your assumptions.</li>
      <li>How contacts change future behaviour (the replay assumes outreach does not alter who purchases).</li></ul></div>
  </div>
  ${callout('warn', 'Before scaling, run a randomized holdout: score everyone, randomly withhold contact from a fixed share of each strategy\'s audience, and compare purchase rates between contacted and held-out clients. That difference — not the lift above — is the incremental effect.')}`, { cls: '', sub: '' });
const SIM_METHOD = () => `<div class="methodology">
  <ol>
    <li><b>Send dates.</b> Daily: every date with eligible predictions in the window. Weekly / monthly: the first such date in each ISO week (Monday start) / calendar month.</li>
    <li><b>Scoring snapshot.</b> With rescoring before every send the snapshot is the send date; weekly / bi-weekly rescoring uses the latest rescoring date on or before the send; frozen uses the first send date. Each client's most recent prediction dated on or before the snapshot is used, and only if it is at most <i>freshness</i> days old. Future predictions or feature values are never used.</li>
    <li><b>Eligible pool.</b> Clients with a fresh prediction, minus clients who purchased during the campaign before the send (if suppression is on), minus any eligibility filter. The pool is the same for every strategy.</li>
    <li><b>Selection.</b> Each strategy orders the pool (score, random, or rule then score / random) and walks down it, skipping clients still in cooldown, at their maximum number of contacts, or over a per-studio cap, until the budget is filled (matched) or the qualifying list ends (natural).</li>
    <li><b>Outcomes.</b> A contact at send t is followed by a purchase if the client's earliest purchase P satisfies t + lag ≤ P ≤ t + window. ${epSourceNote()}</li>
    <li><b>Deduplication.</b> Contact attempts and unique clients are counted separately. A purchase is counted at most once per strategy even if several contacts preceded it or several overlapping 14-day labels pointed at it. Recall is never summed across sends: capture rate = distinct captured purchases ÷ distinct purchases reachable by any strategy (the client was in the pool at a send within the outcome window).</li>
    <li><b>Baselines.</b> Pool base rate = Σ over sends of pool members who purchased within the window after that send ÷ Σ pool sizes; lift = contact precision ÷ that rate. Random targeting draws the same budget from the same pool with ${simState().st.random.runs} different seeds.</li>
  </ol></div>`;

async function experimentPanel(v) {
  const host = $('#sim-exp-panel'); if (!host) return;
  if (!S.roles.treatment) { html(host, `<div class="card" style="margin-top:20px">${disc('Experimental comparison (treatment vs control)', `<p class="muted small">Not available: no TREATMENT_GROUP column was mapped. With randomized assignment data (one arm contacted, one withheld), this panel compares conversion rates between arms at the unique-client grain — the only valid estimate of incremental impact in this app.</p>`, { cls: 'line' })}</div>`); return; }
  const col = qi(S.roles.treatment);
  const r = await q(`SELECT COALESCE(CAST(${col} AS VARCHAR), '(missing)') AS arm, COUNT(*) AS n, SUM(y) AS pos FROM (${unitSQL('client', `client_id, y, ${col}`)}) GROUP BY 1 ORDER BY n DESC`);
  if (stale(v)) return;
  const U = simState(); U.control ||= (r.find(x => /control|hold/i.test(x.arm)) || r[r.length - 1])?.arm;
  const ctl = r.find(x => x.arm === U.control);
  const rows = r.map(x => { const p = div(x.pos, x.n), w = wilsonCI(p, x.n); const d = ctl && x !== ctl ? diffCI(x.pos, x.n, ctl.pos, ctl.n) : null; return { ...x, rate: p, lo: w.lo, hi: w.hi, diff: d?.d, dlo: d?.lo, dhi: d?.hi }; });
  html(host, card('Experimental comparison (treatment vs control)', `
    <div class="form-row" style="margin-bottom:12px"><span class="faint">Control arm</span><select id="ex-ctl">${r.map(x => `<option ${x.arm === U.control ? 'selected' : ''}>${esc(x.arm)}</option>`).join('')}</select></div>
    <div id="ex-tbl"></div>
    ${callout('neutral', 'Valid as an incremental estimate only if the arms were randomly assigned and the outcome window is the same for both. Unique-client grain: each client\'s first eligible prediction date in the evaluation window. The app cannot verify randomization from the file.')}`, { sub: `Arms from ${esc(S.roles.treatment)}. Difference vs control with a 95% Wald interval.`, cls: '' }));
  host.firstElementChild.style.marginTop = '20px';
  renderTable($('#ex-tbl'), { rows, maxRows: 20, exportName: 'experiment_arms', columns: [{ key: 'arm', label: 'Arm' }, { key: 'n', label: 'Clients', num: true, fmt: fmtInt }, { key: 'pos', label: 'Converted', num: true, fmt: fmtInt },
    { key: 'rate', label: 'Conversion rate', num: true, fmt: (x, rw) => `${fmtPct(x)} ${fmtCI(rw.lo, rw.hi, fmtPct)}` }, { key: 'diff', label: 'Difference vs control', num: true, fmt: (x, rw) => (fin(x) ? `${x >= 0 ? '+' : '−'}${fmtPct(Math.abs(x))} ${fmtCI(rw.dlo, rw.dhi, y => (y >= 0 ? '+' : '−') + fmtPct(Math.abs(y)))}` : '—') }] });
  $('#ex-ctl').onchange = e => { U.control = e.target.value; experimentPanel(v); };
}
function wilsonCI(p, n, z = 1.959964) { if (!fin(p) || !(n > 0)) return { lo: null, hi: null }; const z2 = z * z, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den; return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) }; }
function diffCI(x1, n1, x2, n2) { const p1 = x1 / n1, p2 = x2 / n2, d = p1 - p2, se = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2); return { d, lo: d - 1.96 * se, hi: d + 1.96 * se }; }

/** Default scenario for the Executive Report when the simulator has not been run: weekly, top 10%, 14-day cooldown. */
async function ensureSimulation(v) {
  if (S.sim && S.sim.ver === S.ver) return S.sim;
  const U = simState();
  if (U.st.threshold.tau === null) { const qs = await scoreQuantiles('row'); U.st.threshold.tau = +(+qs.raw90).toPrecision(3); U.st.threshold.tauP = S.hasProb ? +(+qs.prob90).toPrecision(3) : null; }
  if (U.setup.fresh === null) U.setup.fresh = freshDefault(U.setup.cadence);
  const r = await runCampaign(v); if (!r) return null;
  return S.sim;
}

/* ====================================================== LIKELIHOOD TIERS (Break Points) */
function bpDatasets() {
  const d0 = dayIdx(S.settings.d0), d1 = dayIdx(S.settings.d1), mid = d0 + Math.floor((d1 - d0) / 2);
  const list = [];
  const sp = S.roles.split ? S.core.segs.find(s => s.name === S.roles.split) : null;
  if (sp && S.settings.split === null) sp.labels.forEach((l, i) => list.push({ id: 'split:' + l, label: `split = ${l}`, spec: { split: i, d0, d1 } }));
  list.push({ id: 'early', label: `Earlier half (${S.settings.d0} to ${dayIso(mid)})`, spec: { split: -1, d0, d1: mid } });
  list.push({ id: 'late', label: `Later half (${dayIso(mid + 1)} to ${S.settings.d1})`, spec: { split: -1, d0: mid + 1, d1 } });
  list.push({ id: 'all', label: 'All evaluation dates', spec: { split: -1, d0, d1 } });
  return list;
}
const parseList = s => String(s || '').split(/[,\s;]+/).map(Number).filter(x => Number.isFinite(x) && x > 0);
async function tiersView(body, v) {
  const U = simState();
  const ds = bpDatasets();
  const B = (U.bp ||= { mode: 'auto', k: null, minConv: 100, minRatio: 1.5, needCI: true, kMax: 6, manual: '1, 5, 20', capacity: '100, 500, 2000', labels: {}, hyps: {}, cumul: false, logy: true });
  const valid = ds.find(d => /^split:.*valid/i.test(d.id));
  if (!ds.find(d => d.id === B.fit)) B.fit = valid ? valid.id : 'early';
  if (!ds.find(d => d.id === B.confirm)) B.confirm = valid ? (ds.find(d => /^split:.*test/i.test(d.id))?.id || 'late') : 'late';
  const opt = sel => ds.map(d => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  html(body, `
    ${callout('info', 'Where does conversion likelihood change abruptly within each day\'s ranking? Tiers found here rank <b>likelihood to convert</b>, not responsiveness to outreach. Find breaks on one period and confirm them on another the search never saw. Labels and intervention hypotheses are yours to edit; nothing is inferred.')}
    <div class="card" style="margin-top:20px"><div class="form-grid wide">
      <label class="field"><span class="lab">Find breaks on</span><select id="bp-fit">${opt(B.fit)}</select></label>
      <label class="field"><span class="lab">Confirm on</span><select id="bp-confirm">${opt(B.confirm)}</select></label>
      <label class="field"><span class="lab">Tier mode</span><select id="bp-mode"><option value="auto" ${B.mode === 'auto' ? 'selected' : ''}>Automatic break search</option><option value="manual" ${B.mode === 'manual' ? 'selected' : ''}>Manual (% of daily ranking)</option><option value="capacity" ${B.mode === 'capacity' ? 'selected' : ''}>Capacity (clients per day)</option></select></label>
      ${B.mode === 'manual' ? `<label class="field"><span class="lab">Breakpoints, %</span><input type="text" id="bp-manual" value="${esc(B.manual)}" placeholder="1, 5, 20"></label>` : ''}
      ${B.mode === 'capacity' ? `<label class="field"><span class="lab">Cumulative clients per day</span><input type="text" id="bp-capacity" value="${esc(B.capacity)}" placeholder="100, 500, 2000"></label>` : ''}
      <label class="field"><span class="lab">Min. unique converters per tier</span><input type="number" id="bp-minconv" min="1" step="10" value="${B.minConv}"></label>
      <label class="field"><span class="lab">Min. rate ratio, adjacent tiers</span><input type="number" id="bp-ratio" min="1" step="0.1" value="${B.minRatio}"></label>
      <label class="field"><span class="lab">Max tiers (k)</span><input type="number" id="bp-kmax" min="2" max="8" value="${B.kMax}"></label>
      <label class="field"><span class="lab">Intervals</span><label class="inline"><input type="checkbox" id="bp-ci" ${B.needCI ? 'checked' : ''}> adjacent tiers must not overlap</label></label>
    </div><div id="bp-warn" style="margin-top:12px"></div><div class="faint" id="bp-status" style="margin-top:6px"></div></div>
    <div id="bp-body" style="margin-top:20px"></div>`);
  const rerun = debounce(() => runBreaks(v, false), 400), retier = debounce(() => runBreaks(v, true), 300);
  const rd = (id, k, f = Number) => $(id).addEventListener('input', () => { B[k] = f($(id).value); rerun(); });
  $('#bp-fit').onchange = e => { B.fit = e.target.value; B.k = null; rerun(); };
  $('#bp-confirm').onchange = e => { B.confirm = e.target.value; retier(); };
  $('#bp-mode').onchange = e => { B.mode = e.target.value; tiersView(body, v); };
  $('#bp-manual')?.addEventListener('input', e => { B.manual = e.target.value; retier(); });
  $('#bp-capacity')?.addEventListener('input', e => { B.capacity = e.target.value; retier(); });
  rd('#bp-minconv', 'minConv'); rd('#bp-ratio', 'minRatio'); rd('#bp-kmax', 'kMax', x => clamp(Math.round(+x || 6), 2, 8));
  $('#bp-ci').onchange = e => { B.needCI = e.target.checked; rerun(); };
  await runBreaks(v, false);
}
async function runBreaks(v, tiersOnly) {
  const U = simState(), B = U.bp, ds = bpDatasets();
  const fit = ds.find(d => d.id === B.fit), conf = ds.find(d => d.id === B.confirm);
  html($('#bp-warn'), fit.id === conf.id ? callout('warn', 'Breaks are found and confirmed on the same rows, so the tier table is in-sample. Pick a different “Confirm on” dataset.') : (fit.id === 'early' ? callout('neutral', 'Breaks are fitted on the earlier half of the evaluation window and confirmed on the later half — a time-based substitute for a separate validation set.') : ''));
  if (tiersOnly && !U.bpRes) tiersOnly = false;
  const Bn = Math.min(200, bootN(S.pop.n));
  const cfg = { fit: fit.spec, confirm: conf.spec, minConv: B.minConv, minRatio: B.minRatio, needCI: B.needCI, kMax: B.kMax, B: Bn, Bstab: Math.min(Bn, 100), mode: B.mode, k: B.k,
    manual: parseList(B.manual).map(x => x / 100), capacity: parseList(B.capacity).map(Math.round), tiersOnly,
    splitCol: S.roles.split ? segIdx(S.roles.split) : -1, stageCol: S.roles.lifecycle ? segIdx(S.roles.lifecycle) : -1, pgCol: S.roles.product ? segIdx(S.roles.product) : -1 };
  let keepK = null;
  if (tiersOnly && B.mode === 'auto') { const kk = U.bpRes.ks.find(x => x.k === (B.k ?? U.bpRes.usedK) && x.cuts); cfg.mode = 'manual'; cfg.manual = kk ? kk.cuts.map(c => U.bpRes.edges[c] / 100) : []; keepK = kk ? kk.k : null; }
  const tok = (U.bpTok = (U.bpTok || 0) + 1);
  html($('#bp-status'), `<span class="computing"><span class="spinner"></span>${tiersOnly ? 'Recomputing tiers…' : `Searching breaks for k = 2…${B.kMax} with ${Bn} client resamples…`}</span>`);
  $('#bp-body').classList.add('dimmed');
  let r;
  try { r = await busy.wrap(() => eng({ type: 'breaks', cfg }), 'Searching for break points…'); }
  catch (e) { if (tok === U.bpTok) { $('#bp-body').classList.remove('dimmed'); html($('#bp-body'), callout('bad', `Break search failed: ${esc(e.message)}`)); } return; }
  if (tok !== U.bpTok || stale(v)) return;
  if (tiersOnly) r = { ...U.bpRes, confirm: r.confirm, fit: r.fit, bounds: r.bounds, kind: r.kind, usedK: B.mode === 'auto' ? keepK : null };
  U.bpRes = r;
  $('#bp-body').classList.remove('dimmed');
  html($('#bp-status'), `${r.B} client resamples for intervals · ${r.Bs} for stability · ${r.folds.length} rolling time windows · fit set: ${fmtInt(r.totalConvFit)} unique converters over ${fmtInt(r.fitDays)} days`);
  renderBreaks(r, fit, conf, v);
}
function tierRange(r, t) { const b = r.bounds, lo = t === 0 ? 0 : b[t - 1], hi = t < b.length ? b[t] : null; if (r.kind === 'rank') return hi === null ? `rank > ${fmtInt(lo)} per day` : `ranks ${fmtInt(lo + 1)}–${fmtInt(hi)} per day`; const p = x => +(x * 100).toFixed(2) + '%'; return `${p(lo)}–${hi === null ? '100%' : p(hi)}`; }
function renderBreaks(r, fit, conf, v) {
  const U = simState(), B = U.bp, host = $('#bp-body'), m = r.slices.length, c = C();
  const tiers = r.confirm.tiers, fitT = r.fit.tiers, rec = r.ks.find(k => k.k === r.recK), noBreaks = B.mode === 'auto' && !r.recK;
  html(host, `
    ${B.mode === 'auto' ? (noBreaks ? callout('warn', `<b>No natural breaks found; consider capacity-based tiers.</b> No k from 2 to ${B.kMax} gives breakpoints that are feasible under the constraints and stable in at least 70% of bootstrap and time-window re-searches.`)
      : callout('good', `Recommended: <b>k = ${r.recK}</b>, breaks at ${rec.stab.map(s => `top ${s.pct}%`).join(', ')} of the daily ranking (all breakpoints stable).${r.usedK !== r.recK ? ` Showing k = ${r.usedK} as selected.` : ''}`)) : ''}
    <div class="grid g2" style="margin-top:20px">
      ${card('Conversion rate per slice of the daily ranking', '<div class="chart lg" id="bp-curve"></div>', { tipKey: 'bp_slice', sub: B.cumul ? 'Cumulative lift always falls down the list, which hides breaks.' : `Bars: rate inside each slice (fit set), 95% client-bootstrap intervals. Lines: tier rates.${B.mode === 'manual' ? ' Drag the dashed lines to move breakpoints.' : ''}`,
        actions: `<label class="inline small"><input type="checkbox" id="bp-cum" ${B.cumul ? 'checked' : ''}> cumulative lift</label><label class="inline small"><input type="checkbox" id="bp-logy" ${B.logy ? 'checked' : ''}> log scale</label>` })}
      ${card('Fit vs number of tiers', '<div class="chart lg" id="bp-elbow"></div>', { tipKey: 'bp_dev', sub: 'Lower deviance = tiers fit the slice rates better. Hollow markers: not stable; “infeasible” = no partition meets the constraints.' })}
    </div>
    ${B.mode === 'auto' ? card('Break search results (fit set)', '<div id="bp-ks"></div>', { tipKey: 'bp_stab' }) : ''}
    ${card(`Tier table · ${esc(conf.label)}`, '<div id="bp-tiers"></div><div class="chart-note" id="bp-sum"></div>', { sub: 'Tiers applied to the confirm dataset. Score cutoffs are the lowest score admitted to the tier each day.', actions: `<button class="btn sm" id="bp-exp-json">${ICON.download} Tier config (JSON)</button><button class="btn sm" id="bp-exp-csv">${ICON.download} CSV</button>` })}
    <div class="card" style="margin-top:20px">${disc(`Tier profile · ${esc(conf.label)}`, '<div id="bp-profile"></div>', { cls: 'line' })}${disc('Slice table (fit set)', '<div id="bp-slices"></div>', { cls: 'line' })}</div>`);
  const x = r.slices.map((_, i) => i);
  const pos = p => { const e = r.edges; let k = 0; while (k < m - 1 && e[k + 1] < p * 100 - 1e-9) k++; return k - 0.5 + (p * 100 - e[k]) / (e[k + 1] - e[k]); };
  const tierCols = [c.s1, c.s2, c.s3, c.s4, c.s5, c.s1, c.s2, c.s3];
  const drawCurve = () => {
    const el = $('#bp-curve');
    if (B.cumul) { plot(el, [{ x, y: r.slices.map(s => s.cumLift), mode: 'lines+markers', line: { color: c.s1, width: 2 }, marker: { size: 5 }, customdata: r.slices.map(s => `${s.from}–${s.to}%`), hovertemplate: 'top %{customdata}: cumulative lift %{y:.2f}×<extra></extra>' }],
      { xaxis: { tickvals: x.filter(i => i % 3 === 0), ticktext: x.filter(i => i % 3 === 0).map(i => 'top ' + r.slices[i].to + '%'), title: { text: 'Daily ranking' } }, yaxis: { title: { text: 'Cumulative lift' }, type: B.logy ? 'log' : 'linear' }, showlegend: false }); return; }
    const traces = [{ x, y: r.slices.map(s => s.rate), type: 'bar', name: 'Slice rate', marker: { color: rgba(c.s1, 0.55) },
      error_y: { type: 'data', symmetric: false, array: r.slices.map(s => (fin(s.hi) ? s.hi - s.rate : 0)), arrayminus: r.slices.map(s => (fin(s.lo) ? s.rate - s.lo : 0)), color: c.text3, thickness: 1, width: 2 },
      customdata: r.slices.map(s => [`${s.from}–${s.to}%`, s.uniq, s.perDay, s.lo, s.hi, s.lift]), hovertemplate: 'slice %{customdata[0]}<br>rate %{y:.2%} [%{customdata[3]:.2%}–%{customdata[4]:.2%}]<br>lift %{customdata[5]:.1f}×<br>unique converters %{customdata[1]:,}<br>clients/day %{customdata[2]:,.1f}<extra></extra>' }];
    const bnd = r.kind === 'pct' ? r.bounds : [], edgesX = [-0.5, ...bnd.map(pos), m - 0.5];
    if (r.kind === 'pct') fitT.forEach((t, i) => traces.push({ x: [edgesX[i], edgesX[i + 1]], y: [t.rate, t.rate], mode: 'lines', name: `Tier ${i + 1}`, showlegend: false, line: { color: tierCols[(i + 1) % tierCols.length], width: 3 }, hovertemplate: `Tier ${i + 1}: %{y:.2%}<extra></extra>` }));
    traces.push({ x: [-0.5, m - 0.5], y: [r.rateFit, r.rateFit], mode: 'lines', name: `Overall ${fmtPct(r.rateFit)}`, line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' });
    const shapes = bnd.map(b => ({ type: 'line', xref: 'x', yref: 'paper', x0: pos(b), x1: pos(b), y0: 0, y1: 1, line: { color: c.text, width: 2, dash: 'dash' }, editable: B.mode === 'manual' }));
    plot(el, traces, { shapes, bargap: 0.08, xaxis: { tickvals: x.filter(i => i % 2 === 0), ticktext: x.filter(i => i % 2 === 0).map(i => r.slices[i].to + '%'), tickangle: -45, title: { text: 'Daily ranking: slice upper edge (top X%)' } },
      yaxis: { title: { text: 'Conversion rate in slice' }, type: B.logy ? 'log' : 'linear', tickformat: '.2~%' }, legend: { x: 1, xanchor: 'right', y: 1.1 } }, B.mode === 'manual' ? { edits: { shapePosition: true } } : {});
    if (B.mode === 'manual' && !el.__bpDrag) {
      el.__bpDrag = true;
      el.on('plotly_relayout', ev => {
        if (U.bp.mode !== 'manual') return;
        const keys = Object.keys(ev).filter(k => /^shapes\[\d+\]\.x0$/.test(k)); if (!keys.length) return;
        const cur = U.bpRes.bounds.map(b => +(b * 100).toFixed(4));
        for (const k of keys) { const i = +k.match(/\d+/)[0], e = Math.min(m - 1, Math.max(1, Math.round(ev[k] + 0.5))); cur[i] = r.edges[e]; }
        U.bp.manual = [...new Set(cur)].sort((a, b) => a - b).join(', ');
        if ($('#bp-manual')) $('#bp-manual').value = U.bp.manual;
        runBreaks(v, true);
      });
    }
  };
  $('#bp-cum').onchange = e => { B.cumul = e.target.checked; drawCurve(); };
  $('#bp-logy').onchange = e => { B.logy = e.target.checked; drawCurve(); };
  drawCurve();
  const ks = r.ks || [];
  plot($('#bp-elbow'), [{ x: ks.map(k => k.k), y: ks.map(k => k.dev), mode: 'lines+markers', line: { color: c.s1, width: 2 }, marker: { size: ks.map(k => (k.k === r.usedK ? 13 : 9)), color: ks.map(k => (k.stable ? c.s1 : c.surface)), line: { color: c.s1, width: 2 } },
    customdata: ks.map(k => [k.cuts ? k.cuts.map(cc => r.edges[cc] + '%').join(', ') : 'infeasible', k.stable ? 'stable' : k.k === 1 ? '—' : 'not stable']), hovertemplate: 'k = %{x}<br>deviance %{y:,.1f}<br>breaks: %{customdata[0]}<br>%{customdata[1]}<extra></extra>' }],
    { xaxis: { title: { text: 'Number of tiers (k)' }, dtick: 1 }, yaxis: { title: { text: 'Binomial deviance' } }, showlegend: false, annotations: ks.filter(k => !k.feasible).map(k => ({ x: k.k, y: 0, yref: 'paper', text: 'infeasible', showarrow: false, font: { size: 10, color: c.text3 }, yanchor: 'bottom' })) });
  if (B.mode === 'auto') {
    const kh = $('#bp-ks');
    html(kh, `<div class="tbl-wrap"><table class="data"><thead><tr><th class="nosort">Show</th><th class="num nosort">k</th><th class="num nosort">Deviance</th><th class="nosort">Breakpoints (top X% of daily ranking)</th><th class="nosort">Bootstrap: same edge</th><th class="nosort">±1 slice</th><th class="nosort">Time windows ${tip('bp_fold')}</th><th class="nosort">Verdict</th></tr></thead><tbody>
      ${ks.filter(k => k.k > 1).map(k => `<tr><td><input type="radio" name="bp-k" value="${k.k}" ${k.k === r.usedK ? 'checked' : ''} ${k.feasible ? '' : 'disabled'} aria-label="Show k = ${k.k}"></td><td class="num">${k.k}</td><td class="num">${fmtNum(k.dev, 1)}</td>
        <td>${k.cuts ? k.stab.map(s => `${s.pct}%`).join(', ') : '<span class="dim">no partition meets the constraints</span>'}</td><td>${k.stab ? k.stab.map(s => fmtPct(s.boot, 0)).join(' · ') : '—'}</td><td class="dim">${k.stab ? k.stab.map(s => fmtPct(s.boot1, 0)).join(' · ') : '—'}</td>
        <td>${k.stab ? k.stab.map(s => (s.fold === null ? 'n/a' : fmtPct(s.fold, 0))).join(' · ') : '—'}</td><td>${!k.feasible ? '<span class="dim">infeasible</span>' : k.stable ? flag('Stable', 'good') : flag('Not stable')}</td></tr>`).join('')}</tbody></table></div>
      <div class="tbl-foot"><span>Stable = every breakpoint reappears at the same slice edge in ≥ 70% of bootstrap re-searches and ≥ 70% of rolling time windows. ${r.folds.length ? `Windows: ${r.folds.map(f => `${f.from}→${f.to} (${fmtInt(f.conv)} conv.)`).join('; ')}.` : 'Too few dates for rolling windows (need ≥ 8).'}</span></div>`);
    $$('input[name=bp-k]', kh).forEach(rb => rb.onchange = () => { B.k = +rb.value; runBreaks(v, true); });
  }
  const hasCal = S.hasProb;
  const fmtCut = (a, lo, hi) => (fin(a) ? `${fmtScore(a)} <span class="ci-inline">${fmtScore(lo)}–${fmtScore(hi)}</span>` : '—');
  html($('#bp-tiers'), `<div class="tbl-wrap"><table class="data"><thead><tr><th class="nosort">Label</th><th class="nosort">Daily ranking range</th><th class="num nosort">Score cutoff ${tip('bp_cut')}</th>${hasCal ? '<th class="num nosort">Probability cutoff</th>' : ''}<th class="num nosort">Clients/day ${tip('bp_perday')}</th>
    <th class="num nosort">Rate [95% CI]</th><th class="num nosort">Lift</th><th class="num nosort">Unique converters ${tip('bp_uniq')}</th><th class="num nosort">Best-tier converters ${tip('bp_best')}</th><th class="num nosort">Share</th><th class="num nosort">Cumulative</th><th class="num nosort">Fit-set rate</th><th class="nosort">Intervention hypothesis</th></tr></thead><tbody>
    ${tiers.map((t, i) => `<tr><td><input type="text" class="bp-label" data-t="${i}" value="${esc(B.labels[i] ?? `Tier ${i + 1}`)}" style="width:120px" aria-label="Tier label"></td><td>${esc(tierRange(r, i))}</td><td class="num">${fmtCut(t.rawMean, t.rawP5, t.rawP95)}</td>${hasCal ? `<td class="num">${fmtCut(t.calMean, t.calP5, t.calP95)}</td>` : ''}
      <td class="num">${fmtNum(t.perDayAvg, 1)} <span class="ci-inline">${fmtInt(t.perDayP5)}–${fmtInt(t.perDayP95)}</span></td><td class="num">${fmtPct(t.rate)} ${fmtCI(t.lo, t.hi, fmtPct)}</td><td class="num">${fmtX(t.lift, 1)}</td>
      <td class="num">${fmtInt(t.uniq)}${t.uniq < 30 ? ' ' + flag('low') : ''}</td><td class="num">${fmtInt(t.best)}</td><td class="num">${fmtPct(t.share)}</td><td class="num">${fmtPct(t.cumShare)}</td><td class="num">${fmtPct(fitT[i]?.rate)}</td>
      <td><input type="text" class="bp-hyp" data-t="${i}" value="${esc(B.hyps[i] ?? '')}" placeholder="what you plan to test" style="width:220px" aria-label="Intervention hypothesis"></td></tr>`).join('')}</tbody></table></div>`);
  $$('.bp-label', host).forEach(inp => inp.oninput = () => { B.labels[inp.dataset.t] = inp.value; inp.style.borderColor = /persuad/i.test(inp.value) ? 'var(--bad)' : ''; inp.title = /persuad/i.test(inp.value) ? 'These are likelihood tiers; they do not identify who is persuadable.' : ''; });
  $$('.bp-hyp', host).forEach(inp => inp.oninput = () => { B.hyps[inp.dataset.t] = inp.value; });
  const Cf = r.confirm;
  html($('#bp-sum'), `${Cf.sumBest === Cf.totalConv ? '✓' : '✗'} Converters summed across tiers (each counted once, in the best tier any of their rows reached): ${fmtInt(Cf.sumBest)} = ${fmtInt(Cf.totalConv)} unique converters. “Unique converters” per tier can add to more because one converter's rows may fall in several tiers.`);
  const prof = (title, key, labels, missing) => {
    if (missing) return `<p class="faint">${missing}</p>`;
    const cats = [...new Set(tiers.flatMap(t => Object.keys(t[key])))].sort((a, b) => a - b);
    return `<h4 style="margin:12px 0 8px">${title}</h4><div class="tbl-wrap"><table class="data"><thead><tr><th class="nosort">Tier</th>${cats.map(cc => `<th class="num nosort">${esc(labels(cc))}</th>`).join('')}</tr></thead><tbody>
      ${tiers.map((t, i) => `<tr><td>${esc(B.labels[i] ?? `Tier ${i + 1}`)}</td>${cats.map(cc => `<td class="num">${fmtPct(div(t[key][cc] || 0, t.rows))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const lab = role => { const s = S.roles[role] ? S.core.segs.find(x => x.name === S.roles[role]) : null; return s ? (cc => (cc < 0 ? '(missing)' : s.labels[cc])) : null; };
  html($('#bp-profile'), [
    prof('Lifecycle mix (share of tier rows)', 'stage', lab('lifecycle') || (x => x), S.roles.lifecycle ? null : 'Lifecycle mix unavailable: map a LIFECYCLE_STAGE column.'),
    prof('Product-group mix (share of tier rows)', 'pg', lab('product') || (x => x), S.roles.product ? null : 'Product-group mix unavailable: map a PRODUCT_GROUP column.'),
    prof('Overlap with the current strategy (share of tier rows)', 'rules', cc => ({ '-1': '(missing)', 0: 'not targeted', 1: 'targeted today' })[cc], S.roles.current ? null : 'Overlap unavailable: map a CURRENT_STRATEGY_FLAG column.'),
  ].join(''));
  renderTable($('#bp-slices'), { rows: r.slices.map(s => ({ ...s, slice: `${s.from}–${s.to}%` })), exportName: 'break_points_slices', sort: { key: 'k', dir: 1 }, maxRows: 100,
    columns: [{ key: 'slice', label: 'Slice' }, { key: 'rows', label: 'Rows', num: true, fmt: fmtInt }, { key: 'perDay', label: 'Clients/day', num: true, fmt: x => fmtNum(x, 1) }, { key: 'pos', label: 'Converter rows', num: true, fmt: fmtInt },
      { key: 'uniq', label: 'Unique converters', num: true, fmt: fmtInt }, { key: 'rate', label: 'Rate', num: true, fmt: (x, rw) => `${fmtPct(x)} ${fmtCI(rw.lo, rw.hi, fmtPct)}` }, { key: 'lift', label: 'Lift', num: true, fmt: x => fmtX(x, 1) }, { key: 'cumLift', label: 'Cumulative lift', num: true, fmt: x => fmtX(x, 2) }] });
  const cfgRows = () => tiers.map((t, i) => ({ tier: i + 1, label: B.labels[i] ?? `Tier ${i + 1}`, intervention_hypothesis: B.hyps[i] ?? '', boundary_kind: r.kind === 'rank' ? 'clients_per_day_rank' : 'daily_percentile',
    from: i === 0 ? 0 : r.kind === 'rank' ? r.bounds[i - 1] : r.bounds[i - 1] * 100, to: i < r.bounds.length ? (r.kind === 'rank' ? r.bounds[i] : r.bounds[i] * 100) : r.kind === 'rank' ? null : 100,
    score_cutoff_mean: t.rawMean, score_cutoff_p5: t.rawP5, score_cutoff_p95: t.rawP95, probability_cutoff_mean: t.calMean, clients_per_day_avg: t.perDayAvg, rate: t.rate, rate_ci_low: t.lo, rate_ci_high: t.hi, lift: t.lift,
    unique_converters: t.uniq, converters_best_tier: t.best, share_of_converters: t.share, cumulative_share: t.cumShare, fit_set_rate: fitT[i]?.rate ?? null, rows: t.rows }));
  $('#bp-exp-csv').onclick = () => download('tier_config.csv', toCSV(cfgRows()));
  $('#bp-exp-json').onclick = () => download('tier_config.json', JSON.stringify({ generated_at: new Date().toISOString(), file: S.file.name, demo_data: S.isDemo, tier_type: 'likelihood (not persuadability)', evaluation: settingsSnapshot(),
    ranking: 'daily percentile rank by PREDICTED_SCORE (ties: fixed hash of client and date), within each date', fit_dataset: fit.label, confirm_dataset: conf.label, mode: B.mode, k: r.usedK, recommended_k: r.recK,
    constraints: { min_unique_converters: B.minConv, min_adjacent_rate_ratio: B.minRatio, non_overlapping_intervals: B.needCI }, bootstrap_resamples: r.B, purchase_dates: S.ep.source, tiers: cfgRows() }, null, 2), 'application/json');
}

/* ========================================================= CLASS ROSTERS (prototype's coach simulation) */
async function rosterView(body, v) {
  if (!S.roles.class_id) { html(body, empty('Needs a CLASS_ID column', 'Map CLASS_ID (and optionally COACH_ID) on the upload screen.')); return; }
  const hasCoach = !!S.roles.coach_id, W = evalWhere(), cls = qi(S.roles.class_id), coach = hasCoach ? qi(S.roles.coach_id) : null;
  html(body, computing('Ranking class rosters…'));
  const base = `WITH c AS (SELECT ${cls} AS class_id, date, client_id, MAX(score) AS s, MAX(y) AS y, MIN(__hb) AS hb ${hasCoach ? `, ANY_VALUE(${coach}) AS coach_id` : ''} FROM data WHERE ${W} AND ${cls} IS NOT NULL GROUP BY 1, 2, 3),
    r AS (SELECT *, row_number() OVER (PARTITION BY class_id, date ORDER BY s DESC, hb) AS rn FROM c),
    k AS (SELECT class_id, date ${hasCoach ? ', ANY_VALUE(coach_id) AS coach_id' : ''}, COUNT(*)::DOUBLE AS sz, SUM(y) AS cp, SUM(CASE WHEN rn <= 1 THEN y ELSE 0 END) AS t1, SUM(CASE WHEN rn <= 2 THEN y ELSE 0 END) AS t2, SUM(CASE WHEN rn <= 3 THEN y ELSE 0 END) AS t3 FROM r GROUP BY 1, 2)`;
  const agg = g => `${base} SELECT ${g} AS g, COUNT(*) AS classes, SUM(sz) AS clients, SUM(cp) AS conv, SUM(CASE WHEN cp > 0 THEN 1.0 ELSE 0 END) AS cls_with,
    ${[1, 2, 3].map(k => `SUM(LEAST(${k}, sz)) AS slots${k}, SUM(t${k}) AS tp${k}, SUM(LEAST(${k}, sz) * cp / sz) AS rtp${k}, SUM(CASE WHEN cp > 0 AND t${k} > 0 THEN 1.0 ELSE 0 END) AS hit${k},
      SUM(CASE WHEN cp > 0 THEN 1 - (GREATEST(sz - cp, 0) / sz) * (CASE WHEN LEAST(${k}, sz) >= 2 THEN GREATEST(sz - cp - 1, 0) / (sz - 1) ELSE 1 END) * (CASE WHEN LEAST(${k}, sz) >= 3 THEN GREATEST(sz - cp - 2, 0) / (sz - 2) ELSE 1 END) ELSE 0 END) AS rhit${k}`).join(',\n')}
    FROM k GROUP BY 1`;
  const all = await q1(agg("'all'")), coachRows = hasCoach ? await q(agg('coach_id')) : [];
  if (stale(v)) return;
  if (!all.classes) { html(body, empty('No rows with a class in the evaluation population')); return; }
  const kRows = [1, 2, 3].map(k => ({ k, prec: div(all['tp' + k], all['slots' + k]), rprec: div(all['rtp' + k], all['slots' + k]), hit: div(all['hit' + k], all.cls_with), rhit: div(all['rhit' + k], all.cls_with), shareAll: div(all['hit' + k], all.classes) }));
  kRows.forEach(r => r.lift = div(r.prec, r.rprec));
  html(body, `
    ${callout('info', 'A roster is one class on one date. If a coach can mention membership to k clients per class, does the model pick the right ones? “Random” is the expected value of picking k clients at random within each class (exact hypergeometric).')}
    <div class="tiles" style="margin-top:20px">${tile('Class rosters', fmtInt(all.classes), { sub: 'class × date' })}${tile('Avg. clients per roster', fmtNum(div(all.clients, all.classes), 1))}${tile('Rosters with ≥1 converter', fmtPct(div(all.cls_with, all.classes)), { sub: `${fmtInt(all.cls_with)} rosters` })}
      ${tile('Precision@1', fmtPct(kRows[0].prec), { tipKey: 'p_at_k', sub: `random ${fmtPct(kRows[0].rprec)}`, hl: true })}${tile('Hit rate@3', fmtPct(kRows[2].hit), { tipKey: 'hit_k', sub: `random ${fmtPct(kRows[2].rhit)}`, hl: true })}</div>
    <div class="grid g2" style="margin-top:20px">${card('Precision@k and hit rate', '<div id="c-tbl"></div>')}${card('Model vs random pick within the class', '<div class="chart" id="c-chart"></div>')}</div>
    ${hasCoach ? card('By coach', '<div id="c-coach"></div>') : card('By coach', empty('Needs a COACH_ID column'))}`);
  renderTable($('#c-tbl'), { rows: kRows, exportName: 'class_roster_k', sort: { key: 'k', dir: 1 }, columns: [{ key: 'k', label: 'k', num: true }, { key: 'prec', label: 'Precision@k', num: true, fmt: x => fmtPct(x), tip: 'p_at_k' }, { key: 'rprec', label: 'Random', num: true, fmt: x => fmtPct(x) }, { key: 'lift', label: 'Lift', num: true, fmt: x => fmtX(x, 1) }, { key: 'hit', label: 'Hit rate', num: true, fmt: x => fmtPct(x), tip: 'hit_k' }, { key: 'rhit', label: 'Random hit rate', num: true, fmt: x => fmtPct(x) }, { key: 'shareAll', label: 'Share of all rosters', num: true, fmt: x => fmtPct(x) }] });
  const c = C();
  plot($('#c-chart'), [{ x: kRows.map(r => 'k = ' + r.k), y: kRows.map(r => r.hit), type: 'bar', name: 'Model', marker: { color: c.s1 }, hovertemplate: '%{x}: %{y:.1%}<extra></extra>' }, { x: kRows.map(r => 'k = ' + r.k), y: kRows.map(r => r.rhit), type: 'bar', name: 'Random', marker: { color: c.base }, hovertemplate: '%{x}: %{y:.1%}<extra></extra>' }],
    { barmode: 'group', bargap: 0.35, bargroupgap: 0.08, yaxis: { tickformat: '.0%', title: { text: 'Rosters with a converter in the top k' }, range: [0, 1] } });
  if (hasCoach) {
    coachRows.forEach(cr => { cr.p1 = div(cr.tp1, cr.slots1); cr.p3 = div(cr.tp3, cr.slots3); cr.hit3r = div(cr.hit3, cr.cls_with); cr.rhit3r = div(cr.rhit3, cr.cls_with); });
    renderTable($('#c-coach'), { rows: coachRows, exportName: 'class_roster_by_coach', sort: { key: 'classes', dir: -1 }, columns: [{ key: 'g', label: 'Coach' }, { key: 'classes', label: 'Rosters', num: true, fmt: fmtInt }, { key: 'clients', label: 'Client slots', num: true, fmt: fmtInt }, { key: 'conv', label: 'Converters', num: true, fmt: fmtInt }, { key: 'p1', label: 'Precision@1', num: true, fmt: x => fmtPct(x) }, { key: 'p3', label: 'Precision@3', num: true, fmt: x => fmtPct(x) }, { key: 'hit3r', label: 'Hit rate@3', num: true, fmt: x => fmtPct(x) }, { key: 'rhit3r', label: 'Random hit@3', num: true, fmt: x => fmtPct(x) }] });
  }
}
