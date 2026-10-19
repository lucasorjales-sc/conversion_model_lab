/* ==========================================================================
   00 · UTILITIES, GLOSSARY AND UI COMPONENTS
   ========================================================================== */
// null-tolerant: an async render that finishes after the user navigated away finds nothing instead of throwing
const $ = (sel, root = document) => (root ? root.querySelector(sel) : null);
const $$ = (sel, root = document) => (root ? [...root.querySelectorAll(sel)] : []);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qi = c => '"' + String(c).replace(/"/g, '""') + '"';      // SQL identifier
const ql = v => "'" + String(v).replace(/'/g, "''") + "'";       // SQL string literal
const fin = x => x !== null && x !== undefined && typeof x === 'number' && Number.isFinite(x);
const div = (a, b) => (fin(a) && fin(b) && b !== 0 ? a / b : null);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const html = (el, s) => { if (el) el.innerHTML = s; return el; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = (() => { let i = 0; return p => (p || 'u') + (++i); })();

/* ---------- number formatting ---------- */
const fmtInt = x => (fin(x) ? Math.round(x).toLocaleString('en-US') : '—');
const fmtPct = (x, d) => {
  if (!fin(x)) return '—';
  if (d === undefined) d = Math.abs(x) >= 0.1 ? 1 : Math.abs(x) >= 0.01 ? 1 : Math.abs(x) >= 0.001 ? 2 : 3;
  return (x * 100).toFixed(d) + '%';
};
const fmtX = (x, d = 2) => (fin(x) ? x.toFixed(d) + '×' : '—');
const fmtNum = (x, d = 3) => (fin(x) ? (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : (+x).toFixed(d)) : '—');
const fmtScore = x => (fin(x) ? (x === 0 ? '0' : Math.abs(x) < 0.001 ? x.toExponential(2) : x.toFixed(4)) : '—');
const fmtCompact = x => { if (!fin(x)) return '—'; const a = Math.abs(x); return a >= 1e6 ? (x / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e4 ? (x / 1e3).toFixed(0) + 'K' : a >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : fmtInt(x); };
const fmtMoney = x => (fin(x) ? (x < 0 ? '−$' : '$') + Math.abs(Math.round(x)).toLocaleString('en-US') : '—');
const fmtCI = (lo, hi, f) => (fin(lo) && fin(hi) ? `<span class="ci-inline">${f(lo)} – ${f(hi)}</span>` : '');
const fmtDays = n => `${fmtInt(n)} day${n === 1 ? '' : 's'}`;
const plural = (n, w, pl) => `${fmtInt(n)} ${n === 1 ? w : (pl || w + 's')}`;

/* ---------- icons ---------- */
const ICON = {
  chev: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4v12m0 0l-4.5-4.5M12 16l4.5-4.5M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 11V8a4 4 0 118 0v3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  mark: '<svg viewBox="0 0 16 16"><path d="M2 12l3.5-4 3 2.5L14 4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

/* ---------- glossary (one sentence per term; shown as tooltips) ---------- */
const TIPS = {
  grain_row: 'Every eligible client-date row is a separate record. A converter appears on several days, so this counts client-days, not people.',
  grain_client: 'One index record per client: the client\'s first eligible prediction date in the window (or period). Its label is the outcome within the horizon after that date. Never the max score.',
  grain_episode: 'One index record per client eligibility episode: the first eligible date, then the first date after each purchase if the client re-enters the population.',
  prevalence: 'Share of evaluation records with a positive outcome. A random ranking achieves this precision on average.',
  pr_auc: 'Average precision across all thresholds (step-wise, ties as one threshold). A random ranking scores the prevalence, so compare it with the prevalence.',
  roc_auc: 'Probability that a random positive record is scored above a random negative one (ties count half). 0.5 = random.',
  precision: 'True positives ÷ selected records: the share of the targeted audience with a positive outcome.',
  recall: 'True positives ÷ all positive records in the evaluation cohort: the share of conversions captured by the selection.',
  lift: 'Precision of the selected group ÷ prevalence of the eligible comparison population. 5× means five times the observed conversion rate — not five times more conversions caused by marketing.',
  topx: 'Top X%: the first ceil(X × N) records in score order. Tied scores are ordered by a fixed hash of client and date, so the audience size is exact and reproducible.',
  threshold: 'Fixed threshold: every record with score ≥ τ. The audience size is whatever the scores produce and can change from period to period.',
  pooled: 'Pooled: one calculation over every record in the window.',
  mean_period: 'Mean period performance: compute the metric inside each period, then take the unweighted mean of the periods where it is defined.',
  ci: '95% interval. Rates use a client-clustered variance (a client\'s repeated rows are not independent); pooled AUC/PR-AUC use a client-block bootstrap.',
  brier: 'Mean squared difference between predicted probability and the 0/1 outcome. Lower is better; compare with the reference (always predicting the prevalence).',
  logloss: 'Mean negative log-likelihood of the outcomes under the predicted probabilities. Lower is better.',
  cal_slope: 'Slope b in logit P(y) = a + b·logit(p). 1 = well-spread probabilities; below 1 = predictions too extreme; above 1 = too timid.',
  citl: 'Calibration-in-the-large: intercept a in logit P(y) = a + logit(p). 0 = average level right; negative = predictions too high on average.',
  ece: 'Expected calibration error: count-weighted mean |mean predicted − observed rate| across equal-count bins. Depends on the binning; use as a summary only.',
  cal_ratio: 'Mean predicted probability ÷ observed conversion rate. 1 = right on average; above 1 = over-prediction.',
  psi: 'Population Stability Index of the score distribution versus the reference period(s), on the reference deciles. <0.1 stable, 0.1–0.25 moderate shift, >0.25 major shift. This compares periods inside the uploaded file only — not against training data.',
  low_pos: 'Fewer positives than the minimum per period: the metric is computed but is a noisy estimate.',
  not_estimable: 'Undefined because the period has no positive (or no negative) records.',
  clients: 'Distinct client IDs among the evaluation records.',
  converters: 'Distinct clients with at least one positive evaluation record.',
  episodes: 'Distinct purchases (conversion episodes). One purchase can make up to 14 consecutive client-date rows positive; it is counted once.',
  ties: 'Records whose score equals the score at the cutoff. Only the tie-break hash decides which of them are in the audience; ranking metrics are not affected.',
  contacts: 'Contact attempts: one per client per send. Repeated contacts of the same client count separately.',
  unique_clients: 'Distinct clients contacted at least once during the campaign.',
  captured: 'Distinct purchases preceded by at least one contact within the outcome window (each purchase counted once, however many contacts preceded it).',
  capture_rate: 'Captured purchases ÷ reachable purchases. Reachable = purchases whose client was in the eligible pool at a send within the outcome window — the same denominator for every strategy.',
  contact_precision: 'Contacts followed by a purchase within the outcome window ÷ contacts.',
  client_rate: 'Distinct contacted clients who purchased after a contact ÷ distinct contacted clients.',
  pool_rate: 'Pool base rate: across all sends, the share of eligible pool members who purchased within the outcome window after that send. Lift = contact precision ÷ this rate.',
  shortfall: 'Matched comparison only: contacts the strategy could not make because too few eligible clients qualified.',
  coverage: 'Share of all errors (misses or false alarms) in the population that fall in this group.',
  miss_rate: 'Share of converters scored below the cutoff, so the model did not flag them.',
  fa_rate: 'Share of flagged records (above the cutoff) that did not convert.',
  unstable: 'Error rate compared between two periods; a change of more than 30% (relative) means the pattern may be noise.',
  effect: 'Difference between the FN and TP means divided by the feature\'s overall standard deviation.',
  pred_vs_actual: 'Mean predicted probability compared with the observed conversion rate, shown as how many times too high or too low predictions run.',
  disagree: 'Worse at only one grain: row-level only usually means a timing issue; client-level only usually means small samples.',
  within_auc: 'ROC-AUC computed inside the segment. Comparable across segments; PR-AUC is not, because it depends on each segment\'s prevalence.',
  within_ap: 'PR-AUC inside the segment. Depends on the segment\'s own prevalence — compare it with that prevalence, not with other segments.',
  sel_rate: 'Share of the segment\'s records that fall in the global top X%.',
  fpr: 'Share of the segment\'s negative records that fall in the global top X%.',
  late_fp: 'Flagged non-converters whose same client converted 15–45 days after the row date.',
  adj_prec: 'Precision if conversions within 45 days (not just 14) counted as hits.',
  bp_slice: 'Conversion rate inside each slice of the daily ranking (not cumulative), pooled across the fit dates.',
  bp_dev: 'Binomial deviance of a constant-rate-per-tier model fitted to the slices; lower means the tiers explain the slice rates better.',
  bp_stab: 'Share of client-bootstrap re-searches that put a breakpoint at exactly the same slice edge (±1 slice shown for reference).',
  bp_fold: 'Share of rolling time windows (half the fit dates each) whose search puts a breakpoint at the same slice edge.',
  bp_uniq: 'Distinct converters (purchases) with at least one row in the tier; one converter can appear in several tiers.',
  bp_best: 'Each converter counted once, in the highest tier any of their rows reached; these add up to the total.',
  bp_cut: 'Lowest score admitted to the tier on each day: mean across days, with the 5th–95th percentile range.',
  bp_perday: 'Clients falling in the tier per day: average, with the 5th–95th percentile across days.',
  p_at_k: 'Converters among the top-k scored clients in each class roster ÷ the number of slots (k per class).',
  hit_k: 'Among classes with at least one converter, the share where a converter is in the top k.',
};
const tip = key => `<i class="tip" tabindex="0" data-tip="${esc(TIPS[key] || key)}">i</i>`;
const tipText = text => `<i class="tip" tabindex="0" data-tip="${esc(text)}">i</i>`;
const term = (text, key) => `<span class="term" data-tip="${esc(TIPS[key] || key)}">${text}</span>`;

/* Floating tooltip (never clipped by scroll containers); also on keyboard focus. */
(() => {
  const tt = document.createElement('div'); tt.id = 'tooltip'; tt.className = 'hidden'; tt.setAttribute('role', 'tooltip'); document.body.appendChild(tt);
  const show = t => {
    tt.textContent = t.dataset.tip; tt.classList.remove('hidden');
    const r = t.getBoundingClientRect(), w = tt.offsetWidth, h = tt.offsetHeight;
    let x = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8), yv = r.top - h - 8;
    if (yv < 8) yv = r.bottom + 8;
    tt.style.left = x + 'px'; tt.style.top = yv + 'px';
  };
  document.addEventListener('mouseover', e => { const t = e.target.closest('[data-tip]'); if (t) show(t); });
  document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) tt.classList.add('hidden'); });
  document.addEventListener('focusin', e => { const t = e.target.closest('[data-tip]'); if (t) show(t); });
  document.addEventListener('focusout', () => tt.classList.add('hidden'));
})();

function toast(msg, ms = 4200) {
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- overlay with progress (file loading) ---------- */
const overlay = {
  el: null,
  show(title) {
    this.hide();
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="panel" role="dialog" aria-live="polite"><h3 id="ov-title">${esc(title)}</h3><div class="progress"><div id="ov-bar"></div></div><div class="faint" id="ov-step">Starting…</div></div>`;
    document.body.appendChild(o); this.el = o;
  },
  step(pct, text) { if (!this.el) return; $('#ov-bar', this.el).style.width = pct + '%'; $('#ov-step', this.el).textContent = text; },
  hide() { if (this.el) { this.el.remove(); this.el = null; } },
};

/* ---------- busy pill for background computations ---------- */
const busy = (() => {
  let n = 0, el = null, timer = null, label = 'Computing…';
  return {
    async wrap(fn, text) {
      n++; label = text || label;
      if (!timer) timer = setTimeout(() => { el = document.createElement('div'); el.className = 'busy-pill'; el.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`; document.body.appendChild(el); }, 350);
      try { return await fn(); }
      finally { if (--n === 0) { clearTimeout(timer); timer = null; if (el) { el.remove(); el = null; } } }
    },
  };
})();

