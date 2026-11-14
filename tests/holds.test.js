// v2.13.0: retenções de bins (só milho sujo e produto, confirmadas pelo supervisor de CQ) e kg nas bins (Zhax, 14-11-2026)
const assert = require('assert');
const P = require('../js/prod.js');
const cfgP = P.defaultProdConfig();
const B = P.holdableBins(cfgP);
assert.ok(B.some(b => b.id === 'B01' && b.kind === 'dirty'), 'B01 (milho sujo) pode ser retida');
assert.ok(B.every(b => b.kind === 'dirty' || b.kind === 'product'), 'só milho sujo e produto');
assert.ok(!B.some(b => (cfgP.temperedBins || []).some(x => x.id === b.id) && !(cfgP.bins || []).some(x => x.id === b.id) && !(cfgP.dirtyBins || []).some(x => x.id === b.id)), 'temperado não');
const ch = [{ kind: 'binHold', binId: 'B01', t: 1, reason: 'aflatoxina' }, { kind: 'binHold', binId: 'B44', t: 2 }, { kind: 'binRelease', binId: 'B44', t: 3 }, { kind: 'warnClear', t: 4 }];
const H = P.binHolds(ch);
assert.deepStrictEqual(Object.keys(H), ['B01'], 'libertada sai; a última manda');
assert.deepStrictEqual(P.validateHold({ binId: 'B01', reason: '', by: '' }, cfgP, H, false), ['holdAlready', 'holdReason', 'holdBy']);
assert.deepStrictEqual(P.validateHold({ binId: 'B44', reason: 'x', by: 'QA' }, cfgP, H, true), ['holdNone']);
assert.deepStrictEqual(P.validateHold({ binId: 'ZZ', reason: 'x', by: 'QA' }, cfgP, H, false), ['holdBin']);
// despacho de bin retida: bloqueado
const r = P.validateDispatch({ binId: 'B44', kg: '1000', dest: 'bagging', by: 'Rui' }, cfgP, [], { B44: { kind: 'binHold' } });
assert.ok(r.errors.some(e => e.code === 'bin_hold'), 'saída de bin retida é recusada');
assert.ok(P.SOFT.indexOf('bin_hold') < 0, 'retenção não passa a aviso');
// kg nas bins
assert.deepStrictEqual(P.readBinKg(['B44', 'B45', 'B46'], { B44: '12 000', B45: '0', B46: '' }), { values: { B44: 12000, B45: 0 }, bad: ['B46'] });
// total por produto e % de carga
const ev = [{ binId: 'B44', type: 'SET', productId: 'fuba2', t: 1 }, { binId: 'B45', type: 'SET', productId: 'fuba2', t: 1 }];
const cap = id => (cfgP.bins.find(b => b.id === id) || {}).capKg;
const T = P.productTotals(cfgP, ev, id => (id === 'B44' ? { kg: cap('B44') / 2 } : id === 'B45' ? { kg: null } : null));
assert.strictEqual(T.length, 1);
assert.deepStrictEqual([T[0].productId, T[0].bins, T[0].kg, T[0].unknown, T[0].pct], ['fuba2', ['B44', 'B45'], cap('B44') / 2, 1, 50]);
console.log('holds.test: OK');
