/* ==========================================================================
   ANALYTICAL ENGINE (Web Worker)
   Holds a compact columnar copy of the evaluation data and answers metric
   requests. Every ranking metric in the app is computed here, by one code path.

   Ranking convention (documented in the app's methodology):
     records are ordered by score descending; tied scores are ordered by a fixed
     hash of (client_id, date) computed once in SQL (__hb), then by row id.
     - Top-K / top-X% selections take exactly K = ceil(X × N) records in that
       order, so audience sizes are exact and reproducible.
     - ROC-AUC and average precision treat tied scores as one threshold
       (ties share credit), so they never depend on the tie-break.
   Uncertainty: rates use a client-clustered (ratio-estimator) variance turned
   into an effective sample size for a Wilson interval; pooled ranking metrics
   use a client-block (Poisson) bootstrap. Repeated rows of one client are never
   treated as independent.
   ========================================================================== */
'use strict';
let D = null;          // core arrays
let MASK = null;       // evaluation mask (Uint8Array, 1 = row in the evaluation population)
const RULES = new Map();  // id -> Uint8Array rule/flag masks (row-aligned)

self.onmessage = e => {
  const m = e.data;
  try {
    let out;
    switch (m.type) {
      case 'load': out = load(m.core); break;
      case 'mask': MASK = m.mask; out = maskSummary(); break;
      case 'rule': RULES.set(m.ruleId, m.mask); out = { ok: true }; break;
      case 'metrics': out = metrics(m.spec); break;
      case 'bootstrap': out = bootstrapCI(m.spec); break;
      case 'playground': out = playground(m.spec); break;
      case 'segments': out = segments(m.spec); break;
      case 'campaign': out = campaign(m.spec); break;
      case 'breaks': out = breaks(m.cfg); break;
      case 'units': out = unitsInfo(m.spec); break;
      case 'calibration': out = D.hasP ? calibration(buildUnits(m.spec.grain, 'overall').U, m.spec.bins || 10, m.spec.mode || 'quantile') : null; break;
      default: throw new Error('unknown message ' + m.type);
    }
    self.postMessage({ id: m.id, ok: true, out });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.stack) || err) });
  }
};

/* ---------------------------------------------------------------- load */
function load(core) {
  D = core;
  const n = D.n;
  // global ranking order: score desc, tie-break hash asc, row asc
  const ord = new Int32Array(n); for (let i = 0; i < n; i++) ord[i] = i;
  const s = D.s, hb = D.hb;
  ord.sort((a, b) => (s[b] - s[a]) || (hb[a] - hb[b]) || (a - b));
  D.order = ord;
  // day order (day asc, row asc) and client order (client asc, day asc, row asc)
  D.dayOrder = sortedIdx(n, (a, b) => (D.day[a] - D.day[b]) || (a - b));
  D.cliOrder = sortedIdx(n, (a, b) => (D.cli[a] - D.cli[b]) || (D.day[a] - D.day[b]) || (a - b));
  let maxDay = 0, maxCli = 0;
  for (let i = 0; i < n; i++) { if (D.day[i] > maxDay) maxDay = D.day[i]; if (D.cli[i] > maxCli) maxCli = D.cli[i]; }
  D.nDays = maxDay + 1; D.nCli = Math.max(D.nCli || 0, maxCli + 1);
  D.dayStart = new Int32Array(D.nDays + 1);
  for (let i = 0; i < n; i++) D.dayStart[D.day[i] + 1]++;
  for (let d = 0; d < D.nDays; d++) D.dayStart[d + 1] += D.dayStart[d];
  // purchases (conversion episodes): one entry per episode id
  let maxEp = -1; for (let i = 0; i < n; i++) if (D.ep[i] > maxEp) maxEp = D.ep[i];
  D.nEp = maxEp + 1;
  D.epCli = new Int32Array(D.nEp).fill(-1); D.epDay = new Int32Array(D.nEp).fill(-1);
  for (let i = 0; i < n; i++) if (D.ep[i] >= 0) { D.epCli[D.ep[i]] = D.cli[i]; D.epDay[D.ep[i]] = D.pday[i]; }
  // per-client purchase list (CSR, sorted by purchase day)
  const cnt = new Int32Array(D.nCli + 1);
  for (let e = 0; e < D.nEp; e++) if (D.epCli[e] >= 0) cnt[D.epCli[e] + 1]++;
  for (let c = 0; c < D.nCli; c++) cnt[c + 1] += cnt[c];
  const fill = cnt.slice(0, D.nCli), list = new Int32Array(Math.max(1, cnt[D.nCli]));
  for (let e = 0; e < D.nEp; e++) { const c = D.epCli[e]; if (c >= 0) list[fill[c]++] = e; }
  for (let c = 0; c < D.nCli; c++) {
    const a = cnt[c], b = cnt[c + 1];
    if (b - a > 1) { const sub = Array.from(list.subarray(a, b)).sort((x, y) => D.epDay[x] - D.epDay[y]); for (let k = 0; k < sub.length; k++) list[a + k] = sub[k]; }
  }
  D.cpStart = cnt; D.cpList = list;
  D.hasP = false; for (let i = 0; i < n && !D.hasP; i++) if (!Number.isNaN(D.p[i])) D.hasP = true;
  D.d0ms = Date.parse(D.d0 + 'T00:00:00Z');
  MASK = new Uint8Array(n).fill(1);
  return { n, nDays: D.nDays, nCli: D.nCli, nEp: D.nEp, hasP: D.hasP };
}
function sortedIdx(n, cmp) { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; a.sort(cmp); return a; }
function maskSummary() {
  let n = 0, pos = 0; const seen = new Uint8Array(D.nCli); let cl = 0;
  for (let i = 0; i < D.n; i++) if (MASK[i]) { n++; pos += D.y[i]; if (!seen[D.cli[i]]) { seen[D.cli[i]] = 1; cl++; } }
  return { n, pos, clients: cl };
}

