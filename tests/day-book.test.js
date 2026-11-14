// v2.9.0: livro do dia — registos e relatório (Zhax, 14-11-2026)
const assert = require('assert');
const B = require('../js/day-book.js');
const P = require('../js/prod.js');
const T0 = Date.parse('2026-11-14T06:00:00Z'), H = 3600000, R = [T0, T0 + 24 * H];
const d = {
  samples: [{ id: 'a', t: T0 + H, decision: 'warn' }, { id: 'b', t: T0 + 2 * H, decision: 'accept', correctsId: 'a' }, { id: 'c', t: T0 - H, decision: 'accept' }],
  jobs: [{ uid: 'j', startedAt: T0 + H, closedAt: T0 + 10 * H, lineId: 'C' }],
  shiftLog: [{ uid: 'l', kind: 'login', t: T0 + 60000, period: 'D' }, { uid: 'o', kind: 'logout', t: T0 + 12 * H, period: 'D', shiftKg: { b1: 200000, flour1: 160000, flour2: 10000 }, achievedPct: 95 },
    { uid: 's', kind: 'safety', t: T0 + 3 * H, sType: 'nearmiss', description: 'x' }, { uid: 'i', kind: 'issue', t: T0 + 4 * H, code: 'A01', downtimeMin: 30, codeInfo: { tier3: 'Breakdown' } },
    { uid: 'a1', kind: 'activity', t: T0 + 5 * H, type: 'reprocessing', qtyKg: 1200 }, { uid: 'v', kind: 'void', voids: 'a1', t: T0 + 6 * H },
    { uid: 'a2', kind: 'activity', t: T0 + 7 * H, type: 'reprocessing', qtyKg: 800 }],
  moves: [{ type: 'TRANSFER', binId: 'B01', kg: 30000, t: T0 + 2 * H, parts: [{ silo: 'S03', kg: 30000 }], source: 'grain-mgt' }],
  stocks: [{ t: T0 + 30 * 60000, levels: { B01: { kg: 104625, dipM: 4.5 } }, scope: 'dips' }],
  binEvents: [{ binId: 'B44', type: 'OUT', kg: 12000, dest: 'bagging', productId: 'super', t: T0 + 8 * H }, { binId: 'B44', type: 'FILL', productId: 'super', t: T0 + H }],
  prodChanges: [], maint: [{ uid: 'm', kind: 'stop', startT: T0 + 9 * H, durationMin: 40, code: 'A02', category: 'Breakdown', stopKind: 'electrical' }]
};
const it = B.items(d, R);
assert.ok(!it.some(x => x.rec.id === 'a'), 'amostra corrigida não aparece');
assert.ok(!it.some(x => x.rec.id === 'c'), 'fora do dia de produção');
assert.ok(!it.some(x => x.rec.uid === 'a1'), 'registo anulado não aparece');
assert.deepStrictEqual(it.map(x => x.cat).filter((c, i, a) => a.indexOf(c) === i).sort(), ['acts', 'bins', 'grain', 'jobs', 'products', 'qc', 'safety', 'shift', 'stops']);
const s = B.summary(d, R);
assert.deepStrictEqual([s.prod[0].b1, s.prod[0].extraction, s.prod[0].pct], [200000, 85, 95]);
assert.deepStrictEqual([s.grain.kg, s.grain.byBin.B01, s.grain.bySilo.S03, s.grain.fromGrainMgt], [30000, 30000, 30000, 1]);
assert.deepStrictEqual([s.products.byDest.bagging, s.products.outByProd.super, s.products.fills.length], [12000, 12000, 1]);
assert.deepStrictEqual([s.stops.min, s.stops.byTier.Breakdown], [70, 70]);
assert.deepStrictEqual([s.safety.byType.nearmiss, s.acts.reprocKg], [1, 800]);
assert.deepStrictEqual(B.validateSafety({ sType: 'x', description: '', by: '' }), ['sType', 'description', 'by']);
// v2.9.0: leituras das balanças com vírgula
assert.deepStrictEqual([P.scaleNum('1,234,567'), P.scaleNum('2.190.000'), P.fmtScale(2190000), P.fmtScale(null)], [1234567, 2190000, '2,190,000', '']);
assert.ok(P.SHIFT_JOBS.indexOf('hk6') >= 0 && P.SHIFT_JOBS.indexOf('other') >= 0);
console.log('day-book: OK');
