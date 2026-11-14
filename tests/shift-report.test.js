// v2.10.0: relatório de um só turno (Zhax, 14-11-2026)
const assert = require('assert');
const L = require('../js/logic.js');
const t0 = new Date(2026, 10, 14, 7, 0).getTime(), h = 3600000;
const r = { day: '2026-11-14', start: t0, end: t0 + 24 * h,
  samples: [{ t: t0 + h, decision: 'accept' }, { t: t0 + 13 * h, decision: 'warn' }, { t: t0 + 20 * h, decision: 'reject' }],
  summary: [{ period: 'D' }, { period: 'N' }], holds: [{ openedAt: t0 + 2 * h, closedAt: t0 + 3 * h }], alerts: [] };
const d = L.shiftReport(r, 'D'), n = L.shiftReport(r, 'N');
assert.deepStrictEqual([d.totals.n, d.totals.accept, d.summary.length, d.holds.length, d.end - d.start], [1, 1, 1, 1, 12 * h]);
assert.deepStrictEqual([n.totals.n, n.totals.warn, n.totals.reject, n.alerts.length, n.holds.length, n.start], [2, 1, 1, 2, 0, t0 + 12 * h]);
assert.strictEqual(L.shiftReport(r, ''), r, 'dia inteiro sem mudança');
console.log('shift-report.test: OK');
