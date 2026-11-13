// v2.8.0: stock e descargas da Grain-Mgt (Zhax, 13-11-2026)
const assert = require('assert');
const P = require('../js/prod.js');
const cfgP = P.defaultProdConfig();
const st = { kind: 'silos-status', writer: 'grain-mgt', app: 'moagem-app', exportedAt: '2026-11-14T10:00:00.000Z',
  settings: [{ key: 'main', value: { silos: [{ id: 'S03', cereal: 'Milho', colour: 'Amarelo', grade: '1', cap: '1000000' }] } }],
  events: [{ uid: 'a', silo: 'S03', type: 'IN', kg: 500000, date: '2026-11-13', time: '08:00' },
    { uid: 'old', silo: 'S03', type: 'OUT', kg: 20000, bin: 'B01', date: '2026-11-14', time: '06:59' },
    { uid: 'b', silo: 'S03', type: 'OUT', kg: 30000, bin: 'B01', date: '2026-11-14', time: '08:15', operator: 'Rui' },
    { uid: 'c', silo: 'S03', type: 'OUT', kg: 5000, bin: 'B05', date: '2026-11-14', time: '09:00' },
    { uid: 'd', silo: 'S03', type: 'OUT', kg: 1, bin: 'B02', date: '2026-11-14', time: '09:00', test: true }],
  sevents: [] };
const snap = P.parseSilosStatus(st, 1);
assert.strictEqual(snap.silos[0].kg, 445000, 'stock do silo a partir dos eventos (500 t − 20 − 30 − 5; teste fora)');
assert.strictEqual(snap.uid, 'auto:2026-11-14T10:00:00.000Z');
assert.throws(() => P.parseSilosStatus({ kind: 'x' }, 1));
const mv = P.grainMgtMoves(st, cfgP, P.autoFeedFromMs());
assert.deepStrictEqual(mv.map(m => [m.uid, m.binId, m.kg, m.parts[0].colour, m.by]), [['gm:b', 'B01', 30000, 'Amarelo', 'Rui']],
  'só depois da passagem, só B01–B04, sem registos de teste');
assert.strictEqual(P.gmEvMs({ date: '2026-11-14', time: '07:00' }), P.autoFeedFromMs());
// bins-status: a janela da conciliação começa na passagem
const empty = { uid: 'e', type: 'EMPTY', binId: 'B01', t: P.autoFeedFromMs() - 86400000, bookKg: 0 };
const manual = { uid: 'm', type: 'TRANSFER', binId: 'B01', t: P.autoFeedFromMs() - 3600000, kg: 10, parts: [{ silo: 'S05', kg: 10 }] };
const bs = P.buildBinsStatus(cfgP, [empty, manual].concat(mv), [], { now: P.autoFeedFromMs() + 3 * 3600000, feedFrom: P.autoFeedFromMs() });
const b1 = bs.bins.find(b => b.id === 'B01');
assert.deepStrictEqual(b1.transfers.map(t => t.parts[0].silo), ['S03'], 'transferência à mão antes da passagem fica fora da conciliação');
const before = P.buildBinsStatus(cfgP, [empty, manual], [], { now: P.autoFeedFromMs() - 60000, feedFrom: P.autoFeedFromMs() });
assert.strictEqual(before.bins.find(b => b.id === 'B01').transfers.length, 1, 'antes da passagem nada muda');
console.log('grain-feed: OK');