/* ---------- side sheet (settings etc.) ---------- */
function openSheet(title, bodyHTML, { onApply, applyLabel = 'Apply', wide = false } = {}) {
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const sh = document.createElement('aside'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', title);
  if (wide) sh.style.width = 'min(720px, 100vw)';
  sh.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="sheet-body">${bodyHTML}</div>
    ${onApply ? `<div class="sheet-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-apply>${esc(applyLabel)}</button></div>` : ''}`;
  const close = () => { sh.classList.add('closing'); scrim.classList.add('closing'); setTimeout(() => { sh.remove(); scrim.remove(); }, 280); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  scrim.onclick = close;
  sh.addEventListener('click', async e => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-apply]')) { const ok = await onApply(sh); if (ok !== false) close(); }
  });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, sh);
  setTimeout(() => (sh.querySelector('input,select,button:not([data-close])') || sh.querySelector('[data-close]')).focus(), 50);
  return { el: sh, close };
}

/* ---------- components ---------- */
/** Segmented control. opts: [{v, label, disabled?, tip?}] */
function segHTML(name, opts, value, cls = '') {
  return `<div class="seg ${cls}" role="tablist" data-seg="${esc(name)}"><span class="thumb"></span>${opts.map(o =>
    `<button type="button" role="tab" data-v="${esc(o.v)}" aria-selected="${o.v === value}" class="${o.v === value ? 'on' : ''}" ${o.disabled ? 'disabled' : ''} ${o.tip ? `data-tip="${esc(o.tip)}"` : ''}>${esc(o.label)}</button>`).join('')}</div>`;
}
function syncSeg(seg, animate = true) {
  const on = $('button.on', seg), th = $('.thumb', seg); if (!th) return;
  if (!on) { th.style.width = '0'; return; }
  if (!animate) th.style.transition = 'none';
  th.style.width = on.offsetWidth + 'px'; th.style.transform = `translateX(${on.offsetLeft}px)`;
  if (!animate) { th.offsetWidth; th.style.transition = ''; }
}
function syncSegs(root = document) { $$('.seg', root).forEach(s => syncSeg(s, false)); }
/** Wire a segmented control inside root: fn(value) on change. */
function bindSeg(root, name, fn) {
  const seg = $(`.seg[data-seg="${CSS.escape(name)}"]`, root); if (!seg) return;
  syncSeg(seg, false);
  seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b || b.disabled || b.classList.contains('on')) return;
    $$('button', seg).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    syncSeg(seg, true); fn(b.dataset.v);
  });
}
window.addEventListener('resize', debounce(() => syncSegs(), 150));

const card = (title, body, { sub = '', actions = '', id = '', cls = '', tipKey = '' } = {}) =>
  `<section class="card ${cls}" ${id ? `id="${id}"` : ''}>${title || actions ? `<div class="card-head"><div class="titles"><h3>${title}${tipKey ? ' ' + (TIPS[tipKey] ? tip(tipKey) : tipText(tipKey)) : ''}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>` : ''}${body}</section>`;
const tile = (label, value, { sub = '', ci = '', tipKey = '', hl = false, size = '' } = {}) =>
  `<div class="tile ${hl ? 'hl' : ''}"><div class="lab">${label}${tipKey ? ' ' + (TIPS[tipKey] ? tip(tipKey) : tipText(tipKey)) : ''}</div><div class="val ${size}">${value}</div>${ci ? `<div class="ci">${ci}</div>` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const STATUS = {
  good: { cls: 'good', icon: '✓' }, warn: { cls: 'warn', icon: '!' }, bad: { cls: 'bad', icon: '×' }, na: { cls: 'na', icon: '–' }, info: { cls: 'info', icon: 'i' },
};
const statusPill = (kind, label, lg = false) => { const s = STATUS[kind] || STATUS.na; return `<span class="status ${s.cls} ${lg ? 'lg' : ''}"><span class="dot" aria-hidden="true">${s.icon}</span>${esc(label)}</span>`; };
const callout = (kind, body, title = '') => { const icon = { info: 'i', warn: '!', bad: '×', good: '✓', neutral: 'i' }[kind] || 'i'; return `<div class="callout ${kind}"><span class="ci-ico" aria-hidden="true">${icon}</span><div class="body">${title ? `<b>${title}</b> ` : ''}${body}</div></div>`; };
const flag = (text, kind = '', tipKey = '') => `<span class="flag ${kind}" ${tipKey ? `data-tip="${esc(TIPS[tipKey] || tipKey)}"` : ''}>${text}</span>`;
const disc = (summary, body, { open = false, cls = '', sub = '', id = '' } = {}) =>
  `<details class="disc ${cls}" ${open ? 'open' : ''} ${id ? `id="${id}"` : ''}><summary><span class="chev">${ICON.chev}</span><span>${summary}</span>${sub ? `<span class="sum-sub">${sub}</span>` : ''}<span class="grow"></span></summary><div class="disc-body">${body}</div></details>`;
const empty = (title, detail = '') => `<div class="empty"><b>${title}</b>${detail ? `<div class="faint">${detail}</div>` : ''}</div>`;
const computing = (text = 'Computing…') => `<div class="empty"><span class="computing"><span class="spinner"></span>${esc(text)}</span></div>`;
const legend = items => `<div class="legend">${items.map(([label, color, kind = 'line']) => `<span class="key"><i class="${kind === 'dot' ? 'dot' : ''}" style="background:${color}"></i>${esc(label)}</span>`).join('')}</div>`;

/* ---------- downloads (explicit user action only) ---------- */
function toCSV(rows, cols) {
  const keys = cols || Object.keys(rows[0] || {});
  const cell = v => { if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\n');
}
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/**
 * Sortable table with CSV export. columns: [{key, label, fmt?(v,row), tip?, num?, cls?(row), nosort?}]
 * Values are escaped unless fmt returns HTML (fmt output is trusted markup built from escaped parts).
 */
function renderTable(host, { columns, rows, exportName, maxRows = 500, rowClass, sort, note = '', tall = false, exportRows }) {
  let sortKey = sort?.key ?? null, sortDir = sort?.dir ?? -1, showAll = false;
  const draw = () => {
    let data = rows.slice();
    if (sortKey) data.sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      const nx = x === null || x === undefined || (typeof x === 'number' && isNaN(x)), ny = y === null || y === undefined || (typeof y === 'number' && isNaN(y));
      if (nx && ny) return 0; if (nx) return 1; if (ny) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    const lim = showAll ? Math.min(data.length, 5000) : maxRows;
    const shown = data.slice(0, lim);
    html(host, `<div class="tbl-wrap ${tall ? 'tall' : ''}"><table class="data"><thead><tr>${columns.map(c => `<th data-k="${esc(c.key)}" class="${c.num ? 'num' : ''} ${c.nosort ? 'nosort' : ''}" scope="col">${esc(c.label)}${c.tip ? ' ' + (TIPS[c.tip] ? tip(c.tip) : tipText(c.tip)) : ''}${sortKey === c.key ? `<span class="arrow">${sortDir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(r => `<tr class="${rowClass ? rowClass(r) : ''}">${columns.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls ? c.cls(r) : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}
      ${shown.length ? '' : `<tr><td colspan="${columns.length}" class="dim" style="text-align:center;padding:24px">No rows</td></tr>`}</tbody></table></div>
      <div class="tbl-foot"><span>${data.length > lim ? `Showing ${fmtInt(lim)} of ${fmtInt(data.length)} rows${exportName ? ' (export includes all)' : ''}. <button class="link-btn" data-more>Show more</button> ` : `${fmtInt(data.length)} row${data.length === 1 ? '' : 's'}. `}${note}</span>
      ${exportName ? `<button class="btn sm" data-export>${ICON.download} Export CSV</button>` : ''}</div>`);
    $$('th', host).forEach(th => th.onclick = e => {
      if (e.target.closest('.tip') || th.classList.contains('nosort')) return;
      const k = th.dataset.k; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; } draw();
    });
    const more = $('[data-more]', host); if (more) more.onclick = () => { showAll = true; draw(); };
    const ex = $('[data-export]', host);
    if (ex) ex.onclick = () => download(exportName + '.csv', toCSV(exportRows ? exportRows(data) : data.map(r => Object.fromEntries(columns.map(c => [c.key, plainValue(r[c.key])]))), exportRows ? undefined : columns.map(c => c.key)));
  };
  draw();
}
const plainValue = v => (Array.isArray(v) ? v.join('; ') : v);

/* ---------- charts (Plotly, theme-aware) ---------- */
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const C = () => ({
  actual: cssVar('--actual'), predicted: cssVar('--predicted'), s1: cssVar('--s1'), s2: cssVar('--s2'), s3: cssVar('--s3'), s4: cssVar('--s4'), s5: cssVar('--s5'),
  base: cssVar('--baseline'), text: cssVar('--text'), text2: cssVar('--text-2'), text3: cssVar('--text-3'), grid: cssVar('--grid'), axis: cssVar('--axis'),
  surface: cssVar('--chart-surface'), good: cssVar('--good'), warn: cssVar('--warn'), bad: cssVar('--bad'), accent: cssVar('--accent'),
  up: cssVar('--shap-up'), down: cssVar('--shap-down'),
});
const rgba = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const PLOT_CFG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines', 'hoverCompareCartesian', 'hoverClosestCartesian'] };
const PLOTS = new Set();
function plot(el, traces, layout = {}, config = {}) {
  if (!el) return;
  if (!window.Plotly) { html(el, empty('Charts unavailable', 'The chart library (Plotly) could not be loaded from the CDN. Tables and numbers are unaffected.')); return; }
  const c = C();
  const axis = { gridcolor: c.grid, zerolinecolor: c.grid, linecolor: c.axis, tickcolor: c.axis, ticks: '', tickfont: { color: c.text3, size: 11 }, title: { font: { color: c.text2, size: 12 } }, automargin: true, showline: true, linewidth: 1 };
  const base = {
    margin: { l: 56, r: 16, t: 28, b: 48 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: getComputedStyle(document.body).fontFamily, size: 12, color: c.text },
    hoverlabel: { bgcolor: 'rgba(29,29,31,0.94)', bordercolor: 'rgba(0,0,0,0)', font: { color: '#f5f5f7', size: 12, family: getComputedStyle(document.body).fontFamily } },
    legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 11.5, color: c.text2 }, bgcolor: 'rgba(0,0,0,0)' },
    hovermode: 'closest', dragmode: 'zoom',
  };
  const L = { ...base, ...layout, xaxis: { ...axis, ...(layout.xaxis || {}) }, yaxis: { ...axis, ...(layout.yaxis || {}) } };
  for (const k of Object.keys(layout)) if (/^[xy]axis\d+$/.test(k)) L[k] = { ...axis, ...layout[k] };
  try { Plotly.react(el, traces, L, { ...PLOT_CFG, ...config }); PLOTS.add(el); }
  catch (e) { console.error(e); html(el, empty('Chart failed to render', esc(e.message))); }
}
/** Re-render charts on theme change: callers register a redraw fn per tab via S.redraw. */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