/* ------------------------------------------------------------- helpers */
const fin = x => x !== null && x !== undefined && Number.isFinite(x);
const dv = (a, b) => (b > 0 ? a / b : null);
function quantile(arr, p) {
  const a = arr.filter(fin).sort((x, y) => x - y); if (!a.length) return null;
  const h = (a.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return a[lo] + (a[hi] - a[lo]) * (h - lo);
}
function mean(arr) { const a = arr.filter(fin); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function sd(arr) { const a = arr.filter(fin); if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const EXP_M1 = Math.exp(-1);
function poissonWeights(b, out) {   // Poisson(1) weight per client: the Poisson approximation of resampling clients with replacement
  const r = mulberry32(0x9E3779B1 ^ Math.imul(b + 1, 2654435761));
  for (let c = 0; c < out.length; c++) { let k = 0, p = r(); while (p > EXP_M1) { k++; p *= r(); } out[c] = k; }
  return out;
}
/** Wilson score interval for proportion r with (effective) sample size n. */
function wilson(r, n, z = 1.959964) {
  if (!fin(r) || !(n > 0)) return { lo: null, hi: null };
  const z2 = z * z, den = 1 + z2 / n, c = (r + z2 / (2 * n)) / den;
  const h = z * Math.sqrt(Math.max(0, r * (1 - r) / n + z2 / (4 * n * n))) / den;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
/** Client-clustered ratio: r = A/B with clusters; returns r, Wilson CI on the effective n, and m (#clusters with B>0). */
function clusterResult(A, B, Saa, Sbb, Sab, m) {
  const r = dv(A, B);
  if (r === null) return { r: null, lo: null, hi: null, m, neff: 0, num: A, den: B };
  let neff;
  if (m < 2) neff = Math.max(1, m);
  else {
    const ss = Saa - 2 * r * Sab + r * r * Sbb;
    const v = (m / (m - 1)) * Math.max(0, ss) / (B * B);
    neff = v > 0 ? Math.min(B, r * (1 - r) / v) : m;   // all-0 or all-1: fall back to #clusters (conservative)
    if (!(neff > 0)) neff = m;
  }
  const c = wilson(r, neff);
  return { r, lo: c.lo, hi: c.hi, m, neff, num: A, den: B };
}

/* ------------------------------------------------------------- periods */
function dateOf(day) { return new Date(D.d0ms + day * 864e5); }
function iso(day) { return dateOf(day).toISOString().slice(0, 10); }
/** Period id per day. Weeks start Monday (ISO); months are calendar months; all dates are calendar dates (no timezone shift). */
function periodMap(gran) {
  const pd = new Int32Array(D.nDays), labels = [], starts = [], ends = [];
  let last = null, id = -1;
  for (let d = 0; d < D.nDays; d++) {
    const dt = dateOf(d);
    let key;
    if (gran === 'day') key = d;
    else if (gran === 'week') { const wd = (dt.getUTCDay() + 6) % 7; key = d - wd; }   // day index of that week's Monday
    else if (gran === 'month') key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    else key = 0;
    if (key !== last) {
      id++; last = key;
      if (gran === 'day') labels.push(iso(d));
      else if (gran === 'week') labels.push(isoFromKeyDay(key));
      else if (gran === 'month') labels.push(`${Math.floor(key / 12)}-${String(key % 12 + 1).padStart(2, '0')}`);
      else labels.push('All');
      starts.push(d);
    }
    pd[d] = id; ends[id] = d;
  }
  return { pd, labels, starts, ends, nP: id + 1 };
}
function isoFromKeyDay(k) { return new Date(D.d0ms + k * 864e5).toISOString().slice(0, 10); }

/**
 * Evaluation units.
 *   row     : every eligible client-date row
 *   client  : one index row per client = its first eligible row (earliest date) in the window / period
 *   episode : one index row per client eligibility episode = first eligible row after each prior purchase
 * The index row's own label is the outcome (converted within the horizon after the index date).
 * Never the max score across the window.
 */
function buildUnits(grain, gran) {
  const n = D.n, U = new Uint8Array(n);
  const P = gran && gran !== 'overall' ? periodMap(gran) : null;
  if (grain === 'row') { for (let i = 0; i < n; i++) U[i] = MASK[i]; }
  else {
    const lastP = new Int32Array(D.nCli).fill(-1), lastE = new Int32Array(D.nCli).fill(-1);
    const order = D.dayOrder;
    for (let k = 0; k < n; k++) {
      const i = order[k]; if (!MASK[i]) continue;
      const c = D.cli[i], p = P ? P.pd[D.day[i]] : 0, e = grain === 'episode' ? D.epi[i] : 0;
      if (lastP[c] !== p || lastE[c] !== e) { U[i] = 1; lastP[c] = p; lastE[c] = e; }
    }
  }
  return { U, P };
}
function unitsInfo(spec) {
  const { U } = buildUnits(spec.grain, 'overall');
  let n = 0, pos = 0; for (let i = 0; i < D.n; i++) if (U[i]) { n++; pos += D.y[i]; }
  return { n, pos };
}

/* ------------------------------------------------------- ranking pass */
/**
 * One pass over the global order, grouped by G (Int32Array of group per row, or null = one group).
 * ks: capacity fractions. w: optional per-client weights (bootstrap). Returns per-group arrays.
 * If selOut is given (Uint8Array), marks rows selected at ks[selK] (unweighted only).
 */
function rankPass(U, G, nG, ks, w, opts = {}) {
  const { s, y, cli } = D, ord = D.order, n = D.n, nk = ks.length;
  const W = new Float64Array(nG), Pw = new Float64Array(nG);
  for (let i = 0; i < n; i++) {
    if (!U[i]) continue;
    const wt = w ? w[cli[i]] : 1; if (!wt) continue;
    const g = G ? G[i] : 0; if (g < 0) continue;
    W[g] += wt; if (y[i]) Pw[g] += wt;
  }
  const thr = new Float64Array(nG * nk);
  for (let g = 0; g < nG; g++) for (let k = 0; k < nk; k++) thr[g * nk + k] = ks[k] * W[g] - 1e-9;
  const negAbove = new Float64Array(nG), disc = new Float64Array(nG), tpCum = new Float64Array(nG), nCum = new Float64Array(nG), apSum = new Float64Array(nG);
  const lastS = new Float64Array(nG).fill(NaN), gp = new Float64Array(nG), gn = new Float64Array(nG), cum = new Float64Array(nG);
  const selN = new Float64Array(nG * nk), selTP = new Float64Array(nG * nk), sumS = new Float64Array(nG);
  const lastSelS = opts.ties ? new Float64Array(nk).fill(NaN) : null;
  const curve = opts.curve ? [] : null;
  const selOut = opts.selOut || null, selK = opts.selK ?? -1;
  const flush = g => {
    const a = gp[g], b = gn[g]; if (a + b <= 0) return;
    disc[g] += a * negAbove[g] + 0.5 * a * b;
    negAbove[g] += b; tpCum[g] += a; nCum[g] += a + b; apSum[g] += a * (tpCum[g] / nCum[g]);
    if (curve) curve.push([tpCum[g], nCum[g], lastS[g]]);
    gp[g] = 0; gn[g] = 0;
  };
  for (let q = 0; q < n; q++) {
    const i = ord[q]; if (!U[i]) continue;
    const wt = w ? w[cli[i]] : 1; if (!wt) continue;
    const g = G ? G[i] : 0; if (g < 0) continue;
    const sv = s[i];
    if (sv !== lastS[g]) { flush(g); lastS[g] = sv; }
    if (y[i]) gp[g] += wt; else gn[g] += wt;
    sumS[g] += wt * sv;
    const base = g * nk, cb = cum[g];
    for (let k = 0; k < nk; k++) {
      if (cb < thr[base + k]) {
        selN[base + k] += wt; if (y[i]) selTP[base + k] += wt;
        if (lastSelS) lastSelS[k] = sv;
        if (selOut && k === selK) selOut[i] = 1;
      }
    }
    cum[g] = cb + wt;
  }
  for (let g = 0; g < nG; g++) flush(g);
  const out = { nG, nk, W, Pw, selN, selTP, sumS, auc: new Float64Array(nG), ap: new Float64Array(nG), curve };
  for (let g = 0; g < nG; g++) {
    const P = Pw[g], N = W[g] - Pw[g];
    out.auc[g] = P > 0 && N > 0 ? 1 - disc[g] / (P * N) : NaN;
    out.ap[g] = P > 0 ? apSum[g] / P : NaN;
  }
  if (lastSelS) {   // tie bookkeeping at each cutoff (pooled, unweighted)
    const inT = new Float64Array(nk), allT = new Float64Array(nk);
    for (let q = 0, cnt = 0; q < n; q++) {
      const i = ord[q]; if (!U[i]) continue;
      for (let k = 0; k < nk; k++) if (s[i] === lastSelS[k]) { allT[k]++; if (cnt < thr[k]) inT[k]++; }
      cnt++;
    }
    out.ties = Array.from({ length: nk }, (_, k) => ({ score: lastSelS[k], tiedTotal: allT[k], tiedSelected: inT[k] }));
  }
  return out;
}

/**
 * Client-clustered ratio accumulators. Groups by G (or one group); for each pair [numArr, denArr] of 0/1 indicators
 * (null = constant 1), accumulates per (group, client) sums and returns clusterResult per group per pair.
 * Also returns distinct clients per group (clusters with any unit).
 */
function clusterPass(U, G, nG, pairs) {
  const ord = D.cliOrder, n = D.n, np = pairs.length, cli = D.cli;
  const curC = new Int32Array(nG).fill(-1);
  const ca = new Float64Array(nG * np), cb = new Float64Array(nG * np);
  const A = new Float64Array(nG * np), B = new Float64Array(nG * np), Saa = new Float64Array(nG * np), Sbb = new Float64Array(nG * np), Sab = new Float64Array(nG * np), M = new Float64Array(nG * np);
  const clients = new Float64Array(nG);
  const flush = g => {
    for (let p = 0; p < np; p++) {
      const k = g * np + p, a = ca[k], b = cb[k];
      if (b > 0 || a > 0) { A[k] += a; B[k] += b; Saa[k] += a * a; Sbb[k] += b * b; Sab[k] += a * b; if (b > 0) M[k]++; }
      ca[k] = 0; cb[k] = 0;
    }
  };
  for (let q = 0; q < n; q++) {
    const i = ord[q]; if (!U[i]) continue;
    const g = G ? G[i] : 0; if (g < 0) continue;
    const c = cli[i];
    if (curC[g] !== c) { if (curC[g] >= 0) flush(g); curC[g] = c; clients[g]++; }
    for (let p = 0; p < np; p++) {
      const pr = pairs[p], k = g * np + p;
      ca[k] += pr[0] ? pr[0][i] : 1;
      cb[k] += pr[1] ? pr[1][i] : 1;
    }
  }
  for (let g = 0; g < nG; g++) if (curC[g] >= 0) flush(g);
  const res = [];
  for (let g = 0; g < nG; g++) {
    const row = [];
    for (let p = 0; p < np; p++) { const k = g * np + p; row.push(clusterResult(A[k], B[k], Saa[k], Sbb[k], Sab[k], M[k])); }
    res.push(row);
  }
  return { res, clients };
}

/* ---------------------------------------------------------- metrics */
const DEFAULT_KS = [0.01, 0.05, 0.10, 0.20, 0.30];
function metrics(spec) {
  const ks = spec.ks || DEFAULT_KS, gran = spec.gran || 'overall';
  const t0 = Date.now();
  if (gran === 'overall') return { ...pooledMetrics(spec.grain, ks, spec), ms: Date.now() - t0 };
  return { ...periodMetrics(spec, ks), ms: Date.now() - t0 };
}

function pooledMetrics(grain, ks, spec) {
  const { U } = buildUnits(grain, 'overall');
  const n = D.n, y = D.y, cli = D.cli;
  const k10 = ks.indexOf(0.10) >= 0 ? ks.indexOf(0.10) : 0;
  const sel10 = new Uint8Array(n);
  const R = rankPass(U, null, 1, ks, null, { curve: true, ties: true, selOut: sel10, selK: k10 });
  const N = R.W[0], P = R.Pw[0], prev = dv(P, N);
  // distinct clients & clustered CIs
  const selMasks = ks.map((k, j) => j === k10 ? sel10 : null);
  // per-capacity selection masks (needed for clustered CIs of precision/recall at every capacity)
  for (let j = 0; j < ks.length; j++) if (!selMasks[j]) { const m = new Uint8Array(n); rankPass(U, null, 1, [ks[j]], null, { selOut: m, selK: 0 }); selMasks[j] = m; }
  const yArr = y;
  const pairs = [[yArr, null]];
  const tpMasks = selMasks.map(m => { const t = new Uint8Array(n); for (let i = 0; i < n; i++) t[i] = m[i] & yArr[i]; return t; });
  ks.forEach((_, j) => { pairs.push([tpMasks[j], selMasks[j]]); pairs.push([tpMasks[j], yArr]); });
  const C = clusterPass(U, null, 1, pairs);
  const prevC = C.res[0][0];
  // distinct converting clients / episodes in the units, and captured at each capacity
  const convCli = new Uint8Array(D.nCli), epAll = new Uint8Array(Math.max(1, D.nEp));
  let nConvCli = 0, nEp = 0;
  for (let i = 0; i < n; i++) if (U[i] && y[i]) { if (!convCli[cli[i]]) { convCli[cli[i]] = 1; nConvCli++; } const e = D.ep[i]; if (e >= 0 && !epAll[e]) { epAll[e] = 1; nEp++; } }
  const capacity = ks.map((k, j) => {
    const sel = R.selN[j], tp = R.selTP[j], fp = sel - tp, fn = P - tp;
    const pc = C.res[0][1 + 2 * j], rc = C.res[0][2 + 2 * j];
    const precision = dv(tp, sel), recall = dv(tp, P);
    // distinct clients selected / converting clients captured / episodes captured
    const sc = new Uint8Array(D.nCli), cc = new Uint8Array(D.nCli), ec = new Uint8Array(Math.max(1, D.nEp));
    let nSelCli = 0, nCapCli = 0, nCapEp = 0;
    const m = selMasks[j];
    for (let i = 0; i < n; i++) if (m[i]) {
      const c = cli[i]; if (!sc[c]) { sc[c] = 1; nSelCli++; }
      if (y[i]) { if (!cc[c]) { cc[c] = 1; nCapCli++; } const e = D.ep[i]; if (e >= 0 && !ec[e]) { ec[e] = 1; nCapEp++; } }
    }
    return { k, sel, tp, fp, fn, tn: N - P - fp, precision, recall, lift: precision !== null && prev ? precision / prev : null,
      precLo: pc.lo, precHi: pc.hi, recLo: rc.lo, recHi: rc.hi, liftLo: pc.lo !== null && prev ? pc.lo / prev : null, liftHi: pc.hi !== null && prev ? pc.hi / prev : null,
      selClients: nSelCli, capClients: nCapCli, capEpisodes: nCapEp, ties: R.ties[j] };
  });
  // curves (PR, ROC, gains) downsampled to <= ~400 points
  const pts = R.curve, curve = [];
  const step = Math.max(1, Math.floor(pts.length / 400));
  for (let q = 0; q < pts.length; q++) if (q % step === 0 || q === pts.length - 1) {
    const [tp, nc, sv] = pts[q];
    curve.push({ s: sv, tpr: dv(tp, P), fpr: dv(nc - tp, N - P), prec: tp / nc, share: nc / N, n: nc });
  }
  // deciles (exact equal-count groups in ranking order)
  const dec = Array.from({ length: 10 }, (_, d) => ({ decile: d + 1, n: 0, pos: 0, smin: Infinity, smax: -Infinity, ssum: 0, psum: 0, pn: 0 }));
  { let r = 0; const ord = D.order;
    for (let q = 0; q < n; q++) { const i = ord[q]; if (!U[i]) continue; const d = Math.min(9, Math.floor(r * 10 / N)); r++;
      const x = dec[d]; x.n++; x.pos += y[i]; const sv = D.s[i]; if (sv < x.smin) x.smin = sv; if (sv > x.smax) x.smax = sv; x.ssum += sv; if (!Number.isNaN(D.p[i])) { x.psum += D.p[i]; x.pn++; } } }
  let cumPos = 0;
  dec.forEach(x => { cumPos += x.pos; x.rate = dv(x.pos, x.n); x.lift = x.rate !== null && prev ? x.rate / prev : null; x.cumRecall = dv(cumPos, P); x.meanS = dv(x.ssum, x.n); x.meanP = x.pn ? x.psum / x.pn : null; if (!x.n) { x.smin = null; x.smax = null; } });
  // score histogram per class (log10 axis when all scores > 0)
  const hist = scoreHist(U);
  const cal = spec.withCalibration !== false && D.hasP ? calibration(U, spec.calBins || 10, spec.calMode || 'quantile') : null;
  return {
    grain, n: N, pos: P, prev, prevLo: prevC.lo, prevHi: prevC.hi, clients: C.clients[0], convClients: nConvCli, episodes: nEp,
    auc: fin(R.auc[0]) ? R.auc[0] : null, ap: fin(R.ap[0]) ? R.ap[0] : null, meanScore: dv(R.sumS[0], N),
    capacity, curve, deciles: dec, hist, cal, ks,
  };
}

function scoreHist(U) {
  let mn = Infinity, mx = -Infinity; const s = D.s;
  for (let i = 0; i < D.n; i++) if (U[i]) { if (s[i] < mn) mn = s[i]; if (s[i] > mx) mx = s[i]; }
  if (!Number.isFinite(mn)) return null;
  const log = mn > 0, B = 40;
  const lo = log ? Math.log10(mn) : mn, hi = log ? Math.log10(mx) : mx, wdt = (hi - lo) / B || 1;
  const c0 = new Float64Array(B), c1 = new Float64Array(B);
  for (let i = 0; i < D.n; i++) if (U[i]) { const v = log ? Math.log10(s[i]) : s[i]; const b = Math.min(B - 1, Math.max(0, Math.floor((v - lo) / wdt))); if (D.y[i]) c1[b]++; else c0[b]++; }
  const centers = Array.from({ length: B }, (_, b) => { const c = lo + (b + 0.5) * wdt; return log ? Math.pow(10, c) : c; });
  return { log, centers, neg: Array.from(c0), pos: Array.from(c1) };
}

/* -------------------------------------------------------- calibration */
const BANDS = [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.000001];
function calibration(U, nBins, mode) {
  const n = D.n, p = D.p, y = D.y;
  const idx = []; let missing = 0;
  for (let i = 0; i < n; i++) if (U[i]) { if (Number.isNaN(p[i])) missing++; else idx.push(i); }
  const N = idx.length; if (!N) return { missing, n: 0 };
  idx.sort((a, b) => p[a] - p[b] || a - b);
  // equal-count bins (mode quantile) or fixed bands
  const G = new Int32Array(n).fill(-1);
  let nG;
  if (mode === 'bands') { nG = BANDS.length - 1; for (const i of idx) { let b = 0; while (b < nG - 1 && p[i] >= BANDS[b + 1]) b++; G[i] = b; } }
  else { nG = Math.min(nBins, N); for (let r = 0; r < N; r++) G[idx[r]] = Math.min(nG - 1, Math.floor(r * nG / N)); }
  const Ucal = new Uint8Array(n); for (const i of idx) Ucal[i] = 1;
  const C = clusterPass(Ucal, G, nG, [[y, null]]);
  const bins = Array.from({ length: nG }, (_, b) => ({ bin: b + 1, n: 0, pos: 0, psum: 0, pmin: Infinity, pmax: -Infinity }));
  let brier = 0, ll = 0, sumP = 0, sumY = 0;
  for (const i of idx) {
    const b = bins[G[i]], pi = p[i], yi = y[i];
    b.n++; b.pos += yi; b.psum += pi; if (pi < b.pmin) b.pmin = pi; if (pi > b.pmax) b.pmax = pi;
    brier += (pi - yi) ** 2; const pc = Math.min(1 - 1e-15, Math.max(1e-15, pi)); ll += -(yi ? Math.log(pc) : Math.log(1 - pc));
    sumP += pi; sumY += yi;
  }
  let ece = 0;
  bins.forEach((b, k) => {
    const cr = C.res[k][0];
    b.clients = C.clients[k]; b.meanP = dv(b.psum, b.n); b.rate = dv(b.pos, b.n); b.lo = cr.lo; b.hi = cr.hi;
    b.gap = b.meanP !== null && b.rate !== null ? b.meanP - b.rate : null;
    if (b.n) ece += b.n * Math.abs(b.gap); else { b.pmin = null; b.pmax = null; }
    if (mode === 'bands') { b.band = [BANDS[k], Math.min(1, BANDS[k + 1])]; }
  });
  // logistic recalibration diagnostics: slope from logit(y) ~ a + b·logit(p); calibration-in-the-large a | b = 1
  const lg = new Float64Array(N);
  for (let r = 0; r < N; r++) { const pc = Math.min(1 - 1e-12, Math.max(1e-12, p[idx[r]])); lg[r] = Math.log(pc / (1 - pc)); }
  const fit = logisticFit(idx, lg, y);
  const citl = interceptOnly(idx, lg, y);
  return {
    mode, n: N, missing, bins: bins.filter(b => b.n > 0), brier: brier / N, logloss: ll / N, meanP: sumP / N, rate: sumY / N,
    ratio: sumY > 0 ? (sumP / N) / (sumY / N) : null, ece: ece / N, slope: fit.b, intercept: fit.a, citl, converged: fit.ok,
    brierRef: (sumY / N) * (1 - sumY / N),   // Brier of always predicting the observed prevalence
  };
}
function logisticFit(idx, x, y) {   // IRLS for 2 parameters (closed-form 2×2 solve)
  let a = 0, b = 1, ok = false;
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let r = 0; r < idx.length; r++) {
      const eta = a + b * x[r], mu = 1 / (1 + Math.exp(-eta)), w = Math.max(1e-12, mu * (1 - mu)), e = y[idx[r]] - mu;
      g0 += e; g1 += e * x[r]; h00 += w; h01 += w * x[r]; h11 += w * x[r] * x[r];
    }
    const det = h00 * h11 - h01 * h01; if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db;
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) { ok = true; break; }
  }
  return { a: fin(a) ? a : null, b: fin(b) ? b : null, ok };
}
function interceptOnly(idx, x, y) {   // offset model: logit P(y) = a + logit(p)
  let a = 0;
  for (let it = 0; it < 40; it++) {
    let g = 0, h = 0;
    for (let r = 0; r < idx.length; r++) { const mu = 1 / (1 + Math.exp(-(a + x[r]))); g += y[idx[r]] - mu; h += Math.max(1e-12, mu * (1 - mu)); }
    const d = g / h; a += d; if (Math.abs(d) < 1e-10) break;
  }
  return fin(a) ? a : null;
}

/* ------------------------------------------------------ period metrics */
function periodMetrics(spec, ks) {
  const { grain, gran } = spec;
  const minPos = spec.minPos ?? 20;
  const { U, P } = buildUnits(grain, gran);
  const n = D.n, G = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (U[i]) G[i] = P.pd[D.day[i]];
  const nG = P.nP;
  const k10 = ks.indexOf(0.10) >= 0 ? ks.indexOf(0.10) : 0;
  const sel = new Uint8Array(n);
  const R = rankPass(U, G, nG, ks, null, { selOut: sel, selK: k10 });
  const tp = new Uint8Array(n); for (let i = 0; i < n; i++) tp[i] = sel[i] & D.y[i];
  const C = clusterPass(U, G, nG, [[D.y, null], [tp, sel], [tp, D.y]]);
  // calibration per period (probabilities only)
  const calAcc = D.hasP ? { n: new Float64Array(nG), sp: new Float64Array(nG), sy: new Float64Array(nG), br: new Float64Array(nG) } : null;
  if (calAcc) for (let i = 0; i < n; i++) if (U[i] && !Number.isNaN(D.p[i])) { const g = G[i]; calAcc.n[g]++; calAcc.sp[g] += D.p[i]; calAcc.sy[g] += D.y[i]; calAcc.br[g] += (D.p[i] - D.y[i]) ** 2; }
  // PSI of the score distribution vs the reference periods (default: the first period)
  const ref = (spec.refPeriods && spec.refPeriods.length ? spec.refPeriods : [0]).filter(x => x < nG);
  const refSet = new Uint8Array(nG); ref.forEach(r => refSet[r] = 1);
  const refScores = []; for (let i = 0; i < n; i++) if (U[i] && refSet[G[i]]) refScores.push(D.s[i]);
  refScores.sort((a, b) => a - b);
  const cuts = []; for (let q = 1; q < 10; q++) { const v = refScores.length ? refScores[Math.min(refScores.length - 1, Math.floor(q * refScores.length / 10))] : null; if (v !== null && (!cuts.length || v > cuts[cuts.length - 1])) cuts.push(v); }
  const K = cuts.length + 1, pc = new Float64Array(nG * K), refC = new Float64Array(K);
  const binOf = v => { let lo = 0, hi = cuts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v <= cuts[m]) hi = m; else lo = m + 1; } return lo; };
  for (let i = 0; i < n; i++) if (U[i]) { const b = binOf(D.s[i]); pc[G[i] * K + b]++; if (refSet[G[i]]) refC[b]++; }
  const refTot = refC.reduce((a, b) => a + b, 0) || 1, eps = 1e-4;
  const periods = [];
  for (let g = 0; g < nG; g++) {
    const N = R.W[g], Pp = R.Pw[g]; if (!N) continue;
    const j = k10, selN = R.selN[g * ks.length + j], selTP = R.selTP[g * ks.length + j];
    const prev = dv(Pp, N), precision = dv(selTP, selN), recall = dv(selTP, Pp);
    const cPrev = C.res[g][0], cPrec = C.res[g][1], cRec = C.res[g][2];
    const estimable = Pp > 0 && N - Pp > 0;
    let psi = 0; const tot = Array.from({ length: K }, (_, b) => pc[g * K + b]).reduce((a, b) => a + b, 0) || 1;
    for (let b = 0; b < K; b++) { const a = Math.max(pc[g * K + b] / tot, eps), r = Math.max(refC[b] / refTot, eps); psi += (a - r) * Math.log(a / r); }
    const row = {
      g, label: P.labels[g], start: iso(P.starts[g]), end: iso(P.ends[g]), days: P.ends[g] - P.starts[g] + 1,
      n: N, pos: Pp, clients: C.clients[g], prev, prevLo: cPrev.lo, prevHi: cPrev.hi,
      auc: estimable ? R.auc[g] : null, ap: estimable ? R.ap[g] : null, apRatio: estimable && prev ? R.ap[g] / prev : null,
      prec10: precision, prec10Lo: cPrec.lo, prec10Hi: cPrec.hi, rec10: Pp ? recall : null, rec10Lo: Pp ? cRec.lo : null, rec10Hi: Pp ? cRec.hi : null,
      lift10: Pp && precision !== null ? precision / prev : null, lift10Lo: Pp && cPrec.lo !== null ? cPrec.lo / prev : null, lift10Hi: Pp && cPrec.hi !== null ? cPrec.hi / prev : null,
      sel10: selN, tp10: selTP, meanScore: dv(R.sumS[g], N), psi: refScores.length ? psi : null, isRef: !!refSet[g],
      estimable, lowPos: estimable && Pp < minPos,
    };
    if (calAcc && calAcc.n[g]) { row.meanP = calAcc.sp[g] / calAcc.n[g]; row.brier = calAcc.br[g] / calAcc.n[g]; row.calRatio = calAcc.sy[g] ? row.meanP / (calAcc.sy[g] / calAcc.n[g]) : null; }
    periods.push(row);
  }
  // summaries of period metrics: unweighted mean of defined values (+ median, sd, range, count)
  const keys = ['prev', 'auc', 'ap', 'prec10', 'rec10', 'lift10', 'meanScore', 'brier', 'calRatio', 'psi'];
  const summary = {};
  for (const k of keys) {
    const all = periods.map(r => r[k]).filter(fin);
    const strong = periods.filter(r => !r.lowPos).map(r => r[k]).filter(fin);
    summary[k] = { mean: mean(all), median: quantile(all, 0.5), sd: sd(all), min: all.length ? Math.min(...all) : null, max: all.length ? Math.max(...all) : null,
      p25: quantile(all, 0.25), p75: quantile(all, 0.75), count: all.length, of: periods.length, meanStrong: mean(strong), countStrong: strong.length };
  }
  const pooled = pooledMetrics(grain, ks, { withCalibration: false });
  delete pooled.curve; delete pooled.hist; delete pooled.deciles;
  return { grain, gran, periods, summary, pooled, minPos, refLabels: ref.map(r => P.labels[r]) };
}

