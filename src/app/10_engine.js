/* ==========================================================================
   10 · SHARED STATE, DUCKDB AND THE ENGINE CLIENT
   One dataset, one schema, one set of global evaluation settings; every tab
   reads from here. Tab-local controls live in S.ui[tab] and never change the
   global settings.
   ========================================================================== */
const S = {
  file: null, isDemo: false,
  rawCols: [],              // columns of the uploaded file [{name, type}]
  roles: {},                // role -> source column name
  posValues: null,          // target values treated as positive (strings, lower-case)
  probFromScore: false,     // user declared PREDICTED_SCORE is a probability
  info: null,               // validation summary
  schema: null,             // { cols: [{name, type}], typeOf }
  disc: null,               // discovery: segments / features / excluded
  ep: null,                 // conversion-episode summary
  settings: null,           // global evaluation settings (see defaultSettings)
  cohorts: [],              // saved population filters (from the error tree)
  eval: { grain: 'row', gran: 'overall' },
  ver: 0,                   // bumps whenever the evaluation population changes
  core: null,               // { d0, d1, nDays, cliNames, segIndex }
  cache: new Map(),
  ui: {},                   // tab-local state
  hasProb: false,           // valid probabilities available (mapped column, or score declared as a probability)
  sim: null,                // last campaign simulation (read by the Executive Report)
  rendered: {},             // tab -> version last rendered
};
const ROLE_DEFS = [
  { role: 'client_id', label: 'CLIENT_ID', req: true, desc: 'Client identifier', aliases: ['client_id', 'clientid', 'customer_id', 'member_id'] },
  { role: 'date', label: 'DATE_T', req: true, desc: 'Prediction (as-of) date', aliases: ['date_t', 'date', 'score_date', 'prediction_date', 'as_of_date'] },
  { role: 'target', label: 'CONVERSION_TARGET', req: true, desc: 'Outcome label: converted within the horizon after DATE_T', aliases: ['conversion_target', 'y_true', 'target', 'label', 'converted'] },
  { role: 'score', label: 'PREDICTED_SCORE', req: true, desc: 'Model score used for ranking', aliases: ['predicted_score', 'y_score', 'score_raw', 'score', 'predict_proba_positive', 'raw_score'] },
  { role: 'prob', label: 'PREDICTED_PROBABILITY', desc: 'Calibrated probability (enables calibration analysis)', aliases: ['predicted_probability', 'score_cal', 'calibrated_probability', 'probability', 'p_calibrated'] },
  { role: 'studio', label: 'PRIMARY_STUDIO_ID', desc: 'Primary studio / location (segment, per-studio caps)', aliases: ['primary_studio_id', 'primary_location_id', 'studio_id', 'location_id'] },
  { role: 'lifecycle', label: 'LIFECYCLE_STAGE', desc: 'Client lifecycle category (segment)', aliases: ['lifecycle_stage', 'lifecycle_category', 'client_lifecycle', 'lifecycle'] },
  { role: 'product', label: 'PRODUCT_GROUP', desc: 'Product group on the date (segment, tier profile)', aliases: ['product_group_on_date_t', 'product_group'] },
  { role: 'version', label: 'MODEL_VERSION', desc: 'Model version (filter; versions must not be mixed)', aliases: ['model_version', 'model_id'] },
  { role: 'split', label: 'SPLIT', desc: 'Dataset split (train / validation / test)', aliases: ['split', 'dataset_split'] },
  { role: 'treatment', label: 'TREATMENT_GROUP', desc: 'Randomized campaign assignment (treatment / control)', aliases: ['treatment', 'treatment_group', 'campaign_group', 'test_control', 'assignment', 'arm'] },
  { role: 'current', label: 'CURRENT_STRATEGY_FLAG', desc: '1 if the current marketing strategy targeted the client on that date', aliases: ['current_strategy_flag', 'in_existing_rules', 'current_strategy', 'existing_rule_flag'] },
  { role: 'purchase_date', label: 'PURCHASE_DATE', desc: 'Conversion (purchase) date for positives', aliases: ['purchase_date', 'conversion_date'] },
  { role: 'days_to_conv', label: 'DAYS_TO_CONVERSION', desc: 'Days from DATE_T to the purchase (positives)', aliases: ['days_to_conversion', 'days_to_purchase'] },
  { role: 'class_id', label: 'CLASS_ID', desc: 'Class identifier (class-roster simulation)', aliases: ['class_id'] },
  { role: 'coach_id', label: 'COACH_ID', desc: 'Coach identifier (class-roster breakdown)', aliases: ['coach_id'] },
];
const ROLE = Object.fromEntries(ROLE_DEFS.map(r => [r.role, r]));
const roleCol = r => S.roles[r] || null;   // column name in `data` for a role (standard name for consumed roles)
const CONSUMED = { client_id: 'client_id', date: 'date', target: 'y', score: 'score', prob: 'prob' };

