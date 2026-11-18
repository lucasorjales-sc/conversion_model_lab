/* ==========================================================================
   55 · “HOW THIS WORKS” GUIDES (Targeting Simulator)
   A paged walkthrough for non-technical readers: each page explains one idea,
   shows a small illustration, and says what it means for the result.
   Illustrations are inline SVG drawn with the app's colour tokens (light/dark aware).
   ========================================================================== */

/* ---------- generic paged modal ---------- */
function openGuide({ eyebrow, pages, anchor }) {
  let i = 0, dir = 1;
  const back = document.createElement('div'); back.className = 'guide-back';
  back.innerHTML = `<div class="guide" role="dialog" aria-modal="true" aria-label="${esc(eyebrow)}">
    <div class="guide-head"><span class="guide-eyebrow">${esc(eyebrow)}</span><button class="icon-btn" data-gclose aria-label="Close">${ICON.close}</button></div>
    <div class="guide-stage" aria-live="polite"></div>
    <div class="guide-foot"><div class="guide-dots" role="tablist">${pages.map((p, k) => `<button class="gdot" data-gdot="${k}" aria-label="Page ${k + 1}: ${esc(p.title)}"></button>`).join('')}</div>
      <span class="guide-count"></span><span class="grow"></span><button class="btn" data-gprev>Back</button><button class="btn primary" data-gnext>Next</button></div></div>`;
  const dlg = $('.guide', back);
  if (anchor) {   // grow from the button that opened it
    const r = anchor.getBoundingClientRect();
    dlg.style.transformOrigin = `${clamp(r.left + r.width / 2 - (window.innerWidth - Math.min(860, window.innerWidth - 32)) / 2, 0, 860)}px -40px`;
  }
  const draw = () => {
    const p = pages[i];
    html($('.guide-stage', back), `<div class="guide-page ${dir > 0 ? 'from-right' : 'from-left'}">
      <div class="guide-art">${p.art || ''}</div>
      <div class="guide-text"><div class="guide-step">Step ${i + 1} of ${pages.length}</div><h2>${p.title}</h2><div class="guide-body">${p.body}</div>
        ${p.means ? `<div class="guide-means"><div class="gm-k">What this means for you</div>${p.means}</div>` : ''}</div></div>`);
    $$('.gdot', back).forEach((d, k) => { d.classList.toggle('on', k === i); d.setAttribute('aria-selected', k === i); });
    $('.guide-count', back).textContent = `${i + 1} / ${pages.length}`;
    $('[data-gprev]', back).disabled = i === 0;
    $('[data-gnext]', back).textContent = i === pages.length - 1 ? 'Done' : 'Next';
  };
  const goTo = k => { if (k < 0 || k >= pages.length || k === i) return; dir = k > i ? 1 : -1; i = k; draw(); };
  const close = () => { back.classList.add('closing'); setTimeout(() => back.remove(), 220); document.removeEventListener('keydown', onKey); if (anchor) anchor.focus(); };
  const onKey = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') goTo(i + 1); else if (e.key === 'ArrowLeft') goTo(i - 1); };
  back.addEventListener('click', e => {
    if (e.target === back || e.target.closest('[data-gclose]')) close();
    else if (e.target.closest('[data-gprev]')) goTo(i - 1);
    else if (e.target.closest('[data-gnext]')) { if (i === pages.length - 1) close(); else goTo(i + 1); }
    else { const d = e.target.closest('[data-gdot]'); if (d) goTo(+d.dataset.gdot); }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  draw();
  setTimeout(() => $('[data-gnext]', back).focus(), 60);
}

/* ---------- illustration kit (viewBox 0 0 640 220) ---------- */
const GA = {
  svg: (inner, h = 220) => `<svg viewBox="0 0 640 ${h}" role="img" aria-hidden="true" class="gsvg">${inner}</svg>`,
  person: (x, y, fill, op = 1, ring = false) => `<g opacity="${op}"><circle cx="${x}" cy="${y - 9}" r="6" style="fill:${fill}"/><path d="M${x - 9},${y + 9} a9,9 0 0 1 18,0 v2 h-18z" style="fill:${fill}"/>${ring ? `<circle cx="${x}" cy="${y}" r="16" fill="none" style="stroke:var(--good)" stroke-width="2"/>` : ''}</g>`,
  text: (x, y, t, { size = 12, w = 500, anchor = 'middle', fill = 'var(--text-2)' } = {}) => `<text x="${x}" y="${y}" text-anchor="${anchor}" style="fill:${fill};font-size:${size}px;font-weight:${w}">${t}</text>`,
  arrow: (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:var(--axis)" stroke-width="2" marker-end="url(#gah)"/>`,
  defs: `<defs><marker id="gah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--axis)"/></marker></defs>`,
  box: (x, y, w, h, fill = 'var(--surface-3)', r = 12) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:${fill}"/>`,
  check: (x, y) => `<g><circle cx="${x}" cy="${y}" r="8" style="fill:var(--good)"/><path d="M${x - 3.5},${y} l2.5,2.5 l4.5,-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  crowd(x0, y0, cols, rows, gap, colorOf) { let o = ''; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = r * cols + c, s = colorOf(k); o += GA.person(x0 + c * gap, y0 + r * (gap + 4), s.fill, s.op ?? 1, s.ring); } return o; },
};
const BLUE = 'var(--s1)', ORANGE = 'var(--s2)', GRAY = 'var(--axis)', GREEN = 'var(--good)', MUTED = 'var(--surface-3)';
// fixed pseudo-random pattern so illustrations are stable
const PAT = [3, 7, 11, 18, 22, 25, 31, 34, 40, 44];
const isConv = k => [2, 9, 15, 21, 30].includes(k);

/* ---------- current numbers for “what this means” ---------- */
function simNumbers() {
  const U = simState(), st = U.setup, sim = S.sim, res = sim?.r?.results || [];
  const pool = sim?.r?.ctx?.pools?.length ? sim.r.ctx.pools.reduce((a, b) => a + b, 0) / sim.r.ctx.pools.length : null;
  const per = st.audType === 'pct' ? (pool ? Math.ceil(pool * st.audPct / 100) : null) : st.audN;
  const get = k => res.find(r => r.kind === k)?.matched;
  return { st, pool, per, sends: sim?.r?.sends?.length, model: get('topx'), rnd: get('random'), cur: get('current'), rule: get('rule'), thr: get('threshold'), reachable: sim?.r?.ctx?.reachable, cad: PERIOD_ADJ[st.cadence] };
}

/* ---------- Campaign comparison ---------- */
function campaignGuide() {
  const n = simNumbers(), st = n.st;
  const art = {
    overview: GA.svg(GA.defs + GA.text(160, 22, 'Today’s targeting', { w: 650, fill: 'var(--text)' }) + GA.text(480, 22, 'Model targeting', { w: 650, fill: 'var(--text)' }) +
      GA.crowd(70, 60, 6, 3, 34, k => ({ fill: [1, 4, 8, 13, 16].includes(k) ? ORANGE : GRAY, op: [1, 4, 8, 13, 16].includes(k) ? 1 : 0.55 })) +
      GA.crowd(390, 60, 6, 3, 34, k => ({ fill: [0, 2, 3, 9, 15].includes(k) ? BLUE : GRAY, op: [0, 2, 3, 9, 15].includes(k) ? 1 : 0.55 })) +
      GA.box(95, 172, 130, 36, 'var(--surface-3)') + GA.check(117, 190) + GA.text(133, 195, '1 of 5 bought', { anchor: 'start', w: 600, fill: 'var(--text)' }) +
      GA.box(415, 172, 130, 36, 'var(--surface-3)') + GA.check(437, 190) + GA.text(453, 195, '3 of 5 bought', { anchor: 'start', w: 600, fill: 'var(--text)' }) +
      `<line x1="320" y1="40" x2="320" y2="200" style="stroke:var(--sep-strong)" stroke-dasharray="4 4"/>`),
    pool: GA.svg(GA.defs + [0, 1, 2, 3].map(w => { const x = 40 + w * 150; return GA.box(x, 30, 130, 150, 'var(--surface-2)') + GA.text(x + 65, 52, `Send ${w + 1}`, { w: 650, fill: 'var(--text)' }) +
      GA.crowd(x + 22, 85, 4, 3, 28, k => ({ fill: (k + w) % 5 === 0 ? GRAY : BLUE, op: (k + w) % 5 === 0 ? 0.25 : 0.9 })); }).join('') +
      GA.text(320, 206, 'Faded people are not eligible at that send: no recent score, or they already bought.', { size: 12.5 })),
    budget: GA.svg(GA.defs + Array.from({ length: 12 }, (_, k) => { const h = 150 - k * 11, x = 50 + k * 46; return `<rect x="${x}" y="${190 - h}" width="30" height="${h}" rx="5" style="fill:${k < 4 ? BLUE : 'var(--surface-3)'}"/>`; }).join('') +
      `<line x1="226" y1="30" x2="226" y2="196" style="stroke:var(--text)" stroke-width="2" stroke-dasharray="5 4"/>` + GA.text(232, 34, 'Budget: 4 people per send', { anchor: 'start', w: 650, fill: 'var(--text)' }) +
      GA.text(320, 212, 'Everyone eligible, sorted from most to least likely to buy. Each strategy fills the same budget its own way.', { size: 12.5 })),
    size: GA.svg(GA.defs + GA.box(40, 30, 260, 160, 'var(--surface-2)') + GA.box(340, 30, 260, 160, 'var(--surface-2)') +
      GA.text(170, 54, 'Small audience', { w: 650, fill: 'var(--text)' }) + GA.text(470, 54, 'Large audience', { w: 650, fill: 'var(--text)' }) +
      GA.crowd(110, 95, 4, 2, 34, k => ({ fill: BLUE, ring: [0, 1, 4].includes(k) })) +
      GA.crowd(372, 90, 7, 3, 32, k => ({ fill: BLUE, op: 0.9, ring: [0, 1, 4, 9, 15].includes(k) })) +
      GA.text(170, 178, '3 of 8 bought · 38%', { size: 12.5, w: 600 }) + GA.text(470, 178, '5 of 21 bought · 24%', { size: 12.5, w: 600 })),
    cooldown: GA.svg(GA.defs + `<line x1="40" y1="110" x2="600" y2="110" style="stroke:var(--axis)" stroke-width="2"/>` +
      Array.from({ length: 8 }, (_, w) => { const x = 60 + w * 75; return `<line x1="${x}" y1="102" x2="${x}" y2="118" style="stroke:var(--axis)" stroke-width="2"/>` + GA.text(x, 140, `Send ${w + 1}`, { size: 11.5 }); }).join('') +
      [0, 3, 6].map(w => { const x = 60 + w * 75; return `<rect x="${x}" y="70" width="${Math.min(150, 600 - x)}" height="22" rx="11" style="fill:var(--warn-soft)"/>` + GA.text(x + Math.min(150, 600 - x) / 2, 85, 'cooldown', { size: 11, fill: 'var(--warn)', w: 600 }) + `<circle cx="${x}" cy="110" r="10" style="fill:${BLUE}"/>` + GA.text(x, 114, '✉', { size: 11, fill: '#fff' }); }).join('') +
      GA.text(320, 190, 'One client: contacted, then skipped while cooling down, then eligible again.', { size: 12.5 })),
    window: GA.svg(GA.defs + `<line x1="40" y1="110" x2="600" y2="110" style="stroke:var(--axis)" stroke-width="2"/>` +
      `<circle cx="90" cy="110" r="11" style="fill:${BLUE}"/>` + GA.text(90, 115, '✉', { size: 12, fill: '#fff' }) + GA.text(90, 145, 'Contact', { w: 600 }) +
      `<rect x="120" y="86" width="380" height="48" rx="12" style="fill:var(--good-soft)"/>` + GA.text(310, 78, `Outcome window: ${st.lag}–${st.horizon} days after the send`, { w: 600, fill: 'var(--good)' }) +
      GA.check(260, 110) + GA.text(260, 152, 'Purchase here counts', { size: 12, w: 600, fill: 'var(--good)' }) +
      `<circle cx="560" cy="110" r="8" style="fill:${GRAY}"/>` + GA.text(560, 152, 'Too late: not counted', { size: 12 })),
    dedupe: GA.svg(GA.defs + `<line x1="40" y1="110" x2="600" y2="110" style="stroke:var(--axis)" stroke-width="2"/>` +
      [80, 200, 320].map((x, k) => `<circle cx="${x}" cy="110" r="11" style="fill:${BLUE}"/>` + GA.text(x, 115, '✉', { size: 12, fill: '#fff' }) + GA.text(x, 145, `Contact ${k + 1}`, { size: 12 })).join('') +
      GA.check(420, 110) + GA.text(420, 145, 'One purchase', { size: 12, w: 600, fill: 'var(--good)' }) +
      GA.box(470, 60, 140, 100, 'var(--surface-2)') + GA.text(540, 92, '3 contacts', { w: 650, fill: 'var(--text)' }) + GA.text(540, 114, '1 client', { w: 650, fill: 'var(--text)' }) + GA.text(540, 136, '1 purchase', { w: 650, fill: 'var(--good)' })),
    results: GA.svg(GA.defs + [['Model', 0.62, BLUE], ['Current', 0.34, ORANGE], ['Random', 0.12, GRAY]].map(([l, v, c], k) => { const y = 50 + k * 50; return GA.text(110, y + 17, l, { anchor: 'end', w: 600, fill: 'var(--text)' }) + `<rect x="122" y="${y}" width="${v * 700}" height="26" rx="6" style="fill:${c}"/>`; }).join('') +
      GA.text(330, 208, 'Same budget, same people available — who brought in more purchases?', { size: 12.5 })),
    causal: GA.svg(GA.defs + GA.box(40, 30, 260, 150, 'var(--surface-2)') + GA.box(340, 30, 260, 150, 'var(--surface-2)') +
      GA.text(170, 54, 'Contacted', { w: 650, fill: 'var(--text)' }) + GA.text(470, 54, 'Held out (not contacted)', { w: 650, fill: 'var(--text)' }) +
      GA.crowd(100, 90, 5, 2, 34, k => ({ fill: BLUE, ring: [0, 2, 5, 7].includes(k) })) + GA.crowd(400, 90, 5, 2, 34, k => ({ fill: GRAY, ring: [1, 6, 8].includes(k) })) +
      GA.text(170, 168, '4 of 10 bought', { w: 600 }) + GA.text(470, 168, '3 of 10 bought anyway', { w: 600 }) +
      GA.text(320, 208, 'The real effect of outreach is the difference: about 1 in 10, not 4 in 10.', { size: 12.5, w: 600, fill: 'var(--text)' })),
  };
  const m = n.model, r = n.rnd, c = n.cur;
  return [
    { title: 'What this page answers', art: art.overview,
      body: `<p>Imagine running a real campaign over the period in your file. At every send, each strategy chooses who to contact from the same group of people. Afterwards we look at who actually went on to buy a membership.</p><p>The page lines strategies up side by side: the model’s picks, your current approach, a simple rule you define, and pure chance as a baseline.</p>`,
      means: m && r ? `In the current scenario, contacting the model’s picks would have reached <b>${fmtInt(m.episodesCaptured)}</b> people who later bought, versus <b>${fmtInt(r.episodesCaptured)}</b> if the same number of people had been picked at random.` : 'Run the comparison to see your own numbers here.' },
    { title: 'Who can be contacted at each send', art: art.pool,
      body: `<p>At every send (${n.cad}, between ${esc(st.d0)} and ${esc(st.d1)}) we start with the <b>eligible pool</b>: people who have a recent model score and have not already bought.</p><p>“Recent” means scored in the last <b>${st.fresh} day${st.fresh === 1 ? '' : 's'}</b> (score freshness). You can also limit the pool to certain segments, or leave out people today’s strategy already targets.</p>`,
      means: n.pool ? `With your settings about <b>${fmtInt(n.pool)}</b> people are eligible at a typical send. Every strategy chooses from exactly this group, so the comparison is fair.` : 'Every strategy chooses from exactly the same pool, so the comparison is fair.' },
    { title: 'Everyone gets the same budget', art: art.budget,
      body: `<p>The <b>audience per send</b> is your budget — how many people marketing can contact each time. Every strategy gets the same budget and fills it its own way:</p><ul><li><b>Model · top X%</b> takes the people the model rates most likely to buy.</li><li><b>Current strategy</b> takes people who meet today’s rules.</li><li><b>Feature rule</b> takes people who meet a condition you set (for example “at least one class in the last 30 days”).</li><li><b>Model · threshold</b> takes everyone above a score cut-off.</li><li><b>Random</b> takes people by chance — what you would get with no targeting at all.</li></ul>`,
      means: n.per ? `Right now each strategy can contact about <b>${fmtInt(n.per)}</b> people per send (${st.audType === 'pct' ? `${st.audPct}% of the pool` : 'a fixed number'}). If a rule qualifies fewer people than that, it simply contacts fewer — shown as a “budget shortfall”.` : 'Changing the budget changes every strategy at once.' },
    { title: 'Bigger audiences reach more — but less efficiently', art: art.size,
      body: `<p>Raising the budget reaches more future buyers in total, because you contact more people. But the extra people are, on average, less likely to buy than the ones already picked, so the <b>share of contacts that convert</b> goes down.</p><p>That is why the page shows both “purchases captured” (how many) and “contact precision” (how efficiently).</p>`,
      means: 'Pick a budget you can actually afford to contact, then compare strategies at that budget. A strategy is not “better” just because it contacts more people.' },
    { title: 'Not contacting the same people too often', art: art.cooldown,
      body: `<p><b>Cooldown</b> is the minimum gap between two contacts to the same person — currently <b>${st.cooldown} days</b>. While someone is cooling down, their spot goes to the next person in line.</p><p><b>Max contacts per client</b> caps how many times one person can be contacted in total (${st.maxContacts ? `currently ${st.maxContacts}` : 'currently unlimited'}). With <b>suppression</b> on, anyone who buys is removed from later sends.</p>`,
      means: 'A longer cooldown spreads your budget over more different people (more reach) and avoids fatigue, but it can skip someone at the moment they are most ready to buy.' },
    { title: 'When does a purchase count?', art: art.window,
      body: `<p>After a contact we wait and see whether the person buys. A purchase counts if it happens <b>${st.lag} to ${st.horizon} days</b> after the send — the outcome window.</p><p>Purchases after the window, or before the contact could arrive, do not count for that contact.</p>`,
      means: `A longer window counts more purchases for every strategy, but it also credits purchases that may have nothing to do with the message. Keep it close to how long a campaign realistically influences someone (your model was built for ${S.settings.horizon} days).` },
    { title: 'Counting fairly', art: art.dedupe,
      body: `<p>If someone is contacted three times and then buys once, that is <b>3 contacts</b>, <b>1 person</b> and <b>1 purchase</b>. A purchase is never counted twice, however many messages came before it.</p><p>That keeps strategies that contact the same people repeatedly from looking better than they are.</p>`,
      means: m ? `For the model’s strategy: <b>${fmtInt(m.contacts)}</b> contacts went to <b>${fmtInt(m.uniqueClients)}</b> different people, and <b>${fmtInt(m.episodesCaptured)}</b> distinct purchases followed.` : 'Look at contacts, people and purchases separately — they answer different questions (cost, reach, results).' },
    { title: 'Reading the results', art: art.results,
      body: `<ul><li><b>Purchases captured</b>: how many distinct purchases followed a contact. The headline “how many”.</li><li><b>Contact precision</b>: the share of contacts followed by a purchase. The headline “how efficiently”.</li><li><b>Capture rate</b>: the share of all purchases that could have been reached which a strategy actually reached.</li><li><b>Precision vs random</b>: how many times better than picking people by chance.</li><li><b>Natural audiences</b>: what rules and thresholds do without a budget cap — useful to see their true size.</li></ul>`,
      means: m && r ? `The model’s contacts were followed by a purchase <b>${fmtPct(m.precision)}</b> of the time, versus <b>${fmtPct(r.precision)}</b> for random picks — <b>${fmtX(div(m.precision, r.precision), 1)}</b> as efficient.${c ? ` Today’s strategy: <b>${fmtPct(c.precision)}</b>.` : ''}` : 'Compare strategies on the same row of the matched-budget table.' },
    { title: 'What this cannot tell you (yet)', art: art.causal,
      body: `<p>Everything here is <b>historical</b>: it shows who would have been contacted and who went on to buy. It does <b>not</b> show that the contact caused the purchase. People the model ranks highly often buy anyway.</p><p>The way to measure the real effect is a test: contact most of a strategy’s picks but randomly hold some back, then compare how often each group buys.</p>`,
      means: 'Use this page to choose which strategy to test and at what budget. Use a holdout test to decide whether outreach actually pays off.' },
  ];
}

/* ---------- Likelihood tiers ---------- */
function tiersGuide() {
  const B = simState().bp || {}, r = simState().bpRes;
  const stair = (breaks = true) => GA.svg(GA.defs + Array.from({ length: 16 }, (_, k) => { const h = [150, 146, 141, 138, 96, 92, 90, 86, 50, 48, 46, 44, 42, 22, 20, 19][k], x = 50 + k * 34; return `<rect x="${x}" y="${190 - h}" width="26" height="${h}" rx="4" style="fill:${k < 4 ? BLUE : k < 8 ? ORANGE : k < 13 ? 'var(--s3)' : GRAY}" opacity="${breaks ? 0.85 : 0.6}"/>`; }).join('') +
    (breaks ? [182, 318, 488].map(x => `<line x1="${x}" y1="30" x2="${x}" y2="194" style="stroke:var(--text)" stroke-width="2" stroke-dasharray="5 4"/>`).join('') + GA.text(115, 30, 'Tier 1', { w: 650, fill: 'var(--text)' }) + GA.text(250, 80, 'Tier 2', { w: 650, fill: 'var(--text)' }) + GA.text(400, 130, 'Tier 3', { w: 650, fill: 'var(--text)' }) + GA.text(560, 160, 'Rest', { w: 650, fill: 'var(--text)' }) : '') +
    GA.text(320, 212, 'Each bar: how often people at that point in the day’s ranking went on to buy.', { size: 12.5 }));
  return [
    { title: 'What a tier is', art: GA.svg(GA.defs + GA.crowd(60, 70, 14, 1, 38, k => ({ fill: k < 2 ? BLUE : k < 5 ? ORANGE : k < 9 ? 'var(--s3)' : GRAY })) + GA.arrow(60, 110, 580, 110) + GA.text(60, 135, 'Most likely to buy', { anchor: 'start', w: 600 }) + GA.text(580, 135, 'Least likely', { anchor: 'end', w: 600 }) +
        GA.text(90, 40, 'Tier 1', { w: 650, fill: BLUE }) + GA.text(190, 40, 'Tier 2', { w: 650, fill: ORANGE }) + GA.text(330, 40, 'Tier 3', { w: 650, fill: 'var(--s3)' }) + GA.text(500, 40, 'Rest', { w: 650, fill: 'var(--text-3)' })),
      body: '<p>Every day the model ranks everyone from most to least likely to buy. A <b>tier</b> is a band of that ranking — for example the top 1% of each day, then the next 4%, and so on.</p><p>Tiers let you treat groups differently: a personal call for the very top, an email for the next band, nothing for the rest.</p>',
      means: 'Tiers turn a long list of scores into a few groups your team can act on.' },
    { title: 'How likely each slice is to buy', art: stair(false),
      body: '<p>We cut each day’s ranking into thin slices (top 0.5%, 0.5–1%, …) and measure how often people in each slice went on to buy, across all the days in your file.</p><p>Usually the rate falls as you go down the list. Sometimes it falls in <b>steps</b>: a group at the top that is clearly different from the next.</p>',
      means: 'Steps are natural places to draw tier lines. A smooth slope means there is no natural cut — you then choose tiers by how many people your team can handle.' },
    { title: 'Finding the natural breaks', art: stair(true),
      body: `<p>The automatic search tries 2, 3, … up to ${B.kMax || 6} tiers and keeps the split that best separates high and low buying rates. It only accepts tiers that are big enough (at least ${fmtInt(B.minConv || 100)} buyers each) and clearly different from their neighbours (at least ${B.minRatio || 1.5}× apart).</p><p>You can also type your own break points, or define tiers by how many people per day each team can contact (capacity mode).</p>`,
      means: 'Bigger minimums give fewer, more trustworthy tiers. Smaller minimums give more tiers that may not hold up.' },
    { title: 'Checking that the tiers hold up', art: GA.svg(GA.defs + GA.box(40, 40, 260, 130, 'var(--surface-2)') + GA.box(340, 40, 260, 130, 'var(--surface-2)') + GA.text(170, 66, 'Find the breaks here', { w: 650, fill: 'var(--text)' }) + GA.text(470, 66, 'Confirm them here', { w: 650, fill: 'var(--text)' }) +
        GA.text(170, 92, 'earlier half of the period', { size: 12 }) + GA.text(470, 92, 'later half — unseen', { size: 12 }) + GA.arrow(300, 115, 340, 115) + GA.check(470, 130) + GA.text(470, 158, 'Same steps? Then trust them.', { size: 12, w: 600, fill: 'var(--good)' })),
      body: '<p>Any search will find some steps that are just noise. So the breaks are found on one period and the tier table is reported on a different period the search never saw.</p><p>We also re-run the search many times on reshuffled data and on rolling time windows. A break is <b>stable</b> only if it keeps reappearing in the same place.</p>',
      means: r ? (r.recK ? `In your data the search recommends <b>${r.recK} tiers</b>, and their break points are stable.` : 'In your data no set of break points was stable, so tiers based on capacity (how many people each team can contact) are the safer choice.') : 'Prefer tiers marked “Stable”. If none are stable, use capacity-based tiers.' },
    { title: 'Using tiers wisely', art: GA.svg(GA.defs + GA.box(60, 40, 520, 140, 'var(--surface-2)') + GA.text(320, 74, 'Tier 1 · “Personal call”', { w: 650, fill: 'var(--text)', size: 14 }) + GA.text(320, 104, 'Tier 2 · “Email with offer”', { w: 650, fill: 'var(--text)', size: 14 }) + GA.text(320, 134, 'Rest · “No action”', { w: 650, fill: 'var(--text-3)', size: 14 }) + GA.text(320, 164, 'You name the tiers and write what you plan to test for each.', { size: 12 })),
      body: '<p>Tiers measure <b>likelihood to buy</b>, not whether a contact will change someone’s mind. People at the top may buy with or without a call.</p><p>Give each tier a name and an intervention hypothesis (“coach mentions membership after class”), then test it with a holdout before rolling it out. Both are saved in the tier export.</p>',
      means: 'Use tiers to decide where to focus effort; use a test to learn which action works for each tier.' },
  ];
}

/* ---------- Class rosters ---------- */
function rosterGuide() {
  const classArt = (pick) => GA.svg(GA.defs + GA.box(60, 30, 520, 150, 'var(--surface-2)') + GA.text(320, 56, 'One class on one day', { w: 650, fill: 'var(--text)' }) +
    GA.crowd(120, 100, 10, 2, 44, k => ({ fill: pick && k < 3 ? BLUE : GRAY, op: pick && k < 3 ? 1 : 0.6, ring: k === 1 || k === 12 })) +
    GA.text(320, 205, pick ? 'Blue: the 3 people the model would point the coach to. Green ring: who actually bought.' : 'Every non-member attending, ranked by the model.', { size: 12.5 }));
  return [
    { title: 'What a class roster is', art: classArt(false),
      body: '<p>A <b>roster</b> is the list of non-members attending one class on one day. Coaches can only speak to a few people per class, so the question is: <b>who should they talk to?</b></p>',
      means: 'This view tests the model in the setting coaches actually work in — one class at a time, not one big list.' },
    { title: 'The model picks k people per class', art: classArt(true),
      body: '<p>For each class, the model ranks the attendees and picks the top <b>k</b> (1, 2 or 3). We then check whether a person who went on to buy was among them.</p>',
      means: 'k is how many conversations a coach can realistically have. Compare k = 1 with k = 3 to see how much an extra conversation adds.' },
    { title: 'How success is measured', art: GA.svg(GA.defs + [['Model picks', 0.58, BLUE], ['Random picks', 0.21, GRAY]].map(([l, v, c], k) => { const y = 60 + k * 60; return GA.text(150, y + 18, l, { anchor: 'end', w: 600, fill: 'var(--text)' }) + `<rect x="162" y="${y}" width="${v * 700}" height="28" rx="6" style="fill:${c}"/>` + GA.text(170 + v * 700, y + 19, fmtPct(v, 0), { anchor: 'start', w: 650, fill: 'var(--text)' }); }).join('') + GA.text(320, 200, 'Share of classes (with a buyer) where a buyer was among the picks', { size: 12.5 })),
      body: '<ul><li><b>Hit rate</b>: in classes where someone bought, how often a buyer was among the top k.</li><li><b>Precision@k</b>: the share of picked people who bought.</li><li><b>Random</b>: what you would expect if the coach picked k people by chance.</li></ul>',
      means: 'The gap between the model and random is the value of using the model’s list instead of the coach’s guess at random.' },
    { title: 'Using it in the studio', art: GA.svg(GA.defs + GA.box(60, 40, 520, 140, 'var(--surface-2)') + GA.text(320, 80, 'Before class: “Talk to Alex, Sam and Priya”', { w: 650, fill: 'var(--text)', size: 14 }) + GA.text(320, 112, 'After class: note who was spoken to', { w: 600, size: 13 }) + GA.text(320, 142, 'Later: compare with a group of classes without a list', { w: 600, size: 13 })),
      body: '<p>A short list per class is easy to act on. As with every view here, the numbers show who was <b>likely</b> to buy, not who bought <b>because</b> a coach spoke to them.</p><p>To learn whether conversations make a difference, give lists to some classes and not to comparable others, then compare.</p>',
      means: 'Use the hit rate to decide whether a coach list is worth trying; use a simple comparison test to see whether it changes outcomes.' },
  ];
}

function openSimGuide(anchor) {
  const sub = simState().sub;
  const def = sub === 'tiers' ? { eyebrow: 'How this works · Likelihood tiers', pages: tiersGuide() }
    : sub === 'roster' ? { eyebrow: 'How this works · Class rosters', pages: rosterGuide() }
      : { eyebrow: 'How this works · Campaign comparison', pages: campaignGuide() };
  openGuide({ ...def, anchor });
}