/* ------------------------------------------------- bootstrap (pooled) */
function bootstrapCI(spec) {
  const { U } = buildUnits(spec.grain, 'overall');
  const ks = spec.ks || DEFAULT_KS, B = spec.B || 200;
  const w = new Float32Array(D.nCli);
  const out = { auc: [], ap: [], prev: [], prec: ks.map(() => []), rec: ks.map(() => []), lift: ks.map(() => []) };
  for (let b = 0; b < B; b++) {
    poissonWeights(b, w);
    const R = rankPass(U, null, 1, ks, w);
    const N = R.W[0], P = R.Pw[0], prev = dv(P, N);
    out.auc.push(fin(R.auc[0]) ? R.auc[0] : null); out.ap.push(fin(R.ap[0]) ? R.ap[0] : null); out.prev.push(prev);
    ks.forEach((_, j) => { const pr = dv(R.selTP[j], R.selN[j]); out.prec[j].push(pr); out.rec[j].push(dv(R.selTP[j], P)); out.lift[j].push(pr !== null && prev ? pr / prev : null); });
  }
  const ci = a => ({ lo: quantile(a, 0.025), hi: quantile(a, 0.975) });
  return { B, auc: ci(out.auc), ap: ci(out.ap), prev: ci(out.prev), prec: out.prec.map(ci), rec: out.rec.map(ci), lift: out.lift.map(ci) };
}

