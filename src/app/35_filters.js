/* ==========================================================================
   35 · GLOBAL FEATURE FILTERS
   Hidden behind the “Filters” button until needed. Applied filters become part
   of the evaluation population (evalWhere), so every tab uses the same slice.
   Each filter tests a client-date row's own value.
   ========================================================================== */
S.filters = [];

const featMeta = name => S.disc.features.find(f => f.name === name);
/** SQL predicate for one filter. Numeric ranges are inclusive; rows without a value never pass a numeric filter. */
function filterSQL(f) {
  if (f.kind === 'num') {
    const p = [];
    if (fin(f.min)) p.push(`TRY_CAST(${qi(f.col)} AS DOUBLE) >= ${f.min}`);
    if (fin(f.max)) p.push(`TRY_CAST(${qi(f.col)} AS DOUBLE) <= ${f.max}`);
    return p.length ? `(${p.join(' AND ')})` : 'TRUE';
  }
  const v = `COALESCE(CAST(${qi(f.col)} AS VARCHAR), '(missing)')`;
  return `${v} ${f.exclude ? 'NOT IN' : 'IN'} (${f.vals.map(ql).join(', ')})`;
}
function filterText(f) {
  if (f.kind === 'num') return fin(f.min) && fin(f.max) ? `${f.col} ${fmtT(f.min)} – ${fmtT(f.max)}` : fin(f.min) ? `${f.col} ≥ ${fmtT(f.min)}` : `${f.col} ≤ ${fmtT(f.max)}`;
  const shown = f.vals.slice(0, 2).join(', ') + (f.vals.length > 2 ? ` +${f.vals.length - 2}` : '');
  return `${f.col} ${f.exclude ? 'not ' : ''}${shown}`;
}
const filterValid = f => (f.kind === 'num' ? fin(f.min) || fin(f.max) : f.vals && f.vals.length > 0);
/** Evaluation population without the feature filters (used for value counts inside the filter editor). */
function evalWhereBase() {
  const saved = S.filters; S.filters = [];
  try { return evalWhere(); } finally { S.filters = saved; }
}

async function catValueCounts(col) {
  const key = `${S.ver}|fv|${col}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = q(`SELECT COALESCE(CAST(${qi(col)} AS VARCHAR), '(missing)') AS v, COUNT(*) AS n FROM data WHERE ${evalWhereBase()} GROUP BY 1 ORDER BY n DESC LIMIT 200`);
  S.cache.set(key, p); return p;
}
async function numSummary(col) {
  const key = `${S.ver}|fs|${col}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const x = `TRY_CAST(${qi(col)} AS DOUBLE)`;
  const p = q1(`SELECT MIN(${x}) AS mn, MAX(${x}) AS mx, quantile_cont(${x}, [0.1, 0.25, 0.5, 0.75, 0.9]) AS qs, COUNT(*) - COUNT(${x}) AS missing, COUNT(*) AS n FROM data WHERE ${evalWhereBase()}`);
  S.cache.set(key, p); return p;
}

