/* Smart import: reads CSV / TSV / pasted spreadsheet data in common layouts and maps rows to Schedule C lines.
 * Pure functions so they can be tested in Node (test/import.test.js). */
(function (root) {
  'use strict';
  const MAX_YEARS = 6;
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

  // ---------- parsing ----------
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join('\n');
    const count = (ch) => (sample.match(new RegExp(ch === '\t' ? '\t' : '\\' + ch, 'g')) || []).length;
    const cands = [['\t', count('\t')], [',', count(',')], [';', count(';')]];
    cands.sort((a, b) => b[1] - a[1]);
    return cands[0][1] > 0 ? cands[0][0] : ',';
  }

  function parseTable(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const d = detectDelimiter(src);
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { row.push(cur.trim()); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cur.trim()); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
    return rows.filter((r) => r.some((c) => c !== ''));
  }

  // "$1,234", "(1,234)", "1 234.50", "-", "" -> number | 0 (blank) | NaN
  function parseAmount(s) {
    let t = String(s == null ? '' : s).trim();
    if (t === '' || t === '-' || t === '—' || /^n\/?a$/i.test(t)) return 0;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
    t = t.replace(/[$€£\s,]/g, '').replace(/^usd/i, '');
    if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
    if (!/^\d*\.?\d+$/.test(t)) return NaN;
    const n = Number(t);
    return neg ? -n : n;
  }

  const YEAR_RE = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g;
  function yearsIn(s) { const out = []; let m; const re = new RegExp(YEAR_RE); while ((m = re.exec(String(s)))) out.push(Number(m[1])); return out; }
  const RELATIVE = [[/prior|last|previous|filed|py/, -1], [/current|this|projected|ytd|cy|budget/, 0]];
  const EXCLUDE_HEADER = /%|change|variance|diff|total|vs\b|versus|growth|avg|average/i;

  function periodKey(h) {
    const ys = yearsIn(h);
    if (ys.length === 1) return ys[0];
    const n = norm(h);
    for (const [re, off] of RELATIVE) if (re.test(n)) return 100000 + off;
    return null;
  }

  // Finds the name column, the period columns (oldest -> newest) and the data rows.
  function detectLayout(matrix) {
    if (!matrix.length) return { error: 'No data found.' };
    const tryHeader = (m) => {
      for (let h = 0; h < Math.min(10, m.length); h++) {
        const cols = [];
        m[h].forEach((cell, c) => {
          if (c === 0 || !cell || EXCLUDE_HEADER.test(cell) || yearsIn(cell).length > 1) return;
          const k = periodKey(cell);
          if (k != null) cols.push({ c, k, label: cell.replace(/\s+/g, ' ').trim().slice(0, 24) });
        });
        if (cols.length >= 2) return { h, cols };
      }
      return null;
    };
    let m = matrix;
    let found = tryHeader(m);
    let transposed = false;
    if (!found) {
      // Years down the first column? Transpose and try again.
      const width = Math.max(...m.map((r) => r.length));
      const t = Array.from({ length: width }, (_, c) => m.map((r) => r[c] || ''));
      const f2 = tryHeader(t);
      if (f2) { m = t; found = f2; transposed = true; }
    }
    let periods; let cols; let start;
    if (found) {
      start = found.h + 1;
      const seen = new Set();
      cols = found.cols.sort((a, b) => a.k - b.k || a.c - b.c).filter((x) => (seen.has(x.k) ? false : seen.add(x.k)));
      periods = cols.map((x) => x.label);
    } else {
      // No headers: use columns that are mostly numbers, oldest assumed left.
      const width = Math.max(...m.map((r) => r.length));
      const numeric = [];
      for (let c = 1; c < width; c++) {
        const vals = m.map((r) => r[c]).filter((v) => v !== undefined && v !== '');
        if (vals.length && vals.filter((v) => !Number.isNaN(parseAmount(v))).length / vals.length >= 0.6) numeric.push(c);
      }
      if (numeric.length < 1) return { error: 'Could not find any columns of amounts. Put line items in the first column and one column per year.' };
      start = Number.isNaN(parseAmount(m[0][numeric[0]])) ? 1 : 0;
      cols = numeric.map((c) => ({ c }));
      periods = numeric.length === 2 ? ['Prior year', 'Current year'] : numeric.map((_, i) => `Year ${i + 1}`);
    }
    let dropped = 0;
    if (cols.length > MAX_YEARS) { dropped = cols.length - MAX_YEARS; cols = cols.slice(-MAX_YEARS); periods = periods.slice(-MAX_YEARS); }
    const rows = [];
    for (const r of m.slice(start)) {
      const name = (r[0] || '').trim();
      if (!name) continue;
      const raw = cols.map((x) => r[x.c]);
      if (raw.every((v) => v == null || String(v).trim() === '')) {
        rows.push({ name, values: null, raw }); // section heading or a fact with no amount yet
        continue;
      }
      rows.push({ name, values: raw.map(parseAmount), raw });
    }
    return { periods, rows, transposed, dropped, singleYear: cols.length < 2 };
  }

  // ---------- mapping ----------
  function makeMapper(LINE_ITEMS, FACTS) {
    const exact = new Map();
    LINE_ITEMS.forEach((l) => [l.key, l.label, 'line' + l.line, 'schc' + l.line].forEach((n) => exact.set(norm(n), 'line:' + l.key)));
    FACTS.forEach(([k, label]) => [k, label].forEach((n) => exact.set(norm(n), 'fact:' + k)));
    const SKIP = /^(total|net(ordinary)?(income|profit|loss|earnings)|grossprofit|grossmargin|operatingincome|ebitda|incomebeforetax|profit$|expenses$|income$|ordinaryincome)/;
    const RULES = [
      [/interest(income|earned)|dividend|gainon|otherincome|refund/, 'skip'],
      [/healthinsurance|medicalinsurance/, 'fact:healthInsurancePremiums'],
      [/estimatedtax|estimatedpayment/, 'fact:estimatedPaymentsMade'],
      [/costofgoods|cogs|costofsales|costofrevenue|materials|purchases|inventory|jobcosts/, 'line:cogs'],
      [/^(bank|merchant|processing|late|filing|card|stripe|paypal|service)(charges|fees?)/, 'line:otherExpenses'],
      [/sales|revenue|receipts|feesearned|feeincome|^fees$|professionalfees(earned|income)|serviceincome|consultingincome|grossincome|turnover|billings/, 'line:grossReceipts'],
      [/advertis|marketing|promotion|ads$|adspend/, 'line:advertising'],
      [/auto|vehicle|car(and|$)|truck|fuel|gasoline|mileage|parking|toll/, 'line:carTruck'],
      [/contractlabor|contractor|subcontract|freelanc|1099|outsourc/, 'line:contractLabor'],
      [/depreciation|amortization|section179/, 'line:depreciation'],
      [/meal|entertain|dining/, 'line:meals'],
      [/travel|airfare|hotel|lodging|flight/, 'line:travel'],
      [/payrolltax|taxesandlicenses|license|permit|businesstax/, 'line:otherExpenses'],
      [/insurance/, 'line:insurance'],
      [/legal|accounting|bookkeep|professional|attorney|taxprep|audit/, 'line:legalProfessional'],
      [/rent|lease/, 'line:rentLease'],
      [/office/, 'line:officeExpense'],
      [/suppl|smalltools|tools/, 'line:supplies'],
      [/utilit|phone|internet|telephone|electric|water|mobile|cellular/, 'line:utilities'],
      [/wage|salar|payroll|staff|employee/, 'line:wages'],
      [/software|subscription|dues|membership|bank|fee|repair|maintenance|postage|shipping|training|education|computer|hosting|website|merchant|misc|other|expense/, 'line:otherExpenses'],
    ];
    return function mapName(name, values) {
      const n = norm(name);
      if (!n) return { target: 'skip', how: 'empty' };
      if (exact.has(n)) return { target: exact.get(n), how: 'exact' };
      const noLine = n.replace(/^(schc)?line/, '');
      if (exact.has('line' + noLine)) return { target: exact.get('line' + noLine), how: 'exact' };
      if (SKIP.test(n)) return { target: 'skip', how: 'total' };
      for (const [re, t] of RULES) if (re.test(n)) return { target: t, how: t === 'skip' ? 'not used' : 'matched' };
      if (values && values.some((v) => v)) return { target: 'line:otherExpenses', how: 'guess' };
      return { target: 'skip', how: 'heading' };
    };
  }

  // Turns a detected layout + chosen targets into {periods, lines, facts, warnings}.
  function buildImport(layout, targets, LINE_ITEMS, FACTS) {
    const n = layout.periods.length;
    const lines = Object.fromEntries(LINE_ITEMS.map((l) => [l.key, Array(n).fill(0)]));
    const facts = {}; const warnings = [];
    let lineRows = 0;
    layout.rows.forEach((row, i) => {
      const t = targets[i];
      if (!t || t === 'skip') return;
      const [kind, key] = t.split(':');
      if (kind === 'line') {
        if (!row.values) return;
        row.values.forEach((v, j) => {
          if (Number.isNaN(v)) { warnings.push(`"${row.name}" ${layout.periods[j]}: "${row.raw[j]}" is not an amount, treated as 0.`); return; }
          lines[key][j] += v;
        });
        lineRows++;
      } else if (kind === 'fact') {
        const type = (FACTS.find((f) => f[0] === key) || [])[2];
        const rawLast = [...row.raw].reverse().find((v) => v != null && String(v).trim() !== '');
        if (type === 'bool') facts[key] = /^(y|yes|true|1|x)$/i.test(String(rawLast || '').trim());
        else { const v = parseAmount(rawLast); if (!Number.isNaN(v) && v >= 0) facts[key] = v; }
      }
    });
    Object.entries(lines).forEach(([k, arr]) => arr.forEach((v, j) => {
      if (v < 0) { warnings.push(`${(LINE_ITEMS.find((l) => l.key === k) || {}).label} for ${layout.periods[j]} added up to a negative amount and was set to 0.`); arr[j] = 0; }
      else arr[j] = Math.round(v * 100) / 100;
    }));
    return { periods: layout.periods.slice(), lines, facts, lineRows, warnings };
  }

  const api = { parseTable, parseAmount, detectLayout, makeMapper, buildImport, MAX_YEARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TAX_IMPORT = api;
})(typeof window !== 'undefined' ? window : globalThis);
