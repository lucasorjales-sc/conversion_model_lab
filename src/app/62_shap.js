/* ==========================================================================
   62 · SHAP VALUES: detection, validation and aggregation
   SHAP values need the trained model and its input features, so they cannot be
   derived from a predictions file. They are read from columns exported next to
   the predictions (shap__<feature>, plus an optional shap_base_value) and are
   never imputed: rows without a complete set are counted and left out.
   Every aggregate is computed at the row grain (SHAP explains one prediction,
   i.e. one client-date row) over the same evaluation population as every tab.
   ========================================================================== */
const SHAP = { cache: new Map(), check: null };
const SHAP_COL = /^(?:shap|phi|contrib)(?:__|_|\.|:)(.+)$/i;
const SHAP_BASE = /^(?:shap_{1,2}(?:base_value|base|expected_value|bias)|expected_value|base_value)$/i;
const SHAP_TOL = 2e-3;   // additivity tolerance in output units (covers 5-decimal rounding across ~100 features)

/** Find SHAP columns in the uploaded file. At least two are required, so a lone column that happens to match is ignored. */
function detectShap(cols) {
  const base = cols.find(c => SHAP_BASE.test(c.name) && isNumericType(c.type));
  const found = cols.filter(c => c !== base && !SHAP_BASE.test(c.name) && SHAP_COL.test(c.name) && isNumericType(c.type))
    .map(c => ({ src: c.name, feature: c.name.match(SHAP_COL)[1] }));
  return found.length >= 2 ? { cols: found, base: base ? base.name : null } : { cols: [], base: null };
}
/** Describe the SHAP columns stored in `data` (as __shap0…, __shap_base), linked to each feature's own column when present. */
function shapSetup(det, others) {
  if (!det.cols.length) return null;
  const byLower = new Map(others.map(o => [o.src.toLowerCase(), o.name]));
  const cols = det.cols.map((c, k) => ({ k, src: c.src, feature: c.feature, col: `__shap${k}`, valueCol: byLower.get(c.feature.toLowerCase()) || null }));
  return { cols, baseSrc: det.base, hasBase: !!det.base, rowsSQL: `(${cols.map(c => `${c.col} IS NOT NULL`).join(' AND ')})`, sumSQL: `(${cols.map(c => c.col).join(' + ')})` };
}
const shapByFeature = f => S.shap.cols.find(c => c.feature === f);

/* ------------------------------------------------------------ validation */
/**
 * Coverage and additivity, computed once per file. SHAP values are additive: base + Σφ equals the model output the
 * explainer was run on. This tests that identity against PREDICTED_SCORE and PREDICTED_PROBABILITY, on the log-odds and
 * the identity scale, to establish the units and which column the values explain. Nothing is assumed.
 */