function openFilters(focusCol = null) {
  const drafts = S.filters.map(f => ({ ...f, vals: f.vals ? f.vals.slice() : undefined }));
  const feats = S.disc.features;
  const groups = [
    ['Segments', feats.filter(f => S.disc.segments.some(s => s.name === f.name))],
    ['Numeric features', feats.filter(f => f.numeric && f.kind === 'num')],
    ['Other categorical features', feats.filter(f => !S.disc.segments.some(s => s.name === f.name) && !(f.numeric && f.kind === 'num'))],
  ].filter(g => g[1].length);
  const body = `
    <div class="filter-live" id="flt-live"><span class="computing"><span class="spinner"></span>Counting…</span></div>
    <p class="muted small" style="margin:14px 0 18px">Narrow every tab to clients that match these conditions. Each condition tests a client-date row's own value, so a client can be in the population on some dates and not others. With the unique-client grain, the index record is the client's first row that passes the filters.</p>
    <div class="flt-section-head"><h4>Active filters</h4><button class="link-btn small" id="flt-clear">Clear all</button></div>
    <div id="flt-active"></div>
    <h4 style="margin:22px 0 10px">Add a filter</h4>
    <input type="search" id="flt-search" placeholder="Search ${fmtInt(feats.length)} features…" style="width:100%" aria-label="Search features">
    <div id="flt-list" class="feat-pick"></div>`;
  const sh = openSheet('Feature filters', body, {
    applyLabel: 'Apply to all tabs', wide: true,
    onApply: async () => {
      S.filters = drafts.filter(filterValid).map(f => ({ ...f }));
      await busy.wrap(() => applySettings(), 'Applying filters…');
      toast(S.filters.length ? `${plural(S.filters.length, 'filter')} applied to every tab.` : 'Filters cleared.');
    },
  });
  const el = sh.el;
  const drawList = () => {
    const term = ($('#flt-search', el).value || '').trim().toLowerCase();
    const used = new Set(drafts.map(d => d.col));
    html($('#flt-list', el), groups.map(([title, list]) => {
      const m = list.filter(f => !used.has(f.name) && (!term || f.name.toLowerCase().includes(term)));
      if (!m.length) return '';
      const shown = term ? m : m.slice(0, 24);
      return `<div class="feat-group"><div class="faint" style="margin:10px 0 6px">${title} · ${m.length}</div><div class="feat-chips">${shown.map(f => `<button class="feat-chip" data-add="${esc(f.name)}">${esc(f.name)}<span class="ftype">${f.numeric && f.kind === 'num' ? 'range' : 'values'}</span></button>`).join('')}${shown.length < m.length ? `<span class="faint" style="align-self:center">+${m.length - shown.length} more — search to find them</span>` : ''}</div></div>`;
    }).join('') || '<div class="faint">No matching features.</div>');
  };
  const drawActive = async () => {
    const host = $('#flt-active', el);
    if (!drafts.length) { html(host, '<div class="empty" style="min-height:0;padding:20px">No filters. The analysis uses the full evaluation population.</div>'); return; }
    const cards = [];
    for (let i = 0; i < drafts.length; i++) {
      const f = drafts[i];
      if (f.kind === 'num') {
        const s = await numSummary(f.col);
        const qs = s.qs || [];
        cards.push(`<div class="filter-card" data-i="${i}"><div class="fc-head"><b>${esc(f.col)}</b><span class="ftype">range</span><span class="grow"></span><button class="icon-btn" data-rm="${i}" aria-label="Remove filter" style="width:28px;height:28px">${ICON.close}</button></div>
          <div class="form-row"><label class="inline small">From <input type="number" step="any" data-min="${i}" value="${fin(f.min) ? f.min : ''}" placeholder="${fmtT(s.mn)}"></label><label class="inline small">to <input type="number" step="any" data-max="${i}" value="${fin(f.max) ? f.max : ''}" placeholder="${fmtT(s.mx)}"></label></div>
          <div class="faint" style="margin-top:8px">Range ${fmtT(s.mn)} – ${fmtT(s.mx)} · median ${fmtT(qs[2])} · middle half ${fmtT(qs[1])} – ${fmtT(qs[3])}${s.missing ? ` · ${fmtInt(s.missing)} rows have no value and are excluded while this filter is on` : ''}</div></div>`);
      } else {
        const vals = await catValueCounts(f.col);
        const many = vals.length > 14;
        cards.push(`<div class="filter-card" data-i="${i}"><div class="fc-head"><b>${esc(f.col)}</b><span class="ftype">values</span><span class="grow"></span>
            ${segHTML('fmode' + i, [{ v: 'in', label: 'Keep' }, { v: 'out', label: 'Exclude' }], f.exclude ? 'out' : 'in')}
            <button class="icon-btn" data-rm="${i}" aria-label="Remove filter" style="width:28px;height:28px">${ICON.close}</button></div>
          ${many ? `<input type="search" data-vs="${i}" placeholder="Search ${fmtInt(vals.length)}${vals.length >= 200 ? '+' : ''} values…" style="width:100%;margin-bottom:8px">` : ''}
          <div class="form-row small" style="margin-bottom:6px"><button class="link-btn" data-all="${i}">Select all</button><button class="link-btn" data-none="${i}">None</button><span class="faint">${fmtInt(f.vals.length)} selected</span></div>
          <div class="pill-select fc-vals" data-vals="${i}">${vals.map(v => `<label data-v="${esc(String(v.v).toLowerCase())}"><input type="checkbox" value="${esc(v.v)}" ${f.vals.includes(String(v.v)) ? 'checked' : ''}> ${esc(v.v)} <span class="faint">${fmtCompact(v.n)}</span></label>`).join('')}</div></div>`);
      }
    }
    html(host, cards.join(''));
    drafts.forEach((f, i) => { if (f.kind === 'cat') bindSeg(host, 'fmode' + i, m => { f.exclude = m === 'out'; liveCount(); }); });
  };
  const liveCount = debounce(async () => {
    const valid = drafts.filter(filterValid);
    const cond = valid.length ? valid.map(filterSQL).join(' AND ') : 'TRUE';
    try {
      const r = await q1(`SELECT COUNT(*) AS N, COUNT(*) FILTER (WHERE ${cond}) AS n, COUNT(DISTINCT client_id) FILTER (WHERE ${cond}) AS c, COALESCE(SUM(y) FILTER (WHERE ${cond}), 0) AS p FROM data WHERE ${evalWhereBase()}`);
      html($('#flt-live', el), `<div><b>${fmtInt(r.n)}</b> rows · <b>${fmtInt(r.c)}</b> clients · <b>${fmtInt(r.p)}</b> positive rows ${valid.length ? 'match' : '(no filters)'}</div>
        ${r.n === 0 ? '<div style="color:var(--bad);margin-top:4px">No rows match — loosen a filter before applying.</div>' : r.p < 30 ? '<div style="color:var(--warn);margin-top:4px">Fewer than 30 positive rows: most metrics will be too noisy to interpret.</div>' : `<div class="faint" style="margin-top:2px">${valid.length ? `${fmtPct(div(r.n, r.N))} of the ${fmtInt(r.N)} rows in the evaluation window` : 'The full evaluation population'}</div>`}`);
    } catch (e) { html($('#flt-live', el), `<span style="color:var(--bad)">Could not count: ${esc(e.message)}</span>`); }
  }, 250);
  const addFilter = name => {
    const f = featMeta(name); if (!f) return;
    drafts.unshift(f.numeric && f.kind === 'num' ? { id: uid('f'), col: name, kind: 'num', min: null, max: null } : { id: uid('f'), col: name, kind: 'cat', vals: [], exclude: false });
    $('#flt-search', el).value = '';
    drawList(); drawActive().then(() => { const c = $('.filter-card', el); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    liveCount();
  };
  el.addEventListener('click', e => {
    const add = e.target.closest('[data-add]'); if (add) { addFilter(add.dataset.add); return; }
    const rm = e.target.closest('[data-rm]'); if (rm) { drafts.splice(+rm.dataset.rm, 1); drawList(); drawActive(); liveCount(); return; }
    const all = e.target.closest('[data-all]'), none = e.target.closest('[data-none]');
    if (all || none) {
      const i = +(all || none).dataset[all ? 'all' : 'none'], box = $(`[data-vals="${i}"]`, el);
      $$('label', box).forEach(l => { if (l.style.display !== 'none') $('input', l).checked = !!all; });
      drafts[i].vals = $$('input:checked', box).map(x => x.value);
      $(`[data-i="${i}"] .form-row .faint`, el).textContent = `${fmtInt(drafts[i].vals.length)} selected`; liveCount();
    }
    if (e.target.id === 'flt-clear') { drafts.splice(0); drawList(); drawActive(); liveCount(); }
  });
  el.addEventListener('change', e => {
    const box = e.target.closest('[data-vals]');
    if (box) { const i = +box.dataset.vals; drafts[i].vals = $$('input:checked', box).map(x => x.value); $(`[data-i="${i}"] .form-row .faint`, el).textContent = `${fmtInt(drafts[i].vals.length)} selected`; liveCount(); }
  });
  el.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'flt-search') drawList();
    if (t.dataset.vs !== undefined) { const term = t.value.trim().toLowerCase(); $$(`[data-vals="${t.dataset.vs}"] label`, el).forEach(l => { l.style.display = !term || l.dataset.v.includes(term) ? '' : 'none'; }); }
    if (t.dataset.min !== undefined) { drafts[+t.dataset.min].min = t.value === '' ? null : +t.value; liveCount(); }
    if (t.dataset.max !== undefined) { drafts[+t.dataset.max].max = t.value === '' ? null : +t.value; liveCount(); }
  });
  drawList();
  drawActive().then(() => { if (focusCol) { const i = drafts.findIndex(d => d.col === focusCol); const c = $(`[data-i="${i}"]`, el); if (c) c.scrollIntoView({ block: 'nearest' }); } });
  liveCount();
}
