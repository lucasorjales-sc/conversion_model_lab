/* ==========================================================================
   60 · SEGMENT DIAGNOSTICS
   Where it's wrong (preserved from the prototype, restyled; client level now uses
   the index-date rule instead of max score), automatic segment analysis, the
   feature explorer, SHAP feature importance (65_importance.js) and timing of misses.
   ========================================================================== */
const segState = () => (S.ui.seg ||= { sub: 'wrong', cutPct: 20, minN: 200, minPos: 10, tree: { mode: 'misses', level: 'client', depth: 4, minLeaf: 30, selected: null },
  segGrain: 'row', segCols: null, refCol: null, refVal: null, fx: { feat: null, type: 'auto', bin: 'quantile', bins: 10, edges: '', minN: 100, d0: null, d1: null, studio: '', fcol: '', fval: '', grain: 'row', sort: 'gap' }, timingK: 10 });

RENDER.seg = async (el, v) => {
  const U = segState();
  html(el, `
    ${pageHead('Segment Diagnostics', 'Where does the model over-predict, under-predict or miss?', 'Error analysis across every segment and feature in the file, discovered automatically. These are conditional diagnostics: a difference between groups is not evidence that a feature causes conversion.')}
    <div class="subnav">${segHTML('ssub', [{ v: 'wrong', label: 'Where it\'s wrong' }, { v: 'segments', label: 'Segments' }, { v: 'features', label: 'Feature explorer' }, { v: 'importance', label: 'Feature importance' }, { v: 'timing', label: 'Timing of misses' }], U.sub, 'lg')}</div>
    <div id="sg-body"></div>`);
  bindSeg(el, 'ssub', async s => { U.sub = s; await segBody(v); });
  await segBody(v);
};
async function segBody(v) {
  const U = segState(), body = $('#sg-body');
  if (U.sub === 'wrong') return wrongView(body, v);
  if (U.sub === 'segments') return segmentsView(body, v);
  if (U.sub === 'features') return featureView(body, v);
  if (U.sub === 'importance') return importanceView(body, v);
  return timingView(body, v);
}

/* ===================================================== shared SQL helpers */
/** Units with an exact top-X% flag (same order and tie-break as the engine). The ranking window runs on narrow
    columns only; requested columns are joined back from `data` (keeps DuckDB-WASM memory low on wide files). */
