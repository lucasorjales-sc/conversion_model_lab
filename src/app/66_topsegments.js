/* ==========================================================================
   66 · TOP SEGMENTS (Segment Diagnostics → Segments sub-tab)
   Replicates the documented behaviour of Power BI's Key influencers "Top segments":
   a decision tree looks for groups with a high conversion rate; a split is kept only
   when both children are large enough and the difference is significant (p < 0.05);
   leaves converting above average become numbered segments.
   Growing reuses prepTree / splitCandidates from the error-analysis tree (60_seg.js).
   Every number shown is recomputed in SQL on the full filtered data. The model score
   is read only by the "How the model treats this segment" block (tsModelView).
   ========================================================================== */
const tsState = () => (S.ui.ts ||= { unit: 'client', depth: 4, minClients: 100, minConv: 10, maxSegs: 6, sort: 'rate', off: [], on: [], sel: null });
const TS_MAX_ROWS = 200000;
// Never explain-by: identifiers, dates, the label, label timing (leakage) and model outputs.
const SEG_EXCLUDE = /^(client_id|date|date_t|y|y_true|conversion_target|y_score|score|prob|split|class_id|coach_id|days_to_conversion|days_to_purchase|purchase_date|conversion_date|prediction|predicted_.*|p_raw_.*|p_cal_.*|predict_proba.*)$/i;
let TS_TOK = 0;   // bumps on every recompute request, so a slow earlier run can never draw over a newer one
TIPS.ts_seg = 'A group found by the tree: a combination of conditions whose conversion rate is significantly higher than the rest of its parent group (p < 0.05), with at least the minimum number of clients.';
TIPS.ts_lift = 'Segment conversion rate ÷ overall conversion rate in the current selection.';
TIPS.ts_stab = 'Rate in each half of the window. Unstable = the halves differ by more than 30% (relative); thin = fewer than 5 converters in a half.';

