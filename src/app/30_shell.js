/* ==========================================================================
   30 · APP SHELL: navigation, global settings, context bar, routing
   ========================================================================== */
const FILTER_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 3.5h12M4.5 8h7M7 12.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const TABS = [
  { id: 'exec', label: 'Executive Report' },
  { id: 'perf', label: 'Model Performance' },
  { id: 'sim', label: 'Targeting Simulator' },
  { id: 'seg', label: 'Segment Diagnostics' },
  { id: 'valid', label: 'Data & Evaluation Validity' },
];
const RENDER = {};   // tab id -> async (el, v) renderer
let ACTIVE = 'exec';

function enterApp() {
  $('#onboard').classList.add('hidden');
  $('#app').classList.remove('hidden');
  html($('#tabs'), TABS.map(t => `<button class="tab-btn ${t.id === ACTIVE ? 'active' : ''}" data-tab="${t.id}" role="tab">${t.label}</button>`).join(''));
  renderContext();
  const h = parseHash(); go(h.tab || 'exec', h.section, true);
}
function parseHash() { const m = location.hash.match(/^#\/?([a-z]+)(?:\/([\w-]+))?/); return m ? { tab: TABS.some(t => t.id === m[1]) ? m[1] : null, section: m[2] || null } : {}; }
/** Navigate to a tab (and optionally a section anchor inside it). */
async function go(tab, section = null, force = false) {
  const changed = tab !== ACTIVE;
  ACTIVE = tab;
  $$('#tabs .tab-btn').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  const want = `#/${tab}${section ? '/' + section : ''}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  if (section) S.ui.scrollTo = section;
  await renderActive(force || changed);
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}
async function renderActive(force = false) {
  const tab = ACTIVE, el = $('#page');
  if (!force && S.rendered[tab] === S.ver) { scrollToSection(); return; }
  S.rendered[tab] = S.ver;
  const v = S.ver;
  html(el, `<div class="page" id="page-${tab}"></div>`);
  const host = $('#page-' + tab);
  if (!S.pop || !S.pop.n) {
    html(host, `<div class="page-head"><div class="titles"><h1>${TABS.find(t => t.id === tab).label}</h1></div></div>${empty('No records in the evaluation population', 'The current evaluation settings (date window, split, label maturity, feature filters or a saved cohort) exclude every row. Open <b>Evaluation settings</b> or <b>Filters</b> to widen them.')}`);
    if (tab === 'valid') { await RENDER.valid(host, v); }
    return;
  }
  try { await RENDER[tab](host, v); }
  catch (e) { console.error(e); if (!stale(v)) host.insertAdjacentHTML('beforeend', callout('bad', `Something went wrong while rendering this page: ${esc(e.message || e)}. The rest of the app is unaffected; try changing a setting or reloading the file.`)); }
  syncSegs(host);
  scrollToSection();
}
function scrollToSection() {
  const id = S.ui.scrollTo; if (!id) return;
  const el = document.getElementById(id);
  if (el) { S.ui.scrollTo = null; if (el.tagName === 'DETAILS') el.open = true; setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (b && b.closest('#tabs')) { go(b.dataset.tab); return; }
  const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); const [t, s] = a.dataset.go.split('/'); go(t, s || null); }
});
window.addEventListener('hashchange', () => { const h = parseHash(); if (h.tab && (h.tab !== ACTIVE || h.section)) go(h.tab, h.section); });
const goLink = (target, text) => `<a href="#/${target}" data-go="${target}">${text}</a>`;

/* ---------------------------------------------------------- context bar */
const grainLabel = g => ({ row: 'Client-date rows', client: 'Unique clients', episode: 'Client episodes' }[g]);
const granLabel = g => ({ overall: 'Overall', day: 'Daily', week: 'Weekly', month: 'Monthly' }[g]);
function renderContext() {
  const st = S.settings, info = S.info, pop = S.pop || {};
  const chips = [];
  const nf = (S.filters || []).length;
  chips.push(fileChipHTML());
  chips.push(`<button class="ctx-chip filter-btn ${nf ? 'accent' : ''}" id="ctx-filters" data-tip="Filter every tab by feature values (segments and numeric ranges).">${FILTER_ICON}Filters${nf ? ` <b>${nf}</b>` : ''}</button>`);
  if (S.isDemo) chips.push(`<span class="ctx-chip demo" data-tip="Synthetic rows generated in the browser for demonstration. Not real clients.">DEMO DATA</span>`);
  chips.push(`<span class="ctx-chip" data-tip="Evaluation window (prediction dates, calendar days as given in DATE_T; no timezone conversion).">Window <b>${st.d0} → ${st.d1}</b></span>`);
  if (S.roles.split) chips.push(`<span class="ctx-chip ${st.split === null ? 'warn' : ''}" data-tip="Rows are filtered to this split value. Evaluate on an untouched test split.">Split <b>${st.split === null ? 'all values' : esc(st.split)}</b></span>`);
  if (S.roles.version) chips.push(`<span class="ctx-chip ${st.version === null && S.versions.length > 1 ? 'warn' : ''}">Model <b>${st.version === null ? (S.versions.length > 1 ? 'mixed versions' : esc(S.versions[0]?.v ?? '—')) : esc(st.version)}</b></span>`);
  chips.push(st.labelsThrough
    ? `<span class="ctx-chip" data-tip="Only rows whose ${st.horizon}-day outcome window closes on or before the labels-observed date are evaluated.">Mature labels through <b>${st.labelsThrough}</b></span>`
    : `<span class="ctx-chip warn" data-tip="Label maturity is not assessed: set the date through which outcomes were observed in Evaluation settings.">Label maturity <b>not assessed</b></span>`);
  chips.push(`<span class="ctx-chip" data-tip="Records in the evaluation population (client-date rows) and distinct clients.">Population <b>${fmtInt(pop.n)}</b> rows · <b>${fmtInt(pop.clients)}</b> clients · <b>${fmtInt(pop.pos)}</b> positive rows</span>`);
  if (S.hasProb) chips.push(`<span class="ctx-chip accent" data-tip="Calibration analysis uses ${S.roles.prob ? 'PREDICTED_PROBABILITY (' + esc(S.roles.prob) + ')' : 'PREDICTED_SCORE, declared a calibrated probability at upload'}.">Probabilities <b>${S.roles.prob ? 'mapped' : 'declared'}</b></span>`);
  else chips.push(`<span class="ctx-chip" data-tip="No valid probabilities: ranking metrics only; calibration is not computed.">Ranking scores only</span>`);
  (S.filters || []).forEach((f, i) => chips.push(`<span class="ctx-chip accent filter-chip" data-edit-filter="${esc(f.col)}" data-tip="Feature filter applied to every tab. Click to edit.">${esc(filterText(f))}<button data-rm-filter="${i}" aria-label="Remove filter">×</button></span>`));
  for (const c of S.cohorts) chips.push(`<span class="ctx-chip accent" data-tip="${esc('Cohort filter: ' + c.text)}">Cohort <b>${esc(c.name)}</b><button data-rm-cohort="${c.id}" aria-label="Remove cohort">×</button></span>`);
  html($('#context'), chips.join(''));
  $$('[data-rm-cohort]').forEach(b => b.onclick = async () => { S.cohorts = S.cohorts.filter(c => String(c.id) !== b.dataset.rmCohort); await applySettings(); });
  $('#ctx-filters').onclick = () => openFilters();
  const fc = $('#ctx-file'); if (fc) fc.onclick = () => ($('#file-menu') ? closeFileMenu() : openFileMenu());
  $$('[data-rm-filter]').forEach(b => b.onclick = async e => { e.stopPropagation(); S.filters.splice(+b.dataset.rmFilter, 1); await busy.wrap(() => applySettings(), 'Removing filter…'); });
  $$('[data-edit-filter]').forEach(c => c.onclick = () => openFilters(c.dataset.editFilter));
}

/* -------------------------------------------------------- settings sheet */
function openSettings() {
  const st = S.settings, i = S.info.st;
  const body = `
    <h4>Evaluation window</h4>
    <div class="form-grid" style="margin:8px 0 6px">
      <label class="field"><span class="lab">From</span><input type="date" id="set-d0" min="${i.dmin}" max="${i.dmax}" value="${st.d0}"></label>
      <label class="field"><span class="lab">To</span><input type="date" id="set-d1" min="${i.dmin}" max="${i.dmax}" value="${st.d1}"></label>
    </div>
    <p class="faint">Grouping uses the calendar date in DATE_T exactly as provided (no timezone conversion). Weeks start on Monday (ISO); months are calendar months.</p>
    ${S.roles.split ? `<h4 style="margin-top:20px">Split</h4><label class="field" style="margin-top:8px"><select id="set-split"><option value="">All values</option>${S.splitValues.map(v => `<option ${st.split === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <p class="faint" style="margin-top:6px">Evaluate on an untouched temporal test split. Including training or validation rows inflates every metric.</p>` : ''}
    ${S.roles.version ? `<h4 style="margin-top:20px">Model version</h4><label class="field" style="margin-top:8px"><select id="set-ver"><option value="">All versions${S.versions.length > 1 ? ' (mixed — not recommended)' : ''}</option>${S.versions.map(v => `<option value="${esc(v.v)}" ${st.version === v.v ? 'selected' : ''}>${esc(v.v)} (${fmtInt(v.n)} rows)</option>`).join('')}</select></label>` : ''}
    <h4 style="margin-top:20px">Outcome and label maturity</h4>
    <div class="form-grid" style="margin:8px 0 6px">
      <label class="field"><span class="lab">Outcome horizon (days)</span><input type="number" id="set-h" min="1" max="120" step="1" value="${st.horizon}"></label>
      <label class="field"><span class="lab">Labels observed through</span><input type="date" id="set-lt" value="${st.labelsThrough || ''}"></label>
    </div>
    <p class="faint">CONVERSION_TARGET should mean “converted within ${st.horizon} days after DATE_T”. A row's label is mature only when its outcome window has closed, i.e. DATE_T + horizon ≤ the date through which purchases were observed (usually the extract date). Leave empty if unknown: maturity is then reported as <b>not assessed</b> and nothing is excluded.</p>
    <h4 style="margin-top:20px">Reliability flags</h4>
    <div class="form-grid" style="margin:8px 0 6px">
      <label class="field"><span class="lab">Minimum positives per period</span><input type="number" id="set-minpos" min="1" step="1" value="${st.minPos}"></label>
    </div>
    <p class="faint">Periods with fewer positives are still computed but flagged as low-confidence.</p>
    <h4 style="margin-top:20px">Appearance</h4>
    <div style="margin-top:8px">${segHTML('theme', [{ v: 'system', label: 'System' }, { v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }], currentTheme())}</div>`;
  const sh = openSheet('Evaluation settings', body, {
    applyLabel: 'Apply to all tabs',
    onApply: async el => {
      let d0 = $('#set-d0', el).value || i.dmin, d1 = $('#set-d1', el).value || i.dmax; if (d0 > d1) [d0, d1] = [d1, d0];
      const ns = { ...st, d0, d1, horizon: clamp(Math.round(+$('#set-h', el).value || 14), 1, 120), labelsThrough: $('#set-lt', el).value || null, minPos: Math.max(1, Math.round(+$('#set-minpos', el).value || 20)) };
      if ($('#set-split', el)) ns.split = $('#set-split', el).value || null;
      if ($('#set-ver', el)) ns.version = $('#set-ver', el).value || null;
      S.settings = ns;
      await busy.wrap(() => applySettings(), 'Rebuilding the evaluation population…');
      toast('Evaluation settings applied to every tab.');
    },
  });
  bindSeg(sh.el, 'theme', setTheme);
}
function currentTheme() { try { return localStorage.getItem('cml-theme') || 'system'; } catch (_) { return 'system'; } }
function setTheme(t) {
  try { localStorage.setItem('cml-theme', t); } catch (_) { /* storage unavailable */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  S.rendered = {}; renderActive(true);
}
(() => { const t = currentTheme(); if (t !== 'system') document.documentElement.setAttribute('data-theme', t); })();
darkQuery.addEventListener('change', () => { if (currentTheme() === 'system' && S.pop) { S.rendered = {}; renderActive(true); } });

/** Save a population filter (from the error tree) as a global cohort. */
async function applyCohort(name, sql, text) {
  const r = await q1(`SELECT COUNT(*) AS n FROM data WHERE ${evalWhere()} AND (${sql})`);
  if (!r.n) { toast(`Cohort “${name}” matches no rows in the current population, so it was not applied.`); return false; }
  S.cohorts.push({ id: Date.now(), name, sql, text });
  await busy.wrap(() => applySettings(), 'Applying cohort…');
  toast(`Cohort “${name}” applied to every tab. Remove it from the bar at the top.`);
  return true;
}

/* ------------------------------------------------- page-level building blocks */
const pageHead = (eyebrow, title, lede, right = '') => `<div class="page-head"><div class="titles"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div>${right}</div>`;
const sectionTitle = (title, id, right = '') => `<div class="section-title" ${id ? `id="${id}"` : ''}><h2>${title}</h2>${right}</div>`;