/* ---------------------------------------------- threshold / top-X playground */
function playground(spec) {
  const { U } = buildUnits(spec.grain, 'overall');
  const n = D.n, y = D.y, ord = D.order, s = D.s, p = D.p;
  let N = 0, P = 0; for (let i = 0; i < n; i++) if (U[i]) { N++; P += y[i]; }
  const sel = new Uint8Array(n);
  const r = spec.rule;
  let K = 0, excludedNoProb = 0;
  if (r.type === 'pct' || r.type === 'n') {
    K = r.type === 'pct' ? Math.ceil(Math.min(1, Math.max(0, r.value)) * N - 1e-9) : Math.min(N, Math.max(0, Math.round(r.value)));
    for (let q = 0, c = 0; q < n && c < K; q++) { const i = ord[q]; if (!U[i]) continue; sel[i] = 1; c++; }
  } else {
    for (let i = 0; i < n; i++) if (U[i]) {
      if (r.type === 'raw') { if (s[i] >= r.value) { sel[i] = 1; K++; } }
      else if (Number.isNaN(p[i])) excludedNoProb++;
      else if (p[i] >= r.value) { sel[i] = 1; K++; }
    }
  }
  let tp = 0; const sc = new Uint8Array(D.nCli), cc = new Uint8Array(D.nCli), call = new Uint8Array(D.nCli), ec = new Uint8Array(Math.max(1, D.nEp)), eall = new Uint8Array(Math.max(1, D.nEp));
  let selCli = 0, capCli = 0, convCli = 0, capEp = 0, allEp = 0;
  let minSelS = Infinity;
  for (let i = 0; i < n; i++) {
    if (!U[i]) continue;
    const c = D.cli[i];
    if (y[i]) { if (!call[c]) { call[c] = 1; convCli++; } const e = D.ep[i]; if (e >= 0 && !eall[e]) { eall[e] = 1; allEp++; } }
    if (!sel[i]) continue;
    if (s[i] < minSelS) minSelS = s[i];
    if (!sc[c]) { sc[c] = 1; selCli++; }
    if (y[i]) { tp++; if (!cc[c]) { cc[c] = 1; capCli++; } const e = D.ep[i]; if (e >= 0 && !ec[e]) { ec[e] = 1; capEp++; } }
  }
  const tpArr = new Uint8Array(n); for (let i = 0; i < n; i++) tpArr[i] = sel[i] & y[i];
  const C = clusterPass(U, null, 1, [[tpArr, sel], [tpArr, y]]);
  const prev = dv(P, N), precision = dv(tp, K);
  // audience size per week under this rule vs a top-X rule with the same overall share (shows why thresholds drift)
  const Pm = periodMap(spec.periodGran || 'week');
  const nP = Pm.nP, pn = new Float64Array(nP), ps = new Float64Array(nP), pt = new Float64Array(nP), pp = new Float64Array(nP);
  for (let i = 0; i < n; i++) if (U[i]) { const g = Pm.pd[D.day[i]]; pn[g]++; pp[g] += y[i]; if (sel[i]) { ps[g]++; pt[g] += y[i]; } }
  const share = dv(K, N) || 0;
  const G = new Int32Array(n).fill(-1); for (let i = 0; i < n; i++) if (U[i]) G[i] = Pm.pd[D.day[i]];
  const RX = rankPass(U, G, nP, [share], null);
  const perPeriod = [];
  for (let g = 0; g < nP; g++) if (pn[g]) perPeriod.push({ label: Pm.labels[g], n: pn[g], pos: pp[g], sel: ps[g], tp: pt[g], share: ps[g] / pn[g], prec: dv(pt[g], ps[g]),
    topxSel: RX.selN[g], topxPrec: dv(RX.selTP[g], RX.selN[g]) });
  return {
    N, P, prev, K, tp, fp: K - tp, fn: P - tp, tn: N - P - (K - tp), precision, recall: dv(tp, P), lift: precision !== null && prev ? precision / prev : null,
    precLo: C.res[0][0].lo, precHi: C.res[0][0].hi, recLo: C.res[0][1].lo, recHi: C.res[0][1].hi,
    share, selClients: selCli, capClients: capCli, convClients: convCli, capEpisodes: capEp, episodes: allEp,
    minSelScore: Number.isFinite(minSelS) ? minSelS : null, excludedNoProb, perPeriod, periodGran: spec.periodGran || 'week',
  };
}