/* ------------------------------------------------------------ statistics */
function segErf(x) {   // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
/** Two-sided two-proportion z-test with pooled variance. */
function segTwoPropP(c1, n1, c2, n2) {
  if (!n1 || !n2) return 1;
  const p = (c1 + c2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return 1;
  return 1 - segErf(Math.abs(c1 / n1 - c2 / n2) / se / Math.SQRT2);
}

/* ------------------------------------------------------------ population */
/** Explain-by candidates in the current slice: ID-like integer columns are off by default; constants are skipped. */
async function segCandidates() {
  const feats = treeFeatures().filter(f => !SEG_EXCLUDE.test(f.name));
  const parts = feats.map((f, i) => {
    const c = qi(f.name), x = f.kind === 'num' ? `TRY_CAST(${c} AS DOUBLE)` : `CAST(${c} AS VARCHAR)`;
    return `MIN(${x}) AS mn${i}, MAX(${x}) AS mx${i}, COUNT(${c}) AS nn${i}` + (f.kind === 'num' ? `, approx_count_distinct(${c}) AS d${i}, BOOL_AND(${x} = floor(${x})) AS int${i}` : '');
  });
  const r = await q1(`SELECT COUNT(*) AS n, COUNT(DISTINCT client_id) AS clients${parts.length ? ', ' + parts.join(', ') : ''} FROM data WHERE ${evalWhere()}`);
  return feats.map((f, i) => ({ ...f, constant: !r['nn' + i] || (r['mn' + i] === r['mx' + i] && r['nn' + i] === r.n),
    idLike: f.kind === 'num' && !!r['int' + i] && r.clients > 0 && r['d' + i] / r.clients > 0.8 }));
}
/** The records the tree is grown on. Client level: one row per client in the filtered window, target = converted on any
    row, features from ONE anchor row (the first positive row for converters, else a fixed pseudo-random row). */
function segPopSQL(unit, cols) {
  const W = evalWhere(), sel = cols.map(c => ', d.' + qi(c)).join('');
  if (unit === 'row') return `SELECT d.client_id, d.y, d.date AS __adate${sel} FROM data d WHERE ${W}`;
  return `WITH a AS (SELECT client_id, MAX(y) AS t,
        CASE WHEN MAX(y) = 1 THEN arg_min(__rid, date_diff('day', DATE '1970-01-01', date)::BIGINT * 4294967296 + __rid) FILTER (WHERE y = 1)
             ELSE arg_min(__rid, hash(client_id, date)) END AS rid
      FROM data WHERE ${W} GROUP BY client_id)
    SELECT a.client_id, a.t AS y, d.date AS __adate${sel} FROM a JOIN data d ON d.__rid = a.rid`;
}
/** Two halves of the filtered window for the stability check (needs ≥ 28 days). Client level uses the anchor date. */
async function segPeriods() {
  const r = await q1(`SELECT strftime(MIN(date), '%Y-%m-%d') AS a, strftime(MAX(date), '%Y-%m-%d') AS b, date_diff('day', MIN(date), MAX(date)) AS span FROM data WHERE ${evalWhere()}`);
  if (!(r.span >= 28)) return null;
  const mid = new Date((Date.parse(r.a) + Date.parse(r.b)) / 2).toISOString().slice(0, 10);
  return { mid, a: `${r.a} to before ${mid}`, b: `${mid} to ${r.b}` };
}

/* ------------------------------------------------------------ the tree */
/** Copy of growTree with a different objective and gates: node stats at the client grain; a split is taken only if each
    child has ≥ minClients unique clients AND a two-proportion z-test on the children's client conversion rates gives p < 0.05.
    Candidates come from splitCandidates (Gini-ranked, best first); the first one passing both gates is used. */
function growSegTree(Dt, { maxDepth, minClients, level }) {
  const stats = idx => {
    if (level === 'client') { let c = 0; for (const i of idx) c += Dt.y[i]; return { clients: idx.length, conv: c }; }
    const all = new Set(), pos = new Set(); for (const i of idx) { all.add(Dt.cid[i]); if (Dt.y[i]) pos.add(Dt.cid[i]); }
    return { clients: all.size, conv: pos.size };
  };
  let nextId = 0; const nodes = [];
  const make = (idx, depth, rule, parent, st) => {
    let e = 0; for (const i of idx) e += Dt.y[i];
    st ||= stats(idx);
    const nd = { id: nextId++, idx, n: idx.length, e, depth, rule, parent, children: [], clients: st.clients, conv: st.conv, rate: st.clients ? st.conv / st.clients : 0 };
    nodes.push(nd); return nd;
  };
  const root = make(Int32Array.from({ length: Dt.n }, (_, i) => i), 0, null, null);
  const queue = [root];
  while (queue.length) {
    const nd = queue.shift();
    if (nd.depth >= maxDepth || nd.e === 0 || nd.e === nd.n || nd.clients < 2 * minClients) continue;
    for (const c of splitCandidates(Dt, nd, minClients)) {
      const L = [], R = []; for (const i of nd.idx) (c.test(i) ? L : R).push(i);
      const Li = Int32Array.from(L), Ri = Int32Array.from(R), sL = stats(Li), sR = stats(Ri);
      if (sL.clients < minClients || sR.clients < minClients) continue;
      const p = segTwoPropP(sL.conv, sL.clients, sR.conv, sR.clients);
      if (!(p < 0.05)) continue;
      nd.split = { gain: c.gain, p };
      nd.children = [make(Li, nd.depth + 1, c.left, nd, sL), make(Ri, nd.depth + 1, c.right, nd, sR)];
      queue.push(...nd.children); break;
    }
  }
  for (const nd of nodes) delete nd.idx;
  return { root, nodes };
}

/** Full-data numbers for every node, in one query (validateTree's pattern): clients, converters (and rows), per period. */
async function segMeasure(tr, unit, cols, P) {
  const pop = segPopSQL(unit, cols);
  const A = P ? `__adate < DATE ${ql(P.mid)}` : null;
  const parts = tr.nodes.map(nd => {
    const c = pathSQL(nd), id = nd.id;
    if (unit === 'client') return `COUNT(*) FILTER (WHERE ${c}) AS n${id}, COUNT(*) FILTER (WHERE (${c}) AND y = 1) AS e${id}` + (P
      ? `, COUNT(*) FILTER (WHERE (${c}) AND ${A}) AS na${id}, COUNT(*) FILTER (WHERE (${c}) AND ${A} AND y = 1) AS ea${id}, COUNT(*) FILTER (WHERE (${c}) AND NOT ${A}) AS nb${id}, COUNT(*) FILTER (WHERE (${c}) AND NOT ${A} AND y = 1) AS eb${id}` : '');
    return `COUNT(*) FILTER (WHERE ${c}) AS r${id}, COUNT(*) FILTER (WHERE (${c}) AND y = 1) AS rp${id}, COUNT(DISTINCT client_id) FILTER (WHERE ${c}) AS n${id}, COUNT(DISTINCT client_id) FILTER (WHERE (${c}) AND y = 1) AS e${id}` + (P
      ? `, COUNT(DISTINCT client_id) FILTER (WHERE (${c}) AND ${A}) AS na${id}, COUNT(DISTINCT client_id) FILTER (WHERE (${c}) AND ${A} AND y = 1) AS ea${id}, COUNT(DISTINCT client_id) FILTER (WHERE (${c}) AND NOT ${A}) AS nb${id}, COUNT(DISTINCT client_id) FILTER (WHERE (${c}) AND NOT ${A} AND y = 1) AS eb${id}` : '');
  });
  const r = await q1(`SELECT ${parts.join(', ')} FROM (${pop})`);
  for (const nd of tr.nodes) {
    const id = nd.id, n = r['n' + id] || 0, e = r['e' + id] || 0;
    nd.full = { clients: n, conv: e, rate: n ? e / n : 0, rows: unit === 'row' ? r['r' + id] : n, posRows: unit === 'row' ? r['rp' + id] : e };
    if (P) {
      const half = k => ({ n: r[`n${k}${id}`] || 0, e: r[`e${k}${id}`] || 0, rate: r[`n${k}${id}`] ? r[`e${k}${id}`] / r[`n${k}${id}`] : null });
      const a = half('a'), b = half('b');
      nd.stab = { a, b, thin: a.e < 5 || b.e < 5, unstable: fin(a.rate) && fin(b.rate) && (a.rate ? Math.abs(b.rate - a.rate) / a.rate > 0.3 : b.rate > 0) };
    }
  }
}
/** "How the model treats this segment": the Where it's wrong cutoff (top X%); client level ranks clients by their max score. */
async function tsModelView(nodes, unit, cols, cutPct) {
  const W = evalWhere(), seg = nodes.map(nd => ({ id: nd.id, c: pathSQL(nd) }));
  const agg = () => seg.map(({ id, c }) => `COUNT(*) FILTER (WHERE ${c}) AS n${id}, COUNT(*) FILTER (WHERE (${c}) AND __flag) AS f${id}, COUNT(*) FILTER (WHERE (${c}) AND __flag AND y = 1) AS tp${id}, COUNT(*) FILTER (WHERE (${c}) AND y = 1) AS p${id}`).join(', ');
  const sql = unit === 'client'
    ? `WITH snap AS (${segPopSQL('client', cols)}),
        ms AS (SELECT client_id, MAX(score) AS ms FROM data WHERE ${W} GROUP BY 1),
        fl AS (SELECT client_id, (row_number() OVER (ORDER BY ms DESC, hash(client_id))) <= CEIL(${cutPct / 100} * COUNT(*) OVER () - 1e-9) AS __flag FROM ms)
      SELECT ${agg()} FROM snap JOIN fl USING (client_id)`
    : `SELECT ${agg()} FROM (${flaggedSQL('row', cutPct, ['client_id', 'y', ...cols.map(qi)].join(', '))})`;
  const r = await q1(sql), out = new Map();
  for (const { id } of seg) { const n = r['n' + id] || 0, f = r['f' + id] || 0, tp = r['tp' + id] || 0, p = r['p' + id] || 0; out.set(id, { flaggedShare: div(f, n), precision: div(tp, f), caught: div(tp, p), n, f, tp, p }); }
  return out;
}

/* ------------------------------------------------------------ compute (cached per S.ver + settings) */
function segCompute() {
  const U = tsState();
  const key = `${S.ver}|ts|${U.unit}|${U.depth}|${U.minClients}|${U.off.join(',')}|${U.on.join(',')}|${segState().cutPct}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = busy.wrap(async () => {
    const cands = await segCandidates();
    const use = cands.filter(f => !f.constant && !U.off.includes(f.name) && (!f.idLike || U.on.includes(f.name)));
    const cols = use.map(f => f.name);
    const pop = segPopSQL(U.unit, cols);
    const tot = await q1(`SELECT COUNT(*) AS rows, COUNT(DISTINCT client_id) AS clients, COUNT(DISTINCT client_id) FILTER (WHERE y = 1) AS conv, COALESCE(SUM(y), 0) AS posRows FROM data WHERE ${evalWhere()}`);
    const out = { cands, use, tot, unit: U.unit, tree: null, sampled: false };
    if (!tot.conv || tot.conv === tot.clients || !use.length) return out;
    // grow on the full population at client level; at row level on a sample of WHOLE clients above ~200k rows
    let where = '';
    if (U.unit === 'row' && tot.rows > TS_MAX_ROWS) { const k = Math.ceil(TS_MAX_ROWS / tot.rows * 1000003); where = `WHERE hash(client_id) % 1000003 < ${k}`; out.sampled = true; }
    const sel = use.map((f, i) => (f.kind === 'num' ? `COALESCE(TRY_CAST(${qi(f.name)} AS DOUBLE), 'NaN'::DOUBLE) AS f${i}` : `COALESCE(CAST(${qi(f.name)} AS VARCHAR), '(null)') AS f${i}`));
    const t = await DB.conn.query(`SELECT client_id, CAST(y AS TINYINT) AS y${sel.map(x => ', ' + x).join('')} FROM (${pop}) ${where}`);
    const y = t.getChild('y').toArray();
    const d = { n: t.numRows, cols: { client_id: t.getChild('client_id').toArray(), y, e: y, f: use.map((f, i) => (f.kind === 'num' ? new Float64Array(t.getChild('f' + i).toArray()) : t.getChild('f' + i).toArray())) } };
    const Dt = prepTree(d, use);   // target in place of the error flag: Dt.y = converted
    out.sampleRows = d.n; out.sampleClients = new Set(d.cols.client_id).size;
    const tr = growSegTree(Dt, { maxDepth: U.depth, minClients: U.minClients, level: U.unit });
    out.period = await segPeriods();
    await segMeasure(tr, U.unit, cols, out.period);
    out.model = await tsModelView(tr.nodes.filter(nd => !nd.children.length || nd === tr.root), U.unit, cols, segState().cutPct);
    out.tree = tr; out.cols = cols;
    return out;
  }, 'Finding top segments…');
  S.cache.set(key, p); p.catch(() => S.cache.delete(key));
  return p;
}
/** Segments = leaves converting above average with enough clients and converters; numbered by rate (stable across sorts). */
function segSelect(res) {
  const U = tsState(), tr = res.tree, root = tr.root.full;
  const segs = tr.nodes.filter(nd => !nd.children.length && nd.full.rate > root.rate && nd.full.clients >= U.minClients && nd.full.conv >= U.minConv)
    .sort((a, b) => b.full.rate - a.full.rate || b.full.clients - a.full.clients).slice(0, U.maxSegs);
  segs.forEach((nd, i) => { nd.segNo = i + 1; });
  tr.nodes.forEach(nd => { if (!segs.includes(nd)) delete nd.segNo; });
  return segs;
}

/* ------------------------------------------------------------ view */
async function topSegmentsView(host, v) {
  if (!host) return;
  const U = tsState();
  html(host, `<section class="card" id="ts-head">
      <div class="card-head"><div class="titles"><div class="eyebrow">Top segments ${tip('ts_seg')}</div>
        <h3 style="margin-top:4px">What influences <b>conversion within ${S.settings.horizon} days</b> to be <b>Yes</b>?</h3>
        <div class="sub" id="ts-scope">${computing('Reading the selection…')}</div></div></div>
      <div class="toolbar" style="margin:4px 0 0">
        <span class="inline small">Unit ${segHTML('tsunit', [{ v: 'client', label: 'Clients', tip: 'One record per client: converted if any row converted; conditions are read from the client\'s first converting row, or a fixed pseudo-random row for non-converters.' }, { v: 'row', label: 'Rows', tip: 'Every client-day is a record; sizes, rates and significance tests still count unique clients.' }], U.unit)}</span>
        <label class="inline small">Depth <select id="ts-depth">${[2, 3, 4, 5, 6].map(d => `<option ${d === U.depth ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="inline small">Min. segment <input type="number" id="ts-minc" min="10" step="10" value="${U.minClients}" style="width:80px"> clients</label>
        <label class="inline small">Min. converters <input type="number" id="ts-minv" min="1" step="1" value="${U.minConv}" style="width:64px"></label>
        <label class="inline small">Max. segments <select id="ts-max">${[3, 4, 5, 6, 8, 10].map(d => `<option ${d === U.maxSegs ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <span class="inline small">Sort by ${segHTML('tssort', [{ v: 'rate', label: 'Rate' }, { v: 'size', label: 'Size' }], U.sort)}</span>
      </div>
      <div id="ts-explain" style="margin-top:12px"></div>
    </section>
    <div id="ts-body" style="margin-top:20px">${computing('Finding top segments…')}</div>`);
  const regrow = () => tsBody(host, v);
  const later = debounce(regrow, 450);
  bindSeg(host, 'tsunit', u => { U.unit = u; regrow(); });
  bindSeg(host, 'tssort', s => { U.sort = s; regrow(); });
  $('#ts-depth', host).onchange = e => { U.depth = +e.target.value; later(); };
  $('#ts-max', host).onchange = e => { U.maxSegs = +e.target.value; later(); };
  $('#ts-minc', host).oninput = e => { U.minClients = Math.max(10, Math.round(+e.target.value || 100)); later(); };
  $('#ts-minv', host).oninput = e => { U.minConv = Math.max(1, Math.round(+e.target.value || 10)); later(); };
  await tsBody(host, v);
}
async function tsBody(host, v) {
  const U = tsState(), tok = ++TS_TOK, body = $('#ts-body', host);
  const live = () => !stale(v) && tok === TS_TOK && host.isConnected;
  html(body, computing('Finding top segments…'));
  let res;
  try { res = await segCompute(); } catch (e) { console.error(e); if (live()) html(body, callout('bad', `Top segments could not be computed: ${esc(e.message)}`)); return; }
  if (!live()) return;
  const T = res.tot, overall = div(T.conv, T.clients);
  const scope = [`${S.settings.d0} → ${S.settings.d1}`, ...(S.roles.split && S.settings.split !== null ? [`split ${esc(S.settings.split)}`] : []), ...S.filters.map(f => esc(filterText(f))), ...S.cohorts.map(c => `cohort ${esc(c.name)}`)];
  html($('#ts-scope', host), `Scope: ${scope.join(' · ')} — <b>${fmtInt(T.clients)}</b> clients, <b>${fmtInt(T.conv)}</b> converters, overall rate <b>${fmtPct(overall, 1)}</b>${res.unit === 'row' ? ` · ${fmtInt(T.rows)} client-days` : ''}`);
  tsExplainChips(host, res, () => tsBody(host, v));
  if (T.conv < U.minConv) { html(body, `<div class="card">${empty(`Not enough converters to find segments (need ${fmtInt(U.minConv)}, have ${fmtInt(T.conv)})`, 'Widen the filters or the evaluation window.')}</div>`); return; }
  if (T.clients - T.conv < 10) { html(body, `<div class="card">${empty(`Not enough non-converting clients to compare against (need 10, have ${fmtInt(T.clients - T.conv)})`)}</div>`); return; }
  if (!res.use.length) { html(body, `<div class="card">${empty('No explain-by fields selected', 'Every candidate field is excluded, ID-like or constant in this selection. Re-enable a field above.')}</div>`); return; }
  const tr = res.tree, segs = segSelect(res), root = tr.root.full;
  const warn = T.conv < 100 ? callout('warn', `Only ${fmtInt(T.conv)} converters in this selection (Power BI asks for at least 100): treat segments as leads.`) : '';
  const sampled = res.sampled ? callout('neutral', `The selection has ${fmtInt(T.rows)} client-days; the tree was grown on a sample of ${fmtInt(res.sampleClients)} whole clients (${fmtInt(res.sampleRows)} rows). Every number shown is recomputed on the full selection.`) : '';
  if (!segs.length) {
    html(body, `${warn}${sampled}<div class="card">${empty(`No segments found: no group of at least ${fmtInt(U.minClients)} clients converts significantly above average.`, 'Lower the minimum size or widen the filters.')}</div>`);
    return;
  }
  let sel = segs.find(nd => pathSQL(nd) === U.sel) || segs[0]; U.sel = pathSQL(sel);
  const shown = U.sort === 'size' ? segs.slice().sort((a, b) => b.full.clients - a.full.clients) : segs;
  html(body, `${warn}${sampled}
    <section class="card"><div class="card-head"><div class="titles"><h3>${plural(segs.length, 'segment')} convert above the ${fmtPct(overall, 1)} average</h3>
      <div class="sub">Higher bubble = higher conversion rate; bubble area = clients. Click a bubble to see its conditions. Sorted by ${U.sort === 'size' ? 'size' : 'rate'}.</div></div></div>
      <div class="chart" id="ts-bub" style="height:300px"></div></section>
    <section class="card" id="ts-detail" style="margin-top:20px"></section>
    <section class="card" style="margin-top:20px"><div class="card-head"><div class="titles"><h3>Segment tree</h3>
      <div class="sub">Circle size = clients; colour = conversion rate. Outlined, badged leaves are segments; grey leaves are not above average or too small. Click a node or bubble to select.</div></div></div>
      <div class="tree-wrap"><div class="tree-svg" id="ts-tree"></div></div></section>
    <section class="card" style="margin-top:20px"><div class="card-head"><div class="titles"><h3>Segments</h3></div></div><div id="ts-tbl"></div></section>`);
  const pick = nd => { U.sel = pathSQL(nd); sel = nd; drawSelected(); };
  const drawSelected = () => {
    tsBubbles(shown, overall, sel, pick);
    tsDetail(sel, res, overall);
    html($('#ts-tree', host), segTreeSVG(tr, sel.id));
    const box = $('#ts-tree', host), dot = $(`#ts-tree .tnode[data-id="${sel.id}"] circle`, host);   // keep the selected segment in view
    if (box && dot) box.scrollLeft = Math.max(0, +dot.getAttribute('cx') - box.clientWidth / 2);
    $$('#ts-tree .tnode', host).forEach(g => { const nd = tr.nodes.find(n => n.id === +g.dataset.id); const go = () => { if (nd.segNo) pick(nd); else tsNodeInfo(nd, overall); }; g.addEventListener('click', go); g.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); });
  };
  drawSelected();
  const P = res.period, rows = segs.map(nd => { const m = res.model.get(nd.id) || {};
    return { seg: nd.segNo, rules: mergedRules(pathRules(nd)).map(x => x.plain).join(' and '), clients: nd.full.clients, rows: nd.full.rows, conv: nd.full.conv, rate: nd.full.rate, lift: div(nd.full.rate, root.rate),
      pctClients: div(nd.full.clients, root.clients), pctConv: div(nd.full.conv, root.conv), stab: !P ? 'n/a (window < 28 days)' : nd.stab.thin ? 'thin' : nd.stab.unstable ? 'unstable' : 'stable',
      rateA: nd.stab?.a.rate, rateB: nd.stab?.b.rate, flagged: m.flaggedShare, precision: m.precision, caught: m.caught }; });
  renderTable($('#ts-tbl', host), {
    rows, exportName: `top_segments_${res.unit}`, sort: { key: 'seg', dir: 1 },
    columns: [{ key: 'seg', label: 'Segment', num: true, fmt: x => `S${x}` }, { key: 'rules', label: 'Conditions' }, { key: 'clients', label: 'Clients', num: true, fmt: fmtInt },
      ...(res.unit === 'row' ? [{ key: 'rows', label: 'Client-days', num: true, fmt: fmtInt }] : []),
      { key: 'conv', label: 'Converters', num: true, fmt: fmtInt }, { key: 'rate', label: 'Conversion', num: true, fmt: x => fmtPct(x, 1) }, { key: 'lift', label: 'Lift', num: true, fmt: x => fmtX(x, 1), tip: 'ts_lift' },
      { key: 'pctClients', label: '% of clients', num: true, fmt: x => fmtPct(x, 1) }, { key: 'pctConv', label: '% of converters', num: true, fmt: x => fmtPct(x, 1) },
      { key: 'stab', label: 'Stability', tip: 'ts_stab', fmt: x => (x === 'stable' ? '<span class="dim">stable</span>' : x.startsWith('n/a') ? `<span class="dim">${x}</span>` : flag(x, x === 'unstable' ? 'bad' : 'na')) },
      { key: 'flagged', label: `In top ${segState().cutPct}%`, num: true, fmt: x => fmtPct(x, 0) }, { key: 'precision', label: 'Precision (flagged)', num: true, fmt: x => fmtPct(x, 1) }, { key: 'caught', label: 'Converters caught', num: true, fmt: x => fmtPct(x, 0) }],
  });
}
function tsExplainChips(host, res, regrow) {
  const U = tsState(), on = res.use.map(f => f.name);
  const ex = res.cands.filter(f => !f.constant), consts = res.cands.filter(f => f.constant);
  html($('#ts-explain', host), disc(`Explain by <span class="faint">(${on.length} of ${ex.length} fields)</span>`, `
    <div class="pill-select">${ex.map(f => { const isOn = on.includes(f.name); return `<label data-tip="${f.idLike ? 'Integer column with a distinct value for most clients: looks like an identifier, so it is excluded by default.' : f.kind === 'num' ? 'Numeric field' : 'Categorical field'}"><input type="checkbox" data-ts-f="${esc(f.name)}" ${isOn ? 'checked' : ''}> ${esc(f.name)}${f.idLike && !isOn ? ' <span class="faint">ID-like, excluded</span>' : ''}</label>`; }).join('')}</div>
    ${consts.length ? `<p class="faint" style="margin-top:8px">Constant in this selection, skipped: ${consts.map(f => esc(f.name)).join(', ')}.</p>` : ''}
    <p class="faint" style="margin-top:8px">Never used: identifiers, dates, the outcome and its timing (leakage), and model outputs.</p>`, { cls: 'line', open: !!(U.off.length || U.on.length), id: 'ts-explain-disc' }));
  $$('[data-ts-f]', host).forEach(cb => cb.onchange = () => {
    const f = cb.dataset.tsF, c = res.cands.find(x => x.name === f);
    U.off = U.off.filter(x => x !== f); U.on = U.on.filter(x => x !== f);
    if (c.idLike && cb.checked) U.on.push(f); else if (!c.idLike && !cb.checked) U.off.push(f);
    regrow();
  });
}
function tsBubbles(shown, overall, sel, pick) {
  const el = $('#ts-bub'); if (!el) return;
  const c = C(), maxN = Math.max(...shown.map(nd => nd.full.clients));
  plot(el, [{ type: 'scatter', mode: 'markers+text', x: shown.map((_, i) => i + 1), y: shown.map(nd => nd.full.rate), text: shown.map(nd => `S${nd.segNo}`), textposition: 'middle center',
    textfont: { color: shown.map(nd => (nd === sel ? '#fff' : c.text)), size: 12 }, customdata: shown.map(nd => [nd.segNo, pathName(nd), nd.full.clients, nd.full.conv]),
    marker: { size: shown.map(nd => nd.full.clients), sizemode: 'area', sizeref: 2 * maxN / (58 * 58), sizemin: 14, color: shown.map(nd => (nd === sel ? c.accent : rgba(c.accent, 0.45))), line: { color: shown.map(nd => (nd === sel ? c.text : c.surface)), width: 2 } },
    hovertemplate: '<b>Segment %{customdata[0]}</b><br>%{customdata[1]}<br>%{y:.1%} convert · %{customdata[2]:,} clients · %{customdata[3]:,} converters<extra></extra>' }],
  { showlegend: false, margin: { l: 56, r: 24, t: 16, b: 40 }, xaxis: { tickvals: shown.map((_, i) => i + 1), ticktext: shown.map(nd => `Segment ${nd.segNo}`), range: [0.4, shown.length + 0.6], showgrid: false },
    yaxis: { title: { text: 'Conversion rate' }, tickformat: '.0%', rangemode: 'tozero' },
    shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: overall, y1: overall, line: { color: c.text3, width: 1.5, dash: 'dash' } }],
    annotations: [{ xref: 'paper', x: 1, y: overall, text: `average ${fmtPct(overall, 1)}`, showarrow: false, xanchor: 'right', yanchor: 'bottom', font: { size: 11, color: c.text3 } }] });
  el.removeAllListeners?.('plotly_click');
  el.on?.('plotly_click', d => { const p = d.points?.[0]; if (p) pick(shown[p.pointIndex]); });
}
function tsDetail(nd, res, overall) {
  const host = $('#ts-detail'); if (!host) return;
  const f = nd.full, root = res.tree.root.full, m = res.model.get(nd.id) || {}, mo = res.model.get(res.tree.root.id) || {}, P = res.period, st = nd.stab;
  const pp = (f.rate - overall) * 100, lift = div(f.rate, overall);
  const badge = !P ? '<span class="faint">Stability not assessed (window shorter than 28 days)</span>' : st.thin ? flag('thin: fewer than 5 converters in a half', 'na') : st.unstable ? flag('unstable across the two halves', 'bad') : statusPill('good', 'Stable across both halves');
  html(host, `<div class="card-head"><div class="titles"><div class="eyebrow">Segment ${nd.segNo}</div>
      <h3 style="margin-top:4px">${mergedRules(pathRules(nd)).map(x => esc(x.plain)).join(' <span class="faint">and</span> ')}</h3></div>
      <div class="actions"><button class="btn sm primary" id="ts-cohort" data-tip="Adds these conditions as a global cohort (every tab). The cohort tests each client-day's own values.">Apply as cohort</button></div></div>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px">In this group, <b>${fmtPct(f.rate, 1)}</b> convert. The average is ${fmtPct(overall, 1)}, so this segment is <b>${fmtNum(pp, 1)} percentage points higher</b> (${fmtX(lift, 1)} the average). It contains about <b>${fmtPct(div(f.clients, root.clients), 1)}</b> of clients and <b>${fmtPct(div(f.conv, root.conv), 1)}</b> of all converters.</p>
    <div class="tiles">${tile('Clients', fmtInt(f.clients), { size: 'md', sub: res.unit === 'row' ? `${fmtInt(f.rows)} client-days` : '' })}${tile('Converters', fmtInt(f.conv), { size: 'md' })}${tile('Conversion rate', fmtPct(f.rate, 1), { size: 'md', hl: true, sub: `average ${fmtPct(overall, 1)}` })}${tile('Lift', fmtX(lift, 1), { size: 'md', tipKey: 'ts_lift' })}</div>
    <div style="margin-top:14px">${badge}${P ? `<span class="faint" style="margin-left:10px">${esc(P.a)}: ${fmtPct(st.a.rate, 1)} (${fmtInt(st.a.e)} of ${fmtInt(st.a.n)}) · ${esc(P.b)}: ${fmtPct(st.b.rate, 1)} (${fmtInt(st.b.e)} of ${fmtInt(st.b.n)})</span>` : ''}</div>
    <h4 style="margin-top:18px">How the model treats this segment</h4>
    <p class="faint" style="margin:4px 0 10px">Flag = top ${segState().cutPct}% of ${res.unit === 'client' ? 'clients by their highest score in the window' : 'client-days by score'} (the Where it's wrong cutoff). ${res.unit === 'row' ? 'Counts are client-days.' : ''}</p>
    <div class="tiles">${tile('Flagged', fmtPct(m.flaggedShare, 0), { size: 'md', sub: `${fmtPct(mo.flaggedShare, 0)} overall` })}${tile('Precision among flagged', fmtPct(m.precision, 1), { size: 'md', sub: `${fmtPct(mo.precision, 1)} overall` })}${tile('Converters caught', fmtPct(m.caught, 0), { size: 'md', sub: `${fmtPct(mo.caught, 0)} overall` })}</div>`);
  $('#ts-cohort').onclick = () => applyCohort(`Segment ${nd.segNo}: ${pathName(nd)}`, pathSQL(nd), pathPlain(nd));
}
function tsNodeInfo(nd, overall) {
  toast(`${nd.rule ? pathPlain(nd) : 'Everyone in the selection'}: ${fmtPct(nd.full.rate, 1)} convert (${fmtInt(nd.full.conv)} of ${fmtInt(nd.full.clients)} clients; average ${fmtPct(overall, 1)}). ${nd.children.length ? 'Internal node.' : 'Not a segment.'}`, 6000);
}
/** Modelled on treeSVG: size = clients, colour = conversion rate (full-data numbers), segments outlined and badged,
    other leaves greyed, the selected segment's path highlighted. */
function segTreeSVG(tr, selId) {
  const c = C(), leafW = 176, levelH = 122, top = 40;
  let leaves = 0; const px = new Map();
  const place = nd => { if (!nd.children.length) px.set(nd.id, leaves++); else { nd.children.forEach(place); px.set(nd.id, (px.get(nd.children[0].id) + px.get(nd.children[1].id)) / 2); } };
  place(tr.root);
  const depth = Math.max(...tr.nodes.map(n => n.depth));
  const W = Math.max(leaves * leafW, 640), off = (W - leaves * leafW) / 2, H = top + depth * levelH + 80;
  const X = nd => off + px.get(nd.id) * leafW + leafW / 2, Y = nd => top + nd.depth * levelH + 18;
  const maxRate = Math.max(...tr.nodes.map(n => n.full.rate)) || 1, sh = c.surface || '#ffffff';
  const fill = rate => `color-mix(in srgb, ${c.accent} ${Math.round(Math.min(1, rate / maxRate) * 85)}%, ${sh})`;
  const rad = nd => 7 + 22 * Math.sqrt(nd.full.clients / (tr.root.full.clients || 1));
  const path = new Set(); for (let x = tr.nodes.find(n => n.id === selId); x; x = x.parent) path.add(x.id);
  let edges = '', labels = '', circles = '';
  for (const nd of tr.nodes) {
    const leaf = !nd.children.length, grey = leaf && !nd.segNo;
    if (nd.parent) {
      const x1 = X(nd.parent), y1 = Y(nd.parent), x2 = X(nd), y2 = Y(nd), hot = path.has(nd.id);
      edges += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hot ? c.accent : c.axis}" stroke-width="${hot ? 3 : 1.5}"/>`;
      const full = ruleShort(nd.rule), txt = full.length > 26 ? full.slice(0, 25) + '…' : full, lx = x1 + (x2 - x1) * 0.6, ly = y1 + (y2 - y1) * 0.6, w = txt.length * 6.3 + 12;
      labels += `<g><title>${esc(full)}</title><rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="19" rx="9.5" fill="${sh}" stroke="${hot ? c.accent : c.grid}"/><text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="11" fill="${c.text2}">${esc(txt)}</text></g>`;
    }
    const r = rad(nd), sel = nd.id === selId;
    circles += `<g class="tnode" data-id="${nd.id}" tabindex="0" role="button" aria-label="${esc(nd.rule ? pathPlain(nd) : 'Everyone')}" opacity="${grey ? 0.42 : 1}"><title>${esc(nd.rule ? pathPlain(nd) : 'Everyone in the selection')}</title>
      <circle cx="${X(nd)}" cy="${Y(nd)}" r="${r}" fill="${grey ? c.surface : fill(nd.full.rate)}" stroke="${sel ? c.accent : nd.segNo ? c.text : c.axis}" stroke-width="${sel ? 3.5 : nd.segNo ? 2.2 : 1.2}"/>
      ${nd.segNo ? `<rect x="${X(nd) - 15}" y="${Y(nd) - r - 22}" width="30" height="17" rx="8.5" fill="${sel ? c.accent : c.text}"/><text x="${X(nd)}" y="${Y(nd) - r - 9.5}" text-anchor="middle" font-size="11" font-weight="700" fill="${sh}">S${nd.segNo}</text>` : ''}
      <text x="${X(nd)}" y="${Y(nd) + r + 15}" text-anchor="middle" font-size="12.5" font-weight="650" fill="${c.text}">${fmtPct(nd.full.rate, 1)}</text>
      <text x="${X(nd)}" y="${Y(nd) + r + 29}" text-anchor="middle" font-size="10.5" fill="${c.text3}">${fmtInt(nd.full.clients)} clients${nd.stab?.unstable ? ' ⚠' : ''}</text></g>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Top segments tree">${edges}${labels}${circles}</svg>`;
}