function defaultSettings(st) {
  return { d0: st.dmin, d1: st.dmax, horizon: 14, labelsThrough: null, split: null, version: null, minPos: 20 };
}

/* ---------------------------------------------------------------- DuckDB */
const DB = { db: null, conn: null, duckdb: null };
async function initDB() {
  if (DB.conn) return;
  const duckdb = await import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm');
  DB.duckdb = duckdb;
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
  DB.db = db; DB.conn = await db.connect();
}
function convertValue(v, typeStr) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeStr.startsWith('Date') && typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  if (typeStr.startsWith('Timestamp') && typeof v === 'number') return new Date(v).toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v === 'object' && typeof v.toArray === 'function') return Array.from(v.toArray(), x => (typeof x === 'bigint' ? Number(x) : x));
  return v;
}
/** Run SQL, return plain objects. */
async function q(sql) {
  try {
    const t = await DB.conn.query(sql);
    const fields = t.schema.fields.map(f => ({ name: f.name, type: String(f.type) }));
    const out = new Array(t.numRows); let i = 0;
    for (const row of t) { const o = {}; for (const f of fields) o[f.name] = convertValue(row[f.name], f.type); out[i++] = o; }
    return out;
  } catch (e) { console.error('SQL failed:', sql, e); throw e; }
}
const q1 = async sql => (await q(sql))[0] || {};
async function exec(batch) { for (const s of batch.split(/;\s*\n/).map(x => x.trim()).filter(Boolean)) await q(s); }
/** Run SQL and return one column as a typed array. */
async function qColumn(sql, name, C) { const t = await DB.conn.query(sql); const a = t.getChild(name).toArray(); return C ? new C(a) : a; }

/* --------------------------------------------------------- engine client */
const ENG = { worker: null, seq: 0, pending: new Map() };
function engInit() {
  if (ENG.worker) return;
  const src = document.getElementById('engine-src').textContent;
  ENG.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  ENG.worker.onmessage = e => {
    const p = ENG.pending.get(e.data.id); if (!p) return;
    ENG.pending.delete(e.data.id);
    if (e.data.ok) p.res(e.data.out); else { console.error(e.data.error); p.rej(new Error(e.data.error.split('\n')[0])); }
  };
  // a crashed worker (e.g. out of memory) must fail every pending call loudly instead of hanging the UI
  ENG.worker.onerror = e => { console.error('engine error', e.message || e); for (const p of ENG.pending.values()) p.rej(new Error(`Analytical engine stopped: ${e.message || 'unknown error (possibly out of memory)'}`)); ENG.pending.clear(); ENG.worker = null; };
}
function eng(msg, transfer = []) {
  engInit();
  return new Promise((res, rej) => { const id = ++ENG.seq; ENG.pending.set(id, { res, rej }); ENG.worker.postMessage({ ...msg, id }, transfer); });
}
/** Cached engine call keyed by the population version + spec. */
async function engCached(type, spec, label) {
  const key = `${S.ver}|${type}|${JSON.stringify(spec)}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const p = busy.wrap(() => eng({ type, spec }), label || 'Computing…');
  S.cache.set(key, p);
  try { return await p; } catch (e) { S.cache.delete(key); throw e; }
}
const stale = v => v !== S.ver;