/* ------------------------------------------------------- segment metrics */
function segments(spec) {
  const { U } = buildUnits(spec.grain, 'overall');
  const n = D.n, y = D.y, k = spec.k ?? 0.1;
  const sel = new Uint8Array(n);
  const R0 = rankPass(U, null, 1, [k], null, { selOut: sel, selK: 0 });
  const N = R0.W[0], P = R0.Pw[0], prev = dv(P, N);
  const tp = new Uint8Array(n), fpA = new Uint8Array(n), neg = new Uint8Array(n);
  for (let i = 0; i < n; i++) { tp[i] = sel[i] & y[i]; neg[i] = U[i] && !y[i] ? 1 : 0; fpA[i] = sel[i] & neg[i]; }
  const overallSel = R0.selN[0], overallTP = R0.selTP[0];
  const overall = { n: N, pos: P, prev, sel: overallSel, tp: overallTP, precision: dv(overallTP, overallSel), recall: dv(overallTP, P), selRate: dv(overallSel, N) };
  overall.lift = overall.precision !== null && prev ? overall.precision / prev : null;
  let sumP = 0, nP = 0, sumS = 0; for (let i = 0; i < n; i++) if (U[i]) { sumS += D.s[i]; if (!Number.isNaN(D.p[i])) { sumP += D.p[i]; nP++; } }
  overall.meanP = nP ? sumP / nP : null; overall.meanS = dv(sumS, N);
  const cols = spec.cols || D.segs.map((_, j) => j);
  const result = [];
  for (const j of cols) {
    const seg = D.segs[j]; if (!seg) continue;
    const G = seg.codes, nG = seg.nCodes;
    const R = rankPass(U, G, nG, [], null);
    const C = clusterPass(U, G, nG, [[y, null], [tp, sel], [tp, y], [sel, null], [fpA, neg]]);
    const agg = Array.from({ length: nG }, () => ({ n: 0, pos: 0, sp: 0, pn: 0, ss: 0 }));
    for (let i = 0; i < n; i++) if (U[i]) { const g = G[i]; if (g < 0) continue; const a = agg[g]; a.n++; a.pos += y[i]; a.ss += D.s[i]; if (!Number.isNaN(D.p[i])) { a.sp += D.p[i]; a.pn++; } }
    const rows = [];
    for (let g = 0; g < nG; g++) {
      const a = agg[g]; if (!a.n) continue;
      const [cr, cp, crc, csr, cfp] = C.res[g];
      const rate = dv(a.pos, a.n), estimable = a.pos > 0 && a.pos < a.n;
      const precision = cp.r, recall = a.pos ? crc.r : null;
      rows.push({
        code: g, n: a.n, clients: C.clients[g], pos: a.pos, rate, rateLo: cr.lo, rateHi: cr.hi,
        meanP: a.pn ? a.sp / a.pn : null, meanS: a.ss / a.n, gapP: a.pn && rate !== null ? a.sp / a.pn - rate : null,
        sel: csr.num, selRate: csr.r, tp: cp.num, precision, precLo: cp.lo, precHi: cp.hi, recall, recLo: a.pos ? crc.lo : null, recHi: a.pos ? crc.hi : null,
        lift: precision !== null && prev ? precision / prev : null, liftLo: cp.lo !== null && prev ? cp.lo / prev : null, liftHi: cp.hi !== null && prev ? cp.hi / prev : null,
        fpr: cfp.r, aucIn: estimable ? R.auc[g] : null, apIn: estimable ? R.ap[g] : null,
      });
    }
    result.push({ col: j, rows });
  }
  return { grain: spec.grain, k, overall, segs: result };
}

/* ======================================================== CAMPAIGN SIMULATOR
   Simulates an actual contact schedule over the evaluation window.
   Pool at a send = clients whose most recent prediction as of the scoring snapshot is fresh
   (dated within `freshDays` of the snapshot), minus clients suppressed after a purchase.
   Snapshot = the latest rescoring date on or before the send (rescoring every `rescoreEvery` days
   from the first send; 0 = before every send; -1 = frozen at the first send).
   Outcome of a contact at send t: the client's earliest purchase P with t + lag <= P <= t + horizon.
   Each purchase (conversion episode) is counted at most once per strategy, however many contacts preceded it.
   ========================================================================== */
function campaign(spec) {
  const t0 = Date.now();
  const sendDays = computeSendDays(spec);
  const ctx = campaignContext(spec, sendDays);
  const results = [];
  for (const st of spec.strategies) {
    if (st.kind === 'random') {
      const runs = [];
      for (let r = 0; r < (spec.randomRuns || 20); r++) runs.push(runStrategy(spec, ctx, st, 'matched', r + 1));
      results.push(summarizeRandom(st, runs));
    } else {
      const matched = runStrategy(spec, ctx, st, 'matched', 0);
      const natural = (st.kind === 'rule' || st.kind === 'current' || st.kind === 'threshold') ? runStrategy(spec, ctx, st, 'natural', 0) : null;
      results.push({ id: st.id, kind: st.kind, label: st.label, matched, natural });
    }
  }
  // overlap between contacted client sets (model top-X vs every other deterministic strategy, matched)
  const base = results.find(r => r.kind === 'topx');
  if (base) for (const r of results) if (r !== base && r.matched && r.matched._cliSet) {
    const a = base.matched._cliSet, b = r.matched._cliSet; let both = 0, either = 0;
    for (let c = 0; c < a.length; c++) { if (a[c] && b[c]) both++; if (a[c] || b[c]) either++; }
    r.overlapWithModel = { both, jaccard: dv(both, either) };
  }
  let audience = null;
  if (spec.exportStrategy) { const r = results.find(x => x.id === spec.exportStrategy); audience = r?.matched?._contacts || null; }
  for (const r of results) { for (const k of ['matched', 'natural']) if (r[k]) { delete r[k]._cliSet; delete r[k]._contacts; } }
  return { sends: sendDays.map(d => iso(d)), ctx: { pools: ctx.poolSizes, reachable: ctx.reachableEpisodes, eligibleClients: ctx.eligibleClients, poolWouldConvert: ctx.poolWould, sends: sendDays.length },
    results, audience, ms: Date.now() - t0 };
}

function computeSendDays(spec) {
  const d0 = spec.d0 ?? 0, d1 = spec.d1 ?? D.nDays - 1;
  // only days with at least one eligible row can be send days
  const has = new Uint8Array(D.nDays);
  for (let i = 0; i < D.n; i++) if (MASK[i]) has[D.day[i]] = 1;
  const days = [];
  if (spec.cadence === 'daily') { for (let d = d0; d <= d1; d++) if (has[d]) days.push(d); }
  else {
    const P = periodMap(spec.cadence === 'weekly' ? 'week' : 'month');
    let lastP = -1;
    for (let d = d0; d <= d1; d++) { if (!has[d]) continue; const p = P.pd[d]; if (p !== lastP) { days.push(d); lastP = p; } }   // first scored day of each week / month
  }
  return days;
}

