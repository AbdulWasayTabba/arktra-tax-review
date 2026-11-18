/* Arktra tax planning review demo: page logic. */
(function () {
  'use strict';
  const { PRESETS, LINE_ITEMS } = window.TAX_PRESETS;
  const CFG = window.ARKTRA_CONFIG || { replays: {} };
  const qs = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const ENDPOINT = (isLocal && qs.get('endpoint')) || CFG.webhookUrl || '';
  const TIMEOUT_MS = 75000;

  const FACTS = [
    ['equipmentPurchased', 'Equipment bought in 2026', 'money'],
    ['heavyVehicle', 'Includes a vehicle over 6,000 lb', 'bool'],
    ['healthInsurancePremiums', 'Health premiums paid personally', 'money'],
    ['healthInsuranceDeducted', 'Premiums already deducted', 'bool'],
    ['homeOfficeUsed', 'Works from a home office', 'bool'],
    ['homeOfficeClaimed', 'Home office already claimed', 'bool'],
    ['homeOfficeSqft', 'Home office size, sq ft', 'int'],
    ['retirementPlan', 'Has a retirement plan', 'bool'],
    ['contractors1099Count', 'Contractors paid', 'int'],
    ['priorYearTotalTax', '2025 total federal tax', 'money'],
    ['priorYearAgi', '2025 AGI', 'money'],
    ['estimatedPaymentsMade', '2026 estimated payments made', 'money'],
  ];

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const parseNum = (s) => { const t = String(s).replace(/[$,\s]/g, ''); if (t === '') return 0; const n = Number(t); return Number.isFinite(n) && n >= 0 ? n : NaN; };
  const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : '#');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const state = { presetId: 'harborPine', data: null, running: false, locked: false, result: null, reviews: {} };

  // ---------- inputs ----------
  function renderTabs() {
    const box = $('#presetTabs');
    box.innerHTML = Object.entries(PRESETS).map(([id, p]) =>
      `<button type="button" role="tab" aria-selected="${id === state.presetId}" data-id="${id}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (state.running || b.dataset.id === state.presetId) return;
      loadPreset(b.dataset.id);
    }));
  }

  function loadPreset(id) {
    state.presetId = id;
    state.data = clone(PRESETS[id]);
    state.result = null;
    state.reviews = {};
    renderTabs();
    renderInputs();
    resetPipeline();
    showEmpty();
    applyMode();
  }

  function renderInputs() {
    const d = state.data;
    $('#clientInfo').innerHTML = `
      <div><span class="k">Client</span><span class="v">${esc(d.client.name)}</span></div>
      <div><span class="k">Entity</span><span class="v">${esc(d.client.entity)}</span></div>
      <div><span class="k">Industry</span><span class="v">${esc(d.client.industry)}</span></div>
      <div><label class="k" for="filing">Filing status</label>
        <select id="filing"><option value="single">Single</option><option value="mfj">Married filing jointly</option></select></div>`;
    const sel = $('#filing');
    sel.value = d.client.filingStatus;
    sel.addEventListener('change', () => { d.client.filingStatus = sel.value; });

    $('#ledger tbody').innerHTML = LINE_ITEMS.map((li) => `
      <tr><th scope="row"><span class="ln">${esc(li.line)}</span>${esc(li.label)}</th>
        ${['prior', 'current'].map((w) => `<td class="num"><input type="text" inputmode="decimal" data-key="${li.key}" data-w="${w}"
          value="${fmt(d.lines[li.key][w])}" aria-label="${esc(li.label)}, ${w === 'prior' ? '2025 filed' : '2026 projected'}"></td>`).join('')}
      </tr>`).join('');
    $('#ledger tbody').querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const v = parseNum(inp.value);
        inp.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
        if (!Number.isNaN(v)) d.lines[inp.dataset.key][inp.dataset.w] = v;
        renderTotals(); updateRunEnabled();
      });
      inp.addEventListener('blur', () => { const v = parseNum(inp.value); if (!Number.isNaN(v)) inp.value = fmt(v); });
    });
    renderTotals();

    const facts = $('#facts');
    facts.innerHTML = '<legend>Facts from the client interview</legend>' + FACTS.map(([k, label, type]) => {
      const id = 'f_' + k;
      if (type === 'bool') return `<label class="fact" for="${id}"><span>${esc(label)}</span><input id="${id}" type="checkbox" data-k="${k}" ${d.facts[k] ? 'checked' : ''}></label>`;
      return `<label class="fact" for="${id}"><span>${esc(label)}</span><input id="${id}" type="text" inputmode="decimal" data-k="${k}" data-t="${type}" value="${type === 'money' ? fmt(d.facts[k]) : esc(d.facts[k])}"></label>`;
    }).join('');
    facts.querySelectorAll('input').forEach((inp) => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      if (inp.type === 'checkbox') { d.facts[inp.dataset.k] = inp.checked; return; }
      const v = parseNum(inp.value);
      inp.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
      if (!Number.isNaN(v)) d.facts[inp.dataset.k] = v;
      updateRunEnabled();
    }));
  }

  function totals() {
    const l = state.data.lines;
    const t = (w) => {
      const exp = LINE_ITEMS.filter((x) => x.key !== 'grossReceipts' && x.key !== 'cogs').reduce((s, x) => s + l[x.key][w], 0);
      return l.grossReceipts[w] - l.cogs[w] - exp;
    };
    return { prior: t('prior'), current: t('current') };
  }
  function renderTotals() {
    const t = totals();
    $('#ledger tfoot').innerHTML = `<tr><th scope="row">Net profit (line 31)</th><td class="num">${money(t.prior)}</td><td class="num">${money(t.current)}</td></tr>`;
  }

  function setLocked(locked) {
    state.locked = locked;
    document.querySelectorAll('#workpaper input, #workpaper select').forEach((el) => { el.disabled = locked; });
  }
  const hasInvalid = () => !!document.querySelector('#workpaper [aria-invalid="true"]');
  function updateRunEnabled() {
    const btn = $('#runBtn');
    const canRun = ENDPOINT || CFG.replays[state.presetId];
    btn.disabled = state.running || !canRun || hasInvalid();
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
  const STEPS = ['validate', 'variance', 'rules', 'authority', 'ai', 'verify'];
  let timers = [];
  function resetPipeline() {
    timers.forEach(clearTimeout); timers = [];
    document.querySelectorAll('#pipeline li').forEach((li) => { li.className = ''; li.removeAttribute('aria-current'); });
  }
  function setStep(i) {
    document.querySelectorAll('#pipeline li').forEach((li, j) => {
      li.className = j < i ? 'done' : j === i ? 'active' : '';
      if (j === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }
  function startPipeline() {
    resetPipeline();
    const at = [0, 350, 800, 1400, 1800];
    at.forEach((ms, i) => timers.push(setTimeout(() => setStep(i), ms)));
  }
  function finishPipeline(ok) {
    timers.forEach(clearTimeout); timers = [];
    setStep(5);
    timers.push(setTimeout(() => {
      document.querySelectorAll('#pipeline li').forEach((li) => { li.className = ok ? 'done' : 'skipped'; li.removeAttribute('aria-current'); });
    }, 450));
  }

  // ---------- run ----------
  async function run() {
    if (state.running) return;
    const replay = CFG.replays[state.presetId];
    if (!ENDPOINT) { if (replay) showReplay(replay, null); return; }
    state.running = true; updateRunEnabled();
    $('#runBtn').textContent = 'Running the review…';
    startPipeline();
    showWorking();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const body = { token: CFG.token, preset: state.presetId, client: state.data.client, lines: state.data.lines, facts: state.data.facts };
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      let json = null;
      try { json = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.status === 400 && json && json.error) throw Object.assign(new Error(json.error), { input: true });
      if (!res.ok || !json || !json.ok) throw new Error(json && json.error ? json.error : `The workflow returned HTTP ${res.status}.`);
      finishPipeline(true);
      state.result = json; state.reviews = {};
      renderMemo(json, null);
    } catch (err) {
      finishPipeline(false);
      const reason = (err.name === 'AbortError' ? 'the workflow did not answer within 75 seconds' : err.message === 'Failed to fetch' ? 'the workflow could not be reached' : String(err.message)).replace(/\.$/, '');
      if (err.input) showError(`The workflow rejected the input: ${reason}. Correct the highlighted figure and run it again.`);
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
    loadDataFromReplay();
    setLocked(true);
    state.result = replay; state.reviews = {};
    finishPipeline(true);
    renderMemo(replay, reason ? `The live workflow is unavailable (${reason}). This is a recorded run of the same client, so editing is off.` : 'This is a recorded run of a live review. Editing is off so the figures match the memo.');
  }
  function loadDataFromReplay() {
    state.data = clone(PRESETS[state.presetId]);
    renderInputs();
  }

  function showEmpty() { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = '<p>The draft memo will appear here once the review runs.</p>'; }
  function showWorking() { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = '<p>Drafting the memo. The workflow is checking the figures and the authorities.</p>'; }
  function showError(msg) { $('#memo').hidden = true; $('#memoEmpty').hidden = false; $('#memoEmpty').innerHTML = `<p><strong>No memo this time.</strong> ${esc(msg)}</p>`; }

  // ---------- memo ----------
  const pct = (p) => (p == null ? 'new' : (p > 0 ? '+' : '') + Math.round(p * 100) + '%');
  const impactText = (i) => (!i || i.type === 'none' || !i.amount ? '' : i.type === 'savings' ? `Est. tax saved ${money(i.amount)}` : `Est. exposure ${money(i.amount)}`);

  function renderMemo(r, banner) {
    const memo = $('#memo');
    const k = r.summary.kpis;
    const date = new Date(r.meta.generatedAt);
    const f = r.findings;
    memo.innerHTML = `
      ${banner ? `<p class="memo-banner">${esc(banner)}</p>` : ''}
      <header class="memo-head">
        <dl>
          <dt>To</dt><dd>Reviewing CPA</dd>
          <dt>From</dt><dd>Arktra review workflow (${esc(r.meta.model || 'AI model')})</dd>
          <dt>Client</dt><dd>${esc(r.client.name)}, ${r.client.filingStatus === 'mfj' ? 'married filing jointly' : 'single'}</dd>
          <dt>Re</dt><dd>${r.meta.taxYear} tax planning review against the ${r.meta.priorYear} return</dd>
          <dt>Date</dt><dd>${isNaN(date) ? '' : esc(date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</dd>
        </dl>
        <div class="stamp" aria-label="Status: draft for CPA review">Draft<small>for CPA review</small></div>
      </header>
      <ul class="figures">
        <li><b>${money(k.netProfit)}</b>Projected net profit</li>
        <li><b>${k.opportunities}</b>Planning opportunities</li>
        <li><b>${k.attentionItems}</b>Items needing attention</li>
        <li><b>${money(k.savingsLow)}–${money(k.savingsHigh)}</b>Est. savings identified</li>
        ${k.exposure ? `<li><b>${money(k.exposure)}</b>Est. exposure</li>` : ''}
      </ul>
      <h3>Summary</h3>
      <p class="prose">${esc(r.summary.executiveSummary)}</p>

      <h3>Findings for review</h3>
      <ol class="findings">${f.map(findingHtml).join('')}</ol>
      <div class="signoff" id="signoff"></div>

      <h3>Entity scenario: sole proprietor or S corporation</h3>
      ${scenarioHtml(r.scenario)}

      <h3>Year-over-year schedule</h3>
      ${scheduleHtml(r.variance)}

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
    document.querySelectorAll('.finding').forEach((li) => {
      const id = li.dataset.id;
      const [a, w] = li.querySelectorAll('.review button');
      const status = li.querySelector('.review .status');
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

  function scenarioHtml(s) {
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
          <thead><tr><th scope="col">${s.taxYear} projection</th><th scope="col" class="num">Sole prop</th><th scope="col" class="num">S corp</th></tr></thead>
          <tbody>${rows.map(([l, key]) => `<tr${key === 'totalCost' ? ' style="font-weight:700"' : ''}><th scope="row">${l}</th><td class="num">${money(s.soleProp[key])}</td><td class="num">${money(s.sCorp[key])}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    <ul class="questions">${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  }

  function wireChart(s) {
    const wrap = $('#scChart');
    const svg = wrap.querySelector('svg');
    const tip = wrap.querySelector('.tip');
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
        const last = j === segs.length - 1;
        out += `<path d="${last ? `M${x},${y}h${w - 4}a4,4 0 0 1 4,4v${H - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z` : `M${x},${y}h${w}v${H}h${-w}z`}" fill="${c}" data-tip="${label}: ${name} ${money(v)}" tabindex="0"></path>`;
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

  function scheduleHtml(v) {
    const t = v.totals;
    return `<div class="table-scroll"><table class="schedule">
      <caption class="sr-only">Year-over-year variance schedule</caption>
      <thead><tr><th scope="col">Line item</th><th scope="col" class="num">2025</th><th scope="col" class="num">2026</th><th scope="col" class="num">Change</th><th scope="col" class="num">%</th><th scope="col"><span class="sr-only">Flag</span></th></tr></thead>
      <tbody>${v.rows.map((r) => `<tr class="${r.flagged ? 'flag' : ''}"><th scope="row">${esc(r.label)}</th><td class="num">${money(r.prior)}</td><td class="num">${money(r.current)}</td><td class="num">${money(r.change)}</td><td class="num">${r.prior === 0 && r.current === 0 ? '' : pct(r.pct)}</td><td>${r.flagged ? '<span class="tk" title="Material change">?</span><span class="sr-only">Material change</span>' : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Net profit</th><td class="num">${money(t.prior.netProfit)}</td><td class="num">${money(t.current.netProfit)}</td><td class="num">${money(t.netProfitChange)}</td><td class="num">${pct(t.netProfitPct)}</td><td><span class="tk" title="Footed by code">✓</span><span class="sr-only">Footed by code</span></td></tr></tfoot>
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

  // ---------- boot ----------
  $('#runBtn').addEventListener('click', run);
  loadPreset(state.presetId);
})();