function shapCheck() {
  if (SHAP.check) return SHAP.check;
  SHAP.check = busy.wrap(async () => {
    const X = S.shap, R = X.rowsSQL;
    const cov = await q1(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ${R}) AS full, COUNT(DISTINCT client_id) FILTER (WHERE ${R}) AS clients,
        COUNT(*) FILTER (WHERE NOT ${R} AND (${X.cols.map(c => `${c.col} IS NOT NULL`).join(' OR ')})) AS partial
        ${X.hasBase ? ', MIN(__shap_base) AS bmin, MAX(__shap_base) AS bmax' : ''} FROM data`);
    const out = { cov, match: null, base: null, baseSource: null, rankCorr: null, units: 'model output units' };
    if (!cov.full) return out;
    const every = Math.max(1, Math.ceil(cov.full / 200000));   // deterministic sample of at most ~200k rows
    const samp = `SELECT score, prob, ${X.sumSQL} AS tot, ${X.hasBase ? '__shap_base' : 'CAST(NULL AS DOUBLE)'} AS b FROM data WHERE ${R}${every > 1 ? ` AND __hb % ${every} = 0` : ''}`;
    const targets = [['score', 'PREDICTED_SCORE'], ...(S.roles.prob ? [['prob', 'PREDICTED_PROBABILITY']] : [])];
    const parts = [];
    for (const [t] of targets) {
      const ok = `${t} > 0 AND ${t} < 1`, lg = `ln(CASE WHEN ${ok} THEN ${t} / (1 - ${t}) END)`;   // NULL, never an error, outside (0, 1)
      parts.push(`quantile_cont(abs(b + tot - ${lg}), 0.99) FILTER (WHERE ${ok}) AS e_${t}_logit, quantile_cont(abs(b + tot - ${t}), 0.99) AS e_${t}_id,
        stddev_samp(${lg} - tot) FILTER (WHERE ${ok}) AS sd_${t}_logit, AVG(${lg} - tot) FILTER (WHERE ${ok}) AS m_${t}_logit,
        stddev_samp(${t} - tot) AS sd_${t}_id, AVG(${t} - tot) AS m_${t}_id, COUNT(${t}) FILTER (WHERE ${ok}) AS n_${t}_in, COUNT(${t}) AS n_${t}`);
    }
    const r = await q1(`SELECT ${parts.join(', ')} FROM (${samp})`);
    for (const [t, label] of targets) {
      for (const link of ['logit', 'id']) {
        if (link === 'logit' && !(r[`n_${t}_in`] > 0.99 * r[`n_${t}`])) continue;   // log-odds needs a probability-like column
        const fits = X.hasBase ? r[`e_${t}_${link}`] < SHAP_TOL : r[`sd_${t}_${link}`] < SHAP_TOL;
        if (fits && !out.match) {
          out.match = { target: t, label, link, err: X.hasBase ? r[`e_${t}_${link}`] : r[`sd_${t}_${link}`] };
          out.base = X.hasBase ? null : r[`m_${t}_${link}`];
          out.baseSource = X.hasBase ? 'column' : 'inferred';
          out.units = link === 'logit' ? 'log-odds' : t === 'prob' || (S.info.st.smin >= 0 && S.info.st.smax <= 1) ? 'probability' : 'score units';
        }
      }
    }
    if (X.hasBase && !out.baseSource) out.baseSource = 'column';
    if (!out.match) {
      // Same ranking? (e.g. SHAP explains the raw output and the score was calibrated afterwards.) A monotone transform never
      // lowers the score as the SHAP output rises. A row violates that when some row with a clearly lower output (by more than
      // the rounding tolerance) has a higher score. Calibration ties are not violations (scores equal to 1e-6 relative, since
      // tied values written as float text can differ in the last digits).
      const rc = await q1(`SELECT corr(ra, rb) AS c, AVG(CASE WHEN score < pmax - 1e-6 * abs(pmax) - 1e-12 THEN 1.0 ELSE 0 END) AS viol FROM (
          SELECT score, MAX(score) OVER (ORDER BY f RANGE BETWEEN UNBOUNDED PRECEDING AND ${SHAP_TOL} PRECEDING) AS pmax,
            rank() OVER (ORDER BY f) AS ra, rank() OVER (ORDER BY score) AS rb
          FROM (SELECT score, tot + COALESCE(b, 0) AS f FROM (${samp})))`);
      out.rankCorr = rc.c; out.monotone = rc.viol !== null && rc.viol < 1e-3;
    }
    return out;
  }, 'Checking SHAP values…');
  SHAP.check.catch(() => { SHAP.check = null; });
  return SHAP.check;
}
/** The base value for a row (exported, or inferred from additivity); null when unknown. */
const shapBaseSQL = chk => (S.shap.hasBase ? '__shap_base' : fin(chk.base) ? String(chk.base) : null);
const sigmoid = x => 1 / (1 + Math.exp(-x));

/* ----------------------------------------------------------- aggregation */
/** A segment = feature filters + cohort conditions, evaluated inside today's global settings. */
const curSeg = () => ({ filters: S.filters.map(f => ({ ...f, vals: f.vals ? f.vals.slice() : undefined })), cohorts: S.cohorts.slice() });
const segEmpty = seg => !(seg.filters || []).length && !(seg.cohorts || []).length;
const segText = seg => [...(seg.filters || []).map(filterText), ...(seg.cohorts || []).map(c => `cohort ${c.name}`)].join(' · ') || 'Full evaluation population';
const shapWhere = seg => `(${evalWhere(S.settings, seg)}) AND ${S.shap.rowsSQL}`;

/**
 * Mean |SHAP|, mean SHAP and the mean positive / negative parts per feature over a segment, with client-clustered
 * standard errors (a client's rows are not independent). Cached by the full WHERE clause, so returning to a filter
 * set, or comparing a cohort again, costs nothing.
 */
function shapAgg(seg) {
  const W = shapWhere(seg);
  if (SHAP.cache.has(W)) return SHAP.cache.get(W);
  const p = busy.wrap(async () => {
    const cs = S.shap.cols;
    const inner = cs.map(c => `SUM(abs(${c.col})) AS a${c.k}, SUM(${c.col}) AS g${c.k}, SUM(GREATEST(${c.col}, 0)) AS p${c.k}`).join(', ');
    const outer = cs.map(({ k }) => `SUM(a${k}) AS xa${k}, SUM(a${k} * a${k}) AS xaa${k}, SUM(a${k} * cn) AS xab${k}, SUM(g${k}) AS xg${k}, SUM(g${k} * g${k}) AS xgg${k}, SUM(g${k} * cn) AS xgb${k}, SUM(p${k}) AS xp${k}`).join(', ');
    const r = await q1(`WITH c AS (SELECT client_id, COUNT(*)::DOUBLE AS cn, SUM(y)::DOUBLE AS cy, SUM(score) AS cs ${S.shap.hasBase ? ', SUM(__shap_base) AS cb' : ''}, ${inner}
        FROM data WHERE ${W} GROUP BY client_id)
      SELECT COUNT(*) AS m, SUM(cn) AS n, SUM(cy) AS pos, SUM(cs) AS ss, ${S.shap.hasBase ? 'SUM(cb)' : 'NULL'} AS sb, SUM(cn * cn) AS sbb, ${outer} FROM c`);
    const n = r.n || 0, m = r.m || 0;
    const se = (A, AA, AB) => { if (m < 2 || !n) return null; const t = A / n; return Math.sqrt(Math.max(0, m / (m - 1) * (AA - 2 * t * AB + t * t * r.sbb))) / n; };
    const feats = cs.map(({ k, feature, valueCol }) => {
      const A = r['xa' + k] || 0, G = r['xg' + k] || 0, P = r['xp' + k] || 0;
      return { feature, valueCol, k, abs: n ? A / n : null, signed: n ? G / n : null, up: n ? P / n : null, down: n ? (G - P) / n : null,
        seAbs: se(A, r['xaa' + k], r['xab' + k]), seSigned: se(G, r['xgg' + k], r['xgb' + k]) };
    }).sort((a, b) => (b.abs ?? 0) - (a.abs ?? 0));
    feats.forEach((f, i) => { f.rank = i + 1; });
    const totAbs = feats.reduce((a, f) => a + (f.abs || 0), 0);
    feats.forEach(f => { f.share = totAbs ? f.abs / totAbs : null; });
    const sumSigned = feats.reduce((a, f) => a + (f.signed || 0), 0);
    return { n, clients: m, pos: r.pos || 0, meanScore: n ? r.ss / n : null, meanBase: S.shap.hasBase && n ? r.sb / n : null, sumSigned, totAbs, feats };
  }, 'Aggregating SHAP values…');
  SHAP.cache.set(W, p);
  p.catch(() => SHAP.cache.delete(W));
  return p;
}
const shapMetric = (f, mode) => (mode === 'signed' ? f.signed : f.abs);
const shapSE = (f, mode) => (mode === 'signed' ? f.seSigned : f.seAbs);
/** Difference between two segment estimates; flagged when it exceeds its 95% interval. The interval treats the two
    segments as independent, which is conservative when one contains the other (the true difference is less noisy). */
function shapDiff(a, b, mode) {
  const x = shapMetric(a, mode), y = shapMetric(b, mode), sa = shapSE(a, mode), sb = shapSE(b, mode);
  if (!fin(x) || !fin(y)) return { d: null, sig: false };
  const d = x - y, s = fin(sa) && fin(sb) ? Math.sqrt(sa * sa + sb * sb) : null;
  return { d, sig: fin(s) && Math.abs(d) > 1.96 * s, ratio: div(x, y) };
}
/** Signed mean clearly on one side of zero (95%). */
const shapSide = f => (fin(f.signed) && fin(f.seSigned) && Math.abs(f.signed) > 1.96 * f.seSigned ? Math.sign(f.signed) : 0);

/* ------------------------------------------------------- one observation */
async function shapRow(rid, chk) {
  const cs = S.shap.cols, b = shapBaseSQL(chk);
  const r = await q1(`SELECT __rid, client_id, strftime(date, '%Y-%m-%d') AS date, y, score, prob, ${b ? `${b} AS base` : 'NULL AS base'},
      ${cs.map(c => `${c.col} AS s${c.k}`).join(', ')}${cs.filter(c => c.valueCol).map(c => `, CAST(${qi(c.valueCol)} AS VARCHAR) AS v${c.k}`).join('')}
    FROM data WHERE __rid = ${Math.round(rid)}`);
  if (r.__rid === undefined) return null;
  const contribs = cs.map(c => ({ feature: c.feature, valueCol: c.valueCol, value: c.valueCol ? r['v' + c.k] : undefined, phi: r['s' + c.k] }))
    .sort((a, b) => Math.abs(b.phi) - Math.abs(a.phi));
  const sum = contribs.reduce((a, c) => a + (c.phi || 0), 0);
  return { ...r, contribs, sum, out: fin(r.base) ? r.base + sum : null };
}
/** Feature value as text: numbers trimmed, empty as "missing". */
const fmtVal = v => { if (v === null || v === undefined || v === '') return 'missing'; const x = Number(v); return Number.isFinite(x) && String(v).trim() !== '' ? fmtT(x) : String(v); };
const fmtPhi = x => (fin(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(Math.abs(x) >= 1 ? 2 : Math.abs(x) >= 0.01 ? 3 : 4) : '—');
