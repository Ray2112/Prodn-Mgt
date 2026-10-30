// node tests/bin-stock.test.js — totais das bins de manhã e nível das bins (v2.4.0, Zhax 30-10-2026)
const assert = require('assert');
const P = require('../js/prod.js');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('FALHOU:', name); throw e; } }
const T0 = Date.UTC(2026, 9, 30, 6, 0);   // 30-10-2026 07:00 (Luanda)
const H = 3600000;
const cfgP = P.defaultProdConfig();
const stock = (t, levels) => ({ uid: 's' + t, kind: 'stock', t, prodDay: '2026-10-30', levels, by: 'X' });
const codes = r => r.errors.map(e => e.code);
const mv = (binId, kg, t, type) => ({ uid: 'm' + t + binId, type: type || 'TRANSFER', binId, t, kg, parts: [{ silo: 'S01', kg, cereal: 'Milho', colour: 'Branco', grade: 'G1' }] });

t('lista das bins: milho sujo, temperado e produto, com capacidade', () => {
  const B = P.stockBins(cfgP);
  assert.deepStrictEqual(B.filter(b => b.kind === 'dirty').map(b => b.id), ['B01', 'B02', 'B03', 'B04']);
  assert.deepStrictEqual(B.filter(b => b.kind === 'tempered').map(b => b.id), ['B05', 'B06', 'B07', 'B08']);
  assert.ok(B.filter(b => b.kind === 'product').map(b => b.id).indexOf('B45') >= 0);
  assert.ok(B.every(b => b.capKg > 0));
});

t('leitura da manhã: kg (formato angolano), acima da capacidade recusado, produto obrigatório em bin de produto com grão', () => {
  let r = P.validateBinStock({ levels: { B01: { kg: '45.000' }, B45: { kg: '120 000', productId: 'super' }, B44: { kg: '0' } }, by: 'Ana' }, cfgP);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.values, { B01: { kg: 45000, productId: null, kind: 'dirty', capKg: 130000 }, B45: { kg: 120000, productId: 'super', kind: 'product', capKg: 188000 }, B44: { kg: 0, productId: null, kind: 'product', capKg: 188000 } });
  r = P.validateBinStock({ levels: { B01: { kg: '140.000' }, B45: { kg: '10.000' }, B02: { kg: 'abc' } }, by: '' }, cfgP);
  assert.deepStrictEqual(codes(r), ['stock_over_cap', 'stock_bad', 'stock_product', 'stock_by']);
  assert.deepStrictEqual(codes(P.validateBinStock({ levels: {}, by: 'Ana' }, cfgP)), ['stock_none']);
});

t('leitura actualiza o conteúdo das bins de produto (SET/EMPTY); produto diferente recusado', () => {
  const ev = [{ binId: 'B44', type: 'FILL', productId: 'fuba1', t: T0 - H }, { binId: 'B47', type: 'FILL', productId: 'super', t: T0 - H }];
  let r = P.validateBinStock({ levels: { B45: { kg: '100', productId: 'super' }, B47: { kg: '0' } }, by: 'Ana' }, cfgP, { binEvents: ev, jobs: [] });
  assert.deepStrictEqual(r.binOps.map(o => [o.binId, o.type, o.productId]), [['B45', 'SET', 'super'], ['B47', 'EMPTY', null]]);
  r = P.validateBinStock({ levels: { B44: { kg: '100', productId: 'super' } }, by: 'Ana' }, cfgP, { binEvents: ev, jobs: [] });
  assert.deepStrictEqual(codes(r), ['stock_product_mismatch']);
  r = P.validateBinStock({ levels: { B47: { kg: '0' } }, by: 'Ana' }, cfgP, { binEvents: ev, jobs: [{ status: 'running', bins: ['B47'] }] });
  assert.deepStrictEqual(r.binOps, [], 'ordem em curso a encher: não esvazia');
});

t('milho sujo: leitura + transferências − ordens depois da leitura; vazio recomeça; sem leitura = cálculo antigo', () => {
  const stocks = [stock(T0, { B01: { kg: 50000 } })];
  const moves = [mv('B01', 999, T0 - H), mv('B01', 30000, T0 + H)];
  const jobs = [{ uid: 'j', status: 'running', startedAt: T0 + 2 * H, alloc: [{ bin: 'B01', kg: 20000 }] }, { uid: 'old', status: 'running', startedAt: T0 - H, alloc: [{ bin: 'B01', kg: 5000 }] }];
  let L = P.binLevel('B01', { cfgP, stocks, moves, jobs });
  assert.deepStrictEqual([L.kg, L.inKg, L.outKg, L.freeKg, L.state, L.source], [60000, 30000, 20000, 70000, 'OK', 'reading']);
  L = P.binLevel('B01', { cfgP, stocks, moves: moves.concat([mv('B01', 0, T0 + 3 * H, 'EMPTY')]), jobs });
  assert.deepStrictEqual([L.kg, L.state], [0, 'EMPTY'], 'vazio depois da leitura');
  assert.strictEqual(P.binLevel('B02', { cfgP, stocks, moves: [mv('B02', 40000, T0)], jobs: [] }).source, 'calc');
  assert.strictEqual(P.binLevel('B02', { cfgP, stocks, moves: [mv('B02', 40000, T0)], jobs: [] }).kg, 40000);
});

