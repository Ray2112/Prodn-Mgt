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
assert.ok(RP.PASSAGES.every(p => p.refluteEveryDays === null), 'intervalo de reestriagem ainda não definido');
// funciona com as regras de rolos
const st = M.rollState(RP.PASSAGES, [], '2026-10-28');
assert.strictEqual(st.length, 58);
assert.ok(st.every(r => !r.overdue && r.plan === null));
console.log('OK — passagens de rolos (C 36 pares, D 22 pares)');
