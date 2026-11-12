// v2.7.0: login / logout de turno e paragens (Zhax, 12-11-2026)
const assert = require('assert');
const P = require('../js/prod.js');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('FALHOU:', name); throw e; } }
const H = 3600000, T0 = Date.parse('2026-11-12T07:00:00Z');

t('paragem: categoria → códigos v3, duração calculada, falha obrigatória', () => {
  assert.ok(P.codesForCat('electrical').every(c => c.tier3 === 'Breakdown'));
  assert.ok(P.codesForCat('process').some(c => c.code === 'P01'));
  let r = P.validateStop({ category: 'electrical', code: 'A01', start: T0, end: T0 + 95 * 60000, fault: 'Disjuntor disparou' });
  assert.deepStrictEqual(r, { errors: [], downtimeMin: 95 });
  r = P.validateStop({ category: 'process', code: 'A01', start: T0, end: T0 - 1, fault: '' });
  assert.deepStrictEqual(r.errors, ['code', 'end', 'fault'], 'código de avaria numa paragem de processo; fim antes do início');
  assert.deepStrictEqual(P.validateStop({ category: 'x', code: 'P01', start: T0, end: T0 + 25 * H, fault: 'a' }).errors, ['category', 'end']);
});

t('balanças: em branco fica null, inválido assinalado; quantidade do turno = fim − início', () => {
  const a = P.readScales({ b1: '1.000.000', clean: '', germ: 'abc' });
  assert.deepStrictEqual([a.values.b1, a.values.clean, a.bad], [1000000, null, ['germ']]);
  const s = P.shiftScaleKg({ b1: 1000000, flour1: 500, zf: 10 }, { b1: 1190000, flour1: 400, zf: null });
  assert.deepStrictEqual([s.kg.b1, s.kg.flour1, s.kg.zf, s.negative], [190000, null, null, ['flour1']]);
  assert.deepStrictEqual(P.SCALES, ['clean', 'screenings', 'b1', 'flour1', 'flour2', 'germ', 'zf']);
  assert.strictEqual(P.SCALE_SCADA.zf, 'Z.F');
});

t('plano do dia e % do objectivo', () => {
  const plan = { days: { '2026-11-12': [{ line: 'C', product: 'F.Amarela 2', productId: 'fuba2', targetKg: 200000 }, { line: 'D', targetKg: 1 }] } };
  assert.deepStrictEqual(P.dayPlan(plan, '2026-11-12', 'C').map(r => r.targetKg), [200000]);
  assert.deepStrictEqual(P.dayPlan(null, '2026-11-12', 'C'), []);
  assert.strictEqual(P.achievedPct(190000, 200000), 95);
  assert.strictEqual(P.achievedPct(190000, 0), null);
  assert.strictEqual(P.achievedPct(null, 200000), null);
});

console.log('shift: OK (' + n + ')');