t('produto: leitura + o planeado pelas ordens iniciadas depois; cheia; temperado só a leitura; sem leitura = desconhecido', () => {
  const stocks = [stock(T0, { B45: { kg: 150000, productId: 'super' }, B05: { kg: 60000 } })];
  const jobs = [{ uid: 'j', status: 'running', startedAt: T0 + H, outputs: [{ productId: 'super', binPlan: [{ bin: 'B45', kg: 38000 }, { bin: 'B44', kg: 10000 }] }] },
    { uid: 'c', status: 'cancelled', startedAt: T0 + H, outputs: [{ binPlan: [{ bin: 'B45', kg: 99999 }] }] }];
  let L = P.binLevel('B45', { cfgP, stocks, jobs });
  assert.deepStrictEqual([L.kg, L.freeKg, L.state, L.pct], [188000, 0, 'FULL', 100]);
  assert.deepStrictEqual([P.binLevel('B05', { cfgP, stocks, jobs }).kg, P.binLevel('B05', { cfgP, stocks, jobs }).pct], [60000, 63.2]);
  L = P.binLevel('B46', { cfgP, stocks, jobs });
  assert.deepStrictEqual([L.kg, L.state, L.freeKg], [null, 'UNKNOWN', null]);
  L = P.binLevel('B45', { cfgP, stocks, jobs, binEvents: [{ binId: 'B45', type: 'EMPTY', t: T0 + 2 * H }] });
  assert.strictEqual(L.kg, 0, 'vazio registado depois da leitura');
  assert.ok(P.stockDone(stocks, '2026-10-30') && !P.stockDone(stocks, '2026-10-31'));
});

// ordem: as mesmas bases do teste de produção (70 000 kg de super, extracção 70 %, B01 + B02, temperado B05)
function ctx(extra) {
  return Object.assign({ cfgP, millType: 'maize', jobs: [], binEvents: [], shiftStart: T0, now: T0 + 3 * H,
    moves: [mv('B01', 60000, T0 - 2 * H), mv('B02', 100000, T0 - 2 * H)] }, extra || {});
}
const baseJob = bins => ({ productId: 'super', lineId: 'C', targetKg: '70.000', sources: ['B01', 'B02'], tempered: ['B05'], bins,
  m0: '12,0', impurities: '1,5', m1: '16', feedKgh: '', recipe: { colours: ['Branco'], grades: ['G1'] }, targetExtraction: '70' });

t('ordem: bin cheia bloqueia; espaço livre real; fila para a próxima bin; próximas bins sugeridas', () => {
  const stocks = [stock(T0, { B45: { kg: 188000, productId: 'super' }, B44: { kg: 150000, productId: 'super' }, B46: { kg: 0 } })];
  let r = P.validateJob(baseJob(['B45']), ctx({ stocks }));
  assert.ok(codes(r).indexOf('bin_full') >= 0, 'B45 cheia');
  r = P.validateJob(baseJob(['B44']), ctx({ stocks }));
  const cap = r.errors.find(e => e.code === 'bin_capacity');
  assert.deepStrictEqual([cap.need, cap.cap], [70000, 38000], 'só cabem 38 000 kg na B44');
  assert.ok(!r.warnings.some(w => w.code === 'bin_level_unknown'), 'com leitura, o nível já não é desconhecido');
  // pela ordem das Definições; B45 (cheia) e B43 (linha D) ficam de fora; B46 lida a zero: 188 000 kg livres
  const nb = r.calc.outputs[0].nextBins.map(x => [x.bin, x.freeKg]);
  assert.deepStrictEqual(nb, [['B34', null], ['B35', null], ['B40', null], ['B46', 188000], ['B47', null], ['B09', null], ['B10', null]]);
  r = P.validateJob(baseJob(['B44', 'B46']), ctx({ stocks }));
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.calc.outputs[0].binPlan, [{ bin: 'B44', kg: 38000 }, { bin: 'B46', kg: 32000 }]);
  assert.deepStrictEqual(r.calc.outputs[0].binSwitches, [{ from: 'B44', to: 'B46' }]);
});

t('fonte da ordem e transferência usam a leitura da manhã', () => {
  const stocks = [stock(T0, { B01: { kg: 0 }, B02: { kg: 100000 } })];
  const r = P.validateJob(baseJob(['B46']), ctx({ stocks }));
  assert.ok(codes(r).indexOf('source_empty') >= 0, 'B01 lida a zero');
  const full = [stock(T0, { B03: { kg: 125000 } })];
  const tr = P.validateTransfer({ binId: 'B03', silos: [], kg: '10.000', silosConfirmed: true }, { cfgP, millType: 'maize', snapshot: null, moves: [], jobs: [], stocks: full });
  assert.ok(codes(tr).indexOf('dirty_bin_full') >= 0, 'só cabem 5 000 kg');
  const st = P.buildBinsStatus(cfgP, [], [], { now: T0, stocks: full });
  assert.strictEqual(st.bins.find(b => b.id === 'B03').kg, 125000);
});

t('cópia de segurança aceita binStock', () => {
  assert.ok(P.validProdBackup({ binStock: [stock(T0, { B01: { kg: 1 } })] }));
  assert.ok(!P.validProdBackup({ binStock: [{ uid: 'x', kind: 'other', levels: {} }] }));
});

console.log('bin-stock: ' + n + ' testes OK');