function campaignContext(spec, sendDays) {
  const fresh = Math.max(0, spec.freshDays | 0), lag = Math.max(0, spec.lag | 0), H = Math.max(1, spec.horizon | 0);
  const latest = new Int32Array(D.nCli).fill(-1);   // latest eligible row index per client as of a day
  const order = D.dayOrder; let ptr = 0;
  const snapAt = [];   // for each send: list of [cli, row]
  let lastSnap = null, lastSnapDay = -1;
  const first = sendDays.length ? sendDays[0] : 0;
  const eligStamp = new Uint8Array(D.nCli); let eligibleClients = 0;
  const suppressFrom = spec.suppress ? firstPurchaseDay(first) : null;
  const segOK = spec.eligibleSeg ? buildSegFilter(spec.eligibleSeg) : null;
  for (let si = 0; si < sendDays.length; si++) {
    const t = sendDays[si];
    // rescoring snapshot day
    let snapDay;
    if (spec.rescoreEvery === -1) snapDay = first;
    else if (!spec.rescoreEvery) snapDay = t;
    else snapDay = first + Math.floor((t - first) / spec.rescoreEvery) * spec.rescoreEvery;
    if (snapDay !== lastSnapDay) {
      while (ptr < D.n && D.day[order[ptr]] <= snapDay) { const i = order[ptr]; if (MASK[i]) latest[D.cli[i]] = i; ptr++; }
      const pool = [];
      for (let k = D.dayStart[Math.max(0, snapDay - fresh)]; k < D.n && D.day[order[k]] <= snapDay; k++) {
        const i = order[k]; if (!MASK[i]) continue; const c = D.cli[i];
        if (latest[c] === i) pool.push(i);   // the client's most recent row as of the snapshot, and it is fresh
      }
      lastSnap = pool; lastSnapDay = snapDay;
    }
    // apply suppression (purchased on or before the send) and eligibility filters at send time
    const pool = [];
    for (const i of lastSnap) {
      const c = D.cli[i];
      if (suppressFrom && suppressFrom[c] >= 0 && suppressFrom[c] <= t) continue;
      if (segOK && !segOK[i]) continue;
      if (spec.excludeCurrent && D.cur[i] === 1) continue;
      pool.push(i);
    }
    snapAt.push(pool);
    for (const i of pool) { const c = D.cli[i]; if (!eligStamp[c]) { eligStamp[c] = 1; eligibleClients++; } }
  }
  // strategy-independent denominators
  const reach = new Uint8Array(Math.max(1, D.nEp)); let reachable = 0; let poolWould = 0; const poolSizes = [];
  for (let si = 0; si < sendDays.length; si++) {
    const t = sendDays[si]; poolSizes.push(snapAt[si].length);
    for (const i of snapAt[si]) { const e = outcomeEpisode(D.cli[i], t, lag, H); if (e >= 0) { poolWould++; if (!reach[e]) { reach[e] = 1; reachable++; } } }
  }
  return { snapAt, sendDays, lag, H, poolSizes, reachableEpisodes: reachable, poolWould, eligibleClients, poolTotal: poolSizes.reduce((a, b) => a + b, 0) };
}
function firstPurchaseDay(minDay) {   // first purchase on/after the campaign start, per client (suppression after conversion)
  const f = new Int32Array(D.nCli).fill(-1);
  for (let c = 0; c < D.nCli; c++) for (let k = D.cpStart[c]; k < D.cpStart[c + 1]; k++) { const P = D.epDay[D.cpList[k]]; if (P >= minDay) { f[c] = P; break; } }
  return f;
}
function buildSegFilter(es) {
  const seg = D.segs[es.col]; if (!seg) return null;
  const ok = new Uint8Array(seg.nCodes + 1); for (const c of es.codes) ok[c] = 1;
  const m = new Uint8Array(D.n); for (let i = 0; i < D.n; i++) m[i] = seg.codes[i] >= 0 && ok[seg.codes[i]] ? 1 : 0;
  return m;
}
/** Earliest purchase episode of client c with t + lag <= P <= t + H, or -1. */
function outcomeEpisode(c, t, lag, H) {
  for (let k = D.cpStart[c]; k < D.cpStart[c + 1]; k++) { const e = D.cpList[k], P = D.epDay[e]; if (P >= t + lag && P <= t + H) return e; if (P > t + H) break; }
  return -1;
}

function runStrategy(spec, ctx, st, mode, seed) {
  const { snapAt, sendDays, lag, H } = ctx;
  const cooldown = Math.max(0, spec.cooldown | 0), maxC = Math.max(0, spec.maxContacts | 0);
  const lastContact = new Int32Array(D.nCli).fill(-1e9), nContacts = new Int32Array(D.nCli);
  const epCapt = new Uint8Array(Math.max(1, D.nEp)), cliSet = new Uint8Array(D.nCli), cliConv = new Uint8Array(D.nCli);
  const rnd = seed ? mulberry32(seed * 7919 + 17) : null;
  const ruleMask = st.ruleId ? RULES.get(st.ruleId) : null;
  const locCap = spec.locCap > 0 && spec.locCol >= 0 ? spec.locCap : 0, locCodes = locCap ? D.segs[spec.locCol]?.codes : null;
  const series = [];
  let contacts = 0, convContacts = 0, uniq = 0, capt = 0, convCli = 0, skippedCool = 0, short = 0;
  const contactsOut = spec.exportStrategy === st.id && mode === 'matched' ? [] : null;
  // client-clustered precision accumulators (contacts → converted contacts)
  const perCliC = new Int32Array(D.nCli), perCliV = new Int32Array(D.nCli);
  for (let si = 0; si < sendDays.length; si++) {
    const t = sendDays[si], pool = snapAt[si];
    const K = spec.audience.type === 'pct' ? Math.ceil(spec.audience.value * pool.length - 1e-9) : Math.min(pool.length, Math.max(0, Math.round(spec.audience.value)));
    // candidates in this strategy's order
    let cand;
    const scoreOf = i => (st.useProb ? D.p[i] : D.s[i]);
    if (st.kind === 'topx') cand = pool.slice().sort(byRank);
    else if (st.kind === 'threshold') cand = pool.filter(i => scoreOf(i) >= st.tau).sort(byRank);
    else if (st.kind === 'random') cand = shuffle(pool.slice(), rnd);
    else if (st.kind === 'rule' || st.kind === 'current') {
      const q = pool.filter(i => st.kind === 'current' && st.source === 'flag' ? D.cur[i] === 1 : (ruleMask ? ruleMask[i] === 1 : false));
      cand = st.within === 'score' ? q.sort(byRank) : shuffle(q, mulberry32(0xC0FFEE + t));   // capped selection inside the rule: highest score, or random (fixed seed)
    } else cand = [];
    const limit = mode === 'natural' ? Infinity : K;
    let taken = 0, sendConv = 0;
    const locCnt = locCap ? new Map() : null;
    for (const i of cand) {
      if (taken >= limit) break;
      const c = D.cli[i];
      if (t - lastContact[c] <= cooldown) { skippedCool++; continue; }
      if (maxC && nContacts[c] >= maxC) continue;
      if (locCnt) { const l = locCodes[i], q = locCnt.get(l) || 0; if (q >= locCap) continue; locCnt.set(l, q + 1); }
      taken++; contacts++; nContacts[c]++; lastContact[c] = t; perCliC[c]++;
      if (!cliSet[c]) { cliSet[c] = 1; uniq++; }
      const e = outcomeEpisode(c, t, lag, H);
      if (e >= 0) { convContacts++; sendConv++; perCliV[c]++; if (!epCapt[e]) { epCapt[e] = 1; capt++; } if (!cliConv[c]) { cliConv[c] = 1; convCli++; } }
      if (contactsOut) contactsOut.push([c, t, D.s[i], D.p[i], e >= 0 ? 1 : 0]);
    }
    if (mode === 'matched' && taken < K) short += K - taken;
    series.push({ t: iso(t), pool: pool.length, K, contacts: taken, conv: sendConv, cumUnique: uniq, cumCapt: capt, cumContacts: contacts });
  }
  // clustered CI for contact precision; Wilson for client conversion rate (clients independent)
  let A = 0, B = 0, Saa = 0, Sbb = 0, Sab = 0, m = 0;
  for (let c = 0; c < D.nCli; c++) if (perCliC[c]) { const a = perCliV[c], b = perCliC[c]; A += a; B += b; Saa += a * a; Sbb += b * b; Sab += a * b; m++; }
  const pc = clusterResult(A, B, Saa, Sbb, Sab, m);
  const baseRate = dv(ctx.poolWould, ctx.poolTotal);
  const cr = dv(convCli, uniq), crCI = wilson(cr, uniq);
  return {
    mode, sends: sendDays.length, contacts, uniqueClients: uniq, contactsPerClient: dv(contacts, uniq), repeatContacts: contacts - uniq,
    convContacts, precision: pc.r, precLo: pc.lo, precHi: pc.hi, convClients: convCli, clientRate: cr, clientRateLo: crCI.lo, clientRateHi: crCI.hi,
    episodesCaptured: capt, capture: dv(capt, ctx.reachableEpisodes), lift: pc.r !== null && baseRate ? pc.r / baseRate : null, baseRate,
    shortfall: short, skippedCooldown: skippedCool, series, _cliSet: cliSet, _contacts: contactsOut,
  };
}
function byRank(a, b) { return (D.s[b] - D.s[a]) || (D.hb[a] - D.hb[b]) || (a - b); }
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function summarizeRandom(st, runs) {
  const keys = ['contacts', 'uniqueClients', 'contactsPerClient', 'repeatContacts', 'convContacts', 'precision', 'convClients', 'clientRate', 'episodesCaptured', 'capture', 'lift', 'baseRate', 'shortfall'];
  const m = { mode: 'matched', sends: runs[0].sends, runs: runs.length };
  for (const k of keys) { const v = runs.map(r => r[k]); m[k] = mean(v); m[k + 'P5'] = quantile(v, 0.05); m[k + 'P95'] = quantile(v, 0.95); }
  m.precLo = m.precisionP5; m.precHi = m.precisionP95; m.clientRateLo = m.clientRateP5; m.clientRateHi = m.clientRateP95;
  // mean cumulative series across runs
  m.series = runs[0].series.map((s, j) => ({ ...s, cumUnique: mean(runs.map(r => r.series[j].cumUnique)), cumCapt: mean(runs.map(r => r.series[j].cumCapt)),
    cumCaptP5: quantile(runs.map(r => r.series[j].cumCapt), 0.05), cumCaptP95: quantile(runs.map(r => r.series[j].cumCapt), 0.95), contacts: mean(runs.map(r => r.series[j].contacts)), conv: mean(runs.map(r => r.series[j].conv)) }));
  m._cliSet = runs[0]._cliSet;
  return { id: st.id, kind: 'random', label: st.label, matched: m, natural: null, runs: runs.length };
}