function flaggedSQL(grain, cutPct, cols = '*') {
  const flags = `SELECT __rid, (row_number() OVER (ORDER BY score DESC, __hb, __rid)) <= CEIL(${cutPct / 100} * COUNT(*) OVER () - 1e-9) AS __flag FROM (${unitSQL(grain, 'score, __hb, __rid')})`;
  return `SELECT ${cols === '*' ? 'data.*' : cols}, f.__flag FROM data JOIN (${flags}) f USING (__rid)`;
}
const treeFeatures = () => S.disc.features.filter(f => f.role !== 'split').map(f => ({ name: f.name, kind: f.kind === 'cat' && !f.numeric ? 'cat' : f.numeric ? 'num' : 'cat' }));
/** Client-clustered rate CI from per-client sums (same formula as the engine). */
function clusterCI(A, B, Saa, Sbb, Sab, m) {
  const r = div(A, B); if (r === null) return { r: null, lo: null, hi: null };
  let neff;
  if (m < 2) neff = Math.max(1, m);
  else { const ss = Saa - 2 * r * Sab + r * r * Sbb, vv = (m / (m - 1)) * Math.max(0, ss) / (B * B); neff = vv > 0 ? Math.min(B, r * (1 - r) / vv) : m; if (!(neff > 0)) neff = m; }
  const z = 1.959964, z2 = z * z, den = 1 + z2 / neff, c = (r + z2 / (2 * neff)) / den, h = z * Math.sqrt(Math.max(0, r * (1 - r) / neff + z2 / (4 * neff * neff))) / den;
  return { r, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/* ======================================================= WHERE IT'S WRONG */
const TREE_MAX_ROWS = 200000;
const TREE_MODES = {
  misses: { label: 'Misses', pop: 'y = 1', err: 'NOT __flag', errName: 'missed', popName: 'converters' },
  fa: { label: 'False alarms', pop: '__flag', err: 'y = 0', errName: 'false alarms', popName: 'flagged' },
};
async function wrongView(body, v) {
  const U = segState();
  html(body, `
    <div class="card"><div class="toolbar" style="margin:0">
      <label class="inline">Flag the top <input type="number" id="w-cut" min="1" max="99" step="1" value="${U.cutPct}">% of scores ${tipText('A record counts as flagged when it is in the top X% of the evaluation records (exact count, same tie-break as everywhere else). Drives the trees, heatmap, browsers and findings on this page only.')}</label>
      <label class="inline">Min. segment size <input type="number" id="w-minn" min="0" step="100" value="${U.minN}"> records</label>
      <label class="inline">Min. converters <input type="number" id="w-minp" min="0" step="1" value="${U.minPos}"></label>
    </div></div>
    <div class="card" id="w-findings" style="margin-top:20px">${computing('Growing error-analysis trees…')}</div>
    <div class="card" id="w-tree" style="margin-top:20px"></div>
    <div id="w-heat" style="margin-top:20px"></div>
    <div id="w-browsers"></div>`);
  const rerender = debounce(async () => {
    U.cutPct = clamp(Math.round(+$('#w-cut').value || 20), 1, 99); U.minN = Math.max(0, +$('#w-minn').value || 0); U.minPos = Math.max(0, +$('#w-minp').value || 0);
    U.tree.selected = null; await wrongBody(v);
  }, 450);
  ['#w-cut', '#w-minn', '#w-minp'].forEach(s => $(s).oninput = rerender);
  await wrongBody(v);
}
async function wrongBody(v) {
  const model = await errorTrees(); if (stale(v) || !$('#w-tree')) return;
  const seg = await segmentData(segState().tree.level === 'client' ? 'client' : 'row', segState().cutPct); if (stale(v)) return;
  renderFindings(model, seg);
  renderTree(model, v);
  await renderHeat(v); if (stale(v)) return;
  await renderBrowsers(v);
}

function treePopSQL(level, feats, periodExpr) {
  const U = segState();
  const cols = ['client_id', 'y', 'score', '__hb', '__rid', 'date', ...feats.map(f => qi(f.name))].join(', ');
  return `SELECT client_id, y, score, __flag${feats.map(f => ', ' + qi(f.name)).join('')}${periodExpr ? `, ${periodExpr} AS __p` : ''} FROM (${flaggedSQL(level, U.cutPct, cols)})`;
}
async function loadTreeData(mode, level, feats) {
  const M = TREE_MODES[mode];
  const pop = treePopSQL(level, feats);
  const base = `SELECT *, CASE WHEN ${M.err} THEN 1 ELSE 0 END AS __e FROM (${pop}) WHERE ${M.pop}`;
  const cnt = await q1(`SELECT COUNT(*) AS n, SUM(CASE WHEN ${M.err} THEN 1 ELSE 0 END) AS e FROM (${pop}) WHERE ${M.pop}`);
  let sql = base, sampled = false;
  if (cnt.n > TREE_MAX_ROWS) {   // exact proportional stratified sample by error flag
    sampled = true;
    sql = `SELECT * EXCLUDE (__rn, __sn) FROM (SELECT *, row_number() OVER (PARTITION BY __e ORDER BY hash(client_id, score)) AS __rn, COUNT(*) OVER (PARTITION BY __e) AS __sn FROM (${base})) WHERE __rn <= CEIL(__sn * ${TREE_MAX_ROWS / cnt.n})`;
  }
  if (!cnt.n) return { cols: null, n: 0, total: 0, totalErr: 0, sampled };
  // columnar read (Arrow): numerics arrive as Float64Array with NaN for missing, categoricals as strings
  const sel = feats.map((f, i) => f.kind === 'num' ? `COALESCE(TRY_CAST(${qi(f.name)} AS DOUBLE), 'NaN'::DOUBLE) AS f${i}` : `COALESCE(CAST(${qi(f.name)} AS VARCHAR), '(null)') AS f${i}`);
  const t = await DB.conn.query(`SELECT client_id, CAST(y AS TINYINT) AS y, CAST(__e AS TINYINT) AS e${sel.map(x => ', ' + x).join('')} FROM (${sql})`);
  const cols = { client_id: t.getChild('client_id').toArray(), y: t.getChild('y').toArray(), e: t.getChild('e').toArray(),
    f: feats.map((f, i) => (f.kind === 'num' ? new Float64Array(t.getChild('f' + i).toArray()) : t.getChild('f' + i).toArray())) };
  return { cols, n: t.numRows, total: cnt.n, totalErr: cnt.e || 0, sampled };
}
function prepTree(d, feats) {
  const n = d.n, y = new Uint8Array(n), conv = new Uint8Array(n), cid = new Array(n);
  for (let i = 0; i < n; i++) { y[i] = d.cols.e[i] ? 1 : 0; conv[i] = d.cols.y[i] ? 1 : 0; cid[i] = d.cols.client_id[i]; }
  const F = feats.map((f, j) => {
    const src = d.cols.f[j];
    if (f.kind === 'num') return { ...f, x: src };
    const labels = [], map = new Map(), x = new Int32Array(n);
    for (let i = 0; i < n; i++) { const v = String(src[i]); let c = map.get(v); if (c === undefined) { c = labels.length; labels.push(v); map.set(v, c); } x[i] = c; }
    return { ...f, x, labels };
  });
  return { n, y, conv, cid, F };
}
/** All splits of a node with positive Gini gain and both sides ≥ minLeaf, best first (top 20). */
function splitCandidates(Dt, nd, minLeaf) {
  const imp = (n, e) => (n > 0 ? 2 * e * (n - e) / n : 0);
  const out = [], N = nd.n, E = nd.e, base = imp(N, E), idx = nd.idx, y = Dt.y;
  const consider = (nL, eL, mk) => { const nR = N - nL, eR = E - eL; if (nL < minLeaf || nR < minLeaf) return; const gain = base - imp(nL, eL) - imp(nR, eR); if (gain > 1e-9) out.push({ gain, ...mk() }); };
  for (const f of Dt.F) {
    const x = f.x;
    if (f.kind === 'num') {
      const vals = []; let hasNull = false;
      for (const i of idx) { const v = x[i]; if (Number.isNaN(v)) hasNull = true; else vals.push(v); }
      if (vals.length < minLeaf) continue;
      vals.sort((a, b) => a - b);
      const mn = vals[0], mx = vals[vals.length - 1]; if (mn === mx && !hasNull) continue;
      const th = [];
      for (let k = 0; k <= 10; k++) { const t = vals[Math.min(vals.length - 1, Math.floor(k * vals.length / 11))]; if ((t < mx || hasNull) && (!th.length || t > th[th.length - 1])) th.push(t); }
      const K = th.length, cn = new Float64Array(K + 1), ce = new Float64Array(K + 1);
      for (const i of idx) { const v = x[i]; if (Number.isNaN(v)) continue; let lo = 0, hi = K; while (lo < hi) { const m = (lo + hi) >> 1; if (th[m] < v) lo = m + 1; else hi = m; } cn[lo]++; ce[lo] += y[i]; }
      let nL = 0, eL = 0;
      for (let k = 0; k < K; k++) { nL += cn[k]; eL += ce[k]; const t = th[k]; consider(nL, eL, () => ({ test: i => x[i] <= t, left: { f: f.name, kind: 'num', op: 'le', t, isMin: t === mn }, right: { f: f.name, kind: 'num', op: 'gt', t, hasNull, isMin: t === mn } })); }
    } else {
      const Cn = f.labels.length; if (Cn < 2) continue;
      const cn = new Float64Array(Cn), ce = new Float64Array(Cn);
      for (const i of idx) { cn[x[i]]++; ce[x[i]] += y[i]; }
      for (let c = 0; c < Cn; c++) consider(cn[c], ce[c], () => ({ test: i => x[i] === c, left: { f: f.name, kind: 'cat', op: 'eq', v: f.labels[c] }, right: { f: f.name, kind: 'cat', op: 'ne', v: f.labels[c] } }));
    }
  }
  return out.sort((a, b) => b.gain - a.gain).slice(0, 20);
}
/** Greedy binary tree on the error flag (Gini). minLeaf is enforced on units and, at row level, on unique clients too. */
function growTree(Dt, { maxDepth, minLeaf, level }) {
  const uniq = (idx, onlyConv) => { if (level === 'client' && !onlyConv) return idx.length; const s = new Set(); for (const i of idx) if (!onlyConv || Dt.conv[i]) s.add(Dt.cid[i]); return s.size; };
  let nextId = 0; const nodes = [];
  const make = (idx, depth, rule, parent) => { let e = 0; for (const i of idx) e += Dt.y[i]; const nd = { id: nextId++, idx, n: idx.length, e, rate: idx.length ? e / idx.length : 0, depth, rule, parent, children: [], clients: uniq(idx), convClients: uniq(idx, true) }; nodes.push(nd); return nd; };
  const root = make(Int32Array.from({ length: Dt.n }, (_, i) => i), 0, null, null);
  const queue = [root];
  while (queue.length) {
    const nd = queue.shift();
    if (nd.depth >= maxDepth || nd.e === 0 || nd.e === nd.n || nd.n < 2 * minLeaf) continue;
    for (const c of splitCandidates(Dt, nd, minLeaf)) {
      const L = [], R = []; for (const i of nd.idx) (c.test(i) ? L : R).push(i);
      const Li = Int32Array.from(L), Ri = Int32Array.from(R);
      if (level === 'row' && (uniq(Li) < minLeaf || uniq(Ri) < minLeaf)) continue;
      nd.children = [make(Li, nd.depth + 1, c.left, nd), make(Ri, nd.depth + 1, c.right, nd)];
      queue.push(...nd.children); break;
    }
  }
  for (const nd of nodes) { nd.coverage = root.e ? nd.e / root.e : 0; nd.excess = nd.rate - root.rate; nd.score = nd === root ? 0 : nd.coverage * Math.max(0, nd.excess); delete nd.idx; }
  return { root, nodes };
}
const fmtT = t => (Number.isInteger(t) ? String(t) : String(+t.toPrecision(3)));
function ruleShort(r) { if (r.kind === 'cat') return `${r.f} ${r.op === 'eq' ? '=' : '≠'} ${r.v}`; if (r.op === 'le') return `${r.f} ${r.isMin ? '=' : '≤'} ${fmtT(r.t)}`; return `${r.f} > ${fmtT(r.t)}${r.hasNull ? ' or missing' : ''}`; }
function rulePlain(r) { if (r.kind === 'cat') return r.op === 'eq' ? `${r.f} ${r.v}` : `${r.f} other than ${r.v}`; if (r.op === 'le') return r.isMin ? `${r.f} of ${fmtT(r.t)}` : `${r.f} of ${fmtT(r.t)} or less`; return `${r.f} above ${fmtT(r.t)}${r.hasNull ? ' (or missing)' : ''}`; }
function ruleSQL(r) { const c = qi(r.f); if (r.kind === 'cat') return `COALESCE(CAST(${c} AS VARCHAR), '(null)') ${r.op === 'eq' ? '=' : '<>'} ${ql(r.v)}`; return r.op === 'le' ? `${c} <= ${r.t}` : `(${c} > ${r.t} OR ${c} IS NULL)`; }
const pathRules = nd => { const r = []; for (let x = nd; x && x.rule; x = x.parent) r.unshift(x.rule); return r; };
function mergedRules(rules) {
  const by = new Map(); for (const r of rules) { if (!by.has(r.f)) by.set(r.f, []); by.get(r.f).push(r); }
  return [...by.entries()].map(([f, rs]) => {
    if (rs[0].kind === 'cat') { const eq = rs.find(r => r.op === 'eq'); if (eq) return { plain: `${f} ${eq.v}`, short: `${f} = ${eq.v}` }; const ne = rs.map(r => r.v); return { plain: `${f} other than ${ne.join(' or ')}`, short: `${f} ≠ ${ne.join(', ')}` }; }
    const le = rs.filter(r => r.op === 'le'), gt = rs.filter(r => r.op === 'gt');
    const hiR = le.length ? le.reduce((a, b) => (b.t < a.t ? b : a)) : null, lo = gt.length ? Math.max(...gt.map(r => r.t)) : null, nullOk = !le.length && gt.every(r => r.hasNull);
    if (hiR && lo !== null) { const single = Number.isInteger(lo) && Number.isInteger(hiR.t) && hiR.t - lo === 1; return single ? { plain: `${f} of ${fmtT(hiR.t)}`, short: `${f} = ${fmtT(hiR.t)}` } : { plain: `${f} above ${fmtT(lo)} and up to ${fmtT(hiR.t)}`, short: `${fmtT(lo)} < ${f} ≤ ${fmtT(hiR.t)}` }; }
    if (hiR) return { plain: rulePlain(hiR), short: ruleShort(hiR) };
    return { plain: `${f} above ${fmtT(lo)}${nullOk ? ' (or missing)' : ''}`, short: `${f} > ${fmtT(lo)}${nullOk ? ' or missing' : ''}` };
  });
}
const pathPlain = nd => (nd.rule ? mergedRules(pathRules(nd)).map(m => m.plain).join(' and ') : 'any profile (everyone in the evaluation population)');
const pathSQL = nd => (nd.rule ? pathRules(nd).map(r => `(${ruleSQL(r)})`).join(' AND ') : 'TRUE');
const pathName = nd => { const s = mergedRules(pathRules(nd)).map(m => m.short).join(', '); return s.length > 48 ? s.slice(0, 46) + '…' : s; };
/** Two periods for the stability check: first vs second half of the evaluation window (≥ 28 days). */
async function treePeriods() {
  const r = await q1(`SELECT strftime(MIN(date), '%Y-%m-%d') AS a, strftime(MAX(date), '%Y-%m-%d') AS b, date_diff('day', MIN(date), MAX(date)) AS span FROM data WHERE ${evalWhere()}`);
  if (r.span >= 28) { const mid = new Date((Date.parse(r.a) + Date.parse(r.b)) / 2).toISOString().slice(0, 10); return { expr: `CASE WHEN date < DATE ${ql(mid)} THEN 'A' ELSE 'B' END`, a: `${r.a} to before ${mid}`, b: `${mid} to ${r.b}` }; }
  return null;
}
async function validateTree(tr, mode, level, feats, P) {
  const M = TREE_MODES[mode];
  const cols = tr.nodes.map(nd => { const c = pathSQL(nd); return `SUM(CASE WHEN ${c} THEN 1.0 ELSE 0 END) AS n${nd.id}, SUM(CASE WHEN (${c}) AND (${M.err}) THEN 1.0 ELSE 0 END) AS e${nd.id}`; });
  const r = await q(`SELECT __p, ${cols.join(', ')} FROM (${treePopSQL(level, feats, P.expr)}) WHERE ${M.pop} GROUP BY 1`);
  const by = Object.fromEntries(r.map(x => [x.__p, x]));
  for (const nd of tr.nodes) {
    const g = p => { const x = by[p]; return x && x['n' + nd.id] ? { n: x['n' + nd.id], e: x['e' + nd.id], rate: x['e' + nd.id] / x['n' + nd.id] } : null; };
    const A = g('A'), B = g('B');
    nd.val = { A, B, unstable: !!(A && B && (A.rate ? Math.abs(B.rate - A.rate) / A.rate > 0.3 : B.rate > 0)) };
  }
}
async function errorTrees() {
  const U = segState(), T = U.tree;
  const key = `${S.ver}|trees|${U.cutPct}|${T.level}|${T.depth}|${T.minLeaf}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = busy.wrap(async () => {
    const feats = treeFeatures();
    const th = await q1(`SELECT COUNT(*) AS n, COALESCE(SUM(y), 0) AS pos, MIN(CASE WHEN __flag THEN score END) AS t FROM (${flaggedSQL(T.level, U.cutPct, 'y, score, __hb, __rid')})`);
    const out = { t: th.t, feats, level: T.level, pos: th.pos, n: th.n, trees: {}, period: await treePeriods() };
    for (const mode of ['misses', 'fa']) {
      if (mode === 'misses' && !th.pos) { out.trees[mode] = { disabled: 'There are no converters in the evaluation population, so there is nothing to miss.' }; continue; }
      const d = await loadTreeData(mode, T.level, feats);
      if (!d.n) { out.trees[mode] = { disabled: 'No records in this population.' }; continue; }
      const tr = growTree(prepTree(d, feats), { maxDepth: T.depth, minLeaf: T.minLeaf, level: T.level });
      Object.assign(tr, { mode, total: d.total, totalErr: d.totalErr, sampled: d.sampled, sampleN: d.n });
      if (out.period) await validateTree(tr, mode, T.level, feats, out.period);
      out.trees[mode] = tr;
    }
    return out;
  }, 'Growing error-analysis trees…');
  S.cache.set(key, p); return p;
}
const problemNodes = (tr, k = 5) => tr.nodes.filter(nd => nd.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
function treeSVG(tr, selId) {
  const c = C(), leafW = 176, levelH = 122, top = 30;
  let leaves = 0; const px = new Map();
  const place = nd => { if (!nd.children.length) px.set(nd.id, leaves++); else { nd.children.forEach(place); px.set(nd.id, (px.get(nd.children[0].id) + px.get(nd.children[1].id)) / 2); } };
  place(tr.root);
  const depth = Math.max(...tr.nodes.map(n => n.depth));
  const W = Math.max(leaves * leafW, 640), off = (W - leaves * leafW) / 2, H = top + depth * levelH + 80;
  const X = nd => off + px.get(nd.id) * leafW + leafW / 2, Y = nd => top + nd.depth * levelH + 18;
  const maxRate = Math.max(...tr.nodes.map(n => n.rate)) || 1;
  const sh = c.surface || '#ffffff';
  const fill = rate => { const a = Math.min(1, rate / maxRate); return `color-mix(in srgb, ${c.bad} ${Math.round(a * 85)}%, ${sh})`; };
  const rad = nd => 7 + 22 * Math.sqrt(nd.n / tr.root.n);
  let edges = '', labels = '', circles = '';
  for (const nd of tr.nodes) {
    if (nd.parent) {
      const x1 = X(nd.parent), y1 = Y(nd.parent), x2 = X(nd), y2 = Y(nd);
      edges += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.axis}" stroke-width="1.5"/>`;
      const full = ruleShort(nd.rule), txt = full.length > 26 ? full.slice(0, 25) + '…' : full, lx = x1 + (x2 - x1) * 0.6, ly = y1 + (y2 - y1) * 0.6, w = txt.length * 6.3 + 12;
      labels += `<g><title>${esc(full)}</title><rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="19" rx="9.5" fill="${sh}" stroke="${c.grid}"/><text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="11" fill="${c.text2}">${esc(txt)}</text></g>`;
    }
    const sel = nd.id === selId, r = rad(nd);
    circles += `<g class="tnode" data-id="${nd.id}" tabindex="0" role="button" aria-label="${esc(pathPlain(nd))}"><title>${esc(pathPlain(nd))}</title>
      <circle cx="${X(nd)}" cy="${Y(nd)}" r="${r}" fill="${fill(nd.rate)}" stroke="${sel ? c.accent : c.axis}" stroke-width="${sel ? 3 : 1.2}"/>
      <text x="${X(nd)}" y="${Y(nd) + r + 15}" text-anchor="middle" font-size="12.5" font-weight="650" fill="${c.text}">${fmtPct(nd.rate, 0)}</text>
      <text x="${X(nd)}" y="${Y(nd) + r + 29}" text-anchor="middle" font-size="10.5" fill="${c.text3}">${fmtInt(nd.clients)} clients${nd.val?.unstable ? ' ⚠' : ''}</text></g>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Error analysis tree">${edges}${labels}${circles}</svg>`;
}
const predRun = g => (g >= 1 ? `${fmtNum(g, 1)} times too high` : `${fmtNum(1 / g, 1)} times too low`);
function buildFindings(model, seg) {
  const lists = { misses: [], fa: [], cal: [] };
  for (const mode of ['misses', 'fa']) {
    const tr = model.trees[mode]; if (!tr || tr.disabled) continue;
    const chosen = [];
    for (const nd of tr.nodes.filter(n => n.score > 0).sort((a, b) => b.score - a.score)) {
      if (chosen.some(c => { for (let x = nd.parent; x; x = x.parent) if (x === c) return nd.rate < 1.25 * c.rate; return false; })) continue;
      chosen.push(nd); if (chosen.length >= 4) break;
    }
    for (const nd of chosen) {
      const small = nd.convClients < 30, who = esc(pathPlain(nd));
      let h, next, scroll;
      if (mode === 'misses') { h = `Clients with <b>${who}</b>: the model ${term(`misses ${fmtPct(nd.rate, 0)}`, 'miss_rate')} of the ones who convert (${fmtPct(tr.root.rate, 0)} overall). This group holds ${term(`${fmtPct(nd.coverage, 0)} of all missed conversions`, 'coverage')}.`; next = `Open the false-negative browser for this cohort and look at what these ${fmtInt(nd.convClients)} converters have in common.`; scroll = 'fn-card'; }
      else { h = `Clients with <b>${who}</b>: ${term(`${fmtPct(nd.rate, 1)} of those flagged don't convert`, 'fa_rate')} (${fmtPct(tr.root.rate, 1)} overall; ${fmtPct(1 - nd.rate)} convert vs ${fmtPct(1 - tr.root.rate)}).`; next = 'Compare these clients with true positives in the feature comparison to see what the model may be over-weighting.'; scroll = 'ft-card'; }
      lists[mode].push({ kind: mode, html: h, next, clients: nd.clients, conv: nd.convClients, small, unstable: nd.val?.unstable, sql: pathSQL(nd), path: pathPlain(nd), name: pathName(nd), rate: nd.rate, overall: tr.root.rate, coverage: nd.coverage, scroll });
    }
  }
  if (S.hasProb && seg) {
    const o = seg.overall, oGap = div(o.meanP, o.prev), calOk = oGap > 0.8 && oGap < 1.25;
    const rows = seg.rows.filter(r => r.eligible && fin(r.calRatio) && (r.calRatio / (calOk ? 1 : oGap) > 1.5 || r.calRatio / (calOk ? 1 : oGap) < 0.67) && fin(r.rateLo) && (r.meanP < r.rateLo || r.meanP > r.rateHi));
    for (const r of rows.sort((a, b) => Math.abs(Math.log(b.calRatio)) - Math.abs(Math.log(a.calRatio))).slice(0, 3)) {
      const g = calOk ? r.calRatio : r.calRatio / oGap;
      lists.cal.push({ kind: 'cal', clients: r.clients, conv: r.pos, small: r.pos < 30, sql: `COALESCE(CAST(${qi(r.colName)} AS VARCHAR), '(missing)') = ${ql(r.val)}`, path: `${r.colLabel} ${r.val}`, name: `${r.colLabel} = ${r.val}`, rate: r.calRatio, overall: oGap, scroll: null,
        html: `Clients with <b>${esc(r.colLabel)} ${esc(r.val)}</b>: ${term(`predictions run ${predRun(g)}`, 'pred_vs_actual')}${calOk ? '' : ' relative to the rest of the file'} (mean predicted ${fmtPct(r.meanP)}; ${fmtPct(r.rate)} observed, 95% CI ${fmtPct(r.rateLo)}–${fmtPct(r.rateHi)}).`,
        next: 'Do not read these probabilities at face value when sizing budgets for this group; check whether it needs separate calibration.' });
    }
  }
  const out = [], order = ['misses', 'fa', 'misses', 'cal', 'fa', 'misses', 'cal', 'fa', 'misses', 'cal', 'fa'];
  for (const k of order) if (lists[k].length) out.push(lists[k].shift());
  return out;
}
function renderFindings(model, seg) {
  const host = $('#w-findings'), U = segState(); if (!host) return;
  const F = buildFindings(model, seg);
  S.ui.findings = F;
  const showAll = U.showAllFindings, shown = showAll ? F : F.slice(0, 5);
  const chip = { misses: 'Misses', fa: 'False alarms', cal: 'Calibration' };
  html(host, `<div class="card-head"><div class="titles"><h3>Findings</h3><div class="sub">Groups where errors concentrate most, from the error-analysis trees${S.hasProb ? ' and segment calibration' : ''}. Each ends with a suggested next step. Top ${U.cutPct}% flagged · ${grainLabel(model.level === 'client' ? 'client' : 'row').toLowerCase()}.</div></div></div>
    ${F.length ? `<ol class="findings">${shown.map((f, i) => `<li><span class="kind kind-${f.kind}">${chip[f.kind]}</span>${f.html} <b>Next:</b> ${esc(f.next)}
        <div class="faint" style="margin-top:4px">${term(`${fmtInt(f.clients)} clients`, 'clients')} · ${term(`${fmtInt(f.conv)} converters`, 'converters')}${f.small ? ' · ' + flag('small sample — treat as a lead') : ''}${f.unstable ? ' · ' + flag('unstable across periods', '', 'unstable') : ''}
          · <button class="link-btn" data-cohort="${i}">Apply as cohort${f.scroll === 'fn-card' ? ' and open false negatives' : f.scroll === 'ft-card' ? ' and open feature comparison' : ''}</button></div></li>`).join('')}</ol>
      ${F.length > 5 ? `<button class="btn sm" id="f-more" style="margin-top:8px">${showAll ? 'Show fewer' : `Show ${F.length - 5} more`}</button>` : ''}`
    : '<div class="faint">No group stands out at the current cutoff and minimum sizes.</div>'}`);
  $('#f-more')?.addEventListener('click', () => { U.showAllFindings = !showAll; renderFindings(model, seg); });
  $$('button[data-cohort]', host).forEach(b => b.onclick = async () => { const f = shown[+b.dataset.cohort]; S.ui.scrollTo = f.scroll; if (!await applyCohort(f.name, f.sql, f.path)) S.ui.scrollTo = null; });
}
function renderTree(model, v) {
  const U = segState(), T = U.tree, host = $('#w-tree'); if (!host) return;
  const missOff = model.trees.misses?.disabled;
  if (T.mode === 'misses' && missOff) T.mode = 'fa';
  const tr = model.trees[T.mode], unit = T.level === 'client' ? 'clients' : 'rows';
  const numCount = model.feats.filter(f => f.kind === 'num').length;
  const expl = T.mode === 'misses'
    ? `Population: ${fmtInt(tr?.total)} ${T.level === 'client' ? 'clients whose index record converted' : 'positive rows (converter-days)'}. Error = not in the top ${U.cutPct}% (score below ${fmtScore(model.t)}), so the model did not flag them. <b>Who is the model failing to catch?</b>`
    : `Population: ${fmtInt(tr?.total)} ${unit} in the top ${U.cutPct}% (score ≥ ${fmtScore(model.t)}). Error = did not convert. <b>Who is the model wrongly confident about?</b>`;
  html(host, `
    <div class="card-head"><div class="titles"><h3>Error-analysis tree ${tipText('Automatically splits the population on segment and feature values to find the combinations where errors concentrate (greedy tree, Gini impurity of the error flag).')}</h3></div>
      <div class="actions">${segHTML('tmode', [{ v: 'misses', label: 'Misses', disabled: !!missOff, tip: missOff || TIPS.miss_rate }, { v: 'fa', label: 'False alarms', tip: TIPS.fa_rate }], T.mode)}
        ${segHTML('tlevel', [{ v: 'client', label: 'Unique clients', tip: TIPS.grain_client }, { v: 'row', label: 'Rows', tip: TIPS.grain_row }], T.level)}
        <label class="inline small">Depth <select id="t-depth">${[2, 3, 4, 5].map(d => `<option ${d === T.depth ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="inline small">Min. group <input type="number" id="t-min" min="5" step="5" value="${T.minLeaf}" style="width:72px"></label></div></div>
    <p class="muted small" style="margin:0 0 8px">${expl}</p>
    ${missOff && T.mode === 'fa' ? callout('info', `Misses tree disabled: ${esc(missOff)}`) : ''}
    ${tr?.sampled ? callout('neutral', `The population has ${fmtInt(tr.total)} ${unit}; the tree was grown on a stratified sample of ${fmtInt(tr.sampleN)} (same error rate). Period checks use the full population.`) : ''}
    ${!numCount ? callout('neutral', 'No numeric feature columns were found, so the tree splits on segment columns only.') : ''}
    <div id="t-svg-host"></div>`);
  bindSeg(host, 'tmode', m => { T.mode = m; T.selected = null; renderTree(model, v); });
  bindSeg(host, 'tlevel', async l => { T.level = l; T.selected = null; html($('#t-svg-host'), computing('Growing trees…')); await wrongBody(v); });
  $('#t-depth').onchange = async e => { T.depth = +e.target.value; T.selected = null; await wrongBody(v); };
  $('#t-min').oninput = debounce(async e => { T.minLeaf = Math.max(5, Math.round(+e.target.value || 30)); T.selected = null; await wrongBody(v); }, 500);
  const sh = $('#t-svg-host');
  if (!tr || tr.disabled) { html(sh, empty(esc(tr?.disabled || 'No data.'))); return; }
  if (!tr.root.children.length) { html(sh, empty('No split found', `No split produced two groups of at least ${T.minLeaf} ${unit} with different error rates (${fmtInt(tr.root.n)} ${unit}, ${fmtPct(tr.root.rate)} ${TREE_MODES[T.mode].errName}). Lower the minimum group size.`)); return; }
  const probs = problemNodes(tr), sel = tr.nodes.find(n => n.id === T.selected) || probs[0] || tr.root;
  html(sh, `
    <h4 style="margin-top:12px">Biggest problem areas ${tipText('Ranked by error coverage × excess error rate: groups that hold many of the errors and are much worse than average.')}</h4>
    <ol class="problems">${probs.map(nd => `<li data-id="${nd.id}" class="${nd.id === sel.id ? 'on' : ''}" tabindex="0"><b>${esc(pathPlain(nd))}</b><br>
      <span class="faint">${term(`${fmtPct(nd.rate, 0)} ${TREE_MODES[T.mode].errName}`, T.mode === 'misses' ? 'miss_rate' : 'fa_rate')} vs ${fmtPct(tr.root.rate, 0)} overall · ${term(`${fmtPct(nd.coverage, 0)} of all errors`, 'coverage')} · ${fmtInt(nd.clients)} clients${nd.val?.unstable ? ' · ' + flag('unstable', '', 'unstable') : ''}</span></li>`).join('') || '<li class="faint">No group is worse than average.</li>'}</ol>
    <div class="tree-wrap"><div class="tree-svg">${treeSVG(tr, sel.id)}</div><aside class="tree-panel" id="t-panel"></aside></div>
    <div class="chart-note">Circle size = ${unit}; color = error rate (pale = low, red = high). Click a node for details. ⚠ = unstable across the two halves of the window.</div>`);
  const select = id => { T.selected = id; renderTree(model, v); };
  $$('.tnode', sh).forEach(g => { g.addEventListener('click', () => select(+g.dataset.id)); g.addEventListener('keydown', e => { if (e.key === 'Enter') select(+g.dataset.id); }); });
  $$('.problems li[data-id]', sh).forEach(li => { li.onclick = () => select(+li.dataset.id); li.onkeydown = e => { if (e.key === 'Enter') select(+li.dataset.id); }; });
  const M = TREE_MODES[T.mode], P = model.period, nd = sel, rel = div(nd.rate, tr.root.rate);
  html($('#t-panel'), `
    <h4>Selected group</h4><p style="margin:6px 0 12px;font-size:14px">Clients with <b>${esc(pathPlain(nd))}</b></p>
    <div class="tiles" style="grid-template-columns:1fr 1fr">
      ${tile('Clients', fmtInt(nd.clients), { size: 'md', sub: model.level === 'row' ? `${fmtInt(nd.n)} rows` : '' })}
      ${tile(T.mode === 'misses' ? 'Missed' : 'False alarms', fmtInt(nd.e), { size: 'md', sub: `of ${fmtInt(nd.n)} ${M.popName}` })}
      ${tile('Error rate', fmtPct(nd.rate, 1), { size: 'md', sub: `overall ${fmtPct(tr.root.rate, 1)}${rel ? ` (${fmtX(rel, 1)})` : ''}`, hl: true })}
      ${tile('Error coverage', fmtPct(nd.coverage, 0), { size: 'md', tipKey: 'coverage' })}
    </div>
    ${P ? `<h4 style="margin-top:16px">Validate on the other half ${tip('unstable')}</h4>
      <table class="plain" style="font-size:13px;margin-top:6px"><tr><th>Period</th><th>n</th><th>Error rate</th></tr>
        <tr><td>${esc(P.a)}</td><td>${fmtInt(nd.val?.A?.n)}</td><td>${fmtPct(nd.val?.A?.rate, 1)}</td></tr>
        <tr><td>${esc(P.b)}</td><td>${fmtInt(nd.val?.B?.n)}</td><td>${fmtPct(nd.val?.B?.rate, 1)}</td></tr></table>
      <div style="margin-top:8px">${!nd.val?.A || !nd.val?.B ? '<span class="faint">This group has no records in one of the halves.</span>' : nd.val.unstable ? flag('unstable, possibly noise', '', 'unstable') + ' <span class="faint">rates differ by more than 30%</span>' : '<span class="faint">Stable: rates within 30% of each other.</span>'}</div>`
      : '<p class="faint" style="margin-top:12px">Period check needs at least 28 days in the evaluation window.</p>'}
    ${nd.rule ? `<h4 style="margin-top:16px">Save as cohort</h4>
      <input type="text" id="c-name" value="${esc(pathName(nd))}" style="width:100%;margin-top:6px" aria-label="Cohort name">
      <button class="btn primary sm" id="c-save" style="margin-top:8px">Apply as global cohort</button>
      <p class="faint" style="margin-top:8px">Adds a population filter shown in the top bar; every tab then analyses only this cohort. The rule is applied to each row's own values.</p>` : ''}`);
  $('#c-save')?.addEventListener('click', () => applyCohort($('#c-name').value.trim() || pathName(nd), pathSQL(nd), pathPlain(nd)));
}

/* ---- two-way heatmap ---- */
async function renderHeat(v) {
  const U = segState(), host = $('#w-heat'); if (!host) return;
  const segs = S.disc.segments; if (!segs.length) { host.innerHTML = ''; return; }
  const level = U.tree.level;
  const bySize = segs.slice().sort((a, b) => a.distinct - b.distinct);   // default to the two smallest segments: wide segments leave most cells below the minimum size
  U.heatA ||= bySize[0].name; U.heatB ||= (bySize[1] || bySize[0]).name;
  html(host, card('Two-way heatmap', '<div class="chart lg" id="h-chart"></div><div class="chart-note">Cells below the minimum segment size or converters are blank. Columns with more than 25 values keep the 24 largest and fold the rest into “Other”.</div>', {
    sub: `Uses the same top-${U.cutPct}% flag and grain (${grainLabel(level).toLowerCase()}) as the tree.`,
    actions: `<label class="inline small">Rows <select id="h-a">${segs.map(s => `<option value="${esc(s.name)}" ${s.name === U.heatA ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
      <label class="inline small">Columns <select id="h-b">${segs.map(s => `<option value="${esc(s.name)}" ${s.name === U.heatB ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
      <label class="inline small">Metric <select id="h-m"><option value="lift">Lift (rate ÷ overall)</option><option value="prec">Precision in top ${U.cutPct}%</option><option value="recall">Share caught (top ${U.cutPct}%)</option>${S.hasProb ? '<option value="gap">Predicted ÷ observed</option>' : ''}<option value="tdLift">Top-decile lift within cell</option><option value="rate">Conversion rate</option></select></label>` }));
  const drawHeat = async () => {
    const a = $('#h-a').value, bb = $('#h-b').value, m = $('#h-m').value; U.heatA = a; U.heatB = bb;
    const fold = c => `CASE WHEN COALESCE(CAST(${qi(c)} AS VARCHAR), '(missing)') IN (SELECT v FROM (SELECT COALESCE(CAST(${qi(c)} AS VARCHAR), '(missing)') AS v, COUNT(*) AS n FROM data WHERE ${evalWhere()} GROUP BY 1 ORDER BY n DESC LIMIT 24)) THEN COALESCE(CAST(${qi(c)} AS VARCHAR), '(missing)') ELSE 'Other' END`;
    const r = await q(`WITH f AS (SELECT y, score, prob, __flag, ${fold(a)} AS a, ${fold(bb)} AS b FROM (${flaggedSQL(level, U.cutPct, ['y', 'score', 'prob', '__hb', '__rid', ...new Set([a, bb])].map(c => c.startsWith('__') || ['y', 'score', 'prob'].includes(c) ? c : qi(c)).join(', '))})),
        g AS (SELECT *, rank() OVER (PARTITION BY a, b ORDER BY score DESC) + (COUNT(*) OVER (PARTITION BY a, b, score) - 1) / 2.0 AS srk, COUNT(*) OVER (PARTITION BY a, b) AS sn FROM f)
      SELECT a, b, COUNT(*) AS n, SUM(y) AS pos, AVG(prob) AS mp, SUM(CASE WHEN __flag THEN 1.0 ELSE 0 END) AS flagged, SUM(CASE WHEN __flag THEN y ELSE 0 END) AS tp,
        SUM(CASE WHEN srk <= sn * 0.1 THEN y ELSE 0 END) AS td_pos, SUM(CASE WHEN srk <= sn * 0.1 THEN 1.0 ELSE 0 END) AS td_n FROM g GROUP BY 1, 2`);
    if (stale(v)) return;
    const tot = r.reduce((s, x) => ({ n: s.n + x.n, pos: s.pos + x.pos }), { n: 0, pos: 0 }), orate = div(tot.pos, tot.n);
    const A = [...new Set(r.map(x => x.a))].sort(), Bv = [...new Set(r.map(x => x.b))].sort();
    const val = x => { if (x.n < U.minN || x.pos < U.minPos) return null; const rate = div(x.pos, x.n); return { lift: div(rate, orate), prec: div(x.tp, x.flagged), recall: div(x.tp, x.pos), gap: div(x.mp, rate), tdLift: div(div(x.td_pos, x.td_n), rate), rate }[m]; };
    const idx = new Map(r.map(x => [x.a + '\u0000' + x.b, x]));
    const Z = A.map(ai => Bv.map(bi => { const x = idx.get(ai + '\u0000' + bi); return x ? val(x) : null; }));
    const N = A.map(ai => Bv.map(bi => idx.get(ai + '\u0000' + bi)?.n ?? 0));
    const ratio = ['lift', 'gap', 'tdLift'].includes(m);
    const zPlot = Z.map(row => row.map(z => (z === null || !fin(z) ? null : ratio ? Math.log2(Math.max(z, 1e-3)) : z)));
    const lim = ratio ? Math.max(1, ...zPlot.flat().filter(fin).map(Math.abs)) : null;
    const fmtV = z => (z === null ? '' : ['prec', 'recall', 'rate'].includes(m) ? fmtPct(z) : fmtX(z, m === 'gap' ? 2 : 1));
    const c = C(), neutral = cssVar('--surface-3');
    plot($('#h-chart'), [{ type: 'heatmap', x: Bv, y: A, z: zPlot, text: Z.map(row => row.map(fmtV)), texttemplate: '%{text}', textfont: { size: 11 }, customdata: N,
      hovertemplate: `${esc(a)} = %{y}<br>${esc(bb)} = %{x}<br>%{text}<br>n = %{customdata:,}<extra></extra>`,
      colorscale: ratio ? [[0, c.bad], [0.5, neutral], [1, c.s1]] : [[0, neutral], [1, c.s1]], zmin: ratio ? -lim : undefined, zmax: ratio ? lim : undefined, zmid: ratio ? 0 : undefined,
      reversescale: m === 'gap', xgap: 2, ygap: 2, colorbar: { title: { text: ratio ? 'log₂ ratio' : '', side: 'right' }, thickness: 10, outlinewidth: 0, tickfont: { color: c.text3 } } }],
      { xaxis: { title: { text: bb }, type: 'category', showline: false }, yaxis: { title: { text: a }, type: 'category', autorange: 'reversed', showline: false }, margin: { l: 100, r: 10, t: 16, b: 70 } });
  };
  ['#h-a', '#h-b', '#h-m'].forEach(s => $(s).onchange = drawHeat);
  await drawHeat();
}

/* ---- browsers and feature comparison ---- */
async function renderBrowsers(v) {
  const U = segState(), host = $('#w-browsers'); if (!host) return;
  const level = U.tree.level;
  html(host, `
    ${card('False-negative browser', '<div id="fn-tbl"></div>', { id: 'fn-card', sub: `Converters scored below the median of the evaluation ${unitWord(level)}: the model ranked them average-or-worse.`, actions: '<span class="faint" id="fn-count"></span>' })}
    ${card('False-positive browser', '<div id="fp-tbl"></div>', { sub: 'Non-converters with the highest scores.', actions: '<label class="inline small">Show top <select id="fp-lim"><option>100</option><option selected>500</option><option>2000</option></select></label>' })}
    ${card('Feature distributions: true positives vs false negatives vs false positives', '<div id="ft-body"></div>', { id: 'ft-card', sub: `TP = flagged converters, FN = missed converters, FP = flagged non-converters (top ${U.cutPct}%, ${grainLabel(level).toLowerCase()}).` })}`);
  const drop = new Set(['__hb', '__rid', '__flag']);
  const allCols = S.schema.cols.map(c => c.name).filter(c => !drop.has(c));
  const ranked = `SELECT __rid, y, score, (row_number() OVER (ORDER BY score DESC, __hb, __rid)) / COUNT(*) OVER () AS score_rank_pct FROM (${unitSQL(level, 'y, score, __hb, __rid')})`;
  const show = (where, order, lim) => `WITH r AS (SELECT * FROM (${ranked}) WHERE ${where} ORDER BY ${order} LIMIT ${lim})
    SELECT r.score_rank_pct, ${allCols.map(c => 'd.' + qi(c)).join(', ')} FROM r JOIN data d ON d.__rid = r.__rid ORDER BY ${order.replace(/score/g, 'r.score')}`;
  const tblCols = rows => ['score_rank_pct', ...allCols].map(c => ({ key: c, label: c === 'score_rank_pct' ? 'Score rank' : c === 'y' ? 'outcome' : c, num: typeof rows[0]?.[c] === 'number' || c === 'score_rank_pct',
    fmt: c === 'score' || c === 'prob' ? fmtScore : c === 'score_rank_pct' ? (x => fmtPct(x)) : (x => (x === null || x === undefined ? '<span class="dim">null</span>' : esc(typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(4) : x))),
    tip: c === 'score_rank_pct' ? 'Position of the score from the top, as a share of the evaluation records (0% = highest).' : undefined }));
  const med = (await q1(`SELECT median(score) AS m FROM (${unitSQL(level, 'score')})`)).m;
  const fn = await q(show(`y = 1 AND score < ${med}`, 'score ASC', 20000));
  if (stale(v) || !host.isConnected) return;
  const pos = await q1(`SELECT SUM(y) AS p FROM (${unitSQL(level, 'y')})`);
  if (!host.isConnected) return;
  html($('#fn-count'), `${fmtInt(fn.length)} converters below the median (${fmtPct(div(fn.length, pos.p))} of converters)${fn.length >= 20000 ? ' · first 20,000' : ''}`);
  renderTable($('#fn-tbl'), { rows: fn, columns: tblCols(fn), exportName: 'false_negatives', maxRows: 200, sort: { key: 'score', dir: 1 } });
  const drawFP = async () => {
    const lim = +$('#fp-lim').value;
    const fp = await q(show('y = 0', 'score DESC', lim));
    if (stale(v) || !host.isConnected) return;
    renderTable($('#fp-tbl'), { rows: fp, columns: tblCols(fp), exportName: 'false_positives', maxRows: 200, sort: { key: 'score', dir: -1 } });
  };
  const lim = $('#fp-lim'); if (!lim) return;
  lim.onchange = drawFP; await drawFP(); if (stale(v) || !host.isConnected) return;
  // feature comparison (numeric features)
  const fh = $('#ft-body');
  const feats = S.disc.features.filter(f => f.numeric && f.kind === 'num').map(f => f.name).slice(0, 40);
  if (!feats.length) { html(fh, '<div class="faint">No numeric feature columns in the file.</div>'); scrollToSection(); return; }
  const grp = `CASE WHEN y = 1 AND __flag THEN 'TP' WHEN y = 1 THEN 'FN' WHEN __flag THEN 'FP' ELSE 'TN' END`;
  const FT = `(${flaggedSQL(level, U.cutPct, ['y', 'score', '__hb', '__rid', ...feats.map(qi)].join(', '))})`;
  const st = await q(`SELECT ${grp} AS grp, COUNT(*) AS n, ${feats.map((f, i) => `AVG(${qi(f)}::DOUBLE) AS m${i}, median(${qi(f)}::DOUBLE) AS md${i}`).join(', ')} FROM ${FT} GROUP BY 1`);
  const sd = await q1(`SELECT ${feats.map((f, i) => `stddev(${qi(f)}::DOUBLE) AS s${i}, quantile_cont(${qi(f)}::DOUBLE, 0.01) AS lo${i}, quantile_cont(${qi(f)}::DOUBLE, 0.99) AS hi${i}`).join(', ')} FROM ${FT}`);
  if (stale(v) || !fh.isConnected) return;
  const G = Object.fromEntries(st.map(r => [r.grp, r]));
  const rows = feats.map((f, i) => ({ feature: f, tp_mean: G.TP?.['m' + i] ?? null, fn_mean: G.FN?.['m' + i] ?? null, fp_mean: G.FP?.['m' + i] ?? null, tn_mean: G.TN?.['m' + i] ?? null,
    tp_med: G.TP?.['md' + i] ?? null, fn_med: G.FN?.['md' + i] ?? null, fp_med: G.FP?.['md' + i] ?? null,
    effect: fin(G.FN?.['m' + i]) && fin(G.TP?.['m' + i]) && sd['s' + i] ? (G.FN['m' + i] - G.TP['m' + i]) / sd['s' + i] : null, lo: sd['lo' + i], hi: sd['hi' + i] }));
  html(fh, `<div class="faint" style="margin-bottom:10px">Group sizes: TP ${fmtInt(G.TP?.n || 0)} · FN ${fmtInt(G.FN?.n || 0)} · FP ${fmtInt(G.FP?.n || 0)} · TN ${fmtInt(G.TN?.n || 0)}</div><div id="ft-tbl"></div>
    <h4 style="margin:20px 0 10px">Distributions of the features where FN and TP differ most (each group normalised)</h4>${legend([['True positives', C().s1], ['False negatives', C().s2], ['False positives', C().s3]])}<div class="feat-grid" id="ft-grid"></div>`);
  const f3 = x => fmtNum(x, 2);
  renderTable($('#ft-tbl'), { rows, exportName: 'feature_comparison_tp_fn_fp', sort: { key: 'effect', dir: -1 }, maxRows: 40,
    columns: [{ key: 'feature', label: 'Feature' }, { key: 'tp_mean', label: 'TP mean', num: true, fmt: f3 }, { key: 'fn_mean', label: 'FN mean', num: true, fmt: f3 }, { key: 'fp_mean', label: 'FP mean', num: true, fmt: f3 }, { key: 'tn_mean', label: 'TN mean', num: true, fmt: f3 },
      { key: 'tp_med', label: 'TP median', num: true, fmt: f3 }, { key: 'fn_med', label: 'FN median', num: true, fmt: f3 }, { key: 'fp_med', label: 'FP median', num: true, fmt: f3 }, { key: 'effect', label: 'FN vs TP effect', num: true, fmt: f3, tip: 'effect' }] });
  const top = rows.filter(r => fin(r.lo) && fin(r.hi) && r.hi > r.lo).sort((a, b) => Math.abs(b.effect ?? 0) - Math.abs(a.effect ?? 0)).slice(0, 9);
  if (top.length) {
    const B = 20;
    const h = await q(top.map(r => { const w = (r.hi - r.lo) / B; return `SELECT ${ql(r.feature)} AS f, ${grp} AS grp, LEAST(${B - 1}, GREATEST(0, FLOOR((${qi(r.feature)}::DOUBLE - ${r.lo}) / ${w})))::INT AS b, COUNT(*) AS c FROM ${FT} WHERE ${qi(r.feature)} IS NOT NULL GROUP BY 1, 2, 3`; }).join(' UNION ALL '));
    if (stale(v)) return;
    const grid = $('#ft-grid'), c = C();
    if (!grid) return;   // the user moved to another sub-tab while this was computing
    top.forEach(r => {
      const d = document.createElement('div'); d.className = 'chart'; grid.appendChild(d);
      const w = (r.hi - r.lo) / B, xs = Array.from({ length: B }, (_, j) => r.lo + (j + 0.5) * w);
      const tr = [['TP', c.s1], ['FN', c.s2], ['FP', c.s3]].map(([g, col]) => { const sub = h.filter(x => x.f === r.feature && x.grp === g), tot = sub.reduce((s, x) => s + x.c, 0) || 1; const arr = Array(B).fill(0); sub.forEach(x => arr[x.b] = x.c / tot); return { x: xs, y: arr, mode: 'lines', line: { shape: 'hvh', color: col, width: 2 }, name: g, hovertemplate: `${g}: %{y:.1%}<extra></extra>` }; });
      plot(d, tr, { title: { text: r.feature, font: { size: 12.5, color: c.text }, x: 0.02, xanchor: 'left' }, margin: { l: 44, r: 8, t: 30, b: 30 }, showlegend: false, yaxis: { tickformat: '.0%' } });
    });
  }
  scrollToSection();
}

/* ================================================================ SEGMENTS */
/** Engine segment metrics for one grain, joined with labels; cached. */
async function segmentData(grain, cutPct) {
  const key = `${S.ver}|segdata|${grain}|${cutPct}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = (async () => {
    const segs = S.core.segs.filter(s => !s.hidden);
    const R = await engCached('segments', { grain, k: cutPct / 100, cols: segs.map(s => s.idx) }, 'Computing segment metrics…');
    const U = segState(), rows = [];
    for (const sres of R.segs) {
      const meta = S.core.segs[sres.col];
      for (const r of sres.rows) {
        const row = { ...r, col: meta.idx, colName: meta.name, colLabel: meta.label, val: meta.labels[r.code], calRatio: r.meanP !== null && r.rate ? r.meanP / r.rate : null };
        row.eligible = r.n >= U.minN && r.pos >= U.minPos;
        rows.push(row);
      }
    }
    return { grain, overall: R.overall, rows };
  })();
  S.cache.set(key, p); return p;
}
async function segmentsView(body, v) {
  const U = segState(), segs = S.core.segs.filter(s => !s.hidden);
  if (!segs.length) { html(body, `${empty('No segment columns found', 'No categorical column with 2–50 values was found (identifiers and dates are excluded). Map PRIMARY_STUDIO_ID or LIFECYCLE_STAGE, or add segment columns to the file.')}${excludedCard()}`); return; }
  U.segCols ||= segs.map(s => s.name);
  html(body, `
    <div class="card"><div class="toolbar" style="margin:0 0 12px">
      <span class="toolbar-label">Grain</span>${segHTML('sgrain', [{ v: 'row', label: 'Client-date rows', tip: TIPS.grain_row }, { v: 'client', label: 'Unique clients', tip: TIPS.grain_client }], U.segGrain)}
      <label class="inline">Flag the top <input type="number" id="s-cut" min="1" max="99" value="${U.cutPct}">%</label>
      <label class="inline">Min. records <input type="number" id="s-minn" min="0" step="50" value="${U.minN}"></label>
      <label class="inline">Min. converters <input type="number" id="s-minp" min="0" value="${U.minPos}"></label>
      <label class="inline"><input type="checkbox" id="s-small" ${U.showSmall ? 'checked' : ''}> show small segments</label></div>
      <div class="faint" style="margin-bottom:6px">Segments discovered automatically (${segs.length}). Untick to hide from the table:</div>
      <div class="pill-select" id="s-cols">${segs.map(s => `<label><input type="checkbox" value="${esc(s.name)}" ${U.segCols.includes(s.name) ? 'checked' : ''}> ${esc(s.label)} <span class="faint">${fmtInt(s.labels.length)}</span></label>`).join('')}</div>
    </div>
    ${callout('neutral', 'PR-AUC depends on each segment\'s own prevalence, so it is not comparable across segments: a segment with a higher base rate gets a higher PR-AUC from the same ranking quality. Compare within-segment ROC-AUC across segments, and read within-segment PR-AUC against that segment\'s prevalence. Precision, recall and lift use the global top-X% cutoff, so they show how the shared ranking treats each segment.')}
    <div id="s-body" style="margin-top:20px">${computing('Computing segment metrics…')}</div>
    <div id="s-ref" style="margin-top:20px"></div>
    ${excludedCard()}`);
  bindSeg(body, 'sgrain', async g => { U.segGrain = g; await drawSeg(); });
  const re = debounce(async () => { U.cutPct = clamp(Math.round(+$('#s-cut').value || 20), 1, 99); U.minN = Math.max(0, +$('#s-minn').value || 0); U.minPos = Math.max(0, +$('#s-minp').value || 0); await drawSeg(); }, 400);
  ['#s-cut', '#s-minn', '#s-minp'].forEach(s => $(s).oninput = re);
  $('#s-small').onchange = e => { U.showSmall = e.target.checked; drawSeg(); };
  $('#s-cols').onchange = () => { U.segCols = $$('#s-cols input:checked').map(x => x.value); drawSeg(); };
  const drawSeg = async () => {
    const [seg, other] = await Promise.all([segmentData(U.segGrain, U.cutPct), segmentData(U.segGrain === 'row' ? 'client' : 'row', U.cutPct)]); if (stale(v)) return;
    const o = seg.overall, otherBy = new Map(other.rows.map(r => [r.colName + '\u0000' + r.val, r]));
    const oCal = div(o.meanP, o.prev);
    for (const r of seg.rows) {
      const ot = otherBy.get(r.colName + '\u0000' + r.val);
      r.recallOther = ot?.recall ?? null;
      r.flags = [];
      if (!r.eligible) continue;
      const worse = x => fin(x) && fin(o.recall) && x < 0.67 * o.recall;
      const worseHere = worse(r.recall) && fin(r.recHi) && r.recHi < o.recall;
      if (worseHere) r.flags.push('misses more');
      if (fin(r.lift) && fin(r.liftHi) && r.liftHi < 1) r.flags.push('top-X no better than random');
      if (S.hasProb && fin(r.calRatio) && fin(r.rateLo) && (r.meanP < r.rateLo || r.meanP > r.rateHi)) r.flags.push(r.meanP > r.rateHi ? 'over-predicts' : 'under-predicts');
      const ow = worse(ot?.recall);
      if (ot && ot.eligible !== false && worse(r.recall) !== ow) r.disagree = worse(r.recall) ? `${U.segGrain === 'row' ? 'row' : 'client'}-level only` : `${U.segGrain === 'row' ? 'client' : 'row'}-level only`;
    }
    const vis = seg.rows.filter(r => U.segCols.includes(r.colName) && (U.showSmall || r.eligible));
    const hidden = seg.rows.filter(r => U.segCols.includes(r.colName) && !r.eligible).length;
    const uw = unitWord(U.segGrain);
    html($('#s-body'), card('Segment metrics', '<div id="s-tbl"></div>', { sub: `${fmtInt(vis.length)} segment values shown${hidden && !U.showSmall ? ` · ${fmtInt(hidden)} small values hidden (below ${fmtInt(U.minN)} records or ${U.minPos} converters; they are never flagged)` : ''}. Overall: prevalence ${fmtPct(o.prev)}, top-${U.cutPct}% precision ${fmtPct(o.precision)}, recall ${fmtPct(o.recall)}${S.hasProb ? `, predicted ÷ observed ${fmtX(oCal, 2)}` : ''}.` }));
    const pr = x => fmtPct(x);
    renderTable($('#s-tbl'), {
      rows: vis, exportName: `segment_metrics_${U.segGrain}`, maxRows: 300, sort: { key: 'n', dir: -1 }, rowClass: r => (r.flags?.length ? 'flagged' : ''), tall: true,
      note: 'Intervals are 95%, client-clustered. Amber edge = flagged. Recall at the other grain is shown for comparison.',
      columns: [
        { key: 'colLabel', label: 'Segment' }, { key: 'val', label: 'Value' },
        { key: 'n', label: uw, num: true, fmt: fmtInt }, { key: 'clients', label: 'Clients', num: true, fmt: fmtInt, tip: 'clients' }, { key: 'pos', label: 'Positives', num: true, fmt: fmtInt },
        { key: 'rate', label: 'Observed rate', num: true, fmt: (x, r) => `${pr(x)} ${fmtCI(r.rateLo, r.rateHi, pr)}`, tip: 'prevalence' },
        ...(S.hasProb ? [{ key: 'meanP', label: 'Mean predicted', num: true, fmt: pr }, { key: 'gapP', label: 'Predicted − observed', num: true, fmt: (x, r) => (fin(x) ? `${x >= 0 ? '+' : '−'}${fmtPct(Math.abs(x))}` : '—'), cls: r => (r.flags?.some(f => f.endsWith('predicts')) ? 'bad' : '') }]
          : [{ key: 'meanS', label: 'Mean raw score', num: true, fmt: fmtScore, tip: 'Mean PREDICTED_SCORE. Not a probability, so it is not compared with the observed rate.' }]),
        { key: 'selRate', label: `In top ${U.cutPct}%`, num: true, fmt: pr, tip: 'sel_rate' },
        { key: 'precision', label: 'Precision', num: true, fmt: (x, r) => `${pr(x)} ${fmtCI(r.precLo, r.precHi, pr)}`, tip: 'precision' },
        { key: 'recall', label: `Recall · ${U.segGrain === 'row' ? 'rows' : 'clients'}`, num: true, fmt: (x, r) => `${pr(x)} ${fmtCI(r.recLo, r.recHi, pr)}`, tip: 'recall', cls: r => (r.flags?.includes('misses more') ? 'bad' : '') },
        { key: 'recallOther', label: `Recall · ${U.segGrain === 'row' ? 'clients' : 'rows'}`, num: true, fmt: pr },
        { key: 'lift', label: 'Lift', num: true, fmt: (x, r) => `${fmtX(x, 2)} ${fmtCI(r.liftLo, r.liftHi, y => fmtX(y, 1))}`, tip: 'lift' },
        { key: 'fpr', label: 'False positive rate', num: true, fmt: pr, tip: 'fpr' },
        { key: 'aucIn', label: 'ROC-AUC within', num: true, fmt: x => fmtNum(x), tip: 'within_auc' },
        { key: 'apIn', label: 'PR-AUC within', num: true, fmt: (x, r) => (fin(x) ? `${fmtNum(x)} <span class="ci-inline">${fmtX(div(x, r.rate), 1)} prev.</span>` : '—'), tip: 'within_ap' },
        { key: 'flags', label: 'Flags', nosort: true, fmt: (x, r) => [...(x || []).map(f => flag(f, f.endsWith('predicts') || f.startsWith('top') ? 'bad' : '')), r.disagree ? flag(r.disagree, 'info', 'disagree') : '', !r.eligible ? flag('small sample', 'na') : ''].join(' ') },
      ],
      exportRows: data => data.map(r => ({ segment: r.colName, value: r.val, grain: U.segGrain, records: r.n, clients: r.clients, positives: r.pos, observed_rate: r.rate, rate_ci_low: r.rateLo, rate_ci_high: r.rateHi,
        mean_predicted: r.meanP, mean_score: r.meanS, top_pct: U.cutPct, selection_rate: r.selRate, precision: r.precision, precision_ci_low: r.precLo, precision_ci_high: r.precHi, recall: r.recall, recall_ci_low: r.recLo, recall_ci_high: r.recHi,
        recall_other_grain: r.recallOther, lift: r.lift, lift_ci_low: r.liftLo, lift_ci_high: r.liftHi, false_positive_rate: r.fpr, roc_auc_within: r.aucIn, pr_auc_within: r.apIn, flags: (r.flags || []).join('; '), disagreement: r.disagree || '', small_sample: r.eligible ? '' : 'yes' })),
    });
    drawRef(seg);
  };
  const drawRef = (seg) => {
    const host = $('#s-ref'), cols = segs.filter(s => U.segCols.includes(s.name));
    if (!cols.length) { host.innerHTML = ''; return; }
    if (!cols.find(s => s.name === U.refCol)) U.refCol = cols[0].name;
    const rows = seg.rows.filter(r => r.colName === U.refCol);
    if (!rows.find(r => r.val === U.refVal)) U.refVal = rows.slice().sort((a, b) => b.n - a.n)[0]?.val;
    html(host, card('Compare groups with a reference group', '<div class="chart" id="s-refchart"></div><div class="chart-note" id="s-refnote"></div>', {
      sub: 'Each metric for each group ÷ the same metric for the reference group (log scale). The shaded band is 0.8–1.25×. Segment columns can act as proxies for protected attributes; large gaps deserve a closer look.',
      actions: `<label class="inline small">Segment <select id="r-col">${cols.map(s => `<option value="${esc(s.name)}" ${s.name === U.refCol ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        <label class="inline small">Reference <select id="r-val">${rows.slice().sort((a, b) => b.n - a.n).map(r => `<option value="${esc(r.val)}" ${r.val === U.refVal ? 'selected' : ''}>${esc(r.val)} (${fmtInt(r.n)})</option>`).join('')}</select></label>` }));
    $('#r-col').onchange = e => { U.refCol = e.target.value; U.refVal = null; drawRef(seg); };
    $('#r-val').onchange = e => { U.refVal = e.target.value; drawRef(seg); };
    const R = rows.find(r => r.val === U.refVal), others = rows.filter(r => r !== R && r.eligible);
    const M = [['selRate', 'Selection rate'], ['recall', 'Recall (TPR)'], ['fpr', 'False positive rate'], ['precision', 'Precision'], ...(S.hasProb ? [['calRatio', 'Predicted ÷ observed']] : [])];
    const c = C(), cols5 = [c.s1, c.s2, c.s3, c.s4, c.s5], sym = ['circle', 'diamond', 'square', 'triangle-up', 'x'];
    if (!R || !others.length) { html($('#s-refchart'), empty('Not enough eligible groups to compare', 'Lower the minimum size, or pick a segment with more large groups.')); return; }
    plot($('#s-refchart'), M.map(([k, label], i) => ({ x: others.map(r => div(r[k], R[k])), y: others.map(r => r.val), mode: 'markers', type: 'scatter', name: label,
      marker: { size: 10, color: cols5[i], symbol: sym[i], line: { color: c.surface, width: 2 } }, hovertemplate: `%{y}<br>${label}: %{x:.2f}× reference<extra></extra>` })),
      { xaxis: { title: { text: `Ratio vs ${U.refVal} (log scale)` }, type: 'log' }, yaxis: { type: 'category', automargin: true },
        shapes: [{ type: 'rect', xref: 'x', yref: 'paper', x0: 0.8, x1: 1.25, y0: 0, y1: 1, fillcolor: rgba(c.good, 0.08), line: { width: 0 } }, { type: 'line', xref: 'x', yref: 'paper', x0: 1, x1: 1, y0: 0, y1: 1, line: { color: c.base, dash: 'dash', width: 1 } }],
        height: Math.max(280, 70 + others.length * 30) });
    html($('#s-refnote'), `${R.eligible ? '' : '<b>The reference group is below the minimum size, so ratios are noisy.</b> '}Only groups above the minimum size are shown.`);
  };
  await drawSeg();
}
function excludedCard() {
  const ex = S.disc.excluded;
  return `<div class="card" style="margin-top:20px">${disc(`Fields excluded from segment and feature analysis (${ex.length})`, ex.length ? `<table class="plain"><thead><tr><th>Column</th><th>Type</th><th>Distinct</th><th>Reason</th></tr></thead><tbody>${ex.map(e => `<tr><td class="mono">${esc(e.name)}</td><td class="faint">${esc((e.type || '').toLowerCase())}</td><td class="faint num">${fmtInt(e.distinct)}</td><td>${esc(e.reason)}</td></tr>`).join('')}</tbody></table>` : '<div class="faint">None.</div>', { cls: 'line', sub: 'identifiers, dates, model outputs, constants' })}
    ${disc('How segments and features are discovered', `<div class="methodology"><ul>
      <li><b>Segments</b>: text or boolean columns with 2–50 distinct values, plus the mapped PRIMARY_STUDIO_ID (any number of studios) and a mapped current-strategy flag.</li>
      <li><b>Features</b> (explorer, rule builder, trees): every segment plus every numeric column. Numeric columns with 12 or fewer distinct values default to categorical treatment (override in the explorer).</li>
      <li><b>Excluded</b>: identifiers (ID-like names, row indexes, near-unique values), text dates, columns derived from the outcome (purchase timing) or from the model output (thresholded predictions, sampling weights), constant and empty columns. Each exclusion is listed with its reason above.</li></ul></div>`, { cls: 'line' })}</div>`;
}

/* ========================================================= FEATURE EXPLORER */
async function featureView(body, v) {
  const U = segState(), F = U.fx, feats = S.disc.features;
  if (!feats.length) { html(body, `${empty('No feature columns found', 'Only the required columns were found. Add client attributes or model features to the file to explore them.')}${excludedCard()}`); return; }
  if (!feats.find(f => f.name === F.feat)) F.feat = (feats.find(f => f.numeric && f.kind === 'num') || feats[0]).name;
  F.d0 ||= S.settings.d0; F.d1 ||= S.settings.d1;
  if (F.d0 < S.settings.d0 || F.d0 > S.settings.d1) F.d0 = S.settings.d0;
  if (F.d1 > S.settings.d1 || F.d1 < S.settings.d0) F.d1 = S.settings.d1;
  const fmeta = feats.find(f => f.name === F.feat);
  const type = F.type === 'auto' ? fmeta.kind : F.type === 'num' && !fmeta.numeric ? 'cat' : F.type;
  const segs = S.core.segs.filter(s => !s.hidden);
  const studio = S.roles.studio ? S.core.segs.find(s => s.name === S.roles.studio) : null;
  const fseg = segs.find(s => s.name === F.fcol);
  html(body, `
    <div class="card">
      <div class="form-grid wide">
        <label class="field"><span class="lab">Feature</span><select id="fx-feat">${feats.map(f => `<option value="${esc(f.name)}" ${f.name === F.feat ? 'selected' : ''}>${esc(f.name)}${f.role ? ` (${esc(ROLE[f.role]?.label || f.role)})` : ''}</option>`).join('')}</select></label>
        <label class="field"><span class="lab">Treat as</span>${segHTML('fxtype', [{ v: 'auto', label: `Auto (${fmeta.kind === 'num' ? 'numeric' : 'categorical'})` }, { v: 'num', label: 'Numeric', disabled: !fmeta.numeric }, { v: 'cat', label: 'Categorical' }], F.type)}</label>
        <label class="field"><span class="lab">Grain</span>${segHTML('fxgrain', [{ v: 'row', label: 'Rows' }, { v: 'client', label: 'Unique clients' }], F.grain)}</label>
      </div>
      ${type === 'num' ? `<div class="form-grid wide" style="margin-top:14px">
        <label class="field"><span class="lab">Bins</span>${segHTML('fxbin', [{ v: 'quantile', label: 'Quantile' }, { v: 'width', label: 'Equal width' }, { v: 'custom', label: 'Custom' }], F.bin)}</label>
        ${F.bin === 'custom' ? `<label class="field"><span class="lab">Bin edges (comma-separated)</span><input type="text" id="fx-edges" value="${esc(F.edges)}" placeholder="e.g. 0, 1, 3, 7, 14, 30"></label>` : `<label class="field"><span class="lab">Number of bins</span><select id="fx-bins">${[4, 5, 8, 10, 15, 20].map(b => `<option ${b === F.bins ? 'selected' : ''}>${b}</option>`).join('')}</select></label>`}
        <label class="field"><span class="lab">Minimum records per bin</span><input type="number" id="fx-minn" min="1" step="10" value="${F.minN}"></label>
      </div>` : `<div class="form-grid wide" style="margin-top:14px"><label class="field"><span class="lab">Sort categories by</span><select id="fx-sort">${[['gap', S.hasProb ? 'Calibration gap' : 'Observed rate'], ['n', 'Sample size'], ['rate', 'Observed rate'], ...(S.hasProb ? [['pred', 'Predicted rate']] : [])].map(([k, l]) => `<option value="${k}" ${F.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span class="lab">Minimum records per category</span><input type="number" id="fx-minn" min="1" step="10" value="${F.minN}"></label></div>`}
      ${disc('Filters', `<div class="form-grid wide">
        <label class="field"><span class="lab">From</span><input type="date" id="fx-d0" min="${S.settings.d0}" max="${S.settings.d1}" value="${F.d0}"></label>
        <label class="field"><span class="lab">To</span><input type="date" id="fx-d1" min="${S.settings.d0}" max="${S.settings.d1}" value="${F.d1}"></label>
        ${studio ? `<label class="field"><span class="lab">Studio</span><select id="fx-studio"><option value="">All studios</option>${studio.labels.map(l => `<option ${F.studio === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span class="lab">Segment</span><select id="fx-fcol"><option value="">All clients</option>${segs.filter(s => s !== studio).map(s => `<option value="${esc(s.name)}" ${F.fcol === s.name ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        ${fseg ? `<label class="field"><span class="lab">Value</span><select id="fx-fval">${fseg.labels.map(l => `<option ${F.fval === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
      </div><p class="faint" style="margin-top:8px">Filters apply inside the global evaluation population. They change this view only.</p>`, { cls: 'line', open: F.studio || F.fcol || F.d0 !== S.settings.d0 || F.d1 !== S.settings.d1, sub: 'time period, studio, client segment' })}
    </div>
    <div id="fx-body" style="margin-top:20px">${computing('Binning…')}</div>`);
  const rer = () => featureView(body, v);
  $('#fx-feat').onchange = e => { F.feat = e.target.value; F.type = 'auto'; F.edges = ''; rer(); };
  bindSeg(body, 'fxtype', t => { F.type = t; rer(); });
  bindSeg(body, 'fxgrain', g => { F.grain = g; rer(); });
  bindSeg(body, 'fxbin', b => { F.bin = b; rer(); });
  $('#fx-bins')?.addEventListener('change', e => { F.bins = +e.target.value; rer(); });
  $('#fx-edges')?.addEventListener('change', e => { F.edges = e.target.value; rer(); });
  $('#fx-minn').onchange = e => { F.minN = Math.max(1, Math.round(+e.target.value || 100)); rer(); };
  $('#fx-sort')?.addEventListener('change', e => { F.sort = e.target.value; rer(); });
  $('#fx-d0').onchange = e => { F.d0 = e.target.value || S.settings.d0; rer(); };
  $('#fx-d1').onchange = e => { F.d1 = e.target.value || S.settings.d1; rer(); };
  $('#fx-studio')?.addEventListener('change', e => { F.studio = e.target.value; rer(); });
  $('#fx-fcol').onchange = e => { F.fcol = e.target.value; const s = segs.find(x => x.name === F.fcol); F.fval = s ? s.labels[0] : ''; rer(); };
  $('#fx-fval')?.addEventListener('change', e => { F.fval = e.target.value; rer(); });
  // population: evaluation units + local filters
  const where = [`date BETWEEN DATE ${ql(F.d0 <= F.d1 ? F.d0 : F.d1)} AND DATE ${ql(F.d0 <= F.d1 ? F.d1 : F.d0)}`];
  if (studio && F.studio) where.push(`COALESCE(CAST(${qi(studio.name)} AS VARCHAR), '(missing)') = ${ql(F.studio)}`);
  if (fseg && F.fval) where.push(`COALESCE(CAST(${qi(fseg.name)} AS VARCHAR), '(missing)') = ${ql(F.fval)}`);
  const pop = `SELECT * FROM (${unitSQL(F.grain, `client_id, y, score, prob, date, ${qi(F.feat)} AS __x`)}) WHERE ${where.join(' AND ')}`;
  try { await (type === 'num' ? numericExplorer(pop, fmeta, v) : categoricalExplorer(pop, fmeta, v)); }
  catch (e) { console.error(e); html($('#fx-body'), callout('bad', `This feature could not be analysed: ${esc(e.message)}`)); }
}
/** Quantile bin edges of __x over `pop`, open-ended at both ends: [-∞, q1, …, ∞]. */
async function quantileEdges(pop, k) {
  const ps = Array.from({ length: k - 1 }, (_, i) => (i + 1) / k);
  const r = await q1(`SELECT quantile_disc(__x::DOUBLE, [${ps.join(',')}]) AS qs FROM (${pop}) WHERE __x IS NOT NULL`);
  return [-Infinity, ...[...new Set((r.qs || []).filter(Number.isFinite))].sort((a, b) => a - b), Infinity];
}
/** Bin index of __x for edges E: bin k = (E[k], E[k+1]]; −1 = missing. */
const binCase = E => `CASE WHEN __x IS NULL THEN -1 ${E.slice(1, -1).map((e, k) => `WHEN __x::DOUBLE <= ${e} THEN ${k}`).join(' ')} ELSE ${E.length - 2} END`;
/** Aggregate per group with client-clustered sums. groupExpr is evaluated on `pop` rows. */
async function groupStats(pop, groupExpr) {
  return q(`WITH b AS (SELECT ${groupExpr} AS g, client_id, y, score, prob FROM (${pop})),
      c AS (SELECT g, client_id, COUNT(*)::DOUBLE AS n, SUM(y)::DOUBLE AS yy, SUM(prob) AS sp, COUNT(prob) AS np, SUM(score) AS ss FROM b GROUP BY 1, 2)
    SELECT g, SUM(n) AS n, COUNT(*) AS clients, SUM(yy) AS pos, SUM(sp) / NULLIF(SUM(np), 0) AS meanP, SUM(np) AS nProb, SUM(ss) / SUM(n) AS meanS,
      SUM(yy * yy) AS Saa, SUM(n * n) AS Sbb, SUM(yy * n) AS Sab FROM c GROUP BY 1`);
}
function finishGroups(rows, minN) {
  for (const r of rows) {
    const ci = clusterCI(r.pos, r.n, r.Saa, r.Sbb, r.Sab, r.clients);
    r.rate = ci.r; r.lo = ci.lo; r.hi = ci.hi;
    r.gap = S.hasProb && fin(r.meanP) && fin(r.rate) ? r.meanP - r.rate : null;
    r.small = r.n < minN || r.pos < 5;
    r.verdict = r.small ? 'Limited evidence: small sample' : !S.hasProb || !fin(r.meanP) ? '' : r.meanP > r.hi ? 'Potential overprediction' : r.meanP < r.lo ? 'Potential underprediction' : 'Consistent with observed';
  }
  return rows;
}
async function numericExplorer(pop, fmeta, v) {
  const U = segState(), F = U.fx, host = $('#fx-body');
  const st = await q1(`SELECT COUNT(*) AS n, COUNT(__x) AS nn, MIN(__x)::DOUBLE AS mn, MAX(__x)::DOUBLE AS mx FROM (${pop})`); if (stale(v)) return;
  if (!st.n) { html(host, empty('No records match the filters')); return; }
  if (!st.nn) { html(host, empty('This feature is empty for the filtered records', 'Missing values are never filled in.')); return; }
  let edges;
  if (F.bin === 'custom') {
    edges = String(F.edges || '').split(/[,\s;]+/).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    edges = [...new Set(edges)];
    if (edges.length < 1) { html(host, callout('warn', `Enter at least one bin edge. The feature ranges from ${fmtNum(st.mn, 2)} to ${fmtNum(st.mx, 2)}.`)); return; }
    edges = [-Infinity, ...edges, Infinity];
  } else if (F.bin === 'width') {
    const w = (st.mx - st.mn) / F.bins; edges = [-Infinity, ...Array.from({ length: F.bins - 1 }, (_, i) => st.mn + (i + 1) * w), Infinity];
  } else edges = await quantileEdges(pop, F.bins);
  // bin k = (edges[k], edges[k+1]]. Adjacent bins below the minimum are merged by moving edges BEFORE aggregation,
  // so distinct-client counts stay exact (a client whose rows span two bins is never counted twice in one bin).
  let merged = 0;
  if (F.bin !== 'custom' && edges.length > 2) {
    const cnt = await q(`SELECT ${binCase(edges)} AS g, COUNT(*) AS n FROM (${pop}) GROUP BY 1`); if (stale(v)) return;
    const nOf = new Map(cnt.map(r => [r.g, r.n]));
    const groups = []; let cur = null;
    for (let k = 0; k < edges.length - 1; k++) {
      const n = nOf.get(k) || 0;
      if (cur && cur.n < F.minN) { cur.hi = edges[k + 1]; cur.n += n; merged++; }
      else { cur = { lo: edges[k], hi: edges[k + 1], n }; groups.push(cur); }
    }
    if (groups.length > 1 && groups[groups.length - 1].n < F.minN) { const last = groups.pop(); groups[groups.length - 1].hi = last.hi; groups[groups.length - 1].n += last.n; merged++; }
    edges = [groups[0].lo, ...groups.map(g => g.hi)];
  }
  let rows = await groupStats(pop, binCase(edges)); if (stale(v)) return;
  const missing = rows.find(r => r.g === -1); rows = rows.filter(r => r.g >= 0).sort((a, b) => a.g - b.g);
  const bins = rows.map(r => ({ ...r, eLo: edges[r.g], eHi: edges[r.g + 1] }));
  finishGroups(bins, F.minN);
  const lab = b => `${Number.isFinite(b.eLo) ? fmtT(b.eLo) : fmtT(st.mn)} – ${Number.isFinite(b.eHi) ? fmtT(b.eHi) : fmtT(st.mx)}`;
  bins.forEach((b, i) => { b.label = (i === 0 ? '[' : '(') + lab(b) + ']'; });
  if (missing) { finishGroups([missing], F.minN); missing.label = 'Missing'; }
  const c = C(), x = bins.map(b => b.label), uw = unitWord(F.grain);
  const flagged = bins.filter(b => b.verdict.startsWith('Potential'));
  const interp = [];
  if (S.hasProb) {
    if (flagged.length) interp.push(`${plural(flagged.length, 'bin')} where the mean predicted probability lies outside the observed rate's 95% interval: ${flagged.map(b => `<b>${esc(b.label)}</b> (${b.verdict.toLowerCase()}: ${fmtPct(b.meanP)} predicted vs ${fmtPct(b.rate)} observed)`).join('; ')}.`);
    else interp.push('In every bin the mean predicted probability lies inside the 95% interval of the observed rate: no evidence of miscalibration along this feature.');
  } else interp.push('No valid probabilities in this file, so predicted and observed rates are not compared. The observed rate by bin and the mean raw score by bin are shown separately; the raw score is not a conversion rate.');
  const small = bins.filter(b => b.small);
  if (small.length) interp.push(`${plural(small.length, 'bin')} with limited evidence (fewer than ${fmtInt(F.minN)} records or 5 positives).`);
  if (merged) interp.push(`${plural(merged, 'bin')} merged into neighbours to reach ${fmtInt(F.minN)} records.`);
  if (missing) interp.push(`${fmtInt(missing.n)} ${uw} have no value for this feature (observed rate ${fmtPct(missing.rate)}); they are reported separately, not imputed.`);
  html(host, `
    <div class="grid ${S.hasProb ? '' : 'g2'}">
      ${card(S.hasProb ? `Observed vs predicted conversion rate by ${esc(F.feat)}` : `Observed conversion rate by ${esc(F.feat)}`, `${S.hasProb ? legend([['Observed rate (95% CI)', c.actual], ['Mean predicted probability', c.predicted]]) : ''}<div class="chart" id="fx-chart"></div>`, { sub: `${F.bin === 'quantile' ? 'Quantile' : F.bin === 'width' ? 'Equal-width' : 'Custom'} bins · ${grainLabel(F.grain).toLowerCase()} · ${fmtInt(st.nn)} ${uw} with a value` })}
      ${S.hasProb ? '' : card(`Mean raw score by ${esc(F.feat)}`, '<div class="chart" id="fx-score"></div>', { sub: 'PREDICTED_SCORE is not a probability, so it is shown on its own axis and not compared with the observed rate.' })}
    </div>
    ${callout(flagged.length ? 'warn' : 'info', interp.join(' '), 'Interpretation.')}
    <div class="card" style="margin-top:20px">${disc('Bin statistics', '<div id="fx-tbl"></div>', { cls: 'line', sub: `${bins.length} bins${missing ? ' + missing' : ''}` })}</div>`);
  const hov = bins.map(b => [b.n, b.clients, b.pos, b.eLo, b.eHi, b.verdict]);
  plot($('#fx-chart'), [
    { x, y: bins.map(b => b.hi), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    { x, y: bins.map(b => b.lo), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(c.actual, 0.13), hoverinfo: 'skip', showlegend: false },
    { x, y: bins.map(b => b.rate), mode: 'lines+markers', name: 'Observed rate', line: { color: c.actual, width: 2 }, marker: { size: 8, color: bins.map(b => b.small ? c.surface : c.actual), line: { color: c.actual, width: 2 } },
      customdata: bins.map(b => [b.n, b.clients, b.pos, b.lo, b.hi]), hovertemplate: '%{x}<br>observed %{y:.2%} (95% CI %{customdata[3]:.2%}–%{customdata[4]:.2%})<br>%{customdata[0]:,} records · %{customdata[1]:,} clients · %{customdata[2]:,} positive<extra></extra>' },
    ...(S.hasProb ? [{ x, y: bins.map(b => b.meanP), mode: 'lines+markers', name: 'Mean predicted', line: { color: c.predicted, width: 2 }, marker: { size: 8, color: c.predicted, line: { color: c.surface, width: 2 } }, customdata: hov, hovertemplate: '%{x}<br>predicted %{y:.2%}<br>%{customdata[5]}<extra></extra>' }] : []),
  ], { xaxis: { type: 'category', title: { text: `${F.feat} (bin)` }, tickangle: bins.length > 8 ? -30 : 0 }, yaxis: { title: { text: 'Conversion rate' }, tickformat: '.1~%', rangemode: 'tozero' }, showlegend: false });
  if (!S.hasProb) plot($('#fx-score'), [{ x, y: bins.map(b => b.meanS), mode: 'lines+markers', line: { color: c.s5, width: 2 }, marker: { size: 8, color: c.s5, line: { color: c.surface, width: 2 } }, hovertemplate: '%{x}<br>mean raw score %{y:.4f}<extra></extra>' }],
    { xaxis: { type: 'category', title: { text: `${F.feat} (bin)` }, tickangle: bins.length > 8 ? -30 : 0 }, yaxis: { title: { text: 'Mean PREDICTED_SCORE' }, rangemode: 'tozero' }, showlegend: false });
  explorerTable(missing ? [...bins, missing] : bins, 'Bin');
}
async function categoricalExplorer(pop, fmeta, v) {
  const U = segState(), F = U.fx, host = $('#fx-body');
  const V = `COALESCE(CAST(__x AS VARCHAR), '(missing)')`;
  const top = await q(`SELECT ${V} AS v, COUNT(*) AS n FROM (${pop}) GROUP BY 1 ORDER BY n DESC`); if (stale(v)) return;
  if (!top.length) { html(host, empty('No records match the filters')); return; }
  const folded = top.length > 40 ? top.length - 39 : 0;
  const expr = folded ? `CASE WHEN ${V} IN (${top.slice(0, 39).map(t => ql(t.v)).join(',')}) THEN ${V} ELSE 'Other (${folded} values)' END` : V;
  let rows = await groupStats(pop, expr); if (stale(v)) return;
  finishGroups(rows, F.minN);
  rows.forEach(r => { r.label = String(r.g); });
  const key = { gap: r => (S.hasProb ? Math.abs(r.gap ?? 0) : r.rate ?? 0), n: r => r.n, rate: r => r.rate ?? -1, pred: r => r.meanP ?? -1 }[F.sort] || (r => r.n);
  rows.sort((a, b) => key(b) - key(a));
  const c = C(), y = rows.map(r => r.label), uw = unitWord(F.grain);
  const flagged = rows.filter(r => r.verdict.startsWith('Potential')), small = rows.filter(r => r.small);
  const interp = [];
  if (S.hasProb) interp.push(flagged.length ? `${plural(flagged.length, 'category', 'categories')} where the mean predicted probability lies outside the observed rate's 95% interval: ${flagged.slice(0, 8).map(r => `<b>${esc(r.label)}</b> (${r.verdict.toLowerCase()})`).join(', ')}${flagged.length > 8 ? '…' : ''}.` : 'Every category\'s mean predicted probability lies inside its observed rate\'s 95% interval.');
  else interp.push('No valid probabilities in this file: observed rates are shown with the mean raw score in the table, but they are not compared.');
  if (small.length) interp.push(`${plural(small.length, 'category', 'categories')} with limited evidence (fewer than ${fmtInt(F.minN)} records or 5 positives) — drawn hollow.`);
  if (folded) interp.push(`${folded} smaller values are folded into “Other”.`);
  html(host, `
    ${card(S.hasProb ? `Observed vs predicted conversion rate by ${esc(F.feat)}` : `Observed conversion rate by ${esc(F.feat)}`, `${legend(S.hasProb ? [['Observed rate (95% CI)', c.actual, 'dot'], ['Mean predicted probability', c.predicted, 'dot']] : [['Observed rate (95% CI)', c.actual, 'dot']])}<div class="chart" id="fx-chart" style="height:${Math.max(300, 80 + rows.length * 26)}px"></div>`, { sub: `${rows.length} categories · ${grainLabel(F.grain).toLowerCase()} · sorted by ${({ gap: S.hasProb ? 'calibration gap' : 'observed rate', n: 'sample size', rate: 'observed rate', pred: 'predicted rate' })[F.sort]}` })}
    ${callout(flagged.length ? 'warn' : 'info', interp.join(' '), 'Interpretation.')}
    <div class="card" style="margin-top:20px">${disc('Category statistics', '<div id="fx-tbl"></div>', { cls: 'line', sub: `${rows.length} categories` })}</div>`);
  plot($('#fx-chart'), [
    { y, x: rows.map(r => r.rate), mode: 'markers', name: 'Observed', marker: { size: 10, color: rows.map(r => r.small ? c.surface : c.actual), line: { color: c.actual, width: 2 } },
      error_x: { type: 'data', symmetric: false, array: rows.map(r => fin(r.hi) ? r.hi - r.rate : 0), arrayminus: rows.map(r => fin(r.lo) ? r.rate - r.lo : 0), color: rgba(c.actual, 0.55), thickness: 1.5, width: 0 },
      customdata: rows.map(r => [r.n, r.clients, r.pos, r.lo, r.hi]), hovertemplate: '%{y}<br>observed %{x:.2%} (95% CI %{customdata[3]:.2%}–%{customdata[4]:.2%})<br>%{customdata[0]:,} records · %{customdata[1]:,} clients · %{customdata[2]:,} positive<extra></extra>' },
    ...(S.hasProb ? [{ y, x: rows.map(r => r.meanP), mode: 'markers', name: 'Predicted', marker: { size: 10, symbol: 'diamond', color: c.predicted, line: { color: c.surface, width: 2 } }, customdata: rows.map(r => r.verdict), hovertemplate: '%{y}<br>mean predicted %{x:.2%}<br>%{customdata}<extra></extra>' }] : []),
  ], { yaxis: { type: 'category', autorange: 'reversed', automargin: true, showline: false }, xaxis: { title: { text: 'Conversion rate' }, tickformat: '.1~%', rangemode: 'tozero' }, showlegend: false, margin: { l: 120, r: 16, t: 10, b: 48 } });
  explorerTable(rows, 'Category');
}
function explorerTable(rows, first) {
  const F = segState().fx;
  renderTable($('#fx-tbl'), {
    rows, exportName: `feature_${F.feat}_${F.grain}`, maxRows: 100, sort: null,
    columns: [{ key: 'label', label: first }, { key: 'n', label: 'Records', num: true, fmt: fmtInt }, { key: 'clients', label: 'Clients', num: true, fmt: fmtInt }, { key: 'pos', label: 'Positives', num: true, fmt: fmtInt },
      { key: 'rate', label: 'Observed rate', num: true, fmt: (x, r) => `${fmtPct(x)} ${fmtCI(r.lo, r.hi, fmtPct)}` },
      ...(S.hasProb ? [{ key: 'meanP', label: 'Mean predicted', num: true, fmt: x => fmtPct(x) }, { key: 'gap', label: '|Predicted − observed|', num: true, fmt: x => (fin(x) ? fmtPct(Math.abs(x)) : '—') }] : [{ key: 'meanS', label: 'Mean raw score', num: true, fmt: fmtScore }]),
      { key: 'verdict', label: 'Assessment', fmt: x => (x ? (x.startsWith('Potential') ? flag(x, 'bad') : x.startsWith('Limited') ? flag(x, 'na') : `<span class="dim">${esc(x)}</span>`) : '') }],
    exportRows: data => data.map(r => ({ feature: F.feat, [first.toLowerCase()]: r.label, grain: F.grain, records: r.n, clients: r.clients, positives: r.pos, observed_rate: r.rate, ci_low: r.lo, ci_high: r.hi, mean_predicted: r.meanP, mean_raw_score: r.meanS, assessment: r.verdict })),
  });
}

/* ================================================================ TIMING */
async function timingView(body, v) {
  const U = segState(), W = evalWhere();
  html(body, `
    <div class="card"><div class="toolbar" style="margin:0"><label class="inline">Flag the top <input type="number" id="tm-k" min="0.5" max="100" step="0.5" value="${U.timingK}">% of rows by score ${tipText('Defines “flagged” for the analyses on this page (row grain).')}</label></div>
      <p class="faint" style="margin-top:8px">${epSourceNote()}</p></div>
    <div class="grid g2" style="margin-top:20px">
      ${card('Score by days before purchase', '<div class="chart" id="tm-score"></div>', { sub: 'For positive rows: mean and median score by days until the purchase. A rising line means the model sharpens as the purchase approaches.' })}
      ${card('Recall by days before purchase', '<div class="chart" id="tm-rec"></div>', { sub: 'Share of positive rows in the top X%, by days until the purchase.' })}
    </div>
    ${card('Do “false positives” convert later?', '<div id="tm-late"></div>', { tipKey: 'late_fp', sub: 'Flagged non-converters whose client purchased 15–45 days after the row date — outside the 14-day label but possibly influenced by the same intent.' })}`);
  $('#tm-k').oninput = debounce(() => { U.timingK = clamp(+$('#tm-k').value || 10, 0.5, 100); timingView(body, v); }, 450);
  const k = U.timingK;
  const flagged = `(row_number() OVER (ORDER BY score DESC, __hb, __rid)) <= CEIL(${k / 100} * COUNT(*) OVER () - 1e-9)`;
  const s = await q(`WITH f AS (SELECT d.__rid, d.y, d.score, ${flagged} AS fl FROM data d WHERE ${W}),
      p AS (SELECT f.*, date_diff('day', d.date, e.pdate) AS dtc FROM f JOIN __ep e ON e.rid = f.__rid JOIN data d ON d.__rid = f.__rid WHERE f.y = 1)
    SELECT dtc AS d, COUNT(*) AS n, AVG(score) AS ms, median(score) AS md, AVG(CASE WHEN fl THEN 1.0 ELSE 0 END) AS rec FROM p WHERE dtc BETWEEN 0 AND 60 GROUP BY 1 ORDER BY 1`);
  const neg = await q1(`SELECT AVG(score) AS ms FROM data WHERE ${W} AND y = 0`);
  if (stale(v)) return;
  const c = C();
  if (!s.length) { html($('#tm-score'), empty('No positive rows in the evaluation population')); html($('#tm-rec'), ''); }
  else {
    plot($('#tm-score'), [
      { x: s.map(r => r.d), y: s.map(r => r.ms), mode: 'lines+markers', name: 'Mean score (positives)', line: { color: c.s2, width: 2 }, marker: { size: 8, color: c.s2, line: { color: c.surface, width: 2 } }, customdata: s.map(r => [r.n, r.md]), hovertemplate: '%{x} days before purchase<br>mean %{y:.4f}<br>median %{customdata[1]:.4f}<br>n = %{customdata[0]:,}<extra></extra>' },
      { x: [s[0].d, s[s.length - 1].d], y: [neg.ms, neg.ms], mode: 'lines', name: 'Mean score (negatives)', line: { color: c.base, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    ], { xaxis: { title: { text: 'Days before purchase' }, autorange: 'reversed', dtick: 2 }, yaxis: { title: { text: 'PREDICTED_SCORE' }, rangemode: 'tozero' } });
    plot($('#tm-rec'), [{ x: s.map(r => r.d), y: s.map(r => r.rec), type: 'bar', marker: { color: c.s1 }, customdata: s.map(r => r.n), hovertemplate: '%{x} days before<br>recall %{y:.1%}<br>n = %{customdata:,}<extra></extra>', width: 0.6 }],
      { xaxis: { title: { text: 'Days before purchase' }, autorange: 'reversed', dtick: 2 }, yaxis: { title: { text: `Share in top ${k}%` }, tickformat: '.0%', range: [0, 1] }, showlegend: false });
  }
  const r = await q1(`WITH conv AS (SELECT DISTINCT client_id, pdate FROM __ep), hz AS (SELECT MAX(date) + 14 AS horizon FROM data),
      f AS (SELECT client_id, date, y FROM (SELECT client_id, date, y, ${flagged} AS fl FROM data WHERE ${W}) WHERE fl AND date + 45 <= (SELECT horizon FROM hz)),
      j AS (SELECT f.client_id, f.date, ANY_VALUE(f.y) AS y, MIN(conv.pdate - f.date) AS dd FROM f LEFT JOIN conv ON conv.client_id = f.client_id AND conv.pdate - f.date BETWEEN 15 AND 45 GROUP BY 1, 2)
    SELECT COUNT(*) AS flagged, SUM(y) AS tp, SUM(1 - y) AS fp, SUM(CASE WHEN y = 0 AND dd IS NOT NULL THEN 1.0 ELSE 0 END) AS late, (SELECT strftime(MAX(date) + 14 - 45, '%Y-%m-%d') FROM data) AS lastdate FROM j`);
  if (stale(v)) return;
  const p14 = div(r.tp, r.flagged), p45 = div(r.tp + r.late, r.flagged);
  html($('#tm-late'), r.flagged ? `<div class="tiles">
      ${tile('Flagged rows with full follow-up', fmtInt(r.flagged), { sub: `rows dated on or before ${r.lastdate}` })}
      ${tile('False positives', fmtInt(r.fp))}
      ${tile('False positives converting in 15–45 days', fmtPct(div(r.late, r.fp)), { tipKey: 'late_fp', sub: `${fmtInt(r.late)} rows`, hl: true })}
      ${tile('Precision, 14-day label', fmtPct(p14), { tipKey: 'precision' })}
      ${tile('Precision if 45 days counted', fmtPct(p45), { tipKey: 'adj_prec', sub: p14 ? `+${fmtPct(p45 - p14)}` : '' })}</div>
    <p class="faint" style="margin-top:12px">Only rows whose 45-day follow-up is fully observed are used (row date + 45 ≤ last date in the file + 14). A later purchase is detected only if that client has a positive row somewhere in the file, so this is a lower bound. Purchases are ${S.ep.source === 'estimated' ? 'estimated' : 'from ' + S.ep.source}.</p>`
    : empty('No flagged rows have a complete 45-day follow-up', 'The window is too short relative to the end of the file.'));
}
