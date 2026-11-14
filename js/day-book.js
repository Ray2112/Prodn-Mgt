/* Livro do dia (Prodn-Mgt 2.9.0, Zhax 14-11-2026): tudo o que foi registado num dia de produção (07:00 → 07:00), para o
 * separador Registos (lista por categoria e hora) e para o Relatório (resumos de produção, grão, produtos, paragens, segurança,
 * actividades e CQ). Regras puras (sem DOM). Browser: window.DayBook · Node: module.exports.
 * d = {samples, jobs, shiftLog, moves, stocks, binEvents, prodChanges, maint}; range = [início, fim) em ms. */
(function (root) {
  'use strict';
  const isNum = v => typeof v === 'number' && isFinite(v);
  const r3 = v => Math.round(v * 1000) / 1000;
  const CATS = ['qc', 'shift', 'jobs', 'grain', 'bins', 'products', 'stops', 'maint', 'safety', 'acts', 'warn'];
  const SAFETY_TYPES = ['accident', 'nearmiss', 'hazard', 'unsafe'];
  const inR = (t, r) => isNum(t) && t >= r[0] && t < r[1];
  const effLog = log => { const v = new Set((log || []).filter(e => e.kind === 'void').map(e => e.voids)); return (log || []).filter(e => e.kind !== 'void' && !v.has(e.uid)); };
  const effSamples = s => { const sup = new Set((s || []).filter(x => x.correctsId).map(x => x.correctsId)); return (s || []).filter(x => !sup.has(x.id)); };
  const effMaint = m => { const v = new Set((m || []).filter(e => e.kind === 'void').map(e => e.voids)); return (m || []).filter(e => e.kind !== 'void' && !v.has(e.uid)); };

  // Itens do dia: [{t, cat, kind, rec}] por ordem de hora (o texto é feito pela interface, na língua de quem lê)
  function items(d, range) {
    const out = [], add = (t, cat, kind, rec) => { if (inR(t, range)) out.push({ t, cat, kind, rec }); };
    effSamples(d.samples).forEach(x => add(x.t, 'qc', 'sample', x));
    (d.jobs || []).forEach(j => { add(j.startedAt, 'jobs', 'jobStart', j); if (j.closedAt) add(j.closedAt, 'jobs', 'jobClose', j); });
    effLog(d.shiftLog).forEach(x => {
      if (x.kind === 'login' || x.kind === 'logout') add(x.t, 'shift', x.kind, x);
      else if (x.kind === 'issue') add(x.t, 'stops', 'issue', x);
      else if (x.kind === 'activity') add(x.t, 'acts', 'activity', x);
      else if (x.kind === 'safety') add(x.t, 'safety', 'safety', x);
    });
    (d.moves || []).forEach(m => add(m.t, 'grain', m.type === 'EMPTY' ? 'binEmptied' : 'transfer', m));
    (d.stocks || []).forEach(s => add(s.t, 'bins', 'stock', s));
    (d.binEvents || []).filter(e => !e.voidedBy).forEach(e => add(e.t, 'products', 'bin' + e.type, e));
    (d.prodChanges || []).filter(c => c.kind === 'warnClear').forEach(c => add(c.t, 'warn', 'warnClear', c));
    effMaint(d.maint).forEach(m => { if (['stop', 'work', 'pmUpdate', 'consumable', 'shift', 'note'].indexOf(m.kind) >= 0) add(m.startT || m.t, m.kind === 'stop' ? 'stops' : 'maint', 'm_' + m.kind, m); });
    return out.sort((a, b) => a.t - b.t);
  }

  // Resumos do dia para o Relatório
  function summary(d, range) {
    const it = items(d, range);
    const of = k => it.filter(x => x.kind === k).map(x => x.rec);
    // produção: quantidades das balanças pelos logouts do dia (turno de dia e de noite)
    const outs = of('logout');
    const prod = outs.map(lo => {
      const k = lo.shiftKg || {}, b1 = k.b1, fl = isNum(k.flour1) || isNum(k.flour2) ? (k.flour1 || 0) + (k.flour2 || 0) : null;
      return { period: lo.period, b1, flour1: k.flour1, flour2: k.flour2, germ: k.germ, zf: k.zf, clean: k.clean, screenings: k.screenings,
        extraction: isNum(b1) && b1 > 0 && isNum(fl) ? Math.round(fl / b1 * 10000) / 100 : null, pct: lo.achievedPct, target: lo.targetKg };
    });
    // grão: transferências para as bins de milho sujo, por bin e por silo
    const tr = of('transfer'), byBin = {}, bySilo = {};
    tr.forEach(m => { byBin[m.binId] = r3((byBin[m.binId] || 0) + (m.kg || 0)); (m.parts || []).forEach(p => { bySilo[p.silo] = r3((bySilo[p.silo] || 0) + (p.kg || 0)); }); });
    // produtos: saídas por destino e produto; enchimentos por produto (eventos FILL das ordens)
    const outEv = of('binOUT'), byDest = {}, outByProd = {};
    outEv.forEach(e => { byDest[e.dest || 'other'] = r3((byDest[e.dest || 'other'] || 0) + (e.kg || 0)); outByProd[e.productId || '?'] = r3((outByProd[e.productId || '?'] || 0) + (e.kg || 0)); });
    const fills = of('binFILL').map(e => ({ bin: e.binId, productId: e.productId }));
    // paragens: diário (issue) e manutenção (stop)
    const stops = of('issue').filter(i => isNum(i.downtimeMin)).map(i => ({ src: 'log', code: i.code, min: i.downtimeMin, tier: (i.codeInfo || {}).tier3 || null, cat: i.category || null }))
      .concat(of('m_stop').map(s => ({ src: 'maint', code: s.code, min: s.durationMin, tier: s.category || null, cat: s.stopKind || null })));
    const stopMin = stops.reduce((s, x) => s + (isNum(x.min) ? x.min : 0), 0), byTier = {};
    stops.forEach(x => { if (isNum(x.min)) byTier[x.tier || '—'] = (byTier[x.tier || '—'] || 0) + x.min; });
    // segurança e actividades
    const safety = of('safety'), sByType = {};
    safety.forEach(x => { sByType[x.sType] = (sByType[x.sType] || 0) + 1; });
    const acts = of('activity'), aByType = {};
    let reprocKg = 0;
    acts.forEach(a => { aByType[a.type] = (aByType[a.type] || 0) + 1; if (a.type === 'reprocessing' && isNum(a.qtyKg)) reprocKg += a.qtyKg; });
    const qc = of('sample'), qByDec = {};
    qc.forEach(s => { qByDec[s.decision] = (qByDec[s.decision] || 0) + 1; });
    return { items: it, prod, grain: { n: tr.length, kg: r3(tr.reduce((s, m) => s + (m.kg || 0), 0)), byBin, bySilo, fromGrainMgt: tr.filter(m => m.source === 'grain-mgt').length },
      products: { out: outEv, byDest, outByProd, fills, stockReadings: of('stock') }, stops: { list: stops, min: stopMin, byTier },
      safety: { list: safety, byType: sByType }, acts: { list: acts, byType: aByType, reprocKg: r3(reprocKg) }, qc: { n: qc.length, byDec: qByDec },
      jobs: { started: of('jobStart'), closed: of('jobClose') }, maint: of('m_work').concat(of('m_pmUpdate')), warnClears: of('warnClear') };
  }
  // Ocorrência de segurança (v2.9.0): tipo, descrição; acção e pessoa ferida opcionais
  function validateSafety(o) {
    const e = [];
    if (SAFETY_TYPES.indexOf(o.sType) < 0) e.push('sType');
    if (!String(o.description || '').trim()) e.push('description');
    if (!String(o.by || '').trim()) e.push('by');
    return e;
  }
  const api = { CATS, SAFETY_TYPES, items, summary, validateSafety };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DayBook = api;
})(typeof window !== 'undefined' ? window : this);