/* ========================================================== BREAK POINTS
   Ported from the prototype (likelihood tiers in the daily ranking). The tier
   search runs on a day-major copy: rows sorted by day, then the global ranking.
   ========================================================================== */
let BP = null;
function bpBuild(cfg) {
  const key = [cfg.splitCol, cfg.stageCol, cfg.pgCol].join('|');
  if (BP && BP.key === key && BP.maskRef === MASK) return BP;
  const n = D.n, perm = new Int32Array(n);
  let k = 0;
  const pos = new Int32Array(n); for (let q = 0; q < n; q++) pos[D.order[q]] = q;
  const idx = sortedIdx(n, (a, b) => (D.day[a] - D.day[b]) || (pos[a] - pos[b]));
  for (const i of idx) perm[k++] = i;
  const take = (arr, C) => { const o = new C(n); for (let j = 0; j < n; j++) o[j] = arr[perm[j]]; return o; };
  const segOr = (col) => col >= 0 && D.segs[col] ? take(D.segs[col].codes, Int16Array) : new Int16Array(n).fill(-1);
  const B = { key, maskRef: MASK, n, day: take(D.day, Int32Array), cli: take(D.cli, Int32Array), s: take(D.s, Float64Array), sc: take(D.p, Float32Array),
    y: take(D.y, Int8Array), ep: take(D.ep, Int32Array), m: take(MASK, Uint8Array), split: segOr(cfg.splitCol), stage: segOr(cfg.stageCol), pg: segOr(cfg.pgCol), rules: take(D.cur, Int8Array) };
  B.nDays = D.nDays; B.nCli = D.nCli; B.nEp = D.nEp; B.epCli = D.epCli;
  B.dayStart = new Int32Array(B.nDays + 1); for (let j = 0; j < n; j++) B.dayStart[B.day[j] + 1]++; for (let d = 0; d < B.nDays; d++) B.dayStart[d + 1] += B.dayStart[d];
  BP = B; return B;
}
const inSet = (B, i, w) => B.m[i] && B.day[i] >= w.d0 && B.day[i] <= w.d1 && (w.split < 0 || B.split[i] === w.split);
const EDGES = (() => { const e = [0]; for (let x = 0.5; x <= 5 + 1e-9; x += 0.5) e.push(+x.toFixed(1)); for (let x = 6; x <= 20; x++) e.push(x); for (let x = 25; x <= 100; x += 5) e.push(x); return e; })();
function rankDataset(B, ds) {
  const rk = new Int32Array(B.n), pct = new Float64Array(B.n).fill(NaN), dayN = new Int32Array(B.nDays);
  for (let d = 0; d < B.nDays; d++) {
    const a = B.dayStart[d], b = B.dayStart[d + 1];
    let n = 0; for (let i = a; i < b; i++) if (inSet(B, i, ds)) n++;
    dayN[d] = n; let r = 0;
    for (let i = a; i < b; i++) if (inSet(B, i, ds)) { r++; rk[i] = r; pct[i] = r / n; }
  }
  const rows = []; for (let i = 0; i < B.n; i++) if (!Number.isNaN(pct[i])) rows.push(i);
  return { rk, pct, dayN, rows: Int32Array.from(rows) };
}
function sliceOf(p) { const x = p * 100 - 1e-9; let lo = 0, hi = EDGES.length - 2; while (lo < hi) { const m = (lo + hi) >> 1; if (EDGES[m + 1] < x) lo = m + 1; else hi = m; } return lo; }
function sliceStats(B, R, dayMask) {
  const m = EDGES.length - 1;
  const rows = new Float64Array(m), pos = new Float64Array(m), sl = new Int16Array(B.n).fill(-1);
  const epsBySlice = Array.from({ length: m }, () => new Set()), days = new Set();
  for (const i of R.rows) {
    if (dayMask && !dayMask[B.day[i]]) continue;
    const k = sliceOf(R.pct[i]); sl[i] = k; rows[k]++; days.add(B.day[i]);
    if (B.y[i] === 1) { pos[k]++; if (B.ep[i] >= 0) epsBySlice[k].add(B.ep[i]); }
  }
  return { m, rows, pos, eps: epsBySlice.map(x => Int32Array.from(x)), sl, nDays: days.size };
}
function rangeUnique(B, eps, m, w) {
  const U = new Float64Array(m * m), stamp = new Int32Array(Math.max(1, B.nEp)).fill(-1);
  for (let i = 0; i < m; i++) { let acc = 0; for (let j = i; j < m; j++) { for (const e of eps[j]) if (stamp[e] !== i) { stamp[e] = i; acc += w ? w[B.epCli[e]] : 1; } U[i * m + j] = acc; } }
  return U;
}
const devSeg = (N, P) => (N <= 0 || P <= 0 || P >= N) ? 0 : -2 * (P * Math.log(P / N) + (N - P) * Math.log(1 - P / N));
function partition(rows, pos, U, m, K, C, ciLo, ciHi) {
  const cN = new Float64Array(m + 1), cP = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) { cN[i + 1] = cN[i] + rows[i]; cP[i + 1] = cP[i] + pos[i]; }
  const N = (i, j) => cN[j + 1] - cN[i], Pp = (i, j) => cP[j + 1] - cP[i];
  const rate = (i, j) => N(i, j) > 0 ? Pp(i, j) / N(i, j) : 0, cost = (i, j) => devSeg(N(i, j), Pp(i, j));
  const feas = (i, j) => N(i, j) > 0 && U[i * m + j] >= C.minConv;
  const okAdj = (i1, j1, i2, j2) => {
    const r1 = rate(i1, j1), r2 = rate(i2, j2), hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const ratio = lo > 0 ? hi / lo : (hi > 0 ? Infinity : 1); if (ratio < C.minRatio) return false;
    if (C.needCI && ciLo) { const [t, bt] = r1 >= r2 ? [[i1, j1], [i2, j2]] : [[i2, j2], [i1, j1]]; if (!(ciLo[t[0] * m + t[1]] > ciHi[bt[0] * m + bt[1]])) return false; }
    return true;
  };
  const sols = {}; let prev = new Float64Array(m * m).fill(Infinity); const back = [];
  for (let j = 0; j < m; j++) if (feas(0, j)) prev[j * m + 0] = cost(0, j);
  const pick = (arr, k) => {
    let best = Infinity, bi = -1; for (let i = 0; i < m; i++) if (arr[(m - 1) * m + i] < best) { best = arr[(m - 1) * m + i]; bi = i; }
    if (bi < 0) return null; const segs = []; let j = m - 1, i = bi;
    for (let kk = k; kk >= 1; kk--) { segs.unshift([i, j]); if (kk === 1) break; const pi = back[kk][j * m + i]; j = i - 1; i = pi; }
    return { dev: best, segs, cuts: segs.slice(1).map(s => s[0]) };
  };
  sols[1] = pick(prev, 1);
  for (let k = 2; k <= K; k++) {
    const cur = new Float64Array(m * m).fill(Infinity), bk = new Int16Array(m * m).fill(-1);
    for (let j = 0; j < m; j++) for (let i = 1; i <= j; i++) {
      if (!feas(i, j)) continue; const c = cost(i, j);
      for (let ip = 0; ip <= i - 1; ip++) { const v = prev[(i - 1) * m + ip]; if (v === Infinity) continue; if (!okAdj(ip, i - 1, i, j)) continue; if (v + c < cur[j * m + i]) { cur[j * m + i] = v + c; bk[j * m + i] = ip; } }
    }
    back[k] = bk; sols[k] = pick(cur, k); prev = cur;
  }
  return sols;
}
function tierTable(B, R, bounds, kind, Bn) {
  const K = bounds.length + 1;
  const tierOf = i => { const v = kind === 'rank' ? R.rk[i] : R.pct[i]; for (let t = 0; t < bounds.length; t++) if (v <= bounds[t] + 1e-12) return t; return K - 1; };
  const T = Array.from({ length: K }, () => ({ rows: 0, pos: 0, eps: new Set(), perDay: new Map(), minS: new Map(), minC: new Map(), stage: {}, pg: {}, rules: {} }));
  const tier = new Int8Array(B.n).fill(-1), epBest = new Map();
  let totRows = 0, totPos = 0;
  for (const i of R.rows) {
    const t = tierOf(i); tier[i] = t; const x = T[t];
    x.rows++; totRows++; x.pos += B.y[i]; totPos += B.y[i];
    const d = B.day[i]; x.perDay.set(d, (x.perDay.get(d) || 0) + 1);
    if (!(x.minS.get(d) <= B.s[i])) x.minS.set(d, B.s[i]);
    if (!Number.isNaN(B.sc[i]) && !(x.minC.get(d) <= B.sc[i])) x.minC.set(d, B.sc[i]);
    x.stage[B.stage[i]] = (x.stage[B.stage[i]] || 0) + 1; x.pg[B.pg[i]] = (x.pg[B.pg[i]] || 0) + 1; x.rules[B.rules[i]] = (x.rules[B.rules[i]] || 0) + 1;
    if (B.y[i] === 1 && B.ep[i] >= 0) { x.eps.add(B.ep[i]); const b0 = epBest.get(B.ep[i]); if (b0 === undefined || t < b0) epBest.set(B.ep[i], t); }
  }
  const best = new Array(K).fill(0); for (const t of epBest.values()) best[t]++;
  const allEps = new Set(); for (const i of R.rows) if (B.y[i] === 1 && B.ep[i] >= 0) allEps.add(B.ep[i]);
  const bs = Array.from({ length: K }, () => []);
  if (Bn > 0) {
    const w = new Float32Array(B.nCli), nn = new Float64Array(K), pp = new Float64Array(K);
    for (let b = 0; b < Bn; b++) { poissonWeights(b, w); nn.fill(0); pp.fill(0); for (const i of R.rows) { const wt = w[B.cli[i]]; if (!wt) continue; nn[tier[i]] += wt; if (B.y[i] === 1) pp[tier[i]] += wt; } for (let t = 0; t < K; t++) bs[t].push(nn[t] > 0 ? pp[t] / nn[t] : null); }
  }
  const activeDays = []; for (let d = 0; d < B.nDays; d++) if (R.dayN[d] > 0) activeDays.push(d);
  const rate0 = dv(totPos, totRows); let cum = 0;
  const tiers = T.map((x, t) => {
    const perDay = activeDays.map(d => x.perDay.get(d) || 0), minS = [...x.minS.values()], minC = [...x.minC.values()];
    const rate = dv(x.pos, x.rows); cum += best[t];
    const c = Bn > 0 ? { lo: quantile(bs[t], 0.025), hi: quantile(bs[t], 0.975) } : { lo: null, hi: null };
    return { tier: t + 1, rows: x.rows, pos: x.pos, rate, lo: c.lo, hi: c.hi, lift: rate !== null && rate0 ? rate / rate0 : null,
      perDayAvg: mean(perDay), perDayP5: quantile(perDay, 0.05), perDayP95: quantile(perDay, 0.95),
      rawMean: mean(minS), rawP5: quantile(minS, 0.05), rawP95: quantile(minS, 0.95),
      calMean: minC.length ? mean(minC) : null, calP5: minC.length ? quantile(minC, 0.05) : null, calP95: minC.length ? quantile(minC, 0.95) : null,
      uniq: x.eps.size, best: best[t], share: dv(best[t], allEps.size), cumShare: dv(cum, allEps.size), stage: x.stage, pg: x.pg, rules: x.rules };
  });
  return { tiers, totRows, totPos, rate: rate0, totalConv: allEps.size, sumBest: best.reduce((a, b) => a + b, 0), days: activeDays.length };
}
function breaks(cfg) {
  const B = bpBuild(cfg), Bn = cfg.B, m = EDGES.length - 1;
  const RF = rankDataset(B, cfg.fit), RC = cfg.confirm ? rankDataset(B, cfg.confirm) : RF;
  if (cfg.tiersOnly) {
    const kind = cfg.mode === 'capacity' ? 'rank' : 'pct';
    const bounds = kind === 'rank' ? cfg.capacity.slice().sort((a, b) => a - b).filter(x => x > 0) : cfg.manual.slice().sort((a, b) => a - b).filter(x => x > 0 && x < 1);
    const confirmT = tierTable(B, RC, bounds, kind, Bn);
    return { bounds, kind, confirm: confirmT, fit: RC === RF ? confirmT : tierTable(B, RF, bounds, kind, 0), usedK: null, edges: EDGES };
  }
  const F = sliceStats(B, RF, null);
  const totEps = new Set(); for (const i of RF.rows) if (B.y[i] === 1 && B.ep[i] >= 0) totEps.add(B.ep[i]);
  const U = rangeUnique(B, F.eps, m, null);
  const bN = new Float64Array(Bn * m), bP = new Float64Array(Bn * m), w = new Float32Array(B.nCli);
  for (let b = 0; b < Bn; b++) { poissonWeights(b, w); for (const i of RF.rows) { const wt = w[B.cli[i]]; if (!wt) continue; const k = F.sl[i]; bN[b * m + k] += wt; if (B.y[i] === 1) bP[b * m + k] += wt; } }
  const ciLo = new Float64Array(m * m), ciHi = new Float64Array(m * m);
  if (Bn > 0) {
    const tmp = new Array(Bn);
    for (let i = 0; i < m; i++) { const accN = new Float64Array(Bn), accP = new Float64Array(Bn);
      for (let j = i; j < m; j++) { for (let b = 0; b < Bn; b++) { accN[b] += bN[b * m + j]; accP[b] += bP[b * m + j]; tmp[b] = accN[b] > 0 ? accP[b] / accN[b] : 0; } ciLo[i * m + j] = quantile(tmp, 0.025); ciHi[i * m + j] = quantile(tmp, 0.975); } }
  }
  const slices = []; let cumN = 0, cumP = 0;
  const totN = F.rows.reduce((a, b) => a + b, 0), totP = F.pos.reduce((a, b) => a + b, 0), rate0 = dv(totP, totN);
  for (let k = 0; k < m; k++) {
    cumN += F.rows[k]; cumP += F.pos[k]; const rate = dv(F.pos[k], F.rows[k]);
    slices.push({ k, from: EDGES[k], to: EDGES[k + 1], rows: F.rows[k], pos: F.pos[k], rate, lo: Bn ? ciLo[k * m + k] : null, hi: Bn ? ciHi[k * m + k] : null,
      lift: rate !== null && rate0 ? rate / rate0 : null, uniq: F.eps[k].length, perDay: F.nDays ? F.rows[k] / F.nDays : null, cumLift: cumN && rate0 ? (cumP / cumN) / rate0 : null });
  }
  const C = { minConv: cfg.minConv, minRatio: cfg.minRatio, needCI: cfg.needCI };
  const sols = partition(F.rows, F.pos, U, m, cfg.kMax, C, ciLo, ciHi);
  const ks = []; for (let k = 1; k <= cfg.kMax; k++) ks.push({ k, feasible: !!sols[k], dev: sols[k] ? sols[k].dev : null, cuts: sols[k] ? sols[k].cuts : null });
  const Bs = Math.min(Bn, cfg.Bstab);
  const cutHits = {}; for (const r of ks) if (r.cuts) cutHits[r.k] = { boot: new Array(r.cuts.length).fill(0), boot1: new Array(r.cuts.length).fill(0), fold: new Array(r.cuts.length).fill(0) };
  const hit = (cuts, c, tol) => cuts.some(x => Math.abs(x - c) <= tol);
  for (let b = 0; b < Bs; b++) {
    poissonWeights(b, w);
    const Uw = rangeUnique(B, F.eps, m, w);
    const sb = partition(bN.subarray(b * m, (b + 1) * m), bP.subarray(b * m, (b + 1) * m), Uw, m, cfg.kMax, C, ciLo, ciHi);
    for (const r of ks) if (r.cuts && sb[r.k]) { const h = cutHits[r.k]; r.cuts.forEach((c, i) => { if (hit(sb[r.k].cuts, c, 0)) h.boot[i]++; if (hit(sb[r.k].cuts, c, 1)) h.boot1[i]++; }); }
  }
  const fitDays = []; for (let d = 0; d < B.nDays; d++) if (RF.dayN[d] > 0) fitDays.push(d);
  const folds = [];
  if (fitDays.length >= 8) {
    const L = Math.round(fitDays.length * 0.5);
    for (let f = 0; f < 5; f++) {
      const st = Math.round(f * (fitDays.length - L) / 4), ds = fitDays.slice(st, st + L);
      const mask = new Uint8Array(B.nDays); ds.forEach(d => mask[d] = 1);
      const Fw = sliceStats(B, RF, mask);
      const s = new Set(); for (const e of Fw.eps) for (const x of e) s.add(x); const ne = s.size;
      const Uf = rangeUnique(B, Fw.eps, m, null);
      const Cf = { minConv: cfg.minConv * (totEps.size ? ne / totEps.size : 1), minRatio: cfg.minRatio, needCI: false };
      const sf = partition(Fw.rows, Fw.pos, Uf, m, cfg.kMax, Cf, null, null);
      folds.push({ from: iso(ds[0]), to: iso(ds[ds.length - 1]), conv: ne });
      for (const r of ks) if (r.cuts && sf[r.k]) { const h = cutHits[r.k]; r.cuts.forEach((c, i) => { if (hit(sf[r.k].cuts, c, 0)) h.fold[i]++; }); }
    }
  }
  for (const r of ks) {
    if (!r.cuts) continue; const h = cutHits[r.k];
    r.stab = r.cuts.map((c, i) => ({ cut: c, pct: EDGES[c], boot: Bs ? h.boot[i] / Bs : null, boot1: Bs ? h.boot1[i] / Bs : null, fold: folds.length ? h.fold[i] / folds.length : null }));
    r.stable = r.k > 1 && r.stab.every(x => (x.boot === null || x.boot >= 0.7) && (x.fold === null || x.fold >= 0.7));
  }
  const stableKs = ks.filter(r => r.k > 1 && r.stable), recK = stableKs.length ? stableKs[stableKs.length - 1].k : null;
  let bounds, kind = 'pct', usedK = null;
  if (cfg.mode === 'manual') bounds = cfg.manual.slice().sort((a, b) => a - b).filter(x => x > 0 && x < 1);
  else if (cfg.mode === 'capacity') { bounds = cfg.capacity.slice().sort((a, b) => a - b).filter(x => x > 0); kind = 'rank'; }
  else { usedK = cfg.k && sols[cfg.k] ? cfg.k : recK; bounds = usedK && sols[usedK] ? sols[usedK].cuts.map(c => EDGES[c] / 100) : []; }
  const confirmT = tierTable(B, RC, bounds, kind, Bn), fitT = RC === RF ? confirmT : tierTable(B, RF, bounds, kind, 0);
  return { edges: EDGES, slices, ks, recK, usedK, bounds, kind, confirm: confirmT, fit: fitT, folds, fitDays: fitDays.length, totalConvFit: totEps.size, rateFit: rate0, Bs, B: Bn };
}
