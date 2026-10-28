// node tests/roll-passages.test.js — passagens de rolos = tabelas de estriagem C e D (Zhax, 28-10-2026)
const assert = require('assert');
const RP = require('../js/roll-passages.js');
const M = require('../js/maint.js');

// Pares por passagem, como indicados por Zhax
const ZHAX = {
  C: { B1: 3, B2: 3, B3: 2, B4: 2, G1: 2, G2: 2, G3: 2, R1: 4, R2: 4, R3: 3, R4: 3, R5: 2, R6: 2, R7: 2 },
  D: { B1: 2, B2: 2, B3: 1, B4: 1, G1: 2, G2: 2, G3: 1, R1: 4, R2: 2, R3: 2, R4: 1, R5: 1, R6: 1 }
};
['C', 'D'].forEach(line => {
  const got = {};
  RP.PASSAGES.filter(p => p.lineId === line).forEach(p => { got[p.passage] = (got[p.passage] || 0) + 1; });
  assert.deepStrictEqual(got, ZHAX[line], 'linha ' + line);
});
// 2 lados por banco: 36 pares = 18 bancos (C, "18 TK"); 22 pares = 11 bancos (D, "11 TK")
assert.strictEqual(RP.PASSAGES.filter(p => p.lineId === 'C').length, 36);
assert.strictEqual(RP.PASSAGES.filter(p => p.lineId === 'D').length, 22);
assert.strictEqual(new Set(RP.PASSAGES.map(p => p.id)).size, RP.PASSAGES.length, 'ids únicos');
// valores da tabela (amostra)
const c1 = RP.PASSAGES.find(p => p.id === 'C-B1-1'), d6 = RP.PASSAGES.find(p => p.id === 'D-R6-1');
assert.deepStrictEqual([c1.spec.flutesPerCm, c1.spec.flutesPerCirc, c1.spec.angle, c1.spec.lengthMm], [2.86, 225, '30 / 65', 1250]);
assert.deepStrictEqual([d6.spec.flutesPerCm, d6.spec.flutesPerCirc, d6.spec.angle, d6.spec.lengthMm], [12.73, 1000, '45 / 70', 1000]);
// horas ideais (Zhax, 28-10-2026): B1/B2 1200, B3/B4 2400, G1/G2 1800, G3 2400, todas as R 3000
assert.deepStrictEqual(RP.DEFAULT_HOURS, { B1: 1200, B2: 1200, B3: 2400, B4: 2400, G1: 1800, G2: 1800, G3: 2400, R: 3000 });
assert.ok(RP.PASSAGES.every(p => RP.DEFAULT_HOURS[p.hoursGroup] > 0 && (p.passage[0] === 'R') === (p.hoursGroup === 'R')));
// estado inicial: contagem desde 01-08-2026; registo de manutenção (Line C) desde Agosto
assert.ok(RP.PASSAGES.every(p => p.baseline.start === '2026-08-01'));
const base = id => RP.PASSAGES.find(p => p.id === id).baseline;
assert.deepStrictEqual([base('C-R3-3').lastChange, base('C-R1-1').lastChange], ['2026-10-12', '2026-10-24']);
assert.deepStrictEqual(['C-B3-1', 'C-R4-3', 'C-R2-3'].map(id => base(id).inspection), ['due', 'due', 'due']);
assert.strictEqual(RP.PASSAGES.filter(p => p.baseline.lastChange || p.baseline.inspection).length, 5);
// com as regras: sem ficheiro de horas, só os 3 pares do registo pedem inspecção
const st = M.rollState(RP.PASSAGES, [], '2026-10-28', { hours: null, limits: RP.DEFAULT_HOURS });
assert.strictEqual(st.length, 58);
assert.deepStrictEqual(st.filter(r => r.status === 'inspect').map(r => r.id).sort(), ['C-B3-1', 'C-R2-3', 'C-R4-3']);
assert.deepStrictEqual(st.find(r => r.id === 'C-R3-3').startDay, '2026-10-13');
console.log('OK — passagens de rolos (C 36 pares, D 22 pares)');
