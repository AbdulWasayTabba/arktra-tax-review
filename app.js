/* Arktra tax planning review demo: page logic. */
(function () {
  'use strict';
  const { PRESETS, LINE_ITEMS } = window.TAX_PRESETS;
  const IMP = window.TAX_IMPORT;
  const CFG = window.ARKTRA_CONFIG || { replays: {} };
  const qs = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const ENDPOINT = (isLocal && qs.get('endpoint')) || CFG.webhookUrl || '';
  const TIMEOUT_MS = 75000;
  const MAX_YEARS = 6;

  const FACTS = [
    ['equipmentPurchased', 'Equipment bought this year', 'money'],
    ['heavyVehicle', 'Includes a vehicle over 6,000 lb', 'bool'],
    ['healthInsurancePremiums', 'Health premiums paid personally', 'money'],
    ['healthInsuranceDeducted', 'Premiums already deducted', 'bool'],
    ['homeOfficeUsed', 'Works from a home office', 'bool'],
    ['homeOfficeClaimed', 'Home office already claimed', 'bool'],
    ['homeOfficeSqft', 'Home office size (sq ft)', 'int'],
    ['retirementPlan', 'Has a retirement plan', 'bool'],
    ['contractors1099Count', 'Contractors paid', 'int'],
    ['priorYearTotalTax', 'Prior-year total federal tax', 'money'],
    ['priorYearAgi', 'Prior-year AGI', 'money'],
    ['estimatedPaymentsMade', 'Estimated tax paid this year', 'money'],
  ];

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const parseNum = (s) => { const t = String(s).replace(/[$,\s]/g, ''); if (t === '') return 0; const n = Number(t); return Number.isFinite(n) && n >= 0 ? n : NaN; };
  const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : '#');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pctTxt = (p) => (p == null ? '' : (p > 0 ? '+' : '') + Math.round(p * 100) + '%');

  const CUSTOM = {
    label: 'Your own numbers',
    blurb: 'Blank sheet: type your figures, upload a CSV or paste from a spreadsheet',
    client: { name: '', owner: '', entity: 'Schedule C sole proprietor', industry: '', filingStatus: 'single' },
    periods: ['2025', '2026'],
    lines: Object.fromEntries(LINE_ITEMS.map((l) => [l.key, [0, 0]])),
    facts: Object.fromEntries(FACTS.map(([k, , t]) => [k, t === 'bool' ? false : 0])),
  };
  const SHEETS = Object.assign({}, PRESETS, { custom: CUSTOM });

  const state = { presetId: 'harborPine', data: null, running: false, locked: false, result: null, reviews: {} };

  // ---------- tabs ----------
  function renderTabs() {
    const box = $('#presetTabs');
    box.innerHTML = Object.entries(SHEETS).map(([id, p]) =>
      `<button type="button" role="tab" aria-selected="${id === state.presetId}" data-id="${id}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('');
    $$('button', box).forEach((b) => b.addEventListener('click', () => {
      if (state.running || b.dataset.id === state.presetId) return;
      loadPreset(b.dataset.id);
    }));
  }

  function loadPreset(id) {
    state.presetId = id;
    state.data = clone(SHEETS[id]);
    state.result = null;
    state.reviews = {};
    $('#importNote').textContent = '';
    renderTabs();
    renderInputs();
    resetPipeline();
    showEmpty();
    applyMode();
  }

  // ---------- inputs ----------
  function renderInputs() {
    const d = state.data;
    $('#clientInfo').innerHTML = `
      <div><label class="k" for="c_name">Client</label><input id="c_name" data-c="name" maxlength="80" placeholder="Business name" value="${esc(d.client.name)}"></div>
      <div><label class="k" for="c_entity">Entity</label><input id="c_entity" data-c="entity" maxlength="80" value="${esc(d.client.entity)}"></div>
      <div><label class="k" for="c_ind">Industry</label><input id="c_ind" data-c="industry" maxlength="80" placeholder="e.g. Consulting" value="${esc(d.client.industry)}"></div>
      <div><label class="k" for="filing">Filing status</label>
        <select id="filing"><option value="single">Single</option><option value="mfj">Married filing jointly</option></select></div>`;
    $$('#clientInfo input').forEach((inp) => inp.addEventListener('input', () => { d.client[inp.dataset.c] = inp.value; }));
    const sel = $('#filing');
    sel.value = d.client.filingStatus;
    sel.addEventListener('change', () => { d.client.filingStatus = sel.value; });
    renderLedger();
    renderFacts();
  }

  function renderLedger() {
    const d = state.data;
    const n = d.periods.length;
    const last = n - 1;
    $('#ledger thead').innerHTML = `<tr><th scope="col">Sch. C line</th>${d.periods.map((p, j) => `
      <th scope="col" class="num${j === last ? ' cur' : ''}"><div class="yr-cell">
        <input class="yr" data-j="${j}" maxlength="24" value="${esc(p)}" aria-label="Year label, column ${j + 1}">
        ${n > 2 ? `<button type="button" class="x" data-j="${j}" aria-label="Remove ${esc(p)}" title="Remove this year">×</button>` : ''}
      </div>${j === last ? '<span class="tag">Planning year</span>' : ''}</th>`).join('')}</tr>`;
    $$('#ledger thead input.yr').forEach((inp) => inp.addEventListener('input', () => { d.periods[+inp.dataset.j] = inp.value.trim() || `Year ${+inp.dataset.j + 1}`; }));
    $$('#ledger thead .x').forEach((b) => b.addEventListener('click', () => removeYear(+b.dataset.j)));

    $('#ledger tbody').innerHTML = LINE_ITEMS.map((li) => `
      <tr><th scope="row"><span class="ln">${esc(li.line)}</span>${esc(li.label)}</th>
        ${d.periods.map((p, j) => `<td class="num"><input type="text" inputmode="decimal" data-key="${li.key}" data-j="${j}"
          value="${fmt(d.lines[li.key][j])}" aria-label="${esc(li.label)}, ${esc(p)}"></td>`).join('')}
      </tr>`).join('');
    $$('#ledger tbody input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const v = parseNum(inp.value);
        inp.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
        if (!Number.isNaN(v)) d.lines[inp.dataset.key][+inp.dataset.j] = v;
        inp.classList.add('edited');
        renderTotals(); updateRunEnabled();
      });
      inp.addEventListener('blur', () => { const v = parseNum(inp.value); if (!Number.isNaN(v)) inp.value = fmt(v); });
    });
    renderTotals();
    $('#addYearBtn').disabled = n >= MAX_YEARS || state.locked;
  }

  function renderFacts() {
    const d = state.data;
    const facts = $('#facts');
    facts.innerHTML = '<legend>Facts from the client interview</legend>' + FACTS.map(([k, label, type]) => {
      const id = 'f_' + k;
      if (type === 'bool') return `<label class="fact" for="${id}"><span>${esc(label)}</span><input id="${id}" type="checkbox" data-k="${k}" ${d.facts[k] ? 'checked' : ''}></label>`;
      return `<label class="fact" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" inputmode="decimal" data-k="${k}" value="${type === 'money' ? fmt(d.facts[k]) : esc(d.facts[k])}"></label>`;
    }).join('');
    $$('input', facts).forEach((inp) => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      if (inp.type === 'checkbox') { d.facts[inp.dataset.k] = inp.checked; return; }
      const v = parseNum(inp.value);
      inp.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
      if (!Number.isNaN(v)) d.facts[inp.dataset.k] = v;
      updateRunEnabled();
    }));
  }

  function netProfitAt(j) {
    const l = state.data.lines;
    const exp = LINE_ITEMS.filter((x) => x.key !== 'grossReceipts' && x.key !== 'cogs').reduce((s, x) => s + l[x.key][j], 0);
    return l.grossReceipts[j] - l.cogs[j] - exp;
  }
  function renderTotals() {
    $('#ledger tfoot').innerHTML = `<tr><th scope="row">Net profit (line 31)</th>${state.data.periods.map((_, j) => `<td class="num">${money(netProfitAt(j))}</td>`).join('')}</tr>`;
  }

  function addYear() {
    const d = state.data;
    if (d.periods.length >= MAX_YEARS || state.locked) return;
    const m = /((?:19|20)\d{2})/.exec(d.periods[0]);
    d.periods.unshift(m ? String(Number(m[1]) - 1) : 'Earlier year');
    Object.values(d.lines).forEach((arr) => arr.unshift(0));
    renderLedger();
    $('#importNote').textContent = `Added ${d.periods[0]}. Fill in its figures, or import them.`;
    const first = $('#ledger tbody input[data-j="0"]');
    if (first) first.focus();
  }
  function removeYear(j) {
    const d = state.data;
    if (d.periods.length <= 2 || state.locked) return;
    const label = d.periods[j];
    d.periods.splice(j, 1);
    Object.values(d.lines).forEach((arr) => arr.splice(j, 1));
    renderLedger();
    $('#importNote').textContent = `Removed ${label}.`;
  }

  function setLocked(locked) {
    state.locked = locked;
    $$('#workpaper input, #workpaper select, #workpaper .tool-btns button, #workpaper thead button').forEach((el) => { el.disabled = locked; });
  }
  const hasInvalid = () => !!document.querySelector('#workpaper [aria-invalid="true"]');
  function updateRunEnabled() {
    const canRun = ENDPOINT || CFG.replays[state.presetId];
    $('#runBtn').disabled = state.running || !canRun || hasInvalid();
  }

  function applyMode() {
    const note = $('#modeNote');
    const btn = $('#runBtn');
    if (ENDPOINT) {
      setLocked(false);
      btn.textContent = 'Run the review';
      note.innerHTML = `Runs live on n8n with ${esc(CFG.modelLabel || 'the configured model')}. A run takes about 20 to 40 seconds.`;
    } else if (CFG.replays[state.presetId]) {
      setLocked(true);
      btn.textContent = 'Show the recorded review';
      note.innerHTML = '<strong>The live workflow is offline.</strong> You can open a recorded run of this client. Editing is off so the figures always match the memo.';
    } else {
      setLocked(false);
      btn.textContent = 'Run the review';
      note.innerHTML = '<strong>The live workflow is not connected yet.</strong> Add the n8n webhook URL in <code>src/config.js</code> and rebuild the site data.';
    }
    updateRunEnabled();
  }

  // ---------- pipeline animation ----------
  let timers = [];
  function resetPipeline() {
    timers.forEach(clearTimeout); timers = [];
    $$('#pipeline li').forEach((li) => { li.className = ''; li.removeAttribute('aria-current'); });
  }
  function setStep(i) {
    $$('#pipeline li').forEach((li, j) => {
      li.className = j < i ? 'done' : j === i ? 'active' : '';
      if (j === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }
  function startPipeline() {
    resetPipeline();
    [0, 350, 800, 1400, 1800].forEach((ms, i) => timers.push(setTimeout(() => setStep(i), ms)));
  }
  function finishPipeline(ok) {
    timers.forEach(clearTimeout); timers = [];
    setStep(5);
    timers.push(setTimeout(() => {
      $$('#pipeline li').forEach((li) => { li.className = ok ? 'done' : 'skipped'; li.removeAttribute('aria-current'); });
    }, 450));
  }

  // ---------- run ----------
  async function run() {
    if (state.running) return;
    const replay = CFG.replays[state.presetId];
    if (!ENDPOINT) { if (replay) showReplay(replay, null); return; }
    const d = state.data;
    if (!(d.lines.grossReceipts[d.periods.length - 1] > 0)) { showError(`Enter gross receipts above zero for ${d.periods[d.periods.length - 1]}, then run the review.`); return; }
    state.running = true; updateRunEnabled();
    $('#runBtn').textContent = 'Running the review…';
    startPipeline();
    showWorking();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const body = { token: CFG.token, preset: state.presetId, client: d.client, periods: d.periods, lines: d.lines, facts: d.facts };
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      let json = null;
      try { json = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.status === 400 && json && json.error) throw Object.assign(new Error(json.error), { input: true });
      if (!res.ok || !json || !json.ok) throw new Error(json && json.error ? json.error : `the workflow returned HTTP ${res.status}`);
      finishPipeline(true);
      state.result = json; state.reviews = {};
      renderMemo(json, null);
    } catch (err) {
      finishPipeline(false);
      const reason = (err.name === 'AbortError' ? 'the workflow did not answer within 75 seconds' : err.message === 'Failed to fetch' ? 'the workflow could not be reached' : String(err.message)).replace(/\.$/, '');
      if (err.input) showError(`The workflow rejected the input: ${reason}. Correct the figure and run it again.`);
      else if (replay) showReplay(replay, reason);
      else showError(`The review could not run: ${reason}. Check that the n8n workflow is active and the webhook URL is correct.`);
    } finally {
      clearTimeout(to);
      state.running = false;
      $('#runBtn').textContent = CFG.replays[state.presetId] && !ENDPOINT ? 'Show the recorded review' : 'Run the review';
      updateRunEnabled();
    }
  }

  function showReplay(replay, reason) {
    state.data = clone(SHEETS[state.presetId]);
    renderInputs();
    setLocked(true);
    state.result = replay; state.reviews = {};
    finishPipeline(true);
    renderMemo(replay, reason ? `The live workflow is unavailable (${reason}). This is a recorded run of the same client, so editing is off.` : 'This is a recorded run of a live review. Editing is off so the figures match the memo.');
  }

  function showEmpty() { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = '<p>The draft memo will appear here once the review runs.</p>'; }
  function showWorking() { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = '<p>Drafting the memo. The workflow is checking the figures and the authorities.</p>'; }
  function showError(msg) { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = `<p><strong>No memo this time.</strong> ${esc(msg)}</p>`; }

  // ---------- memo ----------
  const impactText = (i) => (!i || i.type === 'none' || !i.amount ? '' : i.type === 'savings' ? `Est. tax saved ${money(i.amount)}` : `Est. exposure ${money(i.amount)}`);

  function renderMemo(r, banner) {
    const memo = $('#memo');
    const k = r.summary.kpis;
    const date = new Date(r.meta.generatedAt);
    const cur = r.variance.currentLabel || String(r.meta.taxYear);
    const prv = r.variance.priorLabel || String(r.meta.priorYear);
    memo.innerHTML = `
      ${banner ? `<p class="memo-banner">${esc(banner)}</p>` : ''}
      <header class="memo-head">
        <dl>
          <dt>To</dt><dd>Reviewing CPA</dd>
          <dt>From</dt><dd>Arktra review workflow (${esc(r.meta.model || 'AI model')})</dd>
          <dt>Client</dt><dd>${esc(r.client.name)}, ${r.client.filingStatus === 'mfj' ? 'married filing jointly' : 'single'}</dd>
          <dt>Re</dt><dd>Tax planning review of ${esc(cur)} against ${esc(prv)}${r.variance.trend ? `, with ${r.variance.trend.years} years of history` : ''}</dd>
          <dt>Date</dt><dd>${isNaN(date) ? '' : esc(date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</dd>
        </dl>
        <div class="stamp" aria-label="Status: draft for CPA review">Draft<small>for CPA review</small></div>
      </header>
      <ul class="figures">
        <li><b>${money(k.netProfit)}</b>Net profit, ${esc(cur)}</li>
        <li><b>${k.opportunities}</b>Planning opportunities</li>
        <li><b>${k.attentionItems}</b>Items needing attention</li>
        <li><b>${money(k.savingsLow)}–${money(k.savingsHigh)}</b>Est. savings identified</li>
        ${k.exposure ? `<li><b>${money(k.exposure)}</b>Est. exposure</li>` : ''}
      </ul>
      <h3>Summary</h3>
      <p class="prose">${esc(r.summary.executiveSummary)}</p>

      <h3>Findings for review</h3>
      <ol class="findings">${r.findings.map(findingHtml).join('')}</ol>
      <div class="signoff" id="signoff"></div>

      <h3>Entity scenario: sole proprietor or S corporation</h3>
      ${scenarioHtml(r.scenario, cur)}

      ${r.variance.trend ? `<h3>${r.variance.trend.years}-year trend</h3>${trendHtml(r.variance.trend)}` : ''}

      <h3>${esc(prv)} to ${esc(cur)}</h3>
      ${scheduleHtml(r.variance, prv, cur)}

      ${(r.dataGaps.length || r.nextSteps.length) ? `<div class="cols2">
        ${r.dataGaps.length ? `<div><h3>Information to request</h3><ul>${r.dataGaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${r.nextSteps.length ? `<div><h3>Next steps for the CPA</h3><ol>${r.nextSteps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
      </div>` : ''}

      ${qcHtml(r)}
      <p class="disclaimer">${esc(r.disclaimer)}</p>`;
    $('#memoEmpty').hidden = true;
    memo.hidden = false;
    wireReviews();
    wireChart(r.scenario);
    updateSignoff();
    memo.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function findingHtml(x) {
    const mark = x.citations.length ? '§' : '?';
    const imp = impactText(x.impact);
    return `<li class="finding" data-id="${esc(x.id)}">
      <div class="margin" aria-hidden="true">${mark}</div>
      <div>
        <h4>${esc(x.title)}</h4>
        <p class="meta"><span>${esc(x.category)}</span><span>Confidence: ${esc(x.confidence)}</span>${imp ? `<span class="impact">${imp}</span>` : ''}<span>${x.source === 'ai' ? 'Written by AI from computed data' : 'Rule engine wording'}</span></p>
        <p><span class="label">Observation</span>${esc(x.observation)}</p>
        <p><span class="label">Consider</span>${esc(x.recommendation)}</p>
        ${x.numbersVerified ? '' : '<span class="qc-flag">? A dollar amount here was not found in the computed data. Check it before use.</span>'}
        ${x.citations.length ? `<ul class="cites">${x.citations.map((c) => `<li><a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" title="${esc(c.summary)}">${esc(c.cite)}</a></li>`).join('')}</ul>` : ''}
        ${x.clientQuestions && x.clientQuestions.length ? `<ul class="questions">${x.clientQuestions.map((q) => `<li>Ask the client: ${esc(q)}</li>`).join('')}</ul>` : ''}
        <div class="review" role="group" aria-label="Reviewer decision for ${esc(x.title)}">
          <button type="button" class="approve" aria-pressed="false">Approve</button>
          <button type="button" class="rework" aria-pressed="false">Needs work</button>
          <span class="status">${esc(x.reviewStatus)}</span>
        </div>
      </div>
    </li>`;
  }

  function wireReviews() {
    $$('.finding').forEach((li) => {
      const id = li.dataset.id;
      const [a, w] = $$('.review button', li);
      const status = $('.review .status', li);
      const set = (v) => {
        state.reviews[id] = state.reviews[id] === v ? undefined : v;
        a.setAttribute('aria-pressed', String(state.reviews[id] === 'approved'));
        w.setAttribute('aria-pressed', String(state.reviews[id] === 'rework'));
        status.textContent = state.reviews[id] === 'approved' ? 'Approved by reviewer' : state.reviews[id] === 'rework' ? 'Sent back for rework' : 'Requires CPA review';
        updateSignoff();
      };
      a.addEventListener('click', () => set('approved'));
      w.addEventListener('click', () => set('rework'));
    });
  }
  function updateSignoff() {
    const total = state.result ? state.result.findings.length : 0;
    const vals = Object.values(state.reviews).filter(Boolean);
    const ok = vals.filter((v) => v === 'approved').length;
    const bad = vals.length - ok;
    const el = $('#signoff');
    if (!el) return;
    el.innerHTML = `<span>Reviewer sign-off: ${vals.length} of ${total} items reviewed, ${ok} approved, ${bad} sent back.</span>
      <span>${vals.length === total && total ? (bad ? 'Ready to return to the preparer.' : 'Ready to discuss with the client.') : 'Each item needs a decision before this goes to the client.'}</span>`;
  }

  function scenarioHtml(s, cur) {
    const rows = [
      ['Net profit', 'netProfit'], ['Owner salary (W-2)', 'salary'], ['SE tax / payroll taxes', 'seOrPayrollTax'],
      ['Deductible half of SE tax', 'halfSeDeduction'], ['SE health insurance deduction', 'seHealthDeduction'],
      ['AGI', 'agi'], ['QBI deduction (§199A)', 'qbiDeduction'], ['Taxable income', 'taxableIncome'],
      ['Federal income tax', 'incomeTax'], ['Added compliance cost', 'complianceCost'], ['Total cost', 'totalCost'],
    ];
    return `<div class="compare">
      <div class="chart" id="scChart">
        <div class="legend-row" aria-hidden="true">
          <span><i class="sw" style="background:var(--s1)"></i>Federal income tax</span>
          <span><i class="sw" style="background:var(--s2)"></i>SE / payroll taxes</span>
          <span><i class="sw" style="background:var(--s3)"></i>Compliance cost</span>
        </div>
        <svg viewBox="0 0 400 130" role="img" aria-label="Total annual cost: sole proprietor ${money(s.soleProp.totalCost)}, S corporation ${money(s.sCorp.totalCost)}"></svg>
        <div class="tip" role="presentation"></div>
        <p class="sens">Estimated difference ${money(s.savings)} a year at a ${Math.round(s.salaryRatio * 100)}% salary. Sensitivity: ${s.sensitivity.map((x) => `${money(x.savings)} at ${Math.round(x.salaryRatio * 100)}% (${money(x.salary)} salary)`).join('; ')}.</p>
      </div>
      <div class="table-scroll">
        <table class="schedule">
          <caption class="sr-only">Scenario breakdown</caption>
          <thead><tr><th scope="col">${esc(cur)}</th><th scope="col" class="num">Sole prop</th><th scope="col" class="num">S corp</th></tr></thead>
          <tbody>${rows.map(([l, key]) => `<tr${key === 'totalCost' ? ' style="font-weight:700"' : ''}><th scope="row">${l}</th><td class="num">${money(s.soleProp[key])}</td><td class="num">${money(s.sCorp[key])}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    <ul class="questions">${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  }

  function wireChart(s) {
    const wrap = $('#scChart');
    const svg = $('svg', wrap);
    const tip = $('.tip', wrap);
    const bars = [['Sole proprietor', s.soleProp], ['S corporation', s.sCorp]];
    const max = Math.max(...bars.map(([, b]) => b.totalCost)) || 1;
    const x0 = 108, W = 224, H = 30;
    let out = '';
    bars.forEach(([label, b], i) => {
      const y = 22 + i * 60;
      const segs = [['Federal income tax', b.incomeTax, 'var(--s1)'], ['SE / payroll taxes', b.seOrPayrollTax, 'var(--s2)'], ['Compliance cost', b.complianceCost, 'var(--s3)']].filter((sg) => sg[1] > 0);
      let x = x0;
      out += `<text x="0" y="${y + H / 2 + 4}">${label}</text>`;
      segs.forEach(([name, v, c], j) => {
        const w = Math.max(2, (v / max) * W - (j < segs.length - 1 ? 2 : 0));
        const lastSeg = j === segs.length - 1;
        out += `<path d="${lastSeg && w > 8 ? `M${x},${y}h${w - 4}a4,4 0 0 1 4,4v${H - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z` : `M${x},${y}h${w}v${H}h${-w}z`}" fill="${c}" data-tip="${label}: ${name} ${money(v)}" tabindex="0"></path>`;
        x += w + 2;
      });
      out += `<text class="val" x="${x + 6}" y="${y + H / 2 + 4}">${money(b.totalCost)}</text>`;
    });
    svg.innerHTML = out;
    const show = (e) => {
      const t = e.target.closest('[data-tip]'); if (!t) return;
      const rb = wrap.getBoundingClientRect(); const tb = t.getBoundingClientRect();
      tip.textContent = t.dataset.tip; tip.style.left = (tb.left - rb.left + tb.width / 2) + 'px'; tip.style.top = (tb.top - rb.top) + 'px'; tip.style.opacity = 1;
    };
    const hide = () => { tip.style.opacity = 0; };
    svg.addEventListener('mousemove', show); svg.addEventListener('mouseleave', hide);
    svg.addEventListener('focusin', show); svg.addEventListener('focusout', hide);
  }

  function spark(values) {
    const w = 64, h = 20, max = Math.max(...values), min = Math.min(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 3 - ((v - min) / span) * (h - 6)}`).join(' ');
    const [lx, ly] = pts.split(' ').pop().split(',');
    return `<svg width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="2.5" fill="var(--s1)"/></svg>`;
  }

  function trendHtml(t) {
    const labels = t.byPeriod.map((p) => p.label);
    const rows = t.rows.filter((r) => r.values.some((v) => v));
    return `<p class="sens">Revenue grew ${t.revenueCagr == null ? 'n/a' : pctTxt(t.revenueCagr)} a year. Rows shaded red are costs growing at least 10 points a year faster than revenue.</p>
    <div class="table-scroll"><table class="schedule trend">
      <caption class="sr-only">Multi-year trend by line item with compound annual growth</caption>
      <thead><tr><th scope="col">Line item</th>${labels.map((l) => `<th scope="col" class="num">${esc(l)}</th>`).join('')}<th scope="col" class="num">Per year</th><th scope="col"><span class="sr-only">Trend</span></th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.outpacing ? 'out' : ''}"><th scope="row">${esc(r.label)}</th>${r.values.map((v) => `<td class="num">${money(v)}</td>`).join('')}<td class="num grow">${r.cagr == null ? '' : pctTxt(r.cagr)}</td><td class="spark">${spark(r.values)}</td></tr>`).join('')}</tbody>
      <tfoot>
        <tr><th scope="row">Net profit</th>${t.byPeriod.map((p) => `<td class="num">${money(p.netProfit)}</td>`).join('')}<td></td><td class="spark">${spark(t.byPeriod.map((p) => p.netProfit))}</td></tr>
        <tr><th scope="row">Net margin</th>${t.byPeriod.map((p) => `<td class="num">${Math.round(p.margin * 100)}%</td>`).join('')}<td class="num grow">${t.marginChange > 0 ? '+' : ''}${Math.round(t.marginChange * 100)} pts</td><td></td></tr>
      </tfoot>
    </table></div>`;
  }

  function scheduleHtml(v, prv, cur) {
    const t = v.totals;
    return `<div class="table-scroll"><table class="schedule">
      <caption class="sr-only">Variance schedule, ${esc(prv)} to ${esc(cur)}</caption>
      <thead><tr><th scope="col">Line item</th><th scope="col" class="num">${esc(prv)}</th><th scope="col" class="num">${esc(cur)}</th><th scope="col" class="num">Change</th><th scope="col" class="num">%</th><th scope="col"><span class="sr-only">Flag</span></th></tr></thead>
      <tbody>${v.rows.map((r) => `<tr class="${r.flagged ? 'flag' : ''}"><th scope="row">${esc(r.label)}</th><td class="num">${money(r.prior)}</td><td class="num">${money(r.current)}</td><td class="num">${money(r.change)}</td><td class="num">${r.prior === 0 && r.current === 0 ? '' : r.pct == null ? 'new' : pctTxt(r.pct)}</td><td>${r.flagged ? '<span class="tk" title="Material change">?</span><span class="sr-only">Material change</span>' : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Net profit</th><td class="num">${money(t.prior.netProfit)}</td><td class="num">${money(t.current.netProfit)}</td><td class="num">${money(t.netProfitChange)}</td><td class="num">${t.netProfitPct == null ? '' : pctTxt(t.netProfitPct)}</td><td><span class="tk" title="Footed by code">✓</span><span class="sr-only">Footed by code</span></td></tr></tfoot>
    </table></div>`;
  }

  function qcHtml(r) {
    const q = r.qc;
    const nums = q.unverifiedNumbers.length ? q.unverifiedNumbers.map((u) => `${money(u.amount)} in ${u.findingId}`).join(', ') : 'none';
    return `<section class="qc" aria-label="Quality control on this run">
      <strong>Quality control on this run</strong>
      <ul>
        <li>AI narrative ${q.aiParsed ? 'parsed and checked' : 'unavailable, so the rule engine wording is shown'}${r.meta.llmError ? ` (${esc(r.meta.llmError)})` : ''}.</li>
        <li>${q.findingsFromAi} of ${r.findings.length} findings written by the AI; ${q.findingsFromRules} from rule wording.</li>
        <li>Citations removed for being outside the approved list: ${q.citationsRemoved}. Findings the AI invented and were dropped: ${q.unknownFindingsDropped}.</li>
        <li>Dollar amounts in AI text not found in the computed data: ${esc(nums)}.</li>
      </ul>
      <p class="note">${esc(r.meta.engine)} v${esc(r.meta.engineVersion)}${r.meta.durationMs ? `, ${(r.meta.durationMs / 1000).toFixed(1)} s` : ''}. Tax figures from Rev. Proc. 2025-32.</p>
    </section>`;
  }

  // ---------- smart import ----------
  const mapName = IMP.makeMapper(LINE_ITEMS, FACTS);
  let pending = null; // { layout, targets }
  const TARGET_OPTS = `<option value="skip">Don't use</option><optgroup label="Schedule C line">${LINE_ITEMS.map((l) => `<option value="line:${l.key}">${esc(l.line)} ${esc(l.label)}</option>`).join('')}</optgroup><optgroup label="Fact (uses the latest value)">${FACTS.map(([k, label]) => `<option value="fact:${k}">${esc(label)}</option>`).join('')}</optgroup>`;

  function openImport() {
    if (state.locked || state.running) return;
    pending = null;
    $('#impPreview').hidden = true;
    $('#impStatus').innerHTML = '';
    $('#impFile').textContent = '';
    const dlg = $('#importDlg');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function readImport(text, sourceName) {
    const status = $('#impStatus');
    const layout = IMP.detectLayout(IMP.parseTable(text));
    if (layout.error || !layout.rows || !layout.rows.length) {
      $('#impPreview').hidden = true;
      status.textContent = layout.error || 'No rows found. Put line items down the first column and one column per year.';
      return;
    }
    if (layout.singleYear) {
      $('#impPreview').hidden = true;
      status.textContent = 'Only one year was found. The review compares years, so include at least two year columns.';
      return;
    }
    const targets = layout.rows.map((r) => mapName(r.name, r.values));
    pending = { layout, targets: targets.map((t) => t.target) };
    const counts = { matched: targets.filter((t) => t.target !== 'skip').length, guess: targets.filter((t) => t.how === 'guess').length, skipped: targets.filter((t) => t.target === 'skip').length };
    status.innerHTML = `${esc(sourceName)}: ${layout.rows.length} rows and ${layout.periods.length} years (${layout.periods.map(esc).join(', ')}), sorted oldest to newest${layout.transposed ? ', years read from rows' : ''}. ${counts.matched} rows matched, ${counts.skipped} not used${counts.guess ? `, ${counts.guess} unrecognised ${counts.guess === 1 ? 'row' : 'rows'} put under Other (check ${counts.guess === 1 ? 'it' : 'them'})` : ''}.` +
      (layout.dropped ? `<span class="warn">Only the latest ${IMP.MAX_YEARS} years are kept; ${layout.dropped} older ${layout.dropped === 1 ? 'year was' : 'years were'} left out.</span>` : '');
    $('#impTable').innerHTML = `<thead><tr><th scope="col">Your row</th>${layout.periods.map((p) => `<th scope="col" class="num">${esc(p)}</th>`).join('')}<th scope="col">Goes to</th><th scope="col"><span class="sr-only">How it was matched</span></th></tr></thead>
      <tbody>${layout.rows.map((r, i) => `<tr class="${targets[i].target === 'skip' ? 'skip' : ''} ${targets[i].how === 'guess' ? 'guess' : ''}">
        <th scope="row">${esc(r.name)}</th>
        ${layout.periods.map((_, j) => `<td class="num">${r.values ? (Number.isNaN(r.values[j]) ? `<span title="Not an amount">${esc(r.raw[j])}?</span>` : fmt(r.values[j])) : esc(r.raw[j] || '')}</td>`).join('')}
        <td><select data-i="${i}" aria-label="Destination for ${esc(r.name)}">${TARGET_OPTS}</select></td>
        <td class="how">${{ exact: 'exact match', matched: 'matched by name', guess: 'unrecognised', total: 'total row', heading: 'heading', 'not used': 'not business income', empty: '' }[targets[i].how] || ''}</td>
      </tr>`).join('')}</tbody>`;
    $$('#impTable select').forEach((s) => {
      s.value = pending.targets[+s.dataset.i];
      s.addEventListener('change', () => { pending.targets[+s.dataset.i] = s.value; s.closest('tr').classList.toggle('skip', s.value === 'skip'); s.closest('tr').classList.remove('guess'); });
    });
    $('#impPreview').hidden = false;
  }

  function applyImport() {
    if (!pending) return;
    const out = IMP.buildImport(pending.layout, pending.targets, LINE_ITEMS, FACTS);
    if (!out.lineRows) { $('#impStatus').textContent = 'No rows are going to a Schedule C line. Pick a destination in the "Goes to" column.'; return; }
    const d = state.data;
    d.periods = out.periods;
    d.lines = out.lines;
    Object.assign(d.facts, out.facts);
    const dlg = $('#importDlg');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    renderInputs();
    $$('#ledger tbody input').forEach((i) => { if (d.lines[i.dataset.key].some((v) => v)) i.classList.add('edited'); });
    const nFacts = Object.keys(out.facts).length;
    $('#importNote').textContent = `Imported ${out.lineRows} rows into ${out.periods.length} years (${out.periods.join(', ')})${nFacts ? ` and ${nFacts} ${nFacts === 1 ? 'fact' : 'facts'}` : ''}. The last column is treated as the planning year.` +
      (out.warnings.length ? ` ${out.warnings.slice(0, 3).join(' ')}` : '') + ' Check the figures, then run the review.';
    pending = null;
  }

  function downloadTemplate() {
    const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const d = state.data;
    const blanks = d.periods.slice(0, -1).map(() => '');
    const rows = [['Line item'].concat(d.periods)]
      .concat(LINE_ITEMS.map((l) => [l.label].concat(d.lines[l.key])))
      .concat(FACTS.map(([k, label, t]) => [label].concat(blanks, [t === 'bool' ? (d.facts[k] ? 'yes' : 'no') : d.facts[k]])));
    const blob = new Blob([rows.map((r) => r.map((c) => q(String(c))).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'tax-review-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#importBtn').addEventListener('click', openImport);
  $('#csvFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#impFile').textContent = file.name;
    if (file.size > 500000) { $('#impStatus').textContent = 'That file is larger than 500 KB. Export just the profit and loss report.'; return; }
    file.text().then((t) => readImport(t, file.name));
  });
  $('#readPaste').addEventListener('click', () => {
    const t = $('#pasteBox').value;
    if (!t.trim()) { $('#impStatus').textContent = 'Paste some rows first.'; return; }
    readImport(t, 'Pasted data');
  });
  $('#applyImport').addEventListener('click', applyImport);
  $('#addYearBtn').addEventListener('click', addYear);
  $('#tplBtn').addEventListener('click', downloadTemplate);
  $('#resetBtn').addEventListener('click', () => { if (!state.running && !state.locked) loadPreset(state.presetId); });

  // ---------- boot ----------
  $('#runBtn').addEventListener('click', run);
  loadPreset(state.presetId);
})();
