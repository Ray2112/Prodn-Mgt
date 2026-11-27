/* Moagem — Produção: interface (ordens de produção, diário de turno, silos de produto, definições).
 * Criada por app.js com ProdUI(ctx). Regras em js/prod.js (window.Prod). */
window.ProdUI = function (C) {
  'use strict';
  const { S, t, esc, DB, L } = C;
  const P = window.Prod;
  const $ = s => document.querySelector(s);
  const now = () => Date.now();
  const isNum = x => typeof x === 'number' && isFinite(x);
  const fmtKg = n => isNum(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '—';
  const keepScroll = () => { const y = window.scrollY; C.render(); window.scrollTo(0, y); };
  const STATUS_CLS = { running: 'd-warn', done: 'd-accept', cancelled: 'd-record' };
  const JOB_ST = { running: 1, done: 1, cancelled: 1 };
  const ACT = new Set(P.ACT_TYPES);
  // Código de paragem: "A07 MILLS · Breakdown" (texto do ficheiro FMO, sem tradução)
  const codes = () => S.cfgP.downtimeCodes;
  const cName = d => (S.lang === 'pt' && d.namePt) ? d.namePt : d.name;
  const codeLabel = (c, info) => { const d = info || P.findCode(c, codes()); return d ? d.code + ' ' + cName(d) : (c || ''); };
  const tierLabel = v => v || t('noTier3');
  const oeeLabel = o => o && P.OEE_KEY[o] ? t('oee_' + P.OEE_KEY[o]) : t('oeeNotSet');
  const GROUPS = [['P', 'cg_P'], ['A', 'cg_A'], ['O', 'cg_O']];

  // ---------- dados ----------
  async function load() {
    dropboxReturn();
    S.cfgP = (await DB.getConfig('cfgP')) || P.defaultProdConfig();
    S.leaderPins = S.rolePins || (await DB.getConfig('rolePins')) || {};   // v2.16.0: PIN dos chefes A–D em Definições → PIN
    // configuração anterior à v1.3: acrescenta os dados mestre em falta (não altera listas já existentes)
    const d = P.defaultProdConfig();
    ['grainSilos', 'dirtyBins', 'temperedBins', 'masterSource', 'leaders', 'dampenerMaxLhByLine'].forEach(k => { if (S.cfgP[k] === undefined) S.cfgP[k] = d[k]; });
    S.deviceId = await DB.getConfig('deviceId');
    if (!S.deviceId) {
      S.deviceId = 'd' + Array.from(crypto.getRandomValues(new Uint8Array(4))).map(x => x.toString(16).padStart(2, '0')).join('');
      await DB.setConfig('deviceId', S.deviceId);
    }
    // códigos: lista do ficheiro v2 (v1.5.0); nomes PT e activação já definidos mantêm-se; códigos que deixaram de existir ficam em codesDropped
    let migrated = false;
    if (!Array.isArray(S.cfgP.downtimeCodes) || S.cfgP.codesSource !== P.DOWNTIME_SOURCE) {
      const m = P.mergeCodes(S.cfgP.downtimeCodes);
      S.cfgP.downtimeCodes = m.list; S.cfgP.codesSource = P.DOWNTIME_SOURCE; S.cfgP.codesDropped = m.dropped; migrated = true;
    }
    // unidades: toneladas → kg (uma vez; idempotente)
    const u = P.migrateUnits(S.cfgP);
    if (u.changed) { S.cfgP = u.cfg; migrated = true; }
    // silos de produto B09 e B10 (v1.8.0)
    const fb = P.addFinishedBins(S.cfgP); if (fb.changed) { S.cfgP = fb.cfg; migrated = true; }
    if (migrated) { try { await DB.setConfig('cfgP', S.cfgP); } catch (e) { /* tenta de novo na próxima abertura */ } }
    S.ctx = Object.assign({ operatorId: '', testMode: false }, (await DB.getConfig('ctx')) || {});
    applyCtx();
    loadAutoSiloCache();
    await reload();
    scheduleDaySync();   // envia pendentes de sessões anteriores
    refreshSilos().then(ok => { if (ok) C.render(); });
    setInterval(() => refreshSilos().then(ok => { if (ok && S.view === 'prod') C.render(); }), 15 * 60000);
  }
  // Operador e modo de teste (deste dispositivo) vão para todos os registos novos (contrato v1)
  function applyCtx() {
    DB.setContext({ deviceId: S.deviceId, operatorId: (S.ctx && S.ctx.operatorId) || null, test: !!(S.ctx && S.ctx.testMode) });
  }
  async function reload() {
    S.jobs = await DB.all('jobs');
    // leituras de versões ≤1.4.0 (chave 'uuid') migram para 'uid' uma vez; o trabalho é regravado só se mudar
    for (let i = 0; i < S.jobs.length; i++) {
      const n = L.normalizeReadings(S.jobs[i], newUid);
      if (n !== S.jobs[i]) { await DB.put('jobs', n); S.jobs[i] = n; }
    }
    S.binEvents = await DB.all('binEvents');
    S.shiftLog = await DB.all('shiftLog');
    S.siloSnaps = await DB.all('siloSnapshots');
    S.prodChanges = await DB.all('prodChanges');
    S.dbMoves = await DB.all('grainMoves');
    combineMoves();
    S.readings = await DB.all('shiftReadings');
    S.stocks = await DB.all('binStock');   // totais das bins de manhã (v2.4.0)
    try { S.maintRecs = await DB.all('maint'); } catch (e) { S.maintRecs = []; }   // v2.9.0: para Registos e Relatório
    refreshBinsStatus();
  }
  // Estado das bins para a Mill-App (bins-status). Guarda a última cópia no dispositivo (localStorage);
  // a escrita para o Dropbox fica para a versão seguinte. Falha de gravação não interrompe o trabalho.
  const BINS_STATUS_KEY = 'mill-qc.binsStatus.v1';
  function refreshBinsStatus() {
    if (!S.cfgP) return;
    try {
      const out = P.buildBinsStatus(S.cfgP, S.moves, S.jobs, { now: Date.now(), writerVersion: P.VERSION, site: S.cfgP.site || '', stocks: S.stocks, feedFrom: P.autoFeedFromMs() });
      S.binsStatus = out;
      localStorage.setItem(BINS_STATUS_KEY, JSON.stringify(out));
      sendBinsStatus(out);
    } catch (e) { console.warn('bins-status', e); }
  }
  // ---- Dropbox: início de sessão (PKCE), renovação e envio do bins-status ----
  // Sessão guardada neste dispositivo em localStorage 'mill-qc.dropbox' = {accessToken, expiresAt, refreshToken}.
  // O refresh token fica no navegador: aceitável para os testes no portátil; a decidir antes de usar nos telemóveis.
  const DB_SESS_KEY = 'mill-qc.dropbox', DB_STATE_KEY = 'mill-qc.dbstate.v1';
  const dbAuth = () => window.DropboxAuth, dbCfg = () => window.DropboxConfig;
  const dbSess = () => { try { return JSON.parse(localStorage.getItem(DB_SESS_KEY) || 'null'); } catch (e) { return null; } };
  function dbSave(s) { try { localStorage.setItem(DB_SESS_KEY, JSON.stringify(s)); } catch (e) { console.warn('dropbox save', e); } }
  const dbRedirect = () => location.origin + location.pathname.replace(/index\.html$/i, '');   // v2.3.3: igual seja aberta em ./ ou ./index.html
  async function dropboxSignIn() {
    const A = dbAuth(), c = dbCfg();
    if (!A || !c) return C.toast(t('dx_nomodule'));
    const getRandom = b => crypto.getRandomValues(b);
    const verifier = A.randomToken(getRandom), state = A.randomToken(getRandom);
    sessionStorage.setItem(DB_STATE_KEY, JSON.stringify({ verifier, state }));
    const challenge = await A.challengeOf(verifier, d => crypto.subtle.digest('SHA-256', d));
    location.href = A.buildAuthorizeUrl({ appKey: c.appKey, redirectUri: dbRedirect(), challenge, state });
  }
  // Ao voltar do Dropbox (?code=...): troca o código por tokens e limpa o endereço.
  async function dropboxReturn() {
    const A = dbAuth(), c = dbCfg();
    const p = new URLSearchParams(location.search);
    if (!A || !c || !p.get('code') && !p.get('error')) return;
    if (await siloReturn(p)) return;   // v2.8.0: retorno da ligação de leitura dos silos
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(DB_STATE_KEY) || 'null'); } catch (e) { st = null; }
    sessionStorage.removeItem(DB_STATE_KEY);
    history.replaceState(null, '', location.pathname);
    if (p.get('error')) return C.toast(t('dx_cancelled', { e: p.get('error') }));
    if (!st || st.state !== p.get('state')) return C.toast(t('dx_mismatch'));
    try {
      const req = A.buildTokenRequest({ appKey: c.appKey, code: p.get('code'), verifier: st.verifier, redirectUri: dbRedirect() });
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      const json = await r.json().catch(() => null);
      if (!r.ok) return C.toast(t('dx_refused', { s: r.status }));
      dbSave(A.parseTokenResponse(json, Date.now()));
      C.toast(t('dx_connected'));
    } catch (e) { C.toast(t('dx_network')); console.warn('dropbox token', e); }
  }
  // ---- v2.8.0: leitura do stock dos silos da Grain-Mgt (Mill-App-Read, só leitura) ----
  const SR_SESS_KEY = 'mill-qc.siloRead', SR_STATE_KEY = 'mill-qc.siloReadState.v1', AUTO_SILO_KEY = 'mill-qc.autoSilo.v1';
  const srSess = () => { try { return JSON.parse(localStorage.getItem(SR_SESS_KEY) || 'null'); } catch (e) { return null; } };
  async function siloSignIn() {
    const A = dbAuth(), c = dbCfg();
    if (!A || !c || !c.siloReadAppKey) return C.toast(t('dx_nomodule'));
    const getRandom = b => crypto.getRandomValues(b);
    const verifier = A.randomToken(getRandom), state = A.randomToken(getRandom);
    sessionStorage.setItem(SR_STATE_KEY, JSON.stringify({ verifier, state }));
    const challenge = await A.challengeOf(verifier, d => crypto.subtle.digest('SHA-256', d));
    location.href = A.buildAuthorizeUrl({ appKey: c.siloReadAppKey, redirectUri: dbRedirect(), challenge, state });
  }
  async function siloReturn(p) {
    const A = dbAuth(), c = dbCfg();
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(SR_STATE_KEY) || 'null'); } catch (e) { st = null; }
    if (!st || st.state !== p.get('state')) return false;
    sessionStorage.removeItem(SR_STATE_KEY);
    history.replaceState(null, '', location.pathname);
    if (p.get('error')) { C.toast(t('srdCancelled')); return true; }
    try {
      const req = A.buildTokenRequest({ appKey: c.siloReadAppKey, code: p.get('code'), verifier: st.verifier, redirectUri: dbRedirect() });
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      const json = await r.json().catch(() => null);
      if (!r.ok) { C.toast(t('srdRefused', { s: r.status })); return true; }
      localStorage.setItem(SR_SESS_KEY, JSON.stringify(A.parseTokenResponse(json, Date.now())));
      C.toast(t('srdConnected')); refreshSilos().then(ok => { if (ok) C.render(); });
    } catch (e) { C.toast(t('srdNetwork')); }
    return true;
  }
  async function siloToken() {
    const A = dbAuth(), c = dbCfg(), sess = srSess();
    if (!A || !c || !sess || !sess.refreshToken) return null;
    if (A.isUsable(sess, Date.now())) return sess.accessToken;
    const req = A.buildRefreshRequest({ appKey: c.siloReadAppKey, refreshToken: sess.refreshToken });
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!r.ok) throw new Error('renovação recusada (' + r.status + ')');
    const next = Object.assign({}, sess, A.parseTokenResponse(await r.json(), Date.now()));
    if (!next.refreshToken) next.refreshToken = sess.refreshToken;
    localStorage.setItem(SR_SESS_KEY, JSON.stringify(next));
    return next.accessToken;
  }
  function useSilosStatus(o, fetchedAt) {
    S.autoSilo = { snap: P.parseSilosStatus(o, fetchedAt), moves: P.grainMgtMoves(o, S.cfgP, P.autoFeedFromMs()), fetchedAt, exportedAt: o.exportedAt };
    combineMoves();
  }
  async function refreshSilos() {
    S.autoSiloErr = null;
    try {
      const tok = await siloToken();
      if (!tok) return false;
      const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Dropbox-API-Arg': JSON.stringify({ path: dbCfg().silosStatusPath }) } });
      if (!r.ok) { S.autoSiloErr = 'HTTP ' + r.status; return false; }
      const o = await r.json();
      useSilosStatus(o, Date.now());
      try { localStorage.setItem(AUTO_SILO_KEY, JSON.stringify({ o, fetchedAt: S.autoSilo.fetchedAt })); } catch (e) { /* sem espaço: fica só em memória */ }
      refreshBinsStatus();
      return true;
    } catch (e) { S.autoSiloErr = String(e && e.message || e); return false; }
  }
  function loadAutoSiloCache() {
    try { const c = JSON.parse(localStorage.getItem(AUTO_SILO_KEY) || 'null'); if (c && c.o) useSilosStatus(c.o, c.fetchedAt); } catch (e) { S.autoSilo = null; }
  }
  // Aviso na página inicial: depois da passagem, sem ligação de leitura ou leitura com mais de 2 h
  function siloFeedIssue() {
    if (!feedAuto() || !dbCfg() || !dbCfg().siloReadAppKey) return null;
    if (!srSess()) return t('srdOff');
    const a = S.autoSilo && S.autoSilo.fetchedAt ? S.autoSilo.fetchedAt : null;   // a cópia reflecte o estado actual quando é lida
    if (!a || now() - a > 2 * 3600000) return t('srdOld', { h: a ? C.fmtDT(a) : '—' });
    return null;
  }
  function dropboxSignOut() { try { localStorage.removeItem(DB_SESS_KEY); } catch (e) { /* ignorar */ } C.toast(t('dx_signedout')); }
  // Devolve um access token válido, renovando se preciso. null se não houver sessão.
  async function dropboxToken() {
    const A = dbAuth(), c = dbCfg(), sess = dbSess();
    if (!A || !c || !sess || !sess.refreshToken) return null;
    if (A.isUsable(sess, Date.now())) return sess.accessToken;
    const req = A.buildRefreshRequest({ appKey: c.appKey, refreshToken: sess.refreshToken });
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!r.ok) throw new Error('renovação recusada (' + r.status + ')');
    const next = Object.assign({}, sess, A.parseTokenResponse(await r.json(), Date.now()));
    if (!next.refreshToken) next.refreshToken = sess.refreshToken;
    dbSave(next);
    return next.accessToken;
  }
  // Envio do bins-status (após cada gravação). Sem sessão, não envia; falhas só ficam no console.
  async function sendBinsStatus(out) {
    if (!window.DropboxUpload || !dbCfg() || !dbSess()) return;
    try {
      const tok = await dropboxToken();
      if (!tok) return;
      const req = window.DropboxUpload.buildUploadRequest({ accessToken: tok, path: dbCfg().binsStatusPath, content: JSON.stringify(out) });
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      if (!r.ok) console.warn('bins-status upload', r.status);
    } catch (e) { console.warn('bins-status upload', e); }
  }
  // ---- Dropbox: ficheiros diários de registos (v2.1.0) ----
  // Após cada gravação (com espera), envia os dias cujo conteúdo mudou desde o último envio confirmado.
  // Um envio falhado fica pendente e é repetido na gravação seguinte, ao abrir a app ou com "Enviar agora".
  const DAY_SENT_KEY = 'mill-qc.daySent.v1', DAY_STATUS_KEY = 'mill-qc.daySync.v1', DAY_GEN_KEY = 'mill-qc.daySentGen.v1';
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } };
  const dayStatus = () => lsGet(DAY_STATUS_KEY, {});
  let dayTimer = null, daySyncing = false, dayAgain = false;
  function scheduleDaySync() {
    if (!window.DayRecords || !dbCfg() || !dbSess()) return;
    clearTimeout(dayTimer);
    dayTimer = setTimeout(syncDays, dbCfg().recordsDebounceMs || 5000);
  }
  async function syncDays(manual) {
    const R = window.DayRecords, c = dbCfg();
    if (!R || !c || !window.DropboxUpload) return;
    if (!dbSess()) { if (manual) C.toast(t('dx_notconnected')); return; }
    if (daySyncing) { dayAgain = true; return; }
    daySyncing = true;
    const st = dayStatus(), sent = lsGet(DAY_SENT_KEY, {}), sentGen = lsGet(DAY_GEN_KEY, {});
    let ok = 0, failed = 0, lastErr = null, undated = 0;
    try {
      const data = await DB.exportAll();
      const tok = await dropboxToken();
      if (!tok) throw new Error('sem sessão');
      const nowMs = Date.now();
      // v2.3.2: o dia que acabou de terminar é sempre enviado (vazio se não tiver registos), e qualquer dia terminado
      // cujo último envio foi gerado antes do fim é reenviado uma vez — assim a ingestão marca-o como completo.
      const yesterday = L.prodDay(nowMs - 24 * 3600000);
      const fin = { now: nowMs, dayEnd: d => L.prodDayRange(d)[1], sentGen };
      for (const test of [false, true]) {
        const dir = test ? c.recordsTestDir : c.recordsDir;
        const built = R.buildDayFiles(data, { prodDayOf: L.prodDay, test, now: nowMs, writerVersion: P.VERSION, deviceId: S.deviceId, site: (S.cfgP && S.cfgP.site) || '', codesSource: (S.cfgP && S.cfgP.codesSource) || null, ensureDays: test ? [] : [yesterday] });
        if (!test) undated = Object.keys(built.undated).reduce((s, k) => s + built.undated[k], 0);
        for (const day of R.pendingDays(built, dir, sent, fin)) {
          const path = R.dayPath(dir, day), f = built.files[day];
          try {
            const req = window.DropboxUpload.buildUploadRequest({ accessToken: tok, path, content: JSON.stringify(f.file) });
            const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            sent[path] = f.hash; sentGen[path] = Date.parse(f.file.generatedAt); ok++;
          } catch (e) { failed++; lastErr = day + ': ' + (e && e.message || e); console.warn('day upload', day, e); }
        }
      }
    } catch (e) { failed++; lastErr = String(e && e.message || e); console.warn('day sync', e); }
    lsSet(DAY_SENT_KEY, sent); lsSet(DAY_GEN_KEY, sentGen);
    const t0 = new Date().toISOString();
    lsSet(DAY_STATUS_KEY, { lastTryAt: t0, lastOkAt: failed ? (st.lastOkAt || null) : t0, sentNow: ok, failed, lastError: failed ? lastErr : null, undated });
    daySyncing = false;
    if (manual) C.toast(failed ? t('dx_failed', { n: failed }) : t('dx_sent', { n: ok }));
    if (manual) keepScroll();   // envio automático não redesenha (não tira o foco a um campo em edição)
    if (dayAgain) { dayAgain = false; scheduleDaySync(); }
  }
  DB.onWrite(() => scheduleDaySync());
  // v2.3.2: fecho do dia sem depender de uma gravação — ao voltar à app e a cada 15 min com a app aberta
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleDaySync(); });
  setInterval(scheduleDaySync, 15 * 60000);
  // Linha de estado do envio diário (Definições). Falhas ficam visíveis ao operador, não só no console.
  function daySyncLine() {
    const s = dayStatus();
    if (!s.lastTryAt) return `<p class="sub">${esc(t('dx_day_none'))}</p>`;
    const okTxt = s.lastOkAt ? t('dx_day_last', { d: C.fmtDT(Date.parse(s.lastOkAt)) }) : t('dx_day_never');
    const err = s.failed ? `<br><b class="d-reject">${esc(t('dx_day_fail', { e: s.lastError || '' }))}</b>` : '';
    const und = s.undated ? `<br>${esc(t('dx_day_undated', { n: s.undated }))}` : '';
    return `<p class="sub">${esc(okTxt)}${err}${und}</p>`;
  }
  let seq = 0;
  // UUID v4 por registo (o dispositivo vai em deviceId); recurso antigo se randomUUID não existir
  const newUid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : P.uid(S.deviceId, now(), (++seq).toString(36) + Math.random().toString(36).slice(2, 6));
  const base = tms => ({ uid: newUid(), deviceId: S.deviceId, createdAt: now(), crew: L.crewOfTime(tms), period: L.shiftOf(tms).period, prodDay: L.prodDay(tms), shift: L.prodDay(tms) + '/' + L.shiftOf(tms).period });
  // v2.8.0: o stock mais recente entre as cópias importadas e a leitura automática da Grain-Mgt
  const snapAt = s => s ? (s.exportedAt ? Date.parse(s.exportedAt) : s.importedAt) : 0;
  const snapshot = () => (S.siloSnaps || []).concat(S.autoSilo && S.autoSilo.snap ? [S.autoSilo.snap] : []).sort((a, b) => snapAt(b) - snapAt(a))[0] || null;
  function combineMoves() {
    const gm = S.autoSilo && S.autoSilo.moves ? S.autoSilo.moves : [];
    const known = new Set((S.dbMoves || []).map(m => m.uid));
    S.moves = (S.dbMoves || []).concat(gm.filter(m => !known.has(m.uid)));
  }
  const feedAuto = () => now() >= P.autoFeedFromMs();   // a partir de 14-11-2026 07:00 as descargas vêm só da Grain-Mgt
  const runningJob = lineId => (S.jobs || []).find(j => j.status === 'running' && j.lineId === lineId);
  const lineIds = () => S.cfg.lines.map(l => l.id);
  const binById = id => S.cfgP.bins.find(b => b.id === id);
  const prodOrDash = id => id ? C.prodName(id) : '—';
  // Chefe de turno: lista (Definições) quando definida; senão texto livre. Por defeito: chefe da turma seleccionada.
  const defLeader = () => P.crewLeader(S.cfgP, L.crewOfTime(now())) || S.operator;
  function leaderField(attr, value) {
    const list = P.leaderNames(S.cfgP);
    if (!list.length) return `<input ${attr} value="${esc(value)}">`;
    const known = list.some(x => x.name === value);
    return `<select ${attr}><option value="">—</option>${list.map(x => `<option value="${esc(x.name)}" ${x.name === value ? 'selected' : ''}>${esc(x.name)} (${esc(t('crew'))} ${esc(x.crew)})</option>`).join('')}${value && !known ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ''}</select>`;
  }
  // v2.10.0 (Zhax, 14-11-2026): PIN de cada chefe de turno, definido pelo supervisor em Definições → Produção.
  // Fica só neste telemóvel (config 'leaderPins' = {A: {salt, hash, setAt}}), nunca nos ficheiros do dia.
  const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  const pinHash = async (salt, pin) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + pin)));   // v2.16.0: como os PIN de Definições → PIN
  async function makeLeaderPin(pin) { const salt = hex(crypto.getRandomValues(new Uint8Array(16))); return { salt, hash: await pinHash(salt, pin), setAt: new Date().toISOString() }; }
  // 'ok' | 'bad' | 'none' (chefe sem PIN definido: grava com aviso)
  async function leaderPinCheck(crew, pin) {
    const p = crew && (S.leaderPins || {})[crew];
    if (!p) return 'none';
    return (await pinHash(p.salt, String(pin || ''))) === p.hash ? 'ok' : 'bad';
  }
  // v2.17.0 (Zhax, 17-11-2026): sem nomes — só o PIN; o registo leva o título da função
  const whoP = async (id, roles) => { const w = await C.who((($('#' + id)) || {}).value, roles); if (w.err) { C.toast(w.err); return null; } return w; };
  const crewOfRole = (role, day, per) => ['A', 'B', 'C', 'D'].indexOf(role) >= 0 ? role : L.crewOfTime(shiftRange(day, per)[0] + 60000);
  const leaderCrewOf = name => { const x = P.leaderNames(S.cfgP).find(l => l.name === name); return x ? x.crew : null; };

  // ---------- vista principal ----------
  function view() {
    // v2.18.0 (Zhax, 26-11-2026): Turno (com ordens), Paragens, Grão (com Milho D/M e C/M), Produtos
    const PTAB_MAP = { log: 'shift', jobs: 'shift', maize: 'grain' };
    if (PTAB_MAP[S.prodTab]) S.prodTab = PTAB_MAP[S.prodTab];
    const tab = S.prodTab || 'shift';
    const tabs = ['shift', 'stops', 'grain', 'bins'].map(k => `<button class="btn ${tab === k ? 'primary' : 'ghost'} small" data-ptab="${k}">${esc(t('ptab_' + k))}</button>`).join(' ');
    const body = tab === 'stops' ? viewStops() : tab === 'bins' ? viewBins() : tab === 'grain' ? viewGrainAll() : viewShift();
    const banner = S.ctx && S.ctx.testMode ? `<section class="card"><b>${esc(t('ctxTestBanner'))}</b></section>` : '';
    return `${banner}<section class="card"><h2>${esc(t('nav_prod'))}</h2><div class="row">${tabs}</div></section>${body}`;
  }


  // ---------- login / logout de turno (v2.7.0, Zhax 12-11-2026) ----------
  // Registos em shiftLog: kind 'login' {leader, state, planJobs, scalesStart, comments} e kind 'logout'
  // {state, activitiesDone, scalesEnd, shiftKg, dayB1Kg, targetKg, achievedPct, comments}, ligados ao turno escolhido
  // (prodDay + period), não à hora da gravação. Os registos novos não mudam o pipeline (só lê kind 'issue').
  // v2.13.0 (Zhax, 14-11-2026): um turno com login e sem logout não desaparece — o separador Turno abre nele e há um alerta até ao logout
  function openShift() {
    const cur = L.shiftOf(now()), from = now() - 3 * 24 * 3600000;
    const ins = P.effectiveLog(S.shiftLog).filter(x => x.kind === 'login' && x.t >= from && !(x.prodDay === cur.day && x.period === cur.period)).sort((a, b) => b.t - a.t);
    return ins.find(x => !shiftRec('logout', x.prodDay, x.period)) || null;
  }
  function shiftSel() { if (!S.shiftSel) { const o = openShift(), sh = L.shiftOf(now()); S.shiftSel = o ? { day: o.prodDay, period: o.period } : { day: sh.day, period: sh.period }; } return S.shiftSel; }
  function logoutIssue() { const o = openShift(); return o ? t('logoutMissing', { s: t('shift_' + o.period), d: C.fmtDT(o.t).slice(0, 10), l: o.leader || '' }) + ' ' + t('logoutNeeds', { n: loginItems(o).length }) : null; }
  const shiftRec = (kind, day, period) => P.effectiveLog(S.shiftLog).filter(x => x.kind === kind && x.prodDay === day && x.period === period).sort((a, b) => b.t - a.t)[0] || null;
  const planRows = day => P.dayPlan(C.plan(), day, 'C');
  const planTarget = day => { const r = planRows(day).filter(x => isNum(x.targetKg)); return r.length ? r.reduce((s, x) => s + x.targetKg, 0) : null; };
  function scaleInputs(prefix, vals) {
    return `<div class="tablewrap"><table class="tbl"><tr><th>${esc(t('scale'))}</th><th>kg</th></tr>${P.SCALES.map(k =>
      `<tr><td>${esc(t('scale_' + k))} <small>(${esc(P.SCALE_SCADA[k])})</small></td><td><input inputmode="numeric" data-scale="1" id="${prefix}_${k}" value="${esc(vals && isNum(vals[k]) ? P.fmtScale(vals[k]) : '')}" placeholder="1,234,567"></td></tr>`).join('')}</table></div>`;
  }
  const scaleVals = prefix => { const o = {}; P.SCALES.forEach(k => { const el = $('#' + prefix + '_' + k); o[k] = el ? el.value : ''; }); return o; };
  function planHtml(day, picks) {
    const rows = planRows(day);
    if (!rows.length) return `<p class="sub">${esc(t('planNone', { d: day }))}</p>`;
    return rows.map((r, i) => `<label class="chk"><input type="checkbox" class="lg_plan" data-i="${i}" ${!picks || picks.indexOf(i) >= 0 ? 'checked' : ''}>
      ${esc(r.product || t('planNoProduct'))} · ${esc(t('targetT'))} ${isNum(r.targetKg) ? fmtKg(r.targetKg) + ' kg' : '—'}</label>`).join('');
  }
  // v2.9.0: trabalhos do turno escolhidos numa lista (Limpeza piso 0–6, reprocessamento, preparar fumigação, arrumação do armazém,
  // manutenção do plansifter, recolha de varreduras, outro). Gravados como código, mostrados na língua de quem lê.
  const jobText = j => j.code === 'other' ? t('sj_other') + (j.note ? ': ' + j.note : '') : t('sj_' + j.code);
  const jobChips = () => (S.lgJobs || []).map((j, i) => `<span class="chip d-record">${esc(jobText(j))} <button class="btn ghost small" data-pact="lgjobrm" data-i="${i}">✕</button></span>`).join(' ');
  function addLgJob() {
    const code = ($('#lg_jobsel') || {}).value, note = (($('#lg_jobtxt') || {}).value || '').trim();
    if (!code) return C.toast(t('sjPick'));
    if (code === 'other' && !note) return C.toast(t('sjOtherNeed'));
    S.lgJobs = (S.lgJobs || []).concat([{ code, note: code === 'other' ? note : '' }]);
    $('#lg_jobs').innerHTML = jobChips(); $('#lg_jobsel').value = ''; $('#lg_jobtxt').value = '';
  }
  // v2.9.0: mergulhos diários das bins de milho sujo B01–B04 (secção própria no separador Turno); gravados como leitura da manhã
  function dipCard() {
    const day = L.prodDay(now());
    const todays = (S.stocks || []).filter(s => s.prodDay === day && P.DIP.bins.some(b => s.levels && s.levels[b] && s.levels[b].method === 'dip')).sort((a, b) => b.t - a.t)[0];
    return `<section class="card"><h3>${esc(t('dipTitle'))}</h3>
      ${todays ? `<p class="sub">${esc(t('dipDone', { h: C.fmtDT(todays.t), by: todays.by }))}: ${P.DIP.bins.map(b => todays.levels[b] ? esc(b) + ' ' + fmtKg(todays.levels[b].kg) + ' kg' : '').filter(Boolean).join(' · ')}</p>` : `<div class="banner b-warn">${esc(t('dipMissing'))}</div>`}
      <div class="tablewrap"><table class="tbl"><tr><th></th><th>${esc(t('dipD'))}</th><th>kg</th></tr>${P.DIP.bins.map(b => `<tr><td><b>${esc(b)}</b></td><td><input inputmode="decimal" id="dip_${b}" data-dip="${b}"></td><td id="dipv_${b}">${esc(t('dipHint'))}</td></tr>`).join('')}</table></div>
      ${shiftLeader() ? `<input type="hidden" id="dip_by" value="${esc(shiftLeader())}">` : `<label class="fld req">${esc(t('name'))}<input id="dip_by" value="${esc(S.operator)}"></label>`}
      <button class="btn primary" data-pact="savedips">${esc(t('dipSave'))}</button></section>`;
  }
  async function saveDips() {
    const levels = {}; P.DIP.bins.forEach(b => { const v = ($('#dip_' + b) || {}).value || ''; if (v.trim()) levels[b] = { dipM: v }; });
    const by = (($('#dip_by') || {}).value || '').trim();
    const r = P.validateBinStock({ levels, by }, S.cfgP, { binEvents: S.binEvents, jobs: S.jobs });
    if (r.errors.length) return C.toast(r.errors.map(e => t('je_' + e.code, { bin: e.bin, max: e.max || '' })).join(' · '));
    const tms = now();
    try { await DB.add('binStock', Object.assign(base(tms), { kind: 'stock', t: tms, levels: r.values, by, scope: 'dips', warnings: r.warnings.map(w => w.code + ':' + w.bin) })); }
    catch (e) { return C.toast(t('saveFailed')); }
    S.operator = by; await DB.setConfig('operator', S.operator);
    await reload(); C.toast(t('dipSaved')); keepScroll();
  }
  // v2.18.0: a manutenção de processo planeia-se no login; o registo do feito aparece depois do login; as ordens ficam no Turno
  function viewShift() {
    const sel = shiftSel(), li = shiftRec('login', sel.day, sel.period);
    return viewShiftTop() + (li ? procCard() : '') + `<section class="card"><h3>${esc(t('ordersTitle'))}</h3></section>` + viewJobs();
  }
  // Turno anterior (para as notas de passagem de turno)
  const prevShiftOf = (day, per) => per === 'N' ? { day, period: 'D' } : { day: P.dayBefore(day), period: 'N' };
  function handoverCard(day, per) {
    const pv = prevShiftOf(day, per), lo = shiftRec('logout', pv.day, pv.period);
    if (!lo || !(lo.handover || lo.comments)) return '';
    return `<section class="card"><h3>${esc(t('handoverFrom', { s: t('shift_' + pv.period), d: pv.day }))}</h3>
      ${lo.handover ? `<p>${esc(lo.handover)}</p>` : ''}${lo.comments ? `<p>${esc(lo.comments)}</p>` : ''}</section>`;
  }
  // v2.22.0 (Zhax, 26-11-2026): plansifter com secções; filtros, condutas, separadores, despedregadores e turbo-peneiro com lista (dropdown) do equipamento
  function procPlanHtml() {
    const cfg = P.procMaintCfg(S.cfgP);
    return P.PROC_GROUPS.map(g => `<label class="chk"><input type="checkbox" class="lg_proc" data-g="${g}"> ${esc(t('pg_' + g))}</label>` +
      // v2.27.0 (Zhax, 27-11-2026): o plansifter também com lista (dropdown) como os outros; todos permitem escolher várias máquinas
      `<div id="${g === 'plansifter' ? 'lg_psecs' : 'lg_pu_' + g}" hidden><select multiple class="lg_punit" data-g="${g}" size="${Math.min(7, ((cfg[g] && cfg[g].sections) || []).length || 1)}">${((cfg[g] && cfg[g].sections) || []).map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select><p class="sub">${esc(t('procMulti'))}</p></div>`).join('');
  }
  function readProcPlan() {
    const groups = [...document.querySelectorAll('.lg_proc')].filter(x => x.checked).map(x => x.dataset.g);
    const units = g => { const el = document.querySelector('.lg_punit[data-g="' + g + '"]'); return el ? [...el.selectedOptions].map(o => o.value) : []; };
    if (groups.indexOf('plansifter') >= 0 && !units('plansifter').length) return { err: true };
    if (groups.some(g => g !== 'plansifter' && !units(g).length)) return { err: 'units' };
    return { plan: groups.map(g => ({ group: g, sections: units(g) })) };
  }
  function viewShiftTop() {
    const sel = shiftSel(), day = sel.day, per = sel.period;
    const li = shiftRec('login', day, per), lo = shiftRec('logout', day, per);
    const plan = C.plan();
    const head0 = `<section class="card"><h3>${esc(t('shiftTitle'))}</h3>
      <div class="grid2"><label class="fld">${esc(t('prodDay'))}<input type="date" id="shDay" value="${esc(day)}"></label>
      <label class="fld">${esc(t('shift'))}<select id="shPeriod"><option value="D" ${per === 'D' ? 'selected' : ''}>${esc(t('shift_D'))} 07–19</option><option value="N" ${per === 'N' ? 'selected' : ''}>${esc(t('shift_N'))} 19–07</option></select></label></div>
      ${plan ? '' : `<p class="sub">${esc(t('planMissing'))}</p>`}</section>`;
    const op = openShift(), opSel = op && op.prodDay === day && op.period === per;
    const head = (op ? `<div class="banner b-reject">⚠ ${esc(t('logoutMissing', { s: t('shift_' + op.period), d: C.fmtDT(op.t).slice(0, 10), l: op.leader || '' }))}${opSel ? '' : ` <button class="btn small" data-shsel="${esc(op.prodDay)}|${esc(op.period)}">${esc(t('logoutGo'))}</button>`}</div>` : '') + head0;
    if (!li) return head + handoverCard(day, per) + `<section class="card"><h3>${esc(t('loginTitle'))}</h3>
      ${C.pinFld('lg_pin', t('leaderPin'))}
      <div class="sub req">${esc(t('jobsToDo'))}</div>${planHtml(day)}
      <div class="grid2"><label class="fld">${esc(t('sjPick'))}<select id="lg_jobsel"><option value="">—</option>${P.SHIFT_JOBS.filter(k => k !== 'plansifter').map(k => `<option value="${k}">${esc(t('sj_' + k))}</option>`).join('')}</select></label>
        <label class="fld">${esc(t('sjOtherText'))}<input id="lg_jobtxt"></label></div>
      <button class="btn small" data-pact="lgjobadd">＋ ${esc(t('sjAdd'))}</button><div id="lg_jobs">${jobChips()}</div>
      <h4>${esc(t('procTitle'))}</h4>${procPlanHtml()}
      <h4>${esc(t('runTitle'))}</h4>${runFields('lg')}
      <h4>${esc(t('scalesStart'))}</h4>${scaleInputs('lgs')}
      <label class="fld">${esc(t('comments'))}<textarea rows="2" id="lg_comments"></textarea></label>
      <button class="btn primary big" data-pact="shiftlogin">${esc(t('loginBtn'))}</button></section>`;
    const loginCard = `<section class="card"><h3>${esc(t('loginTitle'))} · ${esc(C.fmtDT(li.t))}</h3>
      <div class="kv"><span>${esc(t('shiftLeader'))}</span><b>${esc(li.leader)} · ${esc(t('crew'))} ${esc(li.crew || '—')}</b></div>
      <div class="kv"><span>${esc(t('stateNow'))}</span><b>${esc(t('state_' + li.state))}</b></div>
      <div class="kv"><span>${esc(t('jobsToDo'))}</span><b>${esc((li.planJobs || []).map(j => (j.product || t('planNoProduct')) + (isNum(j.targetKg) ? ' · ' + fmtKg(j.targetKg) + ' kg' : '')).concat((li.shiftJobs || []).map(jobText)).concat(li.jobsExtra ? [li.jobsExtra] : []).join(' | ') || '—')}</b></div>
      ${(li.procPlan || []).length ? `<div class="kv"><span>${esc(t('procTitle'))}</span><b>${esc(li.procPlan.map(x => itemLabel({ src: 'proc', group: x.group, sections: x.sections })).join(' | '))}</b></div>` : ''}
      ${li.comments ? `<p><small>${esc(li.comments)}</small></p>` : ''}</section>`;
    const range = shiftRange(day, per);
    const sm = P.shiftSummary(day, per, range, { log: S.shiftLog, jobs: S.jobs, now: now(), codes: codes() });
    if (!lo) return head + loginCard + runCard(day, per) + scalesCard(li, null, day, per) + `<section class="card"><h3>${esc(t('logoutTitle'))}</h3>
      <div class="kpis"><div><b>${sm.jobs.length}</b><span>${esc(t('ptab_jobs'))}</span></div><div><b>${sm.issues.length}</b><span>${esc(t('ptab_stops'))}</span></div>
        <div><b>${sm.downtimeMin}</b><span>${esc(t('downtimeMin'))}</span></div></div>
      <label class="fld req">${esc(t('stateNow'))}<select id="lo_state"><option value="on">${esc(t('state_on'))}</option><option value="off">${esc(t('state_off'))}</option></select></label>
      ${loginItems(li).length ? `<div class="sub req">${esc(t('activitiesDone'))}</div><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('jobsToDo'))}</th><th>${esc(t('pctDone'))}</th></tr>${loginItems(li).map((x, i) =>
        `<tr><td>${esc(x.label)}</td><td><input inputmode="decimal" class="lo_pct" data-i="${i}" placeholder="0–100" style="max-width:90px"> %</td></tr>`).join('')}</table></div>` : ''}
      <h4>${esc(t('scalesEnd'))}</h4>${scaleInputs('los')}
      <label class="fld">${esc(t('comments'))}<textarea rows="2" id="lo_comments"></textarea></label>
      <label class="fld">${esc(t('handoverNotes'))}<textarea rows="2" id="lo_handover"></textarea></label>
      ${P.runState(S.shiftLog, day, per, now() + 24 * 3600000).areas.reproc.on ? `<label class="fld req">${esc(t('reprocBags'))}<input inputmode="numeric" id="lo_bags"></label>` : ''}
      ${C.pinFld('lo_pin', t('leaderPin'))}
      <div id="lo_check">${logoutCheckHtml(li, day, per)}</div>
      <button class="btn primary big" data-pact="shiftlogout">${esc(t('logoutBtn'))}</button></section>`;
    return head + loginCard + scalesCard(li, lo, day, per) + `<section class="card"><h3>${esc(t('logoutTitle'))} · ${esc(C.fmtDT(lo.t))}</h3>
      <div class="kv"><span>${esc(t('stateNow'))}</span><b>${esc(t('state_' + lo.state))}</b></div>
      <div class="kv"><span>${esc(t('targetAchieved'))}</span><b>${isNum(lo.achievedPct) ? esc(String(lo.achievedPct).replace('.', ',')) + ' %' : '—'} <small>(${esc(t('dayB1'))} ${isNum(lo.dayB1Kg) ? fmtKg(lo.dayB1Kg) + ' kg' : '—'} / ${esc(t('targetT'))} ${isNum(lo.targetKg) ? fmtKg(lo.targetKg) + ' kg' : '—'})</small></b></div>
      ${(lo.activitiesPct || []).length ? `<p><b>${esc(t('activitiesDone'))}:</b><br><small>${lo.activitiesPct.map(x => esc(itemLabel(x)) + ': ' + esc(String(x.pct).replace('.', ',')) + ' %').join('<br>')}</small></p>`
        : lo.activitiesDone ? `<p><b>${esc(t('activitiesDone'))}:</b><br><small>${esc(lo.activitiesDone).replace(/\n/g, '<br>')}</small></p>` : ''}${lo.comments ? `<p><small>${esc(lo.comments)}</small></p>` : ''}
      ${lo.handover ? `<div class="kv"><span>${esc(t('handoverNotes'))}</span><b>${esc(lo.handover)}</b></div>` : ''}
      <p class="sub">${esc(t('shiftReadOnly'))}</p>
      <button class="btn" data-pact="shiftxlsx">${esc(t('genExcel'))}</button></section>`;
  }
  async function shiftLogin() {
    const sel = shiftSel(), w = await whoP('lg_pin');
    if (!w) return;
    const leader = w.title;
    const sc = P.readScales(scaleVals('lgs'));
    if (sc.bad.length) return C.toast(t('fixInvalid') + ': ' + sc.bad.map(k => t('scale_' + k)).join(', '));
    const run = readRun('lg', sel);
    if (run.err) return C.toast(t('runTimeNeed', { a: t('ra_' + run.err) }));
    const pp = readProcPlan();
    if (pp.err) return C.toast(t(pp.err === 'units' ? 'procUnitsNeed' : 'procSecsNeed'));
    const rows = planRows(sel.day), picks = [...document.querySelectorAll('.lg_plan')].filter(x => x.checked).map(x => Number(x.dataset.i));
    const tms = now(), start = shiftRange(sel.day, sel.period)[0];
    const rec = Object.assign(base(tms), { kind: 'login', t: tms, prodDay: sel.day, period: sel.period, shift: sel.day + '/' + sel.period, crew: crewOfRole(w.role, sel.day, sel.period),
      leader, leaderRole: w.role, state: run.areas.production.on ? 'on' : 'off', run: run.areas, planJobs: picks.map(i => rows[i]).filter(Boolean), shiftJobs: (S.lgJobs || []).slice(), procPlan: pp.plan,
      planSource: C.plan() ? C.plan().source : null, scalesStart: sc.values, comments: $('#lg_comments').value.trim(), by: leader, leaderPin: 'ok' });
    try { await DB.add('shiftLog', rec); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = rec.by; await DB.setConfig('operator', S.operator); S.lgJobs = [];
    await reload(); C.toast(t('loginSaved')); keepScroll();
  }
  async function shiftLogout() {
    const sel = shiftSel(), li = shiftRec('login', sel.day, sel.period);
    if (!li) return;
    const miss = logoutMissing(li, sel.day, sel.period);
    if (miss.length) { const o = $('#lo_check'); if (o) o.innerHTML = logoutCheckHtml(li, sel.day, sel.period); return C.toast(t('logoutMissingN', { n: miss.length }) + ': ' + miss[0]); }
    const w = await whoP('lo_pin');
    if (!w) return;
    const by = w.title, items = loginItems(li), pcts = items.map((x, i) => P.readPct((document.querySelector('.lo_pct[data-i="' + i + '"]') || {}).value));
    const rpOn = P.runState(S.shiftLog, sel.day, sel.period, now() + 24 * 3600000).areas.reproc;
    const reproc = rpOn.on ? { bags: P.num(($('#lo_bags') || {}).value), from: rpOn.at, to: Math.min(now(), shiftRange(sel.day, sel.period)[1]) } : null;
    const activitiesPct = items.map((x, i) => Object.assign({}, x.rec, { pct: pcts[i] }));
    const sc = P.readScales(scaleVals('los'));
    if (sc.bad.length) return C.toast(t('fixInvalid') + ': ' + sc.bad.map(k => t('scale_' + k)).join(', '));
    const q = P.shiftScaleKg(li.scalesStart, sc.values);
    // B1 do dia até agora: este turno + o outro turno do mesmo dia, se tiver login e logout com B1
    const other = sel.period === 'N' ? 'D' : 'N', oLo = shiftRec('logout', sel.day, other);
    const parts = [q.kg.b1].concat(oLo && oLo.shiftKg && isNum(oLo.shiftKg.b1) ? [oLo.shiftKg.b1] : []);
    const dayB1 = isNum(q.kg.b1) ? Math.round(parts.reduce((s, x) => s + x, 0) * 1000) / 1000 : null, target = planTarget(sel.day);
    const tms = now();
    const rec = Object.assign(base(tms), { kind: 'logout', t: tms, prodDay: sel.day, period: sel.period, shift: sel.day + '/' + sel.period, crew: li.crew,
      state: $('#lo_state').value === 'off' ? 'off' : 'on', activitiesPct, activitiesDone: activitiesPct.map(x => itemLabel(x) + ': ' + x.pct + ' %').join('\n'), scalesEnd: sc.values, shiftKg: q.kg, negative: q.negative,
      dayB1Kg: dayB1, targetKg: target, achievedPct: P.achievedPct(dayB1, target), comments: $('#lo_comments').value.trim(), handover: (($('#lo_handover') || {}).value || '').trim(), by, byRole: w.role, loginUid: li.uid, leaderPin: 'ok', reproc });
    try { await DB.add('shiftLog', rec); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = by; await DB.setConfig('operator', S.operator);
    await reload(); C.toast(t('logoutSaved')); keepScroll();
  }
  // v2.15.0: trabalhos marcados no login (ordens do plano + trabalhos do turno), para o % feito no logout
  function loginItems(li) {
    return (li.planJobs || []).map((j, i) => ({ rec: { src: 'plan', i, product: j.product || '', targetKg: isNum(j.targetKg) ? j.targetKg : null } }))
      .concat((li.shiftJobs || []).map((j, i) => ({ rec: { src: 'job', i, code: j.code, note: j.note || '' } })))
      .concat(li.jobsExtra ? [{ rec: { src: 'text', note: li.jobsExtra } }] : [])
      .concat((li.procPlan || []).map((x, i) => ({ rec: { src: 'proc', i, group: x.group, sections: (x.sections || []).slice() } })))
      .map(x => Object.assign(x, { label: itemLabel(x.rec) }));
  }
  function itemLabel(x) {
    if (x.src === 'plan') return (x.product || t('planNoProduct')) + (isNum(x.targetKg) ? ' · ' + fmtKg(x.targetKg) + ' kg' : '');
    if (x.src === 'job') return jobText({ code: x.code, note: x.note });
    if (x.src === 'proc') return t('pg_' + x.group) + ((x.sections || []).length ? ': ' + x.sections.join(', ') : '');
    return x.note || '';
  }
  // Nome de quem regista: o chefe de turno do login (turno escolhido, senão o turno actual)
  function shiftLeader() {
    const sel = shiftSel(), sh = L.shiftOf(now());
    const li = shiftRec('login', sel.day, sel.period) || shiftRec('login', sh.day, sh.period);
    return li ? li.leader : '';
  }
  const byFld = (lab, f) => shiftLeader() ? '' : `<label class="fld req">${esc(t(lab))}<input data-lf="by" value="${esc(f.by)}"></label>`;

  // ---------- manutenção de processo (v2.15.0, Zhax 16-11-2026) ----------
  const procTaskLabel = k => String(k || '').charAt(0) === '@' ? t('pt_' + k.slice(1)) : String(k || '');
  function procCard() {
    const cfg = P.procMaintCfg(S.cfgP), f = S.procForm || {}, g = f.group && cfg[f.group];
    const lastTbl = grp => {
      const last = P.procLast(S.shiftLog, grp), secs = cfg[grp].sections.length ? cfg[grp].sections : Object.keys(last);
      if (!secs.length) return '';
      return `<h4>${esc(t('pg_' + grp))}</h4><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('procSection'))}</th><th>${esc(t('procLast'))}</th><th>${esc(t('procTask'))}</th><th>${esc(t('comments'))}</th></tr>${secs.map(s => { const x = last[s]; return `<tr><td>${esc(s || '—')}</td><td>${x ? esc(C.fmtDT(x.t)) : '—'}</td><td>${x ? esc(procTaskLabel(x.task)) : ''}</td><td>${x ? esc(x.comment || '') : ''}</td></tr>`; }).join('')}</table></div>`;
    };
    const sel = shiftSel(), mine = P.effectiveLog(S.shiftLog).filter(x => x.kind === 'procMaint' && x.prodDay === sel.day && x.period === sel.period).sort((a, b) => a.t - b.t);
    return `<section class="card"><h3>${esc(t('procTitle'))}</h3>
      <div class="grid2"><label class="fld req">${esc(t('procGroup'))}<select id="pm_group"><option value="">—</option>${P.PROC_GROUPS.map(k => `<option value="${k}" ${f.group === k ? 'selected' : ''}>${esc(t('pg_' + k))}</option>`).join('')}</select></label>
      ${g ? (g.sections.length ? `<label class="fld req">${esc(t('procSection'))}<select id="pm_section"><option value="">—</option>${g.sections.map(s => `<option ${f.section === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`
        : `<label class="fld">${esc(t('procSection'))}<input id="pm_section" value="${esc(f.section || '')}"></label>`) : ''}
      ${g && g.tasks.length > 1 ? `<label class="fld req">${esc(t('procTask'))}<select id="pm_task"><option value="">—</option>${g.tasks.map(k => `<option value="${esc(k)}" ${f.task === k ? 'selected' : ''}>${esc(procTaskLabel(k))}</option>`).join('')}</select></label>` : ''}</div>
      ${g ? `<label class="fld">${esc(t('comments'))}<textarea rows="2" id="pm_comment">${esc(f.comment || '')}</textarea></label>
      ${C.pinFld('pm_pin')}
      <button class="btn primary" data-pact="saveproc">${esc(t('save'))}</button>` : ''}
      ${mine.length ? `<h4>${esc(t('procThisShift'))}</h4>${mine.map(x => `<div class="rowitem"><b>${esc(C.fmtTime(x.t))}</b> · ${esc(t('pg_' + x.group))}${x.section ? ' · ' + esc(x.section) : ''} · ${esc(procTaskLabel(x.task))}${x.comment ? '<div>' + esc(x.comment) + '</div>' : ''}<small>${esc(x.by)}</small>
        <div class="row"><button class="btn ghost small" data-logact="void" data-uid="${esc(x.uid)}">${esc(t('voidEntry'))}</button></div>${S.logAct && S.logAct.uid === x.uid ? `<div class="holdform"><label class="fld req">${esc(t('voidReason'))}<textarea rows="2" id="la_text"></textarea></label>
        ${C.pinFld('la_pin')}<button class="btn primary small" data-pact="voidlog">${esc(t('save'))}</button> <button class="btn ghost small" data-pact="cancella">${esc(t('cancel'))}</button></div>` : ''}</div>`).join('')}` : ''}
      <details><summary>${esc(t('procLog'))}</summary>${P.PROC_GROUPS.map(lastTbl).join('') || '<p class="sub">—</p>'}</details></section>`;
  }
  async function saveProc() {
    const cfg = P.procMaintCfg(S.cfgP), f = S.procForm || {}, g = cfg[f.group];
    const o = { group: f.group, section: (($('#pm_section') || {}).value || '').trim(), task: g && g.tasks.length === 1 ? g.tasks[0] : (($('#pm_task') || {}).value || ''), comment: (($('#pm_comment') || {}).value || '').trim() };
    const e = P.validateProcMaint(o, cfg);
    if (e.length) return C.toast(t('fillFields') + ': ' + e.map(x => t('f_' + x)).join(', '));
    const w = await whoP('pm_pin'); if (!w) return; const by = w.title;
    const tms = now();
    try { await DB.add('shiftLog', Object.assign(base(tms), { kind: 'procMaint', t: tms }, o, { by })); } catch (err) { return C.toast(t('saveFailed')); }
    S.procForm = { group: f.group }; await reload(); C.toast(t('saved')); keepScroll();
  }

  // ---------- leituras das balanças: abertura, fecho, movimento (v2.16.0) ----------
  // As leituras de abertura (login) e de fecho (logout) ficam sempre à vista; movimento = fecho − abertura; total do dia = os dois turnos.
  function scalesCard(li, lo, day, per) {
    const other = shiftRec('logout', day, per === 'D' ? 'N' : 'D');
    const v = (o, k) => o && isNum(o[k]) ? P.fmtScale(o[k]) : '—';
    const mv = k => lo && lo.shiftKg && isNum(lo.shiftKg[k]) ? lo.shiftKg[k] : null;
    const dayTot = k => isNum(mv(k)) && other && other.shiftKg && isNum(other.shiftKg[k]) ? mv(k) + other.shiftKg[k] : null;
    return `<section class="card"><h3>${esc(t('scalesTitle'))}</h3>
      <div class="tablewrap"><table class="tbl"><tr><th>${esc(t('scale'))}</th><th>${esc(t('scOpen'))}</th><th>${esc(t('scClose'))}</th><th>${esc(t('scMove'))} (kg)</th><th>${esc(t('scDay'))} (kg)</th></tr>
      ${P.SCALES.map(k => `<tr><td>${esc(t('scale_' + k))}</td><td>${v(li.scalesStart, k)}</td><td>${lo ? v(lo.scalesEnd, k) : '—'}</td>
        <td class="${lo && (lo.negative || []).indexOf(k) >= 0 ? 'd-reject' : ''}">${isNum(mv(k)) ? P.fmtScale(mv(k)) : '—'}</td><td>${isNum(dayTot(k)) ? P.fmtScale(dayTot(k)) : '—'}</td></tr>`).join('')}</table></div></section>`;
  }

  // ---------- logout: o que falta (v2.17.0, Zhax 17-11-2026) ----------
  function logoutMissing(li, day, per) {
    const out = [];
    loginItems(li).forEach((x, i) => { if (P.readPct((document.querySelector('.lo_pct[data-i="' + i + '"]') || {}).value) === null) out.push(t('lmPct', { j: x.label })); });
    const sc = P.readScales(scaleVals('los'));
    sc.bad.forEach(k => out.push(t('lmScale', { s: t('scale_' + k) })));
    if (P.runState(S.shiftLog, day, per, now() + 24 * 3600000).areas.reproc.on) { const b = P.num(($('#lo_bags') || {}).value); if (b === null || isNaN(b) || b < 0 || Math.round(b) !== b) out.push(t('lmBags')); }
    if (!/^[A-Za-z0-9]{4}$/.test((($('#lo_pin') || {}).value) || '')) out.push(t('lmPin'));
    return out;
  }
  function logoutCheckHtml(li, day, per) {
    const m = logoutMissing(li, day, per);
    return m.length ? `<div class="banner b-warn"><b>${esc(t('lmTitle'))}</b>${m.map(x => '<br>• ' + esc(x)).join('')}</div>` : `<div class="banner b-accept">✓ ${esc(t('lmReady'))}</div>`;
  }

  // ---------- milho D/M e C/M: mergulhos, leituras, tipo e grau, reconciliação (v2.16.0) ----------
  const dmIds = () => (S.cfgP.dirtyBins || []).map(b => b.id), cmIds = () => (S.cfgP.temperedBins || []).map(b => b.id);
  function viewMaize() {
    const day = S.mzDay || L.prodDay(now()), f = S.mzForm;
    const R = P.reconcile({ day, cfgP: S.cfgP, stocks: S.stocks, moves: S.moves, log: S.shiftLog });
    const kgT = v => isNum(v) ? fmtKg(v) + ' kg' : '<span class="sub">' + esc(t('noData')) + '</span>';
    const dCls = x => !isNum(x.diffPct) ? '' : Math.abs(x.diffPct) > 2 ? 'd-reject' : Math.abs(x.diffPct) > 1 ? 'd-warn' : 'd-accept';
    const recRows = (x, rows) => rows.map(([lab, val, sign]) => `<tr><td>${esc(lab)}</td><td>${sign || ''}${kgT(val)}</td></tr>`).join('') +
      `<tr><td><b>${esc(t('rcExpected'))}</b></td><td><b>${kgT(x.expected)}</b></td></tr><tr><td><b>${esc(t('rcToday'))}</b></td><td><b>${kgT(x.today && x.today.kg)}</b></td></tr>
       <tr><td><b>${esc(t('rcDiff'))}</b></td><td class="${dCls(x)}"><b>${isNum(x.diff) ? (x.diff > 0 ? '+' : '') + fmtKg(x.diff) + ' kg' + (isNum(x.diffPct) ? ' (' + String(x.diffPct).replace('.', ',') + ' %)' : '') : esc(t('noData'))}</b></td></tr>`;
    const grades = [['dm', dmIds()], ['cm', cmIds()]].map(([g, ids]) => { const G = P.maizeByGrade(S.stocks, day, ids); return `<h4>${esc(t('mz_' + g))}</h4>` + (G.length ? `<div class="tablewrap"><table class="tbl"><tr><th>${esc(t('mzType'))}</th><th>${esc(t('mzGrade'))}</th><th>kg</th></tr>${G.map(x => `<tr><td>${esc(x.colour === '?' ? '—' : x.colour)}</td><td>${esc(x.grade === '?' ? '—' : x.grade)}</td><td>${fmtKg(x.kg)}</td></tr>`).join('')}<tr><td colspan="2"><b>${esc(t('total'))}</b></td><td><b>${fmtKg(G.reduce((a, x) => a + x.kg, 0))}</b></td></tr></table></div>` : `<p class="sub">—</p>`); }).join('');
    return `<section class="card"><h3>${esc(t('mzTitle'))}</h3><label class="fld">${esc(t('prodDay'))}<input type="date" id="mzDay" value="${esc(day)}"></label>
      ${f ? maizeForm(f) : `<button class="btn primary" data-pact="mznew">${esc(t('mzNew'))}</button>`}</section>
      <section class="card"><h3>${esc(t('mzTotals'))}</h3>${grades}</section>
      <section class="card"><h3>${esc(t('rcTitle'))} · ${esc(C.fmtDT(Date.parse(R.prev + 'T12:00:00')).slice(0, 10))} → ${esc(C.fmtDT(Date.parse(day + 'T12:00:00')).slice(0, 10))}</h3>
        <h4>${esc(t('mz_dm'))}</h4><div class="tablewrap"><table class="tbl">${recRows(R.dm, [[t('rcYesterday'), R.dm.yesterday && R.dm.yesterday.kg], [t('rcReceived'), R.dm.received, '+ '], [t('scale_clean'), R.dm.clean, '− '], [t('scale_screenings'), R.dm.screenings, '− ']])}</table></div>
        <h4>${esc(t('mz_cm'))}</h4><div class="tablewrap"><table class="tbl">${recRows(R.cm, [[t('rcYesterday'), R.cm.yesterday && R.cm.yesterday.kg], [t('scale_clean'), R.cm.clean, '+ '], ['B1', R.cm.b1, '− ']])}</table></div>
        ${R.scales.shifts.every(Boolean) ? '' : `<p class="sub">${esc(t('rcNoLogout', { d: R.prev }))}</p>`}</section>`;
  }
  function maizeForm(f) {
    const opt = (list, v) => `<option value="">—</option>` + list.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const row = (id, dip) => { const x = f.levels[id] || {}; const dk = dip && String(x.dipM || '').trim() !== '' ? P.dipKg(x.dipM, P.dipSpec(id, S.cfgP)) : null;
      return `<tr><td><b>${esc(id)}</b></td><td>${dip ? `<input inputmode="decimal" data-mz="${esc(id)}|dipM" value="${esc(x.dipM || '')}" placeholder="${esc(t('dipD'))}"><br><small id="mzkg_${esc(id)}">${dipKgText(x.dipM, dk)}</small>`
        : `<input inputmode="decimal" data-mz="${esc(id)}|kg" value="${esc(x.kg || '')}">`}</td>
        <td><select data-mz="${esc(id)}|colour">${opt(P.COLOURS, x.colour)}</select></td><td><select data-mz="${esc(id)}|grade">${opt(P.SILO_GRADES, x.grade)}</select></td></tr>`; };
    const head = k => `<tr><th></th><th>${esc(t('dipD'))}</th><th>${esc(t('mzType'))}</th><th>${esc(t('mzGrade'))}</th></tr>`;
    return `<h4>${esc(t('mz_dm'))}</h4><div class="tablewrap"><table class="tbl">${head('dm')}${dmIds().map(id => row(id, P.DIP.bins.indexOf(id) >= 0)).join('')}</table></div>
      <h4>${esc(t('mz_cm'))}</h4><div class="tablewrap"><table class="tbl">${head('cm')}${cmIds().map(id => row(id, true)).join('')}</table></div>
      ${C.pinFld('mz_pin')}
      <button class="btn primary big" data-pact="mzsave">${esc(t('save'))}</button><button class="btn ghost" data-pact="mzcancel">${esc(t('cancel'))}</button>`;
  }
  async function saveMaize() {
    const f = S.mzForm, w = await whoP('mz_pin'); if (!w) return; const by = w.title;
    const changedTG = dmIds().map(id => [id, 'dm']).concat(cmIds().map(id => [id, 'cm'])).some(([id, k]) => { const x = f.levels[id] || {}, r = maizeRow(id, k);
      return (x.colour !== undefined && (x.colour || '') !== (r.colour || '')) || (x.grade !== undefined && (x.grade || '') !== (r.grade || '')); });
    if (changedTG && TOP.indexOf(w.role) < 0) return C.toast(t('tgSupOnly'));
    cmIds().forEach(id => { const r = maizeRow(id, 'cm'), x = f.levels[id] || {}; f.levels[id] = Object.assign(x, { colour: x.colour !== undefined ? x.colour : r.colour || '', grade: x.grade !== undefined ? x.grade : r.grade || '' }); });
    dmIds().forEach(id => { const r = maizeRow(id, 'dm'), x = f.levels[id] || {}; f.levels[id] = Object.assign(x, { colour: x.colour !== undefined ? x.colour : r.colour || '', grade: x.grade !== undefined ? x.grade : r.grade || '' }); });
    const ids = dmIds().concat(cmIds()), levels = {};
    ids.forEach(id => { const x = f.levels[id] || {}; if (String(x.dipM || '').trim() || String(x.kg || '').trim()) levels[id] = { dipM: x.dipM, kg: x.kg }; });
    const r = P.validateBinStock({ levels, by }, S.cfgP, { binEvents: S.binEvents, jobs: S.jobs });
    if (r.errors.length) return C.toast(r.errors.map(stockMsg).join(' · '));
    Object.keys(r.values).forEach(id => { const x = f.levels[id] || {}; r.values[id].colour = x.colour || ''; r.values[id].grade = x.grade || ''; });
    const tms = now();
    try { await DB.add('binStock', Object.assign(base(tms), { kind: 'stock', t: tms, levels: r.values, by, scope: 'maize', warnings: r.warnings.map(w => w.code + ':' + w.bin) })); }
    catch (e) { return C.toast(t('saveFailed')); }
    S.mzForm = null; S.operator = by; await reload(); C.toast(t('saved')); keepScroll();
  }

  // ---------- em marcha: Produção, Limpeza, Reprocessamento (v2.16.0) ----------
  const hmNow = () => {   // agora, se estiver dentro do turno escolhido; senão a hora de início do turno
    const sel = shiftSel(), [a, b] = shiftRange(sel.day, sel.period), x = now();
    if (x < a || x >= b) return sel.period === 'D' ? '07:00' : '19:00';
    const d = new Date(x); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  function runFields(p, cur) {
    return `<div class="tablewrap"><table class="tbl">${P.RUN_AREAS.map(a => { const on = cur ? cur[a].on : false, show = on || p === 'rc'; return `<tr><td><b>${esc(t('ra_' + a))}</b></td>
      <td><select id="${p}_on_${a}" data-runsel="${p}|${a}"><option value="0" ${on ? '' : 'selected'}>${esc(t('no'))}</option><option value="1" ${on ? 'selected' : ''}>${esc(t('yes'))}</option></select></td>
      <td><div id="${p}_box_${a}" ${show ? '' : 'hidden'}><input type="hidden" id="${p}_t_${a}" value="${esc(hmNow())}">
      <label class="fld">${esc(t('comments'))}<input id="${p}_c_${a}"></label>${p === 'rc' && a === 'reproc' && on ? `<label class="fld">${esc(t('reprocBagsOff'))}<input inputmode="numeric" id="rc_bags_reproc"></label>` : ''}</div></td></tr>`; }).join('')}</table></div>`;
  }
  function readRun(p, sel, only) {
    const start = shiftRange(sel.day, sel.period)[0], areas = {};
    for (const a of (only ? [only] : P.RUN_AREAS)) {
      const on = (($('#' + p + '_on_' + a) || {}).value) === '1';
      const hm = (($('#' + p + '_t_' + a) || {}).value) || '';
      const at = P.shiftTimeMs(start, sel.period, hm);
      if (on && at === null) return { err: a };
      areas[a] = { on, at: on ? at : now(), time: on ? hm : '', comment: on ? ((($('#' + p + '_c_' + a) || {}).value) || '').trim() : '' };
    }
    return { areas };
  }
  function runCard(day, per) {
    const rs = P.runState(S.shiftLog, day, per, now() + 24 * 3600000);
    return `<section class="card"><h3>${esc(t('runTitle'))}</h3>
      <div class="tablewrap"><table class="tbl">${P.RUN_AREAS.map(a => { const x = rs.areas[a]; return `<tr><td><b>${esc(t('ra_' + a))}</b></td>
        <td><span class="chip ${x.on ? 'd-accept' : ''}">${esc(x.on ? t('yes') : t('no'))}</span>${x.comment ? '<br><small>' + esc(x.comment) + '</small>' : ''}</td></tr>`; }).join('')}</table></div>
      <h4>${esc(t('runChange'))}</h4>${runFields('rc', rs.areas)}${C.pinFld('rc_pin')}
      <button class="btn primary" data-pact="saverun">${esc(t('save'))}</button></section>`;
  }
  async function saveRun() {
    const sel = shiftSel(), li = shiftRec('login', sel.day, sel.period);
    if (!li) return;
    const cur = P.runState(S.shiftLog, sel.day, sel.period, now() + 24 * 3600000).areas;
    const recs = [];
    for (const a of P.RUN_AREAS) {
      const on = (($('#rc_on_' + a) || {}).value) === '1';
      if (on === cur[a].on) continue;
      const hm = (($('#rc_t_' + a) || {}).value) || '';
      const at = P.shiftTimeMs(shiftRange(sel.day, sel.period)[0], sel.period, hm);
      if (at === null) return C.toast(t('runTimeNeed', { a: t('ra_' + a) }));
      const rec = { area: a, on, at, time: hm, comment: ((($('#rc_c_' + a) || {}).value) || '').trim() };
      if (a === 'reproc' && !on) {   // v2.17.0: sacos reprocessados pedidos ao desligar o reprocessamento
        const b = P.num(($('#rc_bags_reproc') || {}).value);
        if (b === null || isNaN(b) || b < 0 || Math.round(b) !== b) return C.toast(t('lmBags'));
        Object.assign(rec, { bags: b, from: cur.reproc.at });
      }
      recs.push(rec);
    }
    if (!recs.length) return C.toast(t('noChanges'));
    const tms = now();
    const w = await whoP('rc_pin'); if (!w) return;
    try { for (const r of recs) await DB.add('shiftLog', Object.assign(base(tms), { kind: 'runState', t: tms, prodDay: sel.day, period: sel.period, shift: sel.day + '/' + sel.period, crew: li.crew, by: w.title }, r)); }
    catch (e) { return C.toast(t('saveFailed')); }
    await reload(); C.toast(t('saved')); keepScroll();
  }
  // Produção registada agora no turno actual? (sem login ou Produção = Não → sem verificações horárias)
  function prodOn() {
    const sh = L.shiftOf(now());
    const rs = P.runState(S.shiftLog, sh.day, sh.period, now());
    return rs.login && rs.areas.production.on;
  }

  // Aviso na página inicial: turno actual sem login
  function shiftIssue() {
    const sh = L.shiftOf(now());
    if (now() - shiftRange(sh.day, sh.period)[0] < 30 * 60000) return null;   // primeira meia hora do turno: ainda sem aviso
    return shiftRec('login', sh.day, sh.period) ? null : t('loginMissing', { s: t('shift_' + sh.period) });
  }

  // ---------- paragens (v2.7.0) ----------
  // Categoria (mecânica, eléctrica, processo, outra) → código Downtime Codes v3 → início e fim (duração calculada) → falha e acção.
  // Gravadas como registo 'issue' do diário de turno (mesmo formato que o pipeline lê), com category, startT e endT.
  const codeOpts = (cat, sel) => `<option value="">—</option>` + P.codesForCat(cat, codes()).map(c => `<option value="${esc(c.code)}" ${sel === c.code ? 'selected' : ''}>${esc(c.code + ' ' + cName(c))}</option>`).join('');
  function viewStops() {
    const sel = shiftSel(), range = shiftRange(sel.day, sel.period);
    const sm = P.shiftSummary(sel.day, sel.period, range, { log: S.shiftLog, jobs: S.jobs, now: now(), codes: codes() });
    const nowIn = C.localInput(now());
    return `<section class="card"><h3>${esc(t('stopNew'))}</h3>
      <div class="grid2"><label class="fld req">${esc(t('stopCat'))}<select id="st_cat">${P.STOP_CATS.map(c => `<option value="${c}">${esc(t('cat_' + c))}</option>`).join('')}</select></label>
      <label class="fld req">${esc(t('downtimeCode'))}<select id="st_code">${codeOpts('mechanical')}</select></label>
      <label class="fld req">${esc(t('stopStart'))}<input type="datetime-local" id="st_start" value="${esc(nowIn)}"></label>
      <label class="fld req">${esc(t('stopEnd'))}<input type="datetime-local" id="st_end" value="${esc(nowIn)}"></label>
      <label class="fld">${esc(t('line'))}<select id="st_line">${lineOpts('C')}</select></label>
      <label class="fld">${esc(t('durMin'))}<input id="st_dur" readonly tabindex="-1" value="0"></label>
      <div class="req">${C.pinFld('st_pin')}</div></div>
      <label class="fld req">${esc(t('stopFault'))}<textarea rows="2" id="st_fault"></textarea></label>
      <label class="fld">${esc(t('stopIntervention'))}<textarea rows="2" id="st_action"></textarea></label>
      <label class="fld">${esc(t('stopConsumables'))}<textarea rows="2" id="st_cons"></textarea></label>
      <button class="btn primary big" data-pact="savestop">${esc(t('save'))}</button></section>
      <section class="card"><h3>${esc(t('ptab_stops'))} · ${esc(sel.day)} ${esc(t('shift_' + sel.period))} · ${sm.downtimeMin} min</h3>${sm.issues.map(issueItem).join('') || '<p class="sub">—</p>'}</section>`;
  }
  function stopDur() {
    const a = new Date(($('#st_start') || {}).value).getTime(), b = new Date(($('#st_end') || {}).value).getTime(), o = $('#st_dur');
    if (o) o.value = isFinite(a) && isFinite(b) && b >= a ? String(Math.round((b - a) / 60000)) : '—';   // v2.27.0 (Zhax, 27-11-2026): campo «Duração (min)» em vez da frase
  }
  async function saveStop() {
    const f = { category: $('#st_cat').value, code: $('#st_code').value, start: new Date($('#st_start').value).getTime(), end: new Date($('#st_end').value).getTime(),
      fault: $('#st_fault').value, action: $('#st_action').value };
    const r = P.validateStop(f, codes());
    if (r.errors.length) return C.toast(t('fillFields') + ': ' + r.errors.map(x => t('sf_' + x)).join(', '));
    if (f.start > now() + 5 * 60000) return C.toast(t('futureTime'));
    const w = await whoP('st_pin'); if (!w) return; const by = w.title;
    const action = String(f.action || '').trim();
    const rec = Object.assign(base(f.start), { kind: 'issue', t: f.start, startT: f.start, endT: f.end, category: f.category, lineId: $('#st_line').value, code: f.code,
      codeInfo: Object.assign({ source: S.cfgP.codesSource || P.DOWNTIME_SOURCE }, P.findCode(f.code, codes())), equipment: cName(P.findCode(f.code, codes()) || {}),
      description: String(f.fault).trim(), downtimeMin: r.downtimeMin, action, consumables: (($('#st_cons') || {}).value || '').trim(),
      by, status: action ? 'closed' : 'open' });
    if (rec.status === 'closed') { rec.closedAt = f.end; rec.closedBy = by; rec.resolution = action; }
    try { await DB.add('shiftLog', rec); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = by; await DB.setConfig('operator', S.operator);
    S.shiftSel = { day: rec.prodDay, period: rec.period };
    await reload(); C.toast(t('stopSaved', { m: r.downtimeMin })); keepScroll();
  }

  // ---------- ordens de produção ----------
  function snapCard() {
    const sn = snapshot();
    const sh = L.shiftOf(now());
    const exp = sn ? (sn.exportedAt ? Date.parse(sn.exportedAt) : sn.importedAt) : null;
    return `<section class="card"><h3>${esc(t('grainStock'))}</h3>
      ${sn ? `<p class="sub">${esc(sn.source === 'grain-mgt-auto' ? t('snapAuto', { e: C.fmtDT(exp), f: C.fmtDT(S.autoSilo.fetchedAt) }) : t('snapFrom', { e: C.fmtDT(exp), i: C.fmtDT(sn.importedAt) }))}</p>
        ${sn.source !== 'grain-mgt-auto' && exp < sh.start ? `<div class="banner b-warn">${esc(t('snapOld'))}</div>` : ''}
        ${P.nonCanonical(sn, S.cfgP.grainSilos).length ? `<div class="banner b-reject">${esc(t('nonCanonical', { s: P.nonCanonical(sn, S.cfgP.grainSilos).join(', '), list: siloRange() }))}</div>` : ''}` : `<div class="banner b-warn">${esc(t('snapNone'))}</div>`}
      
      <label class="btn ghost">${esc(t('importSilos'))}<input type="file" id="importSilos" accept="application/json" hidden></label></section>`;
  }
  const siloRange = () => { const g = S.cfgP.grainSilos || []; return g.length > 2 ? g[0] + '–' + g[g.length - 1] : g.join(', '); };
  const dirtyState = id => P.dirtyBinState(id, S.moves, S.jobs);
  const gradeName = g => t('g_' + (P.SILO_GRADES.indexOf(g) >= 0 ? g : 'none'));
  const compText = comps => (comps || []).filter(c => c.kg > 0).map(c => (c.cereal === 'Milho' ? '' : c.cereal + ' ') + c.colour + ' · ' + gradeName(c.grade) + ': ' + fmtKg(c.kg) + ' kg (' + c.silos.join(', ') + ')').join(' + ');

  // ---------- v2.18.0 (Zhax, 26-11-2026): Grão = tabela das bins D/M e C/M + leitura + totais por grau + transferências ----------
  // Bin | Espaço vazio (m) | Quantidade | Tipo | Grau | Data de enchimento | Retenção. D/M: tipo e grau só com PIN de Supervisor ou acima;
  // chefes de turno só o espaço vazio; data de enchimento = última descarga recebida (Silo Cereais). C/M: tipo, grau e data vêm
  // da última ordem que usa a C/M (D/M da limpeza → C/M); o espaço vazio é mergulhado pelo chefe de turno.
  const TOP = ['pm', 'head', 'chief', 'sup'];
  const typeName = v => v ? t('ty_' + v) : '—';
  function lastLevel(id) {
    const s = (S.stocks || []).filter(x => x.levels && x.levels[id]).sort((a, b) => b.t - a.t)[0];
    return s ? Object.assign({ t: s.t }, s.levels[id]) : null;
  }
  const dmFilled = id => { const m = (S.moves || []).filter(x => x.binId === id && x.type !== 'EMPTY').sort((a, b) => b.t - a.t)[0]; return m ? m.t : null; };
  function cmFromJob(id) {
    const j = (S.jobs || []).filter(x => (x.tempered || []).indexOf(id) >= 0 && isNum(x.startedAt)).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!j) return null;
    const cols = [], grs = [];
    (j.sources || []).forEach(src => {
      const comps = (j.sourceComps && j.sourceComps[src]) || [], lv = lastLevel(src) || {};
      const c = comps.length ? comps.map(x => x.colour) : [lv.colour], g = comps.length ? comps.map(x => x.grade) : [lv.grade];
      c.filter(Boolean).forEach(x => { if (cols.indexOf(x) < 0) cols.push(x); }); g.filter(Boolean).forEach(x => { if (grs.indexOf(x) < 0) grs.push(x); });
    });
    return { colour: cols.length > 1 ? 'Mistura' : cols[0] || '', grade: grs.join('/'), t: j.startedAt, sources: j.sources || [], jobUid: j.uid };
  }
  function maizeRow(id, kind) {
    const lv = lastLevel(id) || {}, cm = kind === 'cm' ? cmFromJob(id) : null, H = holds()[id];
    const fromJob = cm && !((lv.colour || lv.grade) && lv.t > cm.t) ? cm : null;   // v2.22.0: C/M — o tipo/grau gravados ganham; senão os da ordem
    return { id, kind, dipM: lv.dipM, kg: lv.kg, colour: fromJob ? fromJob.colour : lv.colour, grade: fromJob ? fromJob.grade : lv.grade, filled: kind === 'cm' ? (cm && cm.t) : dmFilled(id), hold: H || null, cm };
  }
  const dash = v => v === undefined || v === null || v === '' ? '—' : esc(String(v));
  function maizeTable(rows, edit) {
    const f = S.mzForm, opt = (list, v, lab) => `<option value="">—</option>` + list.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(lab ? lab(x) : x)}</option>`).join('');
    return `<div class="tablewrap"><table class="tbl"><tr><th>${esc(t('bin'))}</th><th>${esc(t('emptySpace'))}</th><th>${esc(t('quantityKg'))}</th><th>${esc(t('mzType'))}</th><th>${esc(t('mzGrade'))}</th><th>${esc(t('dateFilled'))}</th><th>${esc(t('holdCol'))}</th></tr>
      ${rows.map(r => { const x = edit ? (f.levels[r.id] || {}) : {};
        const dip = edit ? `<input inputmode="decimal" data-mz="${esc(r.id)}|dipM" value="${esc(x.dipM !== undefined ? x.dipM : '')}" style="max-width:80px">` : isNum(Number(r.dipM)) && String(r.dipM || '').trim() !== '' ? esc(String(r.dipM).replace('.', ',')) : '—';
        const ty = edit ? `<select data-mz="${esc(r.id)}|colour">${opt(P.MZ_TYPES, x.colour !== undefined ? x.colour : r.colour, typeName)}</select>` : esc(typeName(r.colour));
        const gr = edit ? `<select data-mz="${esc(r.id)}|grade">${opt(P.SILO_GRADES, x.grade !== undefined ? x.grade : r.grade)}</select>` : dash(r.grade);
        return `<tr><td><b>${esc(r.id)}</b></td><td>${dip}</td><td>${isNum(r.kg) ? fmtKg(r.kg) : '—'}</td><td>${ty}</td><td>${gr}</td><td>${r.filled ? esc(C.fmtDT(r.filled).slice(0, 10)) : '—'}</td>
          <td>${r.hold ? `<span class="chip d-reject">${esc(t('onHold'))}</span>` : '—'}</td></tr>`; }).join('')}</table></div>`;
  }
  function gradeTotals(rows) {
    const T = {}; rows.forEach(r => { if (!isNum(r.kg)) return; const g = r.grade || '—'; T[g] = (T[g] || 0) + r.kg; });
    const ks = Object.keys(T).sort();
    return ks.length ? `<div class="tablewrap"><table class="tbl"><tr><th>${esc(t('mzGrade'))}</th><th>kg</th></tr>${ks.map(g => `<tr><td>${esc(g)}</td><td>${fmtKg(T[g])}</td></tr>`).join('')}
      <tr><td><b>${esc(t('total'))}</b></td><td><b>${fmtKg(ks.reduce((a, g) => a + T[g], 0))}</b></td></tr></table></div>` : `<p class="sub">${esc(t('noData'))}</p>`;
  }
  function viewGrainAll() {
    const dm = dmIds().map(id => maizeRow(id, 'dm')), cm = cmIds().map(id => maizeRow(id, 'cm')), f = S.mzForm;
    const cleaning = cm.filter(r => r.cm).map(r => `<div class="kv"><span>${esc(r.cm.sources.join(', ') || '—')} → <b>${esc(r.id)}</b></span><b>${esc(C.fmtDT(r.cm.t))}</b></div>`).join('');
    const R = P.reconcile({ day: S.mzDay || L.prodDay(now()), cfgP: S.cfgP, stocks: S.stocks, moves: S.moves, log: S.shiftLog });
    const kgT = v => isNum(v) ? fmtKg(v) + ' kg' : esc(t('noData'));
    const recRows = (x, rows) => rows.map(([lab, val, sign]) => `<tr><td>${esc(lab)}</td><td>${sign || ''}${kgT(val)}</td></tr>`).join('') +
      `<tr><td><b>${esc(t('rcExpected'))}</b></td><td><b>${kgT(x.expected)}</b></td></tr><tr><td><b>${esc(t('rcToday'))}</b></td><td><b>${kgT(x.today && x.today.kg)}</b></td></tr>
       <tr><td><b>${esc(t('rcDiff'))}</b></td><td><b>${isNum(x.diff) ? (x.diff > 0 ? '+' : '') + fmtKg(x.diff) + ' kg' : esc(t('noData'))}</b></td></tr>`;
    return `<section class="card"><h3>${esc(t('mz_dm'))}</h3>${maizeTable(dm, !!f)}
      <h3>${esc(t('mz_cm'))}</h3>${maizeTable(cm, !!f)}
      ${f ? `${C.pinFld('mz_pin')}<button class="btn primary big" data-pact="mzsave">${esc(t('save'))}</button><button class="btn ghost" data-pact="mzcancel">${esc(t('cancel'))}</button>`
        : `<button class="btn primary" data-pact="mznew">${esc(t('mzNew'))}</button>`}</section>
      <section class="card"><h3>${esc(t('cleaningSec'))}</h3>${cleaning || '<p class="sub">—</p>'}</section>
      <section class="card"><h3>${esc(t('gradeTotals'))}</h3><h4>${esc(t('mz_dm'))}</h4>${gradeTotals(dm)}<h4>${esc(t('mz_cm'))}</h4>${gradeTotals(cm)}</section>
      <section class="card"><h3>${esc(t('rcTitle'))}</h3><label class="fld">${esc(t('prodDay'))}<input type="date" id="mzDay" value="${esc(S.mzDay || L.prodDay(now()))}"></label>
        <h4>${esc(t('mz_dm'))}</h4><div class="tablewrap"><table class="tbl">${recRows(R.dm, [[t('rcYesterday'), R.dm.yesterday && R.dm.yesterday.kg], [t('rcReceived'), R.dm.received, '+ '], [t('scale_clean'), R.dm.clean, '− '], [t('scale_screenings'), R.dm.screenings, '− ']])}</table></div>
        <h4>${esc(t('mz_cm'))}</h4><div class="tablewrap"><table class="tbl">${recRows(R.cm, [[t('rcYesterday'), R.cm.yesterday && R.cm.yesterday.kg], [t('scale_clean'), R.cm.clean, '+ '], ['B1', R.cm.b1, '− ']])}</table></div></section>` + viewGrain();
  }

  // ---------- grão: stock da app de Silos, transferências para silos de milho sujo ----------
  function viewGrain() {
    const recent = (S.moves || []).slice().sort((a, b) => b.t - a.t).slice(0, 10);
    return snapCard() +
      (feedAuto() ? `<section class="card"></section>` : S.trForm ? transferFormView() : `<section class="card"><button class="btn primary big" data-pact="newtransfer">＋ ${esc(t('newTransfer'))}</button></section>`) +
      (false ? `${recent.map(m => `<div class="rowitem"><b>${esc(C.fmtDT(m.t))}</b> · ${esc(m.binId)}${m.source === 'grain-mgt' ? ' · <small>' + esc(t('srdFromGm')) + '</small>' : ''} · ${m.type === 'EMPTY' ? esc(t('binEmptied', { kg: fmtKg(m.bookKg) })) : esc((m.parts || []).map(p => p.silo + ' ' + fmtKg(p.kg) + ' kg').join(' → '))}<br><small>${esc(t('crew'))} ${esc(m.crew || '—')} · ${esc(m.by || '')}</small></div>`).join('') || ''}` : '');   // v2.22.0: movimentos nos Relatórios
  }
  function dirtyCard(b) {
    const st = dirtyState(b.id);
    const mine = S.emptyBin === b.id;
    if (P.CONTINUOUS_FEED) {
      // v2.8.1: nível = mergulho medido; as entradas somam-se sem limite (a bin enche enquanto a limpeza consome)
      const lv = levelOf(b.id), inSince = st.comps.reduce((s, c) => s + c.kg, 0);
      return `<div class="rowitem"><div class="row between"><span><b>${esc(b.id)}</b> <small>${esc(t('fedBy'))} ${esc(b.lines.join('/'))}${isNum(b.capKg) ? ' · ' + fmtKg(b.capKg) + ' kg' : ''}</small></span>
          <span class="chip ${lv && isNum(lv.kg) ? 'd-warn' : 'd-record'}">${lv && isNum(lv.kg) ? fmtKg(lv.kg) + ' kg' + (isNum(lv.pct) ? ' · ' + String(lv.pct).replace('.', ',') + ' %' : '') : esc(t('stockUnknown'))}</span></div>
        ${lv && lv.reading ? `<small>${esc(t('dipLevelAt', { h: C.fmtDT(lv.reading.t) }))}</small><br>` : `<small>${esc(t('dipNeeded'))}</small><br>`}
        ${inSince > 0 ? `<small>${esc(t('continuousIn', { kg: fmtKg(inSince) }))}: ${esc(compText(st.comps))}</small>` : ''}
        ${st.runningJobs.length ? `<div><small>${esc(t('inUseBy', { n: st.runningJobs.length }))}</small></div>` : ''}</div>`;
    }
    const pct = isNum(b.capKg) && b.capKg > 0 ? Math.max(0, Math.min(100, Math.round(st.kg / (b.capKg / 100)))) : null;
    return `<div class="rowitem"><div class="row between"><span><b>${esc(b.id)}</b> <small>${esc(t('fedBy'))} ${esc(b.lines.join('/'))}${isNum(b.capKg) ? ' · ' + fmtKg(b.capKg) + ' kg' : ''}</small></span>
        <span class="chip ${st.kg > 0 ? 'd-warn' : 'd-accept'}">${st.kg > 0 ? fmtKg(st.kg) + ' kg' + (pct !== null ? ' · ' + pct + ' %' : '') : esc(t('binEmpty'))}</span></div>
      ${st.kg < 0 ? `<div class="banner b-reject"><small>${esc(t('negativeBin'))}</small></div>` : ''}
      ${st.comps.length ? `<small>${esc(t('inputsSince'))}: ${esc(compText(st.comps))}</small>` : ''}
      ${st.runningJobs.length ? `<div><small>${esc(t('inUseBy', { n: st.runningJobs.length }))}</small></div>` : ''}
      ${mine ? `<div class="holdform"><p class="sub">${esc(t('emptyDirtyNote', { kg: fmtKg(st.kg) }))}</p>
          
          <label class="fld req">${esc(t('pin'))}<input type="password" maxlength="4" id="eb_pin"></label>
          <button class="btn primary small" data-pact="emptydirty">${esc(t('save'))}</button> <button class="btn ghost small" data-pact="cancelempty">${esc(t('cancel'))}</button></div>`
        : (st.inKg > 0 || st.kg !== 0 ? `<div class="row"><button class="btn ghost small" data-emptydirty="${esc(b.id)}">${esc(t('binEmptyBtn'))}</button></div>` : '')}</div>`;
  }
  const tctxFor = () => ({ cfgP: S.cfgP, millType: S.cfg.millType, snapshot: snapshot(), moves: S.moves, jobs: S.jobs, shiftStart: L.shiftOf(now()).start });
  function newTransferForm() { S.trForm = { binId: '', silos: [], kg: '', silosConfirmed: false, by: defLeader() }; }
  function transferFormView() {
    const f = S.trForm, sn = snapshot();
    const siloRows = sn ? sn.silos.map(s => {
      const idx = f.silos.indexOf(s.id);
      const canon = (S.cfgP.grainSilos || []).indexOf(s.id) >= 0;
      const red = s.openEvent && isNum(s.openLevel) && s.openLevel >= 4;
      const chip = !canon ? `<span class="chip d-reject">${esc(t('notCanonical'))}</span>` : red ? `<span class="chip d-reject">${esc(t('siloRed'))}</span>` : s.openEvent ? `<span class="chip d-warn">⚠ ${esc(t('openEvent'))}</span>` : '';
      return `<button class="pick ${idx >= 0 ? 'on' : ''}" data-trsilo="${esc(s.id)}">${idx >= 0 ? `<i class="ord">${idx + 1}</i>` : ''}<b>${esc(s.id)}</b>
        <small>${esc(s.cereal)} ${esc(s.colour)} · ${esc(gradeName(s.grade))} · ${fmtKg(P.availableKg(sn, S.moves, s.id))} kg</small>${chip}</button>`;
    }).join('') : `<p class="sub">${esc(t('snapNone'))}</p>`;
    return `<section class="card"><h2>${esc(t('newTransfer'))}</h2>
      <div class="grid2"><label class="fld req">${esc(t('dirtyBin'))}<select data-trf="binId"><option value="">—</option>${(S.cfgP.dirtyBins || []).map(b => { const st = dirtyState(b.id); return `<option value="${esc(b.id)}" ${f.binId === b.id ? 'selected' : ''}>${esc(b.id)} · ${fmtKg(st.kg)} / ${isNum(b.capKg) ? fmtKg(b.capKg) : '?'} kg</option>`; }).join('')}</select></label>
        <label class="fld req">${esc(t('qtyKg'))}<input inputmode="decimal" data-tri="kg" value="${esc(f.kg)}"></label></div>
      <div class="picks">${siloRows}</div>
      <label class="chk"><input type="checkbox" data-trf="silosConfirmed" ${f.silosConfirmed ? 'checked' : ''}> ${esc(t('confirmSilos'))}</label>
      ${C.pinFld('tr_pin')}
      <div id="trCheck">${trCheckHtml()}</div>
      <button class="btn primary big" data-pact="savetransfer">${esc(t('saveTransfer'))}</button>
      <button class="btn ghost" data-pact="canceltransfer">${esc(t('cancel'))}</button></section>`;
  }
  function trErrText(e) {
    const v = Object.assign({}, e);
    if (e.field) v.field = t('f_' + e.field);
    if (isNum(e.short)) v.short = fmtKg(e.short);
    if (isNum(e.free)) v.free = fmtKg(e.free);
    v.list = siloRange();
    return t('je_' + e.code, v);
  }
  function trCheckHtml() {
    const r = P.validateTransfer(S.trForm, tctxFor());
    const rows = r.calc.parts ? `<div class="kv"><span>${esc(t('fromSilos'))}</span><b>${esc(r.calc.parts.map(p => p.silo + ' ' + fmtKg(p.kg) + ' kg').join(' → '))}</b></div>` : '';
    const free = isNum(r.calc.freeKg) ? `<div class="kv"><span>${esc(t('freeInBin'))}</span><b>${fmtKg(r.calc.freeKg)} kg</b></div>` : '';
    return `${rows}${free}${r.errors.length ? `<div class="dec d-reject"><b>${esc(t('trBlocked'))}</b>${r.errors.map(e => `<div class="li">• ${esc(trErrText(e))}</div>`).join('')}</div>` : `<div class="dec d-accept"><b>${esc(t('trOk'))}</b></div>`}
      ${r.warnings.length ? `<div class="dec d-warn">${r.warnings.map(w => `<div class="li">• ${esc(w.soft ? trErrText(w) : t('jw_' + w.code, w))}</div>`).join('')}</div>` : ''}`;
  }
  async function saveTransfer() {
    const f = S.trForm;
    { const w = await whoP('tr_pin'); if (!w) return; f.by = w.title; }
    const r = P.validateTransfer(f, tctxFor());
    if (r.errors.length) { keepScroll(); return C.toast(t('trBlocked')); }
    const tms = now(), sn = snapshot();
    const m = Object.assign(base(tms), { type: 'TRANSFER', binId: f.binId, t: tms, kg: r.values.kg, parts: r.calc.parts,
      snapshotUid: sn ? sn.uid : null, warnings: r.warnings.map(w => w.code + (w.silo ? ':' + w.silo : '') + (w.bin ? ':' + w.bin : '')), by: String(f.by).trim() });
    try { await DB.add('grainMoves', m); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = m.by; await DB.setConfig('operator', S.operator);
    S.trForm = null; await reload(); C.toast(t('trSaved', { kg: fmtKg(m.kg), b: m.binId })); keepScroll();
  }
  async function emptyDirty() {
    const id = S.emptyBin, w = await whoP('eb_pin', ['sup', 'chief', 'head', 'pm']); if (!w) return; const by = w.title;
    const st = dirtyState(id);
    if (st.runningJobs.length) return C.toast(t('binInUse'));
    const r = await C.checkPin($('#eb_pin').value);
    if (!r.ok) return C.toast(C.pinMsg(r));
    const tms = now();
    try { await DB.add('grainMoves', Object.assign(base(tms), { type: 'EMPTY', binId: id, t: tms, bookKg: st.kg, comps: st.comps, by })); }
    catch (e) { return C.toast(t('saveFailed')); }
    S.emptyBin = null; await reload(); C.toast(t('saved')); keepScroll();
  }


  // ---------- v2.27.0 (Zhax, 27-11-2026): amostragem do milho no CQ (silo → D/M, D/M → C/M, C/M → B1) — só registo ----------
  function maizeQcCard() {
    const st = S.mqStage && P.MZQC_STAGES[S.mqStage] ? S.mqStage : 'silo_dm', D = P.MZQC_STAGES[st], f = S.mqForm || {};
    const dm = (S.cfgP.dirtyBins || []).map(b => b.id), cm = (S.cfgP.temperedBins || []).map(b => b.id);
    const LIST = { silo: (S.cfgP.grainSilos && S.cfgP.grainSilos.length) ? S.cfgP.grainSilos : P.GRAIN_SILOS, dmBin: dm, cmBin: cm };
    const sel = k => `<label class="fld req">${esc(t('mq_' + k))}<select data-mq="${k}"><option value="">—</option>${LIST[k].map(x => `<option ${f[k] === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
    const numF = k => `<label class="fld ${k === 'moisture' ? 'req' : ''}">${esc(t('mq_' + k))}<input inputmode="decimal" data-mq="${k}" value="${esc(f[k] || '')}"></label>`;
    const flag = k => `<label class="fld">${esc(t('mq_' + k))}<select data-mq="${k}"><option value="">—</option><option value="no" ${f[k] === 'no' ? 'selected' : ''}>${esc(t('no'))}</option><option value="yes" ${f[k] === 'yes' ? 'selected' : ''}>${esc(t('yes'))}</option></select></label>`;
    const day = L.prodDay(now()), Q = P.maizeQcDay(S.shiftLog, day), fmt = v => typeof v === 'number' && isFinite(v) ? C.fmtNum(v) : '—';
    const LIM = P.maizeQcLimits(S.cfgP), dcls = d => d === 'reject' ? 'd-reject' : d === 'warn' ? 'd-warn' : d === 'accept' ? 'd-accept' : '';
    const tables = Object.keys(P.MZQC_STAGES).filter(s => Q[s].rows.length).map(s => { const X = P.MZQC_STAGES[s], cols = X.ids.concat(X.nums, X.flags);
      return `<h4>${esc(t('mqs_' + s))} (${Q[s].rows.length})</h4><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('time'))}</th>${cols.map(k => `<th>${esc(t('mq_' + k))}</th>`).join('')}${s === 'cm_b1' ? `<th>${esc(t('mqDev'))}</th>` : ''}<th>${esc(t('mqDecision'))}</th><th>${esc(t('holdCol'))}</th></tr>
        ${Q[s].rows.map(r => { const D = P.maizeQcDecide(r, S.cfgP), fc = k => { const x = D.fails.find(f => f.param === k); return x ? dcls(x.decision) : ''; };
          return `<tr><td>${esc(C.fmtTime(r.t))}</td>${cols.map(k => `<td class="${fc(k)}">${X.nums.indexOf(k) >= 0 ? esc(fmt(r[k])) : X.flags.indexOf(k) >= 0 ? esc(r[k] ? t(r[k]) : '—') : esc(r[k] || '—')}</td>`).join('')}
            ${s === 'cm_b1' ? `<td>${D.target ? esc((D.target.dev > 0 ? '+' : '') + C.fmtNum(D.target.dev)) : '—'}</td>` : ''}<td><span class="chip ${dcls(D.decision)}">${esc(t('mqd_' + D.decision))}</span></td><td>${mqHoldCell(r, D, s)}</td></tr>`; }).join('')}
        <tr><td><b>${esc(t('mqAvg'))}</b></td>${cols.map(k => `<td><b>${X.nums.indexOf(k) >= 0 ? esc(fmt(Q[s].avg[k])) : ''}</b></td>`).join('')}${s === 'cm_b1' ? '<td></td>' : ''}<td></td><td></td></tr></table></div>`; }).join('');
    const limTxt = k => { const m = LIM[st][k]; if (!m) return ''; const p = []; if (isNum(m.warnLo)) p.push('⚠ < ' + C.fmtNum(m.warnLo)); if (isNum(m.warnHi)) p.push('⚠ > ' + C.fmtNum(m.warnHi)); if (isNum(m.rejLo)) p.push('✖ < ' + C.fmtNum(m.rejLo)); if (isNum(m.rejHi)) p.push('✖ > ' + C.fmtNum(m.rejHi)); return p.join(' · '); };
    const TG = P.b1Target(S.cfgP), tgNote = st === 'cm_b1' ? `<p class="sub">${esc(t('mqB1Target', { v: C.fmtNum(TG.moisture) }))}${TG.tol !== null ? ' ± ' + esc(C.fmtNum(TG.tol)) : ''}</p>` : '';
    const nc = Object.keys(P.MZQC_STAGES).reduce((a, s) => a + Q[s].rows.filter(r => P.maizeQcDecide(r, S.cfgP).decision === 'reject').length, 0);
    const ncBanner = nc ? `<div class="banner b-warn">⚠ ${esc(t('mqNcToday', { n: nc }))}</div>` : '';
    const limNote = Object.keys(LIM[st]).length || D.flags.length ? `<p class="sub">${D.nums.filter(k => LIM[st][k]).map(k => esc(t('mq_' + k)) + ': ' + esc(limTxt(k))).concat(D.flags.map(k => esc(t('mq_' + k)) + ' ' + esc(t('yes')) + ' = ✖')).join('<br>')}</p>` : `<p class="sub">${esc(t('mqRecordOnly'))}</p>`;
    const hf = S.holdForm && S.holdForm.mq ? `<div class="banner b-reject"><b>${esc(t(S.holdForm.release ? 'holdReleaseBtn' : 'holdBtn'))}: ${esc(S.holdForm.binId)}</b></div>` + holdFormHtml(S.holdForm) : '';
    return `<section class="card"><h3>${esc(t('mqTitle'))}</h3>${ncBanner}${hf}
      <div class="seg mode">${Object.keys(P.MZQC_STAGES).map(s => `<button data-pact="mqstage" data-v="${s}" class="${s === st ? 'on ok' : ''}">${esc(t('mqs_' + s))}</button>`).join('')}</div>
      <div class="grid2">${D.ids.map(sel).join('')}${D.nums.map(numF).join('')}${D.flags.map(flag).join('')}</div>
      ${limNote}${tgNote}${C.pinFld('mq_pin')}
      <button class="btn primary" data-pact="mqsave">${esc(t('mqSave'))}</button>
      <h3>${esc(t('mqToday'))} · ${esc(day)}</h3>${tables || '<p class="sub">—</p>'}</section>`;
  }
  // v2.27.0 (Zhax, 27-11-2026): depois do aviso de não conforme, o Supervisor ou acima retém / liberta a bin D/M com o PIN.
  // Só as bins D/M (milho sujo) e de produto podem ser retidas (v2.13.0) — as bins C/M não.
  function mqHoldCell(r, D, s) {
    const id = r.dmBin, H = holds(), h = id && H[id];
    if (!id || !P.holdableBins(S.cfgP).some(b => b.id === id)) return '—';
    if (h) return `<span class="chip d-reject">${esc(id)} ${esc(t('holdOn'))}</span>${S.holdForm ? '' : ` <button class="btn small" data-hold="${esc(id)}" data-release="1" data-mqhold="1">${esc(t('holdReleaseBtn'))}</button>`}`;
    if (D.decision !== 'reject' || S.holdForm) return '—';
    const p = D.fails.filter(f => f.decision === 'reject').map(f => t('mq_' + f.param)).join(', ');
    return `<button class="btn small" data-hold="${esc(id)}" data-mqhold="1" data-suid="${esc(r.uid || '')}" data-reason="${esc(t('mqHoldReason', { s: t('mqs_' + s), p }))}">${esc(t('holdBtn'))} ${esc(id)}</button>`;
  }
  async function saveMaizeQc() {
    const st = S.mqStage && P.MZQC_STAGES[S.mqStage] ? S.mqStage : 'silo_dm', D = P.MZQC_STAGES[st];
    document.querySelectorAll('[data-mq]').forEach(el => { S.mqForm = Object.assign(S.mqForm || {}, { [el.dataset.mq]: el.value }); });   // lê o ecrã (o «change» pode não ter disparado)
    const f = Object.assign({ stage: st }, S.mqForm || {});
    const e = P.validateMaizeQc(f, S.cfgP); if (e.length) return C.toast(t('fixInvalid') + ': ' + e.map(k => t('mq_' + k)).join(', '));
    const w = await whoP('mq_pin'); if (!w) return;
    const tms = now(), rec = Object.assign(base(tms), { kind: 'maizeQc', t: tms, stage: st, by: w.title, byRole: w.role });
    D.ids.forEach(k => { rec[k] = f[k]; });
    D.nums.forEach(k => { const raw = String(f[k] || '').trim(); rec[k] = raw ? P.num(raw) : null; });
    D.flags.forEach(k => { rec[k] = f[k] || null; });
    const dec = P.maizeQcDecide(rec, S.cfgP); rec.decision = dec.decision; rec.fails = dec.fails;
    try { await DB.add('shiftLog', rec); } catch (x) { return C.toast(t('saveFailed')); }
    // v2.27.0 (Zhax, 27-11-2026): não retém a bin — só avisa
    S.mqForm = {}; await reload(); C.toast(dec.decision === 'reject' ? t('mqSavedRej', { p: dec.fails.filter(f => f.decision === 'reject').map(f => t('mq_' + f.param)).join(', ') }) : dec.decision === 'warn' ? t('mqSavedWarn') : t('mqSaved')); keepScroll();
  }
  // ---------- v2.27.0: arranque de reprocessamento (sem limpeza): hora, sacos disponíveis, secção pneumática ----------
  function reprocForm() {
    const f = S.rpForm;
    return `<section class="card"><h3>${esc(t('rpTitle'))}</h3><div class="grid2">
      <label class="fld req">${esc(t('runStart'))}<input type="time" id="rp_time" value="${esc(f.time || hmNow())}"></label>
      <label class="fld req">${esc(t('rpBags'))}<input inputmode="numeric" id="rp_bags" value="${esc(f.bagsAvail || '')}"></label>
      <label class="fld req">${esc(t('rpSection'))}<select id="rp_sec"><option value="">—</option>${P.pneuSections(S.cfgP).map(x => `<option ${f.pneuSection === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label></div>
      ${C.pinFld('rp_pin')}<button class="btn primary big" data-pact="rpsave">${esc(t('rpStartBtn'))}</button> <button class="btn ghost" data-pact="rpcancel">${esc(t('cancel'))}</button></section>`;
  }
  async function saveReproc() {
    const sel = shiftSel(), li = shiftRec('login', sel.day, sel.period);
    if (!li) return C.toast(t('rpNeedLogin'));
    if (P.runState(S.shiftLog, sel.day, sel.period, now() + 24 * 3600000).areas.reproc.on) return C.toast(t('rpAlready'));
    const f = { time: ($('#rp_time') || {}).value || '', bagsAvail: ($('#rp_bags') || {}).value || '', pneuSection: (($('#rp_sec') || {}).value || '').trim() };
    S.rpForm = f;
    const e = P.validateReprocStart(f, S.cfgP); if (e.length) return C.toast(t('fixInvalid') + ': ' + e.map(k => ({ time: t('runStart'), bags: t('rpBags'), section: t('rpSection') })[k]).join(', '));
    const at = P.shiftTimeMs(shiftRange(sel.day, sel.period)[0], sel.period, f.time); if (at === null) return C.toast(t('runTimeNeed', { a: t('ra_reproc') }));
    const w = await whoP('rp_pin'); if (!w) return;
    const tms = now();
    try { await DB.add('shiftLog', Object.assign(base(tms), { kind: 'runState', t: tms, prodDay: sel.day, period: sel.period, shift: sel.day + '/' + sel.period, crew: li.crew, by: w.title,
      area: 'reproc', on: true, at, time: f.time, comment: '', reprocStart: true, bagsAvail: P.num(f.bagsAvail), pneuSection: f.pneuSection })); }
    catch (x) { return C.toast(t('saveFailed')); }
    S.rpForm = null; await reload(); C.toast(t('rpStarted')); keepScroll();
  }
  function viewJobs() {
    const running = (S.jobs || []).filter(j => j.status === 'running').sort((a, b) => a.lineId < b.lineId ? -1 : 1);
    const closed = (S.jobs || []).filter(j => j.status !== 'running').sort((a, b) => b.closedAt - a.closedAt).slice(0, 1);   // v2.27.0 (Zhax, 27-11-2026): só a última fechada; as restantes nos Relatórios
    const sel = shiftSel(), rp = P.runState(S.shiftLog, sel.day, sel.period, now() + 24 * 3600000).areas.reproc;
    const rpLine = rp.on ? `<div class="hold job"><b>${esc(t('rpOn', { h: C.fmtTime(rp.at) }))}</b>${rp.reprocStart ? `<div><small>${esc(t('rpBags'))}: ${esc(String(rp.bagsAvail))} · ${esc(t('rpSection'))}: ${esc(rp.pneuSection || '—')}</small></div>` : ''}</div>` : '';
    return (S.jobForm ? jobFormView() : S.rpForm ? reprocForm() : `<section class="card"><button class="btn primary big" data-pact="newjob">＋ ${esc(t('newJob'))}</button>
        ${rp.on ? '' : `<button class="btn big" data-pact="rpnew">＋ ${esc(t('rpStartBtn'))}</button>`}</section>`) +
      `<section class="card"><h3>${esc(t('jobsRunning'))}</h3>${rpLine}${running.length ? running.map(jobCard).join('') : rpLine ? '' : `<p class="sub">${esc(t('noJobs'))}</p>`}</section>
      <section class="card"><h3>${esc(t('jobsClosed'))}</h3>${closed.length ? closed.map(jobCard).join('') : '<p class="sub">—</p>'}</section>`;
  }
  function allocText(alloc) { return (alloc || []).map(a => esc(a.bin || a.silo) + ' ' + fmtKg(a.kg) + ' kg' + (isNum(a.pct) ? ' (' + esc(C.fmtNum(a.pct)) + ' %)' : '')).join(isNum((alloc || [])[0] && alloc[0].pct) ? ' + ' : ' → '); }
  function jobCard(j) {
    const st = JOB_ST[j.status] ? j.status : 'running';
    const qc = j.status === 'running' ? qcForJob(j) : '';
    const closing = S.closeJob === j.uid;
    return `<div class="hold job">
      <div class="row between"><b>${esc(C.lineName(j.lineId))} · ${esc(prodNames(j))}</b><span class="status ${STATUS_CLS[st]}">${esc(t('js_' + st))}</span></div>
      <small>${esc(t('startedBy', { d: C.fmtDT(j.startedAt), by: j.leader, crew: j.crew || '—' }))}${j.closedAt ? ' · ' + esc(t('closedBy', { d: C.fmtDT(j.closedAt), by: j.closedBy })) : ''}</small>
      <div class="kv"><span>${esc(t('grainToMill'))}</span><b>${fmtKg(j.grainKg)} kg</b></div>
      <div class="kv"><span>${esc(t('fromBins'))}${j.mode === 'blend' ? ' · ' + esc(t('mode_blend')) : ''}</span><b>${allocText(j.alloc)}</b></div>
      ${j.sourceComps ? `<div><small>${esc(Object.keys(j.sourceComps).map(k => k + ': ' + compText(j.sourceComps[k])).join(' · '))}</small></div>` : ''}
      ${j.recipe && P.recipeSet(j.recipe) ? `<div class="kv"><span>${esc(t('jobRecipe'))}</span><b>${esc(j.recipe.colours.join('/'))} · ${esc(j.recipe.grades.map(g => t('g_' + g)).join('/'))}</b></div>` : ''}
      ${j.offRecipeAuth ? `<div class="banner b-warn"><small>${esc(t('authOnJob', { s: (j.offRecipe || []).map(x => x.bin || x.silo).join(', '), by: j.offRecipeAuth.by, r: j.offRecipeAuth.reason }))}</small></div>`
        : (j.offRecipe || []).length ? `<div class="banner b-warn"><small>${esc(t('offRecipeOnJob', { s: j.offRecipe.map(x => x.bin || x.silo).join(', ') }))}</small></div>` : ''}
      <div class="kv"><span>${esc(t('temperedBin'))}</span><b>${esc((j.tempered || []).join(', ') || '—')}</b></div>
      <div class="kv"><span>${esc(t('toBins'))}</span><b>${esc((j.bins || []).join(', '))}</b></div>
      ${(j.switchLog || []).length ? `<div class="dec d-record"><b>${esc(t('switchesTitle'))}</b>${j.switchLog.map(x => `<div class="li">• ${esc(x.kind === 'feed' ? t('feedSwitchLine', { bin: x.bin, from: x.from, to: x.to }) : t('productSwitchLine', { from: x.from, to: x.to }))}</div>`).join('')}</div>` : ''}
      <div class="kv"><span>${esc(t('moistureFromTo'))}</span><b>${esc(C.fmtNum(j.m0))} → ${esc(C.fmtNum(j.m1))} % · ${esc(t('impurities'))} ${esc(C.fmtNum(j.impurities))} %</b></div>
      <div class="kv"><span>${esc(t('water'))}</span><b>${fmtKg(j.waterLh)} L/h · ${esc(t('total'))} ${fmtKg(j.waterL)} L</b></div>
      <div class="kv"><span>${esc(t('waterAdded'))}</span><b>${isNum(j.waterAddedL) ? fmtKg(j.waterAddedL) + ' L' : '—'}</b></div>
      ${P.jobOutputs(j).map(o => `<div class="kv"><span>${esc(t('expectedProduct'))}${P.jobOutputs(j).length > 1 ? ' · ' + esc(C.prodName(o.productId)) : ''}</span><b>${isNum(o.expectedKg) ? fmtKg(o.expectedKg) + ' kg (' + esc(C.fmtNum(o.extraction)) + ' %)' : esc(t('extractionNotSet'))}${P.jobOutputs(j).length > 1 ? ' → ' + esc((o.bins || []).join(', ')) : ''}</b></div>`).join('')}
      ${j.status === 'done' && isNum(j.actualKg) ? `<div class="kv"><span>${esc(t('actualGrain'))}</span><b>${fmtKg(j.actualKg)} kg</b></div>` : ''}
      ${j.closeNote ? `<p><small>${esc(j.closeNote)}</small></p>` : ''}
      ${(j.startWarnings || []).length ? `<div class="dec d-warn"><b>${esc(t('jobWarnTitle'))}</b>${j.startWarnings.map(w => `<div class="li">• ${esc(w.text)}</div>`).join('')}</div>` : ''}
      ${readingsBlock(j)}
      ${qc}
      ${j.status === 'running' && !closing ? `<div class="row"><button class="btn small" data-closejob="${esc(j.uid)}" data-stop="1">⏹ ${esc(t('stopLineReport'))}</button><button class="btn ghost small" data-closejob="${esc(j.uid)}">${esc(t('closeJob'))}</button></div>` : ''}
      ${closing ? `<div class="holdform">
        <label class="fld">${esc(t('closeAs'))}<select id="cj_status"><option value="done">${esc(t('js_done'))}</option><option value="cancelled">${esc(t('js_cancelled'))}</option></select></label>
        <label class="fld">${esc(t('actualGrain'))} (kg) <small>${esc(t('optional'))}</small><input inputmode="decimal" id="cj_kg"></label>
        ${binKgInputs(j.bins || [], S.closeBinKg || {}, 'cbk', t('binKgEnd'))}
        ${C.pinFld('cj_pin')}
        <label class="fld">${esc(t('notes'))}<textarea id="cj_note" rows="2"></textarea></label>
        ${S.closeStop ? `` : ''}<button class="btn primary" data-pact="closejob">${esc(S.closeStop ? t('stopLineReport') : t('closeJob'))}</button> <button class="btn ghost" data-pact="cancelclose">${esc(t('cancel'))}</button>
      </div>` : ''}
    </div>`;
  }
  // Humidade do milho por turno: histórico + registo do turno actual
  function readingsBlock(j) {
    const rs = (j.readings || []).slice().sort((a, b) => a.t - b.t);
    const need = P.needsShiftReading(j, L.shiftOf(now()).start);
    const last = rs[rs.length - 1];
    const prev = S.readForm && S.readForm.uid === j.uid ? P.readingCalc(j, S.readForm.m0, S.cfgP) : null;
    return `<div class="due"><div class="sub">${esc(t('maizeMoisture'))}</div>
      ${need ? `<div class="banner b-warn">${esc(t('needReading'))}</div>` : ''}
      ${rs.map(r => `<div class="kv"><span>${esc(C.fmtDT(r.t))} · ${esc(t('crew'))} ${esc(r.crew || '—')}${r.kind === 'start' ? ' · ' + esc(t('atStart')) : ''}${r.kind === 'lab' ? ' · ' + esc(t('waLab')) : ''}</span><b class="${r.over ? 'txt-reject' : ''}">${isNum(r.m0) ? esc(C.fmtNum(r.m0)) + ' % → ' + fmtKg(r.waterLh) + ' L/h' : ''}${isNum(r.mTempered) ? (isNum(r.m0) ? ' · ' : '') + esc(t('waWet')) + ' ' + esc(C.fmtNum(r.mTempered)) + ' %' : ''}</b></div>`).join('')}
      ${j.status === 'running' ? `<div class="grid2"><label class="fld">${esc(t('m0Now'))} (%)<input inputmode="decimal" data-rd="${esc(j.uid)}" value="${esc(S.readForm && S.readForm.uid === j.uid ? S.readForm.m0 : '')}"></label>
        ${C.pinFld('rd_pin_' + j.uid)}</div>
        <div id="rdc_${esc(j.uid)}">${readPreview(j, prev)}</div>
        <button class="btn small" data-pact="savereading" data-uid="${esc(j.uid)}">${esc(t('saveReading'))}</button>` : (last ? '' : '')}</div>`;
  }
  function readPreview(j, c) {
    if (!c) return '';
    if (c.error) return `<small class="txt-reject">${esc(t('invalid'))}</small>`;
    return `<small class="${c.over ? 'txt-reject' : ''}">${esc(t('newWaterRate', { lh: fmtKg(c.waterLh), m1: C.fmtNum(j.m1), max: fmtKg(c.max) }))}${c.over ? ' — ' + esc(t('overDampener')) : ''}${c.noWater ? ' — ' + esc(t('jw_no_water')) : ''}</small>`;
  }
  async function saveReading(uid) {
    const j = S.jobs.find(x => x.uid === uid);
    if (!j || j.status !== 'running') return;
    const c = P.readingCalc(j, S.readForm && S.readForm.uid === uid ? S.readForm.m0 : '', S.cfgP);
    if (c.error) return C.toast(t('fixInvalid'));
    const w = await C.who((document.getElementById('rd_pin_' + uid) || {}).value); if (w.err) return C.toast(w.err); const by = w.title;
    const tms = now(), sh = L.shiftOf(tms);
    const rd = { uid: newUid(), deviceId: S.deviceId, createdAt: new Date(now()).toISOString(), t: tms, crew: L.crewOfTime(tms), period: sh.period, prodDay: sh.day, m0: c.m0, waterLh: c.waterLh, over: c.over, by: by.trim(), kind: 'shift' };
    try { await DB.put('jobs', Object.assign({}, j, { readings: (j.readings || []).concat([rd]) })); } catch (e) { return C.toast(t('saveFailed')); }
    S.readForm = null; S.operator = rd.by; await DB.setConfig('operator', S.operator);
    await reload(); C.toast(c.over ? t('overDampener') : t('readingSaved', { lh: fmtKg(c.waterLh) })); keepScroll();
  }

  // Alertas do CQ para a linha desde o início da ordem (o CQ só envia alertas para a produção)
  function qcForJob(j) {
    const status = C.lineStatus(j.lineId);
    const cls = { hold: 'd-reject', warn: 'd-warn', ok: 'd-accept', stopped: 'd-record', nodata: 'd-record' }[status] || 'd-record';
    const from = j.startedAt - j.startedAt % 60000;   // hora das amostras só tem minutos
    const al = L.effective(S.samples).filter(s => s.lineId === j.lineId && s.t >= from && (s.decision === 'warn' || s.decision === 'reject'))
      .sort((a, b) => b.t - a.t).slice(0, 3);
    return `<div class="due"><div class="sub">${esc(t('qcAlerts'))} <span class="chip ${cls}">${esc(t('st_' + status))}</span></div>
      ${al.map(s => `<div class="${C.decCls(s.decision)} pad"><small>${esc(C.fmtTime(s.t))} · ${esc(C.prodName(s.productId))} · ${esc(s.failures.map(f => C.anyLabel(f.param, C.product(s.productId)) + ' ' + (f.value === 'abn' ? t('abnormal') : C.fmtNum(f.value))).join(', '))} → ${esc(C.decLabel(s.decision))}</small></div>`).join('') || `<small class="sub">${esc(t('noQcAlerts'))}</small>`}</div>`;
  }

  // ----- formulário da ordem -----
  function newJobForm() {
    const line = S.cfg.lines.find(l => !runningJob(l.id));
    S.jobForm = { lineId: line ? line.id : '', mode: 'seq', sources: [], blend: {}, tempered: [], m0: '', impurities: '', m1: '', feedKgh: '',
      outputs: [newOutput()], recipe: { colours: [], grades: [] }, leader: defLeader(), feedQueue: {}, startTime: C.localInput(now()) };
  }
  const prodNames = j => P.jobProducts(j).map(C.prodName).join(' + ') || '—';
  const newOutput = () => ({ productId: '', targetKg: '', targetExtraction: '', bins: [] });
  // Bloco de um produto da ordem (v1.5.0): produto, extracção alvo e silos de produto
  function outputBlock(f, o, i, lineBins) {
    const n = f.outputs.length;
    const taken = {}; f.outputs.forEach((x, k) => { if (k !== i) x.bins.forEach(b => { taken[b] = x.productId || '?'; }); });
    const binRows = lineBins.map(b => {
      const st = P.binState(b.id, S.binEvents);
      const on = o.bins.indexOf(b.id) >= 0, other = taken[b.id];
      const clash = st.productId && o.productId && st.productId !== o.productId;
      const lv = levelOf(b.id), full = lv && (lv.state === 'FULL' || lv.state === 'OVER');
      const lvTxt = lv && isNum(lv.kg) ? ' · ' + fmtKg(lv.kg) + ' kg (' + String(lv.pct).replace('.', ',') + ' %) · ' + t('stockFree') + ' ' + fmtKg(lv.freeKg) + ' kg' : (isNum(b.capKg) ? ' · ' + fmtKg(b.capKg) + ' kg' : '');
      const held = !!holds()[b.id];   // v2.13.0: bin retida pelo CQ
      return `<button class="pick ${on ? 'on' : ''}${other || full || held ? ' dim' : ''}" data-jobin="${i}|${esc(b.id)}"><b>${esc(b.id)}</b><small>${esc(t('fedBy'))} ${esc(b.lines.join('/'))}${lvTxt}</small>${held ? `<span class="chip d-reject">${esc(t('holdOn'))}</span>` : ''}${full ? `<span class="chip d-reject">${esc(t('stockFull'))}</span>` : ''}
        ${other ? `<span class="chip d-record">${esc(t('binTakenBy', { p: other === '?' ? t('productN', { n: f.outputs.findIndex(x => x.bins.indexOf(b.id) >= 0) + 1 }) : C.prodName(other) }))}</span>`
          : `<span class="chip ${clash ? 'd-reject' : st.productId ? 'd-warn' : 'd-accept'}">${esc(st.productId ? C.prodName(st.productId) : t('binEmpty'))}</span>`}</button>`;
    }).join('');
    // v1.8.0: só o produto principal (i = 0) tem extracção; os restantes têm só quantidade
    const main = i === 0;
    return `<div class="param out">
      <div class="row between"><b>${esc(main ? t('mainProduct') : t('productN', { n: i + 1 }))}</b>${n > 1 ? `<button class="btn ghost small" data-joutdel="${i}">${esc(t('remove'))}</button>` : ''}</div>
      <div class="grid2">
        <label class="fld req">${esc(t('product'))}<select data-jo="${i}|productId"><option value="">—</option>${C.products().map(p => `<option value="${esc(p.id)}" ${o.productId === p.id ? 'selected' : ''}>${esc(C.prodName(p.id))}</option>`).join('')}</select></label>
        <label class="fld req">${esc(t('targetKg'))}<input inputmode="decimal" data-joi="${i}|targetKg" value="${esc(o.targetKg)}"></label>
        ${main ? `<label class="fld req">${esc(t('extraction'))} (%)<input inputmode="decimal" data-joi="${i}|targetExtraction" value="${esc(o.targetExtraction)}"></label>` : ''}
      </div>
      <div class="sub req">${esc(t('toBins'))}</div>${f.lineId ? '' : `<p class="sub">${esc(t('pickLineFirst'))}</p>`}<div class="picks">${binRows}</div>${nextBinsHtml(f, i)}</div>`;
  }
  // Próximas bins da fila para o produto i (com espaço, da linha, vazias ou com o mesmo produto): junta com um toque
  function nextBinsHtml(f, i) {
    if (!f.lineId || !f.outputs[i] || !f.outputs[i].productId) return '';
    const r = P.validateJob(f, ctxFor()), o = (r.calc.outputs || [])[i];
    if (!o || !o.nextBins || !o.nextBins.length) return '';
    const short = r.errors.some(e => (e.code === 'bin_capacity' || e.code === 'bin_full') && (!e.productId || e.productId === f.outputs[i].productId));
    return `<div class="sub ${short ? 'txt-reject' : ''}">${esc(t('nextBinsTitle'))}</div><div class="row">${o.nextBins.slice(0, 4).map(x =>
      `<button class="btn ghost small" data-jobin="${i}|${esc(x.bin)}">＋ ${esc(x.bin)}${isNum(x.freeKg) ? ' · ' + fmtKg(x.freeKg) + ' kg' : ''}</button>`).join('')}</div>`;
  }
  const holds = () => P.binHolds(S.prodChanges);
  const ctxFor = () => ({ cfgP: S.cfgP, millType: S.cfg.millType, moves: S.moves, jobs: S.jobs, binEvents: S.binEvents, stocks: S.stocks, snapshot: snapshot(), now: now(), shiftStart: L.shiftOf(now()).start, holds: holds() });
  const levelOf = id => P.binLevel(id, ctxFor());
  function jobFormView() {
    const f = S.jobForm;
    const recipe = f.recipe;
    const tphDef = f.lineId ? P.defaultFeedKgh(S.cfgP, f.lineId) : null;
    const srcRows = (S.cfgP.dirtyBins || []).filter(b => !f.lineId || b.lines.indexOf(f.lineId) >= 0).map(b => {
      const idx = f.sources.indexOf(b.id);
      const st = dirtyState(b.id);
      const bad = P.recipeSet(recipe) ? st.comps.map(c => P.recipeFit(recipe, c, S.cfg.millType)).filter(x => !x.ok) : [];
      const hard = bad.find(x => x.why !== 'colour' && x.why !== 'grade');
      const chip = st.kg <= 0 ? '' : !P.recipeSet(recipe) ? `<span class="chip d-record">${esc(t('recipeFirst'))}</span>`
        : hard ? `<span class="chip d-reject">${esc(t('why_' + hard.why))}</span>`
        : bad.length ? `<span class="chip d-warn">${esc(t('why_' + bad[0].why))}</span>` : `<span class="chip d-accept">${esc(t('compatible'))}</span>`;
      return `<button class="pick ${idx >= 0 ? 'on' : ''}${holds()[b.id] ? ' dim' : ''}" data-jsrc="${esc(b.id)}">${idx >= 0 ? `<i class="ord">${idx + 1}</i>` : ''}<b>${esc(b.id)}</b>
        <small>${st.kg > 0 ? fmtKg(st.kg) + ' kg · ' + esc(compText(st.comps)) : esc(t('binEmpty'))}</small>${holds()[b.id] ? `<span class="chip d-reject">${esc(t('holdOn'))}</span>` : chip}</button>`;
    }).join('');
    const tempRows = (S.cfgP.temperedBins || []).filter(b => !f.lineId || b.lines.indexOf(f.lineId) >= 0).map(b =>
      `<button class="pick ${f.tempered.indexOf(b.id) >= 0 ? 'on' : ''}" data-jtemp="${esc(b.id)}"><b>${esc(b.id)}</b><small>${esc(t('fedBy'))} ${esc(b.lines.join('/'))}${isNum(b.capKg) ? ' · ' + fmtKg(b.capKg) + ' kg' : ''}</small></button>`).join('');
    const lineBins = S.cfgP.bins.filter(b => !f.lineId || b.lines.indexOf(f.lineId) >= 0);
    return `<section class="card"><h2>${esc(t('newJob'))}</h2>
      <div class="grid2">
        <label class="fld req">${esc(t('line'))}<select data-jf="lineId"><option value="">—</option>${S.cfg.lines.map(l => `<option value="${esc(l.id)}" ${f.lineId === l.id ? 'selected' : ''}>${esc(l.name)}${runningJob(l.id) ? ' (' + esc(t('busy')) + ')' : ''}</option>`).join('')}</select></label>
        <label class="fld">${esc(t('feedRate'))} (kg/h)<input inputmode="decimal" data-jfi="feedKgh" value="${esc(f.feedKgh)}" placeholder="${esc(tphDef ? C.fmtNum(Math.round(tphDef * 100) / 100) : '')}"></label>
      </div>
      
    </section>
    <section class="card"><h3>${esc(t('jobProducts'))}</h3>
      ${f.outputs.map((o, i) => outputBlock(f, o, i, lineBins)).join('')}
      <button class="btn small" data-pact="addoutput">＋ ${esc(t('addProduct'))}</button>
      
      </section>
    <section class="card"><h3>${esc(t('jobRecipe'))}</h3>
      <div class="sub req">${esc(t('recipeColours'))}</div><div class="picks">${P.COLOURS.map(c => `<button class="pick ${recipe.colours.indexOf(c) >= 0 ? 'on' : ''}" data-jrc="${esc(c)}"><b>${esc(c)}</b></button>`).join('')}</div>
      <div class="sub req">${esc(t('recipeGrades'))}</div><div class="picks">${P.SILO_GRADES.map(g => `<button class="pick ${recipe.grades.indexOf(g) >= 0 ? 'on' : ''}" data-jrg="${esc(g)}"><b>${esc(t('g_' + g))}</b></button>`).join('')}</div>
      </section>
    <section class="card"><h3>${esc(t('rawMaterial'))}</h3>
      <div class="seg mode"><button data-jmode="seq" class="${f.mode !== 'blend' ? 'on ok' : ''}">${esc(t('mode_seq'))}</button><button data-jmode="blend" class="${f.mode === 'blend' ? 'on ok' : ''}">${esc(t('mode_blend'))}</button></div>
      <p class="sub">${esc(t(f.mode === 'blend' ? 'binsBlend' : 'binsOrder'))}</p>${f.lineId ? '' : `<p class="sub">${esc(t('pickLineFirst'))}</p>`}<div class="picks">${srcRows}</div>
      ${f.mode === 'blend' && f.sources.length ? blendTable(f) + feedQueueHtml(f) : ''}
      <h3>${esc(t('temperedBin'))}</h3><div class="picks">${tempRows}</div></section>
    <section class="card"><h3>${esc(t('grainSpecs'))}</h3>
      <div class="grid3">
        ${f.mode === 'blend' ? '' : `<label class="fld req">${esc(t('m0'))} (%)<input inputmode="decimal" data-jfi="m0" value="${esc(f.m0)}"></label>
        <label class="fld req">${esc(t('impurities'))} (%)<input inputmode="decimal" data-jfi="impurities" value="${esc(f.impurities)}"></label>`}
        <label class="fld req">${esc(t('m1'))} (%)<input inputmode="decimal" data-jfi="m1" value="${esc(f.m1)}"></label>
      </div>
      ${f.mode === 'blend' ? `` : ''}
      
      <label class="fld">${esc(t('waterAdded'))} (L)<input inputmode="decimal" data-jfi="waterAddedL" value="${esc(f.waterAddedL || '')}"></label>
      </section>
    <section class="card">
      <label class="fld req">${esc(t('jobStartTime'))}<input type="datetime-local" id="jf_start" value="${esc(f.startTime || '')}"></label>
      ${C.pinFld('jf_pin')}
      ${!P.leaderNames(S.cfgP).length ? `<p class="sub">${esc(t('leadersNotSet'))}</p>` : ''}
      ${binKgInputs(jobFormBins(f), f.binKg || {}, 'jbk', t('binKgStart'))}
      <div id="jobCheck">${jobCheckHtml()}</div>
      <button class="btn primary big" data-pact="startjob">${esc(t('startJob'))}</button>
      <button class="btn ghost" data-pact="canceljob">${esc(t('cancel'))}</button></section>`;
  }
  // v2.13.0: quantidade nas bins de produto (arranque e fecho da ordem); obrigatória, 0 = vazia
  const jobFormBins = f => Array.from(new Set((f.outputs || []).reduce((a, o) => a.concat(o.bins || []), [])));
  const binKgInputs = (bins, vals, attr, title) => !bins.length ? '' : `<h4>${esc(title)}</h4><div class="grid2">${bins.map(id => {
      const lv = levelOf(id), cap = (S.cfgP.bins.find(b => b.id === id) || {}).capKg;
      return `<label class="fld req">${esc(id)} (kg)${isNum(cap) ? ' <small>≤ ' + fmtKg(cap) + ' kg</small>' : ''}<input inputmode="decimal" data-${attr}="${esc(id)}" value="${esc(vals[id] || '')}" placeholder="${lv && isNum(lv.kg) ? esc(String(lv.kg)) : ''}"></label>`; }).join('')}</div>`;
  const binKgRec = (values, job, method, tms) => Object.assign(base(tms), { t: tms, prodDay: L.prodDay(tms), by: job.leader || S.operator, method, jobUid: job.uid,
    levels: Object.keys(values).reduce((o, id) => { const cap = (S.cfgP.bins.find(b => b.id === id) || {}).capKg; o[id] = { kg: values[id], productId: values[id] > 0 ? (P.jobOutputs(job).find(x => (x.bins || []).indexOf(id) >= 0) || {}).productId || null : null, kind: 'product', capKg: isNum(cap) ? cap : null, method }; return o; }, {}) });
  // ---- fila de alimentação (v1.6.0): silos de milho → silos de milho sujo; silos de produto ----
  const CEREAL_OF = { maize: 'Milho', wheat: 'Trigo', rice: 'Arroz' };
  function feedSilos() {
    const snap = snapshot();
    if (!snap) return [];
    return snap.silos.filter(s => (S.cfgP.grainSilos || []).indexOf(s.id) >= 0 && s.cereal === CEREAL_OF[S.cfg.millType])
      .map(s => ({ id: s.id, free: P.availableKg(snap, S.moves, s.id) || 0 }));
  }
  function feedQueueHtml(f) {
    const silos = feedSilos();
    const rows = f.sources.map(id => {
      const q = (f.feedQueue || {})[id] || [];
      const chips = silos.map(s => {
        const idx = q.indexOf(s.id);
        return `<button class="pick ${idx >= 0 ? 'on' : ''}" data-jfq="${esc(id)}|${esc(s.id)}">${idx >= 0 ? `<i class="ord">${idx + 1}</i>` : ''}<b>${esc(s.id)}</b><small>${fmtKg(s.free)} kg</small></button>`;
      }).join('');
      return `<div class="sub"><b>${esc(id)}</b> · ${esc(t('feedQueueFor'))}</div><div class="picks">${chips || `<small>${esc(t('noFeedSilos'))}</small>`}</div>`;
    }).join('');
    return `<div class="sub req">${esc(t('feedQueueTitle'))}</div>${snapshot() ? rows : `<p class="sub">${esc(t('snapNone'))}</p>`}`;
  }
  // silos de produto vazios e livres para esta ordem (opções quando a capacidade não chega)
  function productBinOptions(f) {
    const used = {}; f.outputs.forEach(o => (o.bins || []).forEach(id => { used[id] = true; }));
    const pid = f.outputs[0] ? f.outputs[0].productId : '';
    return S.cfgP.bins.filter(b => !used[b.id] && (!f.lineId || b.lines.indexOf(f.lineId) >= 0) && isNum(b.capKg)
      && (() => { const r = P.binCheck(b, pid, f.lineId, S.binEvents); return r.ok && !r.current; })())
      .map(b => `${b.id} (${fmtKg(b.capKg)} kg)`);
  }
  function jobOptionsHtml(f, r) {
    const lines = [];
    r.errors.filter(e => e.code === 'feed_short').forEach(e => {
      const q = (f.feedQueue || {})[e.bin] || [];
      const opts = feedSilos().filter(s => s.free > 0 && q.indexOf(s.id) < 0).map(s => `${s.id} (${fmtKg(s.free)} kg)`);
      lines.push(t('optSilos', { bin: e.bin, list: opts.join(', ') || '—' }));
    });
    if (r.errors.some(e => e.code === 'bin_capacity')) lines.push(t('optProductBins', { list: productBinOptions(f).join(', ') || '—' }));
    const logs = [];
    (r.calc.feedPlan || []).forEach(p => {
      (p.switches || []).forEach(s => logs.push(t('feedSwitchLine', { bin: p.bin, from: s.from, to: s.to })));
      (p.empties || []).forEach(id => logs.push(t('feedEmptyLine', { silo: id })));
    });
    (r.calc.outputs || []).forEach(o => (o.binSwitches || []).forEach(s => logs.push(t('productSwitchLine', { from: s.from, to: s.to }))));
    return `${lines.length ? `<div class="dec d-warn">${lines.map(x => `<div class="li">• ${esc(x)}</div>`).join('')}</div>` : ''}
      ${logs.length ? `<div class="dec d-record"><b>${esc(t('switchesTitle'))}</b>${logs.map(x => `<div class="li">• ${esc(x)}</div>`).join('')}</div>` : ''}`;
  }
  function blendTable(f) {
    return `<div class="tablewrap"><table class="blend"><thead><tr><th>${esc(t('silo'))}</th><th>%</th><th>${esc(t('m0'))} %</th><th>${esc(t('impurities'))} %</th></tr></thead><tbody>
      ${f.sources.map(id => { const b = f.blend[id] || {}; return `<tr><td><b>${esc(id)}</b></td>
        <td><input inputmode="decimal" data-jbl="${esc(id)}|pct" value="${esc(b.pct || '')}"></td>
        <td><input inputmode="decimal" data-jbl="${esc(id)}|m0" value="${esc(b.m0 || '')}"></td>
        <td><input inputmode="decimal" data-jbl="${esc(id)}|impurities" value="${esc(b.impurities || '')}"></td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function errText(e) {
    const s = errText0(e);
    return e.productId ? C.prodName(e.productId) + ': ' + s : s;
  }
  function errText0(e) {
    const v = Object.assign({}, e);
    if (e.field) v.field = t('f_' + e.field);
    if (e.current) v.current = C.prodName(e.current);
    if (isNum(e.short)) v.short = fmtKg(e.short);
    if (isNum(e.need)) v.need = fmtKg(e.need);
    if (isNum(e.cap)) v.cap = fmtKg(e.cap);
    if (isNum(e.max)) v.max = fmtKg(e.max);
    if (e.code === 'source_incompatible') return t('je_source_incompatible', { bin: e.bin, why: t('why_' + e.why) });
    return t('je_' + e.code, v);
  }
  // v2.6.0: problemas de operação (soft) usam o texto je_; os restantes avisos o texto jw_
  const warnText = w => w.soft ? errText(w) : t('jw_' + w.code, w);
  function jobCheckHtml() {
    const r = P.validateJob(S.jobForm, ctxFor());
    const c = r.calc;
    const rows = [];
    if (S.jobForm.mode === 'blend' && isNum(c.m0)) rows.push(`<div class="kv"><span>${esc(t('blendM0'))}</span><b>${esc(C.fmtNum(c.m0))} % · ${esc(t('impurities'))} ${esc(C.fmtNum(c.impurities))} %</b></div>`);
    if (isNum(c.waterL)) rows.push(`<div class="kv"><span>${esc(t('waterTotal'))}</span><b>${fmtKg(c.waterL)} L</b></div>`);
    if (isNum(c.waterLh)) rows.push(`<div class="kv"><span>${esc(t('waterRate'))}</span><b class="${isNum(c.dampenerMaxLh) && c.waterLh > c.dampenerMaxLh ? 'txt-reject' : ''}">${fmtKg(c.waterLh)} L/h <small>(${esc(t('max'))} ${fmtKg(c.dampenerMaxLh)})</small></b></div>`);
    if (isNum(c.hours)) rows.push(`<div class="kv"><span>${esc(t('duration'))}</span><b>${esc(C.fmtNum(c.hours))} h @ ${esc(C.fmtNum(c.feedKgh))} kg/h</b></div>`);
    if (isNum(c.grainKg)) rows.push(`<div class="kv"><span>${esc(t('grainRequired'))}</span><b>${fmtKg(c.grainKg)} kg <small>(${esc(t('mainProduct'))} ${esc(C.fmtNum(c.extraction))} %)</small></b></div>`);
    (c.outputs || []).forEach((o, i) => { if (o.productId && isNum(o.expectedKg)) rows.push(`<div class="kv"><span>${esc(C.prodName(o.productId))}</span><b>${fmtKg(o.expectedKg)} kg${i === 0 && isNum(o.extraction) ? ' (' + esc(C.fmtNum(o.extraction)) + ' %)' : ''} → ${esc(o.bins.join(', ') || '—')}</b></div>`); });
    if (isNum(c.expectedKg) && (c.outputs || []).length > 1) rows.push(`<div class="kv"><span>${esc(t('expectedProduct'))} · ${esc(t('total'))}</span><b>${fmtKg(c.expectedKg)} kg</b></div>`);
    if (c.alloc && c.alloc.length) rows.push(`<div class="kv"><span>${esc(t('fromBins'))}</span><b>${allocText(c.alloc)}</b></div>`);
    return `${rows.join('')}
      ${r.errors.length ? `<div class="dec d-reject"><b>${esc(t('jobBlocked'))}</b>${r.errors.map(e => `<div class="li">• ${esc(errText(e))}</div>`).join('')}</div>` : `<div class="dec d-accept"><b>${esc(t('jobOk'))}</b></div>`}
      ${r.warnings.length ? `<div class="dec d-warn"><b>${esc(t('jobWarnTitle'))}</b>${r.warnings.map(w => `<div class="li">• ${esc(warnText(w))}</div>`).join('')}</div>` : ''}
      ${jobOptionsHtml(S.jobForm, r)}`;
  }
  async function startJob() {
    const f = S.jobForm;
    { const w = await whoP('jf_pin'); if (!w) return; f.leader = w.title; f.leaderRole = w.role; }
    const r = P.validateJob(f, ctxFor());
    if (r.errors.length) { keepScroll(); return C.toast(t('jobBlocked')); }
    const bk = P.readBinKg(jobFormBins(f), f.binKg);
    if (bk.bad.length) return C.toast(t('binKgNeed') + ': ' + bk.bad.join(', '));
    // v2.7.0: hora de arranque registada (pode ser anterior à gravação, até 24 h)
    const st0 = $('#jf_start') ? new Date($('#jf_start').value).getTime() : now();
    if (!isFinite(st0) || st0 > now() + 5 * 60000 || st0 < now() - 24 * 3600000) return C.toast(t('badStartTime'));
    const tms = st0;
    // produtos da ordem: extracção (número e texto tal como escrito), produto esperado, silos
    const outs = r.calc.outputs.map((o, i) => Object.assign({}, o, { extractionRaw: String(f.outputs[i].targetExtraction) }));
    // v2.10.0: água realmente adicionada (L), escrita pelo chefe de turno; vazio = não registada (nunca estimada)
    const wa = String(f.waterAddedL || '').trim() === '' ? null : P.num(f.waterAddedL);
    if (wa !== null && (isNaN(wa) || wa < 0)) return C.toast(t('fixInvalid') + ': ' + t('waterAdded'));
    const sourceComps = {};
    f.sources.forEach(id => { sourceComps[id] = dirtyState(id).comps; });   // conteúdo de cada silo de moagem no arranque (rastreabilidade)
    const job = Object.assign(base(tms), {
      status: 'running', startedAt: tms, millType: S.cfg.millType, productId: outs[0].productId, lineId: f.lineId,
      grainKg: r.values.grainKg, mode: f.mode === 'blend' ? 'blend' : 'seq', sources: f.sources.slice(), sourceComps, alloc: r.calc.alloc,
      tempered: f.tempered.slice(), bins: [].concat(...outs.map(o => o.bins)), outputs: outs,
      blendInputs: f.mode === 'blend' ? JSON.parse(JSON.stringify(f.blend)) : null,
      offRecipe: r.calc.offRecipe,
      m0: r.values.m0, m1: r.values.m1, impurities: r.values.impurities, feedKgh: r.calc.feedKgh,
      waterL: r.calc.waterL, waterLh: r.calc.waterLh, waterAddedL: wa, binKgStart: bk.values, expectedKg: isNum(r.calc.expectedKg) ? r.calc.expectedKg : null,
      extraction: r.calc.extraction, dampenerMaxLh: P.dampenerMax(S.cfgP, f.lineId),
      recipe: { colours: f.recipe.colours.slice(), grades: f.recipe.grades.slice(), source: 'job' },
      warnings: r.warnings.map(w => w.code + (w.bin ? ':' + w.bin : '') + (w.productId ? '@' + w.productId : '')),
      startWarnings: r.warnings.filter(w => w.soft).map(w => ({ code: w.code, text: warnText(w) })),   // v2.6.0: a ordem arranca; os avisos ficam registados
      leader: String(f.leader).trim(), leaderCrew: crewOfRole(f.leaderRole, L.shiftOf(now()).day, L.shiftOf(now()).period)
    });
    job.readings = [{ uid: newUid(), deviceId: S.deviceId, createdAt: new Date(now()).toISOString(), t: tms, crew: L.crewOfTime(tms), period: job.period, prodDay: job.prodDay, m0: job.m0, waterLh: job.waterLh, by: job.leader, kind: 'start' }];
    // fila de alimentação: transferências silo → silo de milho sujo, gravadas com a ordem (atómico com a ordem)
    const feedMoves = (feedAuto() ? [] : (r.calc.feedPlan || [])).filter(p => p.parts.length).map(p => {   // v2.8.0: depois da passagem a Grain-Mgt regista as descargas
      const sn = snapshot();
      const partsFull = p.parts.map(x => { const s = sn.silos.find(z => z.id === x.silo); return { silo: x.silo, kg: x.kg, cereal: s.cereal, colour: s.colour, grade: s.grade }; });
      const kg = Math.round(partsFull.reduce((a, x) => a + x.kg, 0) * 1000) / 1000;
      return Object.assign(base(tms), { type: 'TRANSFER', binId: p.bin, t: tms, kg, parts: partsFull, snapshotUid: sn.uid, warnings: ['feed_queue_job'], by: String(f.leader).trim(), feedForJob: true });
    });
    job.feedPlan = (r.calc.feedPlan || []).map(p => ({ bin: p.bin, parts: p.parts, switches: p.switches, empties: p.empties }));
    job.switchLog = [];
    (r.calc.feedPlan || []).forEach(p => (p.switches || []).forEach(s => job.switchLog.push({ t: tms, kind: 'feed', bin: p.bin, from: s.from, to: s.to })));
    outs.forEach(o => (o.binSwitches || []).forEach(s => job.switchLog.push({ t: tms, kind: 'product', productId: o.productId, from: s.from, to: s.to })));
    let seq = 0;
    const ops = feedMoves.map(m => ({ store: 'grainMoves', op: 'add', obj: m })).concat([{ store: 'jobs', op: 'add', obj: job }]).concat(...outs.map(o => o.bins.map(b => ({ store: 'binEvents', op: 'add',
      obj: Object.assign(base(tms), { binId: b, type: 'FILL', productId: o.productId, jobUid: job.uid, lineId: f.lineId, t: tms, seq: seq++, by: job.leader }) }))));
    if (Object.keys(bk.values).length) ops.push({ store: 'binStock', op: 'add', obj: binKgRec(bk.values, job, 'jobStart', tms) });   // v2.13.0: kg nas bins no arranque
    try { await DB.batch(ops); } catch (e) { return C.toast(t('saveFailed')); }
    // Integração com o CQ: a linha passa a produzir este produto (controlos horários contam a partir daqui)
    const ls = Object.assign({}, S.lineState, { [f.lineId]: { productId: outs[0].productId, products: outs.map(o => o.productId), running: true, since: tms } });
    S.lineState = ls; await DB.setConfig('lineState', ls);
    S.operator = job.leader; await DB.setConfig('operator', S.operator);
    S.jobForm = null; await reload(); C.toast(t('jobStarted')); C.render(); window.scrollTo(0, 0);
  }
  async function closeJob() {
    const j = S.jobs.find(x => x.uid === S.closeJob);
    if (!j || j.status !== 'running') return;
    const status = $('#cj_status').value === 'cancelled' ? 'cancelled' : 'done';
    const w = await whoP('cj_pin'); if (!w) return; const by = w.title;
    const kg = P.num($('#cj_kg').value, 'kg');
    if (kg !== null && (isNaN(kg) || kg < 0)) return C.toast(t('fixInvalid'));
    const ck = P.readBinKg(j.bins || [], S.closeBinKg || {});
    if (ck.bad.length) return C.toast(t('binKgNeed') + ': ' + ck.bad.join(', '));
    const nj = Object.assign({}, j, { status, closedAt: now(), closedBy: by, closedByRole: w.role, closedByCrew: crewOfRole(w.role, L.shiftOf(now()).day, L.shiftOf(now()).period), actualKg: kg, closeNote: $('#cj_note').value.trim(), binKgEnd: ck.values });
    try { await DB.put('jobs', nj); if (Object.keys(ck.values).length) await DB.add('binStock', binKgRec(ck.values, Object.assign({}, nj, { leader: by }), 'jobClose', nj.closedAt)); } catch (e) { return C.toast(t('saveFailed')); }
    S.closeBinKg = null;
    const st = S.lineState[j.lineId];
    if (st && st.running && st.productId === j.productId) {
      S.lineState = Object.assign({}, S.lineState, { [j.lineId]: Object.assign({}, st, { running: false, since: now() }) });
      await DB.setConfig('lineState', S.lineState);
    }
    const stop = S.closeStop; S.closeJob = null; S.closeStop = false; await reload(); C.toast(t('jobClosed'));
    // v2.7.0: "Parar linha" fecha a ordem e exporta o relatório do turno (Excel)
    if (stop) { S.shiftSel = { day: L.shiftOf(nj.closedAt).day, period: L.shiftOf(nj.closedAt).period }; try { shiftExcel(); } catch (e) { console.warn('shift xlsx', e); } S.prodTab = 'shift'; }
    keepScroll();
  }
  async function importSilos(file) {
    if (!file) return;
    let o, snap;
    try { o = JSON.parse(await file.text()); snap = P.snapshotFromSilosBackup(o, now()); }
    catch (e) { return C.toast(t('notSilosFile')); }
    snap.uid = newUid(); snap.deviceId = S.deviceId; snap.fileName = String(file.name || '').slice(0, 120);
    try { await DB.add('siloSnapshots', snap); } catch (e) { return C.toast(t('saveFailed')); }
    await reload(); C.toast(t('snapImported', { n: snap.silos.length })); keepScroll();
  }

  // ---------- diário de turno ----------
  const logShift = () => shiftSel();   // v2.15.0: o diário usa o turno escolhido no separador Turno
  function shiftRange(day, period) {
    const [s] = L.prodDayRange(day);
    return period === 'D' ? [s, s + 12 * 3600000] : [s + 12 * 3600000, s + 24 * 3600000];
  }
  function viewLog() {
    const ls = logShift();
    const range = shiftRange(ls.day, ls.period);
    const sm = P.shiftSummary(ls.day, ls.period, range, { log: S.shiftLog, jobs: S.jobs, now: now(), codes: codes() });
    const f = S.logForm;
    return `<section class="card"><h3>${esc(t('shiftLog'))}</h3>
      <div class="kpis k4"><div><b>${sm.jobs.length}</b><span>${esc(t('ptab_jobs'))}</span></div><div class="${sm.openIssues ? 'd-warn' : ''}"><b>${sm.issues.length}</b><span>${esc(t('issues'))}</span></div>
        <div><b>${sm.downtimeMin}</b><span>${esc(t('downtimeMin'))}</span></div><div><b>${sm.acts.length}</b><span>${esc(t('activities'))}</span></div></div>
      ${Object.keys(sm.byTier3).length ? `<p class="sub">${esc(t('byTier3'))}: ${Object.keys(sm.byTier3).map(k => esc(tierLabel(k)) + ' ' + sm.byTier3[k] + ' min').join(' · ')}<br>${esc(t('byOee'))}: ${Object.keys(sm.byOee).map(k => esc(oeeLabel(k)) + ' ' + sm.byOee[k] + ' min').join(' · ')}</p>` : ''}
      ${f ? '' : `<div class="row"><button class="btn primary" data-pact="newissue">＋ ${esc(t('newIssue'))}</button><button class="btn" data-pact="newact">＋ ${esc(t('newActivity'))}</button><button class="btn" data-pact="newsafety">＋ ${esc(t('newSafety'))}</button></div>`}
      <div class="row"><button class="btn ghost small" data-pact="shiftxlsx">${esc(t('genExcel'))}</button>
        <a class="btn ghost small" target="_blank" rel="noopener" href="${esc(C.waLink(shiftText(ls, sm)))}">${esc(t('sendSummaryWa'))}</a></div></section>
      ${readingsCard(ls)}
      ${f ? logFormView() : ''}
      <section class="card"><h3>${esc(t('issues'))}</h3>${sm.issues.map(issueItem).join('') || '<p class="sub">—</p>'}</section>
      <section class="card"><h3>${esc(t('activities'))}</h3>${sm.acts.map(actItem).join('') || '<p class="sub">—</p>'}</section>`;
  }
  // ---------- leituras de balança por turno (v2.2.0) ----------
  // Ligadas ao turno escolhido no diário (dia de produção + período), não à hora da gravação:
  // a leitura de fim do turno de dia feita às 19:05 pertence ao turno de dia.
  const SR_ST_CLS = { ok: '', missing: 'd-warn', missing_start: 'd-warn', missing_end: 'd-warn', negative: 'd-reject' };
  function srCell(p) {
    const cls = SR_ST_CLS[p.status] !== undefined ? SR_ST_CLS[p.status] : 'd-warn';
    return `<td>${fmtKg(p.start)}</td><td>${fmtKg(p.end)}</td><td class="${cls}">${p.kg !== null ? fmtKg(p.kg) : esc(t('srSt_' + (SR_ST_CLS[p.status] !== undefined ? p.status : 'missing')))}</td>`;
  }
  function readingsCard(ls) {
    const tot = P.shiftTotals(S.readings, ls.day, ls.period);
    const eff = P.effectiveReadings(S.readings).filter(r => r.prodDay === ls.day && r.period === ls.period)
      .sort((a, b) => (a.lineId > b.lineId ? 1 : a.lineId < b.lineId ? -1 : 0) || a.t - b.t);
    const head = `<tr><th></th><th>${esc(t('srPoint_start'))}</th><th>${esc(t('srPoint_end'))}</th><th>${esc(t('srQty'))} (kg)</th><th>${esc(t('srExtraction'))}</th></tr>`;
    const lines = Object.keys(tot).map(line => {
      const x = tot[line];
      const rows = [`<tr><td>${esc(t('srGrainB1'))}</td>${srCell(x.grain)}<td></td></tr>`].concat(Object.keys(x.products).map(pid =>
        `<tr><td>${esc(C.prodName(pid))}</td>${srCell(x.products[pid])}<td>${x.extraction[pid] !== undefined ? esc(String(x.extraction[pid]).replace('.', ',')) + ' %' : '—'}</td></tr>`));
      return `<h4>${esc(C.lineName(line))}</h4><div class="tablewrap"><table class="tbl">${head}${rows.join('')}</table></div>`;
    }).join('');
    const list = eff.map(r => `<div class="rowitem"><div class="row between"><span><b>${esc(C.lineName(r.lineId))}</b> · ${esc(r.srKind === 'grain' ? t('srGrainB1') : C.prodName(r.productId))} · ${esc(t('srPoint_' + (r.point === 'end' ? 'end' : 'start')))}: <b>${fmtKg(r.valueKg)} kg</b></span>
        <button class="btn ghost small" data-pact="srfix" data-uid="${esc(r.uid)}">${esc(t('srFix'))}</button></div>
        <small>${esc(C.fmtDT(r.t))} · ${esc(r.by)}${r.replaces ? ' · ' + esc(t('srCorrected')) + ': ' + esc(r.reason || '') : ''}</small></div>`).join('');
    return `<section class="card"><h3>${esc(t('srTitle'))}</h3>
      ${lines || `<p class="sub">${esc(t('srNone'))}</p>`}
      ${S.srForm ? srFormView() : `<button class="btn primary" data-pact="newsr">＋ ${esc(t('srNew'))}</button>`}
      ${list}</section>`;
  }
  function newSrForm(fix) {
    const ls = logShift();
    S.srForm = fix ? { prodDay: fix.prodDay, period: fix.period, lineId: fix.lineId, srKind: fix.srKind, productId: fix.productId || '', point: fix.point, valueKg: '', by: S.operator, replaces: fix.uid, reason: '' }
      : { prodDay: ls.day, period: ls.period, lineId: '', srKind: 'grain', productId: '', point: 'start', valueKg: '', by: S.operator, replaces: null, reason: '' };
  }
  function srFormView() {
    const f = S.srForm, fix = !!f.replaces, dis = fix ? 'disabled' : '';
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return `<div class="holdform"><h4>${esc(fix ? t('srFix') : t('srNew'))} · ${esc(f.prodDay)} ${esc(t('shift_' + (f.period === 'N' ? 'N' : 'D')))}</h4><div class="grid2">
      <label class="fld req">${esc(t('line'))}<select data-sr="lineId" ${dis}>${lineOpts(f.lineId)}</select></label>
      <label class="fld req">${esc(t('srKind'))}<select data-sr="srKind" ${dis}>${P.SR_KINDS.map(k => opt(k, f.srKind, t('srKind_' + k))).join('')}</select></label>
      ${f.srKind === 'product' ? `<label class="fld req">${esc(t('product'))}<select data-sr="productId" ${dis}><option value="">—</option>${C.products().map(p => opt(p.id, f.productId, C.prodName(p.id))).join('')}</select></label>` : ''}
      <label class="fld req">${esc(t('srPoint'))}<select data-sr="point" ${dis}>${P.SR_POINTS.map(k => opt(k, f.point, t('srPoint_' + k))).join('')}</select></label>
      <label class="fld req">${esc(t('srValue'))}<input inputmode="decimal" data-sr="valueKg" value="${esc(f.valueKg)}"></label>
      <label class="fld req">${esc(t('name'))}<input data-sr="by" value="${esc(f.by)}"></label></div>
      ${fix ? `<label class="fld req">${esc(t('srReason'))}<textarea rows="2" data-sr="reason">${esc(f.reason)}</textarea></label>` : ''}
      <button class="btn primary" data-pact="savesr">${esc(t('save'))}</button> <button class="btn ghost" data-pact="cancelsr">${esc(t('cancel'))}</button></div>`;
  }
  async function saveSr() {
    const f = S.srForm;
    const e = P.validateShiftReading(f, { lineIds: lineIds(), productIds: C.products().map(p => p.id), readings: S.readings });
    if (e.length) return C.toast(t('fillFields') + ': ' + e.map(x => t(x)).join(', '));
    const tms = now(), start = shiftRange(f.prodDay, f.period)[0];
    const rec = Object.assign(base(tms), {
      srKind: f.srKind, meter: f.srKind === 'grain' ? 'B1' : null, lineId: f.lineId, productId: f.srKind === 'product' ? f.productId : null,
      point: f.point, valueKg: P.num(f.valueKg, 'kg'), t: tms, by: String(f.by).trim(),
      prodDay: f.prodDay, period: f.period, shift: f.prodDay + '/' + f.period, crew: L.crewOfTime(start),
      replaces: f.replaces || null, reason: f.replaces ? String(f.reason).trim() : null
    });
    try { await DB.add('shiftReadings', rec); } catch (err) { return C.toast(t('saveFailed')); }
    S.operator = rec.by; await DB.setConfig('operator', S.operator);
    S.srForm = null; await reload(); C.toast(t('saved')); keepScroll();
  }
  function lineOpts(sel) {
    return `<option value="">—</option>` + S.cfg.lines.map(l => `<option value="${esc(l.id)}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  }
  function logFormView() {
    const f = S.logForm;
    const head = `<label class="fld">${esc(t('time'))}<input type="datetime-local" data-lf="time" value="${esc(f.time)}"></label>
      <label class="fld">${esc(t('line'))}<select data-lf="lineId">${lineOpts(f.lineId)}</select></label>`;
    // v2.9.0: ocorrência de segurança (acidente, quase-acidente, perigo, acto inseguro)
    if (f.kind === 'safety') return `<section class="card"><h3>${esc(t('newSafety'))}</h3><div class="grid2">${head}
        <label class="fld req">${esc(t('sfType'))}<select data-lf="sType"><option value="">—</option>${window.DayBook.SAFETY_TYPES.map(k => `<option value="${k}" ${f.sType === k ? 'selected' : ''}>${esc(t('sf_' + k))}</option>`).join('')}</select></label>
        <label class="fld">${esc(t('sfInjured'))}<input data-lf="injured" value="${esc(f.injured)}"></label></div>
        <label class="fld req">${esc(t('description'))}<textarea rows="2" data-lf="description">${esc(f.description)}</textarea></label>
        <label class="fld">${esc(t('actionTaken'))}<textarea rows="2" data-lf="action">${esc(f.action)}</textarea></label>
        ${byFld('reportedBy', f)}
        <button class="btn primary big" data-pact="savelog">${esc(t('save'))}</button><button class="btn ghost" data-pact="cancellog">${esc(t('cancel'))}</button></section>`;
    if (f.kind === 'issue') return `<section class="card"><h3>${esc(t('newIssue'))}</h3><div class="grid2">${head}
        <label class="fld">${esc(t('downtimeCode'))}<select data-lf="code"><option value="">— ${esc(t('noStopCode'))}</option>${GROUPS.map(([g, k]) => `<optgroup label="${esc(t(k))}">${codes().filter(c => c.code[0] === g && c.active !== false).map(c => `<option value="${esc(c.code)}" ${f.code === c.code ? 'selected' : ''}>${esc(c.code + ' ' + cName(c))}</option>`).join('')}</optgroup>`).join('')}
        ${codes().some(c => c.active !== false && GROUPS.every(([g]) => c.code[0] !== g)) ? `<optgroup label="${esc(t('cg_X'))}">${codes().filter(c => c.active !== false && GROUPS.every(([g]) => c.code[0] !== g)).map(c => `<option value="${esc(c.code)}" ${f.code === c.code ? 'selected' : ''}>${esc(c.code + ' ' + cName(c))}</option>`).join('')}</optgroup>` : ''}</select></label>
        <label class="fld">${esc(t('equipment'))}<input data-lf="equipment" value="${esc(f.equipment)}"></label></div>
        <label class="fld req">${esc(t('issueDesc'))}<textarea rows="2" data-lf="description">${esc(f.description)}</textarea></label>
        <label class="fld">${esc(t('downtimeMin'))}<input inputmode="numeric" data-lf="downtimeMin" value="${esc(f.downtimeMin)}"></label>
        <label class="fld">${esc(t('actionTaken'))}<textarea rows="2" data-lf="action">${esc(f.action)}</textarea></label>
        ${byFld('reportedBy', f)}
        <button class="btn primary big" data-pact="savelog">${esc(t('save'))}</button><button class="btn ghost" data-pact="cancellog">${esc(t('cancel'))}</button></section>`;
    return `<section class="card"><h3>${esc(t('newActivity'))}</h3><div class="grid2">${head}
        <label class="fld req">${esc(t('activityType'))}<select data-lf="type"><option value="">—</option>${P.ACT_TYPES.map(c => `<option value="${c}" ${f.type === c ? 'selected' : ''}>${esc(t('at_' + c))}</option>`).join('')}</select></label>
        ${f.type === 'housekeeping' ? `<label class="fld req">${esc(t('floor'))}<input data-lf="floor" list="floorList" value="${esc(f.floor)}"><datalist id="floorList">${(S.cfgP.floors || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>` : ''}
        ${f.type === 'reprocessing' ? `<label class="fld req">${esc(t('bags'))}<input inputmode="numeric" data-lf="bags" value="${esc(f.bags || '')}"></label>
          <label class="fld req">${esc(t('startTime'))}<input type="time" data-lf="startTime" value="${esc(f.startTime || '')}"></label>
          <label class="fld req">${esc(t('endTime'))}<input type="time" data-lf="endTime" value="${esc(f.endTime || '')}"></label>
          <label class="fld">${esc(t('qtyKg'))} <small>${esc(t('optional'))}</small><input inputmode="decimal" data-lf="qtyKg" value="${esc(f.qtyKg)}"></label>
          <label class="fld">${esc(t('product'))}<select data-lf="productId"><option value="">—</option>${C.products().map(p => `<option value="${esc(p.id)}" ${f.productId === p.id ? 'selected' : ''}>${esc(C.prodName(p.id))}</option>`).join('')}</select></label>` : ''}
      </div>
      <label class="fld ${f.type && f.type !== 'housekeeping' && f.type !== 'reprocessing' ? 'req' : ''}">${esc(t('description'))}<textarea rows="2" data-lf="description">${esc(f.description)}</textarea></label>
      ${byFld('doneBy', f)}
      <button class="btn primary big" data-pact="savelog">${esc(t('save'))}</button><button class="btn ghost" data-pact="cancellog">${esc(t('cancel'))}</button></section>`;
  }
  function newLogForm(kind) {
    S.logForm = { kind, time: C.localInput(now()), lineId: '', code: '', equipment: '', description: '', downtimeMin: '', action: '',
      type: '', floor: '', qtyKg: '', bags: '', startTime: '', endTime: '', productId: '', sType: '', injured: '', by: shiftLeader() || S.operator };
  }
  async function saveLog() {
    const f = S.logForm;
    const tms = new Date(f.time).getTime();
    if (!isFinite(tms)) return C.toast(t('badTime'));
    if (tms > now() + 5 * 60000) return C.toast(t('futureTime'));
    if (tms < now() - 24 * 3600000) return C.toast(t('tooOld'));
    if (!String(f.by || '').trim()) return C.toast(t('needName'));
    let rec;
    if (f.kind === 'safety') {
      const e = window.DayBook.validateSafety(f);
      if (e.length) return C.toast(t('fillFields') + ': ' + e.map(x => t('f_' + x)).join(', '));
      rec = Object.assign(base(tms), { kind: 'safety', t: tms, lineId: f.lineId, sType: f.sType, injured: String(f.injured || '').trim(), description: f.description.trim(), action: String(f.action || '').trim(), by: f.by.trim() });
    } else if (f.kind === 'issue') {
      const e = P.validateIssue(f, codes());
      if (e.length) return C.toast(t('fillFields') + ': ' + e.map(x => t('f_' + x)).join(', '));
      const dt = P.num(f.downtimeMin);
      rec = Object.assign(base(tms), { kind: 'issue', t: tms, lineId: f.lineId, code: f.code || null, codeInfo: f.code ? Object.assign({ source: S.cfgP.codesSource || P.DOWNTIME_SOURCE }, P.findCode(f.code, codes())) : null, equipment: f.equipment.trim(),
        description: f.description.trim(), downtimeMin: dt, action: f.action.trim(), by: f.by.trim(), status: f.action.trim() ? 'closed' : 'open' });
      if (rec.status === 'closed') { rec.closedAt = tms; rec.closedBy = rec.by; rec.resolution = rec.action; }
    } else {
      const e = P.validateActivity(f);
      if (e.length) return C.toast(t('fillFields') + ': ' + e.map(x => t('f_' + x)).join(', '));
      rec = Object.assign(base(tms), { kind: 'activity', t: tms, lineId: f.lineId, type: f.type, floor: f.type === 'housekeeping' ? f.floor.trim() : '',
        qtyKg: f.type === 'reprocessing' && String(f.qtyKg || '').trim() ? P.num(f.qtyKg, 'kg') : null, productId: f.type === 'reprocessing' ? f.productId : '',
        bags: f.type === 'reprocessing' ? P.num(f.bags) : null, startTime: f.type === 'reprocessing' ? f.startTime : null, endTime: f.type === 'reprocessing' ? f.endTime : null,
        durationMin: f.type === 'reprocessing' ? P.reprocMins(f.startTime, f.endTime) : null,
        description: f.description.trim(), by: f.by.trim() });
    }
    try { await DB.add('shiftLog', rec); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = rec.by; await DB.setConfig('operator', S.operator);
    S.logForm = null;
    await reload(); C.toast(t('saved')); keepScroll();
  }
  function issueItem(i) {
    const cd = i.codeInfo || P.findCode(i.code, codes());
    const open = i.status !== 'closed';
    const act = S.logAct && S.logAct.uid === i.uid ? S.logAct.mode : null;
    return `<div class="rowitem">
      <div class="row between"><span><b>${isNum(i.downtimeMin) ? esc(i.downtimeMin + ' min') : '—'}</b>${i.code ? ' · <b>' + esc(codeLabel(i.code, cd)) + '</b> <small>(' + esc(tierLabel(cd && cd.tier3)) + ')</small>' : ' · ' + esc(t('noStopCode'))}${i.lineId ? ' · ' + esc(C.lineName(i.lineId)) : ''}${i.equipment ? ' · ' + esc(i.equipment) : ''}</span>
        <span class="chip ${open ? 'd-warn' : 'd-accept'}">${esc(open ? t('is_open') : t('is_closed'))}</span></div>
      <div>${esc(i.description)}</div>
      ${i.consumables ? `<div><small><b>${esc(t('stopConsumables'))}:</b> ${esc(i.consumables)}</small></div>` : ''}
      <small>${esc(t('crew'))} ${esc(i.crew)} · ${esc(i.by)}</small>
      ${i.resolution ? `<div class="act"><small>${esc(i.closedAt ? C.fmtDT(i.closedAt) : '')} · ${esc(i.closedBy || '')}: ${esc(i.resolution)}</small></div>` : ''}
      ${act ? `<div class="holdform"><label class="fld req">${esc(act === 'close' ? t('resolution') : t('voidReason'))}<textarea rows="2" id="la_text"></textarea></label>
        ${C.pinFld('la_pin')}
        <button class="btn primary small" data-pact="${act === 'close' ? 'closeissue' : 'voidlog'}">${esc(t('save'))}</button> <button class="btn ghost small" data-pact="cancella">${esc(t('cancel'))}</button></div>`
        : `<div class="row">${open ? `<button class="btn ghost small" data-logact="close" data-uid="${esc(i.uid)}">${esc(t('closeIssue'))}</button>` : ''}<button class="btn ghost small" data-logact="void" data-uid="${esc(i.uid)}">${esc(t('voidEntry'))}</button></div>`}
    </div>`;
  }
  function actItem(a) {
    const ty = ACT.has(a.type) ? a.type : 'other';
    const act = S.logAct && S.logAct.uid === a.uid ? S.logAct.mode : null;
    return `<div class="rowitem"><div><b>${esc(C.fmtTime(a.t))}</b> · ${esc(t('at_' + ty))}${a.floor ? ' · ' + esc(a.floor) : ''}${isNum(a.bags) ? ' · ' + esc(t('bagsN', { n: a.bags, h: (a.startTime || '') + '–' + (a.endTime || ''), p: P.reprocPct(a.bags, a.durationMin) == null ? '—' : String(P.reprocPct(a.bags, a.durationMin)).replace('.', ',') + ' %' })) : ''}${a.lineId ? ' · ' + esc(C.lineName(a.lineId)) : ''}${isNum(a.qtyKg) ? ' · ' + fmtKg(a.qtyKg) + ' kg' + (a.productId ? ' ' + esc(C.prodName(a.productId)) : '') : ''}</div>
      ${a.description ? `<div>${esc(a.description)}</div>` : ''}<small>${esc(t('crew'))} ${esc(a.crew)} · ${esc(a.by)}</small>
      ${act ? `<div class="holdform"><label class="fld req">${esc(t('voidReason'))}<textarea rows="2" id="la_text"></textarea></label>
        ${C.pinFld('la_pin')}
        <button class="btn primary small" data-pact="voidlog">${esc(t('save'))}</button> <button class="btn ghost small" data-pact="cancella">${esc(t('cancel'))}</button></div>`
        : `<div class="row"><button class="btn ghost small" data-logact="void" data-uid="${esc(a.uid)}">${esc(t('voidEntry'))}</button></div>`}</div>`;
  }
  async function logAction(mode) {
    const e = S.shiftLog.find(x => x.uid === S.logAct.uid);
    const text = $('#la_text').value.trim();
    if (!e || !text) return C.toast(t('needTextName'));
    const w = await whoP('la_pin'); if (!w) return; const by = w.title;
    try {
      if (mode === 'close') await DB.put('shiftLog', Object.assign({}, e, { status: 'closed', closedAt: now(), closedBy: by, resolution: text }));
      else await DB.add('shiftLog', Object.assign(base(now()), { kind: 'void', voids: e.uid, t: now(), reason: text, by }));
    } catch (err) { return C.toast(t('saveFailed')); }
    S.logAct = null; await reload(); C.toast(t('saved')); keepScroll();
  }
  function shiftText(ls, sm) {
    const lines = [t('waShiftTitle', { d: ls.day, s: t('shift_' + ls.period) })];
    sm.jobs.forEach(j => lines.push('▶ ' + C.lineName(j.lineId) + ' ' + prodNames(j) + ': ' + fmtKg(j.grainKg) + ' kg · ' + t('js_' + (JOB_ST[j.status] ? j.status : 'running'))));
    lines.push(t('issues') + ': ' + sm.issues.length + ' (' + t('is_open') + ' ' + sm.openIssues + ') · ' + t('downtimeMin') + ': ' + sm.downtimeMin + (Object.keys(sm.byTier3).length ? ' (' + Object.keys(sm.byTier3).map(k => tierLabel(k) + ' ' + sm.byTier3[k]).join(', ') + ')' : ''));
    sm.issues.forEach(i => lines.push('• ' + C.fmtTime(i.t) + ' ' + (i.code ? codeLabel(i.code, i.codeInfo) : t('noStopCode')) + (i.lineId ? ' ' + i.lineId : '') + ': ' + i.description + (isNum(i.downtimeMin) ? ' (' + i.downtimeMin + ' min)' : '')));
    if (sm.acts.length) lines.push(t('activities') + ': ' + sm.acts.map(a => t('at_' + (ACT.has(a.type) ? a.type : 'other')) + (a.floor ? ' ' + a.floor : '')).join('; '));
    return lines.join('\n');
  }
  function shiftWorkbook(ls, sm, range) {
    const XLSX = window.XLSX, wb = XLSX.utils.book_new();
    const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31));
    add(t('x_jobs'), [[t('waShiftTitle', { d: ls.day, s: t('shift_' + ls.period) })], [],
      [t('line'), t('product'), t('status'), t('startedAt'), t('closedAt'), t('shiftLeader'), t('crew'), t('grainToMill') + ' (kg)', t('fromBins'), t('binContents'), t('temperedBin'), t('toBins'),
        t('m0'), t('impurities'), t('m1'), t('feedRate') + ' (kg/h)', t('waterRate') + ' (L/h)', t('waterTotal') + ' (L)', t('waterAdded') + ' (L)', t('jobRecipe'), t('x_offRecipe'), t('x_outputs'), t('extraction') + ' % (' + t('total') + ')', t('expectedProduct') + ' (kg, ' + t('total') + ')', t('actualGrain') + ' (kg)', t('notes')],
      ...sm.jobs.map(j => [C.lineName(j.lineId), prodNames(j), t('js_' + (JOB_ST[j.status] ? j.status : 'running')), C.fmtDT(j.startedAt), j.closedAt ? C.fmtDT(j.closedAt) : '',
        j.leader, j.crew, j.grainKg, (j.alloc || []).map(a => (a.bin || a.silo) + '=' + a.kg).join('; '),
        j.sourceComps ? Object.keys(j.sourceComps).map(k => k + ': ' + compText(j.sourceComps[k])).join(' | ') : '', (j.tempered || []).join(', '), (j.bins || []).join(', '), j.m0, j.impurities, j.m1, P.feedKghOf(j), j.waterLh, j.waterL, isNum(j.waterAddedL) ? j.waterAddedL : '',
        j.recipe && P.recipeSet(j.recipe) ? j.recipe.colours.join('/') + ' · ' + j.recipe.grades.join('/') : '',
        (j.offRecipe || []).map(x => x.bin || x.silo).join(', ') + (j.offRecipeAuth ? ' (' + j.offRecipeAuth.by + ': ' + j.offRecipeAuth.reason + ')' : ''),
        P.jobOutputs(j).map(o => C.prodName(o.productId) + ' ' + (isNum(o.extraction) ? o.extraction + ' %' : '—') + ' · ' + (isNum(o.expectedKg) ? o.expectedKg + ' kg' : '—') + ' → ' + (o.bins || []).join('/')).join(' | '),
        isNum(j.extraction) ? j.extraction : '', isNum(j.expectedKg) ? j.expectedKg : '', isNum(j.actualKg) ? j.actualKg : '', j.closeNote || ''])]);
    const mvs = (S.moves || []).filter(m => m.t >= range[0] && m.t < range[1]).sort((a, b) => a.t - b.t);
    add(t('x_moves'), [[t('dateTime'), t('crew'), t('type'), t('dirtyBin'), t('silo'), 'kg', t('colour'), t('grade'), t('name')],
      ...[].concat(...mvs.map(m => m.type === 'EMPTY' ? [[C.fmtDT(m.t), m.crew, t('mv_EMPTY'), m.binId, '', m.bookKg, '', '', m.by]]
        : (m.parts || []).map(pt => [C.fmtDT(m.t), m.crew, t('mv_TRANSFER'), m.binId, pt.silo, pt.kg, pt.colour, gradeName(pt.grade), m.by])))]);
    add(t('dirtyBins'), [[t('dirtyBin'), t('fedBy'), t('capacityT'), 'kg', t('binContents')],
      ...(S.cfgP.dirtyBins || []).map(b => { const st = dirtyState(b.id); return [b.id, b.lines.join('/'), isNum(b.capKg) ? b.capKg : '', st.kg, compText(st.comps)]; })]);
    const rds = [];
    (S.jobs || []).forEach(j => (j.readings || []).forEach(r => { if (r.t >= range[0] && r.t < range[1]) rds.push([C.fmtDT(r.t), r.crew, C.lineName(j.lineId), prodNames(j), r.m0, j.m1, r.waterLh, r.over ? t('overDampener') : '', r.by, r.kind === 'start' ? t('atStart') : '']); }));
    add(t('maizeMoisture'), [[t('dateTime'), t('crew'), t('line'), t('product'), t('maizeMoistureCol') + ' %', t('m1') + ' %', t('waterRate') + ' (L/h)', '', t('name'), ''], ...rds]);
    add(t('issues'), [[t('dateTime'), t('crew'), t('line'), t('downtimeCode'), t('codeName'), t('codeNamePt'), 'Tier 3', t('oeeTreat'), t('equipment'), t('issueDesc'), t('downtimeMin'), t('actionCol'), t('status'), t('reportedBy'), t('closedAt'), t('resolution')],
      ...sm.issues.map(i => { const d = i.codeInfo || P.findCode(i.code, codes()) || {}; return [C.fmtDT(i.t), i.crew, i.lineId ? C.lineName(i.lineId) : '', i.code || '', d.name || '', d.namePt || '', d.tier3 || '', d.oee ? t('oee_' + d.oee) : '', i.equipment, i.description,
        isNum(i.downtimeMin) ? i.downtimeMin : '', i.action, i.status === 'closed' ? t('is_closed') : t('is_open'), i.by, i.closedAt ? C.fmtDT(i.closedAt) : '', i.resolution || '']; })]);
    add(t('byTier3'), [['V2', t('downtimeMin')], ...Object.keys(sm.byTier3).map(k => [tierLabel(k), sm.byTier3[k]]), [], [t('oeeTreat'), t('downtimeMin')],
      ...Object.keys(sm.byOee).map(k => [oeeLabel(k), sm.byOee[k]]), [], [t('codesSource', { s: S.cfgP.codesSource || P.DOWNTIME_SOURCE })]]);
    add(t('activities'), [[t('dateTime'), t('crew'), t('line'), t('activityType'), t('floor'), t('qtyKg'), t('bags'), t('startTime'), t('endTime'), t('product'), t('description'), t('doneBy')],
      ...sm.acts.map(a => [C.fmtDT(a.t), a.crew, a.lineId ? C.lineName(a.lineId) : '', t('at_' + (ACT.has(a.type) ? a.type : 'other')), a.floor || '', isNum(a.qtyKg) ? a.qtyKg : '', isNum(a.bags) ? a.bags : '', a.startTime || '', a.endTime || '',
        a.productId ? C.prodName(a.productId) : '', a.description || '', a.by])]);
    const qa = L.effective(S.samples).filter(s => s.t >= range[0] && s.t < range[1] && (s.decision === 'warn' || s.decision === 'reject')).sort((a, b) => a.t - b.t);
    add(t('x_alerts'), [[t('dateTime'), t('line'), t('product'), t('decision'), t('failures')],
      ...qa.map(s => [C.fmtDT(s.t), C.lineName(s.lineId), C.prodName(s.productId), C.decLabel(s.decision), s.failures.map(f => C.anyLabel(f.param, C.product(s.productId)) + '=' + (f.value === 'abn' ? t('abnormal') : f.value)).join('; ')])]);
    // v2.7.0: login e logout do turno, leituras das balanças e % do objectivo do dia
    const li = shiftRec('login', ls.day, ls.period), lo = shiftRec('logout', ls.day, ls.period);
    add(t('shiftTitle'), [[t('waShiftTitle', { d: ls.day, s: t('shift_' + ls.period) })], [],
      [t('loginTitle'), li ? C.fmtDT(li.t) : t('notDone')], [t('shiftLeader'), li ? li.leader : ''], [t('crew'), li ? li.crew : ''], [t('stateNow') + ' (' + t('loginTitle') + ')', li ? t('state_' + li.state) : ''],
      [t('jobsToDo'), li ? (li.planJobs || []).map(j => (j.product || '') + (isNum(j.targetKg) ? ' ' + j.targetKg + ' kg' : '')).concat((li.shiftJobs || []).map(jobText)).concat(li.jobsExtra ? [li.jobsExtra] : []).join(' | ') : ''],
      [t('comments') + ' (' + t('loginTitle') + ')', li ? li.comments || '' : ''], [],
      [t('scale'), 'SCADA', t('srPoint_start') + ' (kg)', t('srPoint_end') + ' (kg)', t('srQty') + ' (kg)'],
      ...P.SCALES.map(k => [t('scale_' + k), P.SCALE_SCADA[k], li && isNum((li.scalesStart || {})[k]) ? li.scalesStart[k] : '', lo && isNum((lo.scalesEnd || {})[k]) ? lo.scalesEnd[k] : '', lo && isNum((lo.shiftKg || {})[k]) ? lo.shiftKg[k] : '']), [],
      [t('logoutTitle'), lo ? C.fmtDT(lo.t) : t('notDone')], [t('stateNow') + ' (' + t('logoutTitle') + ')', lo ? t('state_' + lo.state) : ''],
      [t('dayB1') + ' (kg)', lo && isNum(lo.dayB1Kg) ? lo.dayB1Kg : ''], [t('targetT') + ' (kg)', lo && isNum(lo.targetKg) ? lo.targetKg : ''], [t('targetAchieved') + ' (%)', lo && isNum(lo.achievedPct) ? lo.achievedPct : ''],
      [t('activitiesDone'), lo ? lo.activitiesDone : ''], [t('comments') + ' (' + t('logoutTitle') + ')', lo ? lo.comments || '' : '']]);
    add(t('ptab_bins'), [[t('bin'), t('fedBy'), t('capacityT'), t('content'), t('since')],
      ...S.cfgP.bins.map(b => { const st = P.binState(b.id, S.binEvents); return [b.id, b.lines.join('/'), isNum(b.capKg) ? b.capKg : '', st.productId ? C.prodName(st.productId) : t('binEmpty'), st.since ? C.fmtDT(st.since) : '']; })]);
    return wb;
  }
  function shiftExcel() {
    const ls = logShift(), range = shiftRange(ls.day, ls.period);
    const sm = P.shiftSummary(ls.day, ls.period, range, { log: S.shiftLog, jobs: S.jobs, now: now(), codes: codes() });
    window.XLSX.writeFile(shiftWorkbook(ls, sm, range), ls.day + '_' + (ls.period === 'D' ? 'Dia' : 'Noite') + '_Producao-Moagem_Diario-Turno.xlsx');
  }

  // ---------- silos de produto ----------
  // v2.13.0: total por produto e retenções (bins de milho sujo e de produto; confirmadas pelo supervisor de CQ)
  function totalsCard() {
    const T = P.productTotals(S.cfgP, S.binEvents, levelOf);
    if (!T.length) return '';
    return `<section class="card"><h3>${esc(t('prodTotals'))}</h3><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('product'))}</th><th>${esc(t('bins'))}</th><th>kg</th><th>${esc(t('loadPct'))}</th></tr>
      ${T.map(p => `<tr><td>${esc(C.prodName(p.productId))}</td><td>${esc(p.bins.join(', '))}</td><td>${fmtKg(p.kg)}${p.unknown ? ' <small>(' + esc(t('binsNoReading', { n: p.unknown })) + ')</small>' : ''}</td><td>${p.pct == null ? '—' : esc(String(p.pct).replace('.', ',')) + ' %'}</td></tr>`).join('')}</table></div></section>`;
  }
  const holdFormHtml = f => `<div class="holdform"><label class="fld req">${esc(t(f.release ? 'holdReleaseReason' : 'holdReason'))}<textarea rows="2" id="hd_reason">${esc(f.reason || '')}</textarea></label>
          <label class="fld req">${esc(t('pin'))}<input type="password" maxlength="4" id="hd_pin"></label>
          <button class="btn primary small" data-pact="holdsave">${esc(t(f.release ? 'holdReleaseBtn' : 'holdBtn'))}</button> <button class="btn ghost small" data-pact="holdcancel">${esc(t('cancel'))}</button></div>`;
  function holdsCard() {
    const H = holds(), f = S.holdForm, B = P.holdableBins(S.cfgP);
    const row = b => {
      const h = H[b.id], open = f && f.binId === b.id && !f.mq;   // v2.27.0: a retenção pedida na amostragem do milho abre o formulário lá
      return `<div class="rowitem"><div class="row between"><span><b>${esc(b.id)}</b> <small>${esc(t(b.kind === 'dirty' ? 'dirtyBins' : 'ptab_bins'))}</small></span>
        <span class="chip ${h ? 'd-reject' : 'd-accept'}">${esc(h ? t('holdOn') : t('holdOff'))}</span></div>
        ${h ? `<small>${esc(C.fmtDT(h.t))} · ${esc(h.by)}: ${esc(h.reason)}</small>` : ''}
        ${open ? holdFormHtml(f)
          : (f ? '' : `<button class="btn small ${h ? '' : 'ghost'}" data-hold="${esc(b.id)}" data-release="${h ? 1 : ''}">${esc(t(h ? 'holdReleaseBtn' : 'holdBtn'))}</button>`)}</div>`;
    };
    const n = Object.keys(H).length, held = B.filter(b => H[b.id]), free = B.filter(b => !H[b.id]);
    // v2.23.0 (Zhax, 26-11-2026): no CQ — bins não conformes primeiro, a pedir autorização do Supervisor (ou acima) para libertar
    return `<section class="card"><h3>${esc(t('ncTitle'))}${n ? ` <span class="chip d-reject">${n}</span>` : ''}</h3>
      ${held.length ? `<div class="banner b-reject">${esc(t('ncNeedSup'))}</div>${held.map(row).join('')}` : `<p class="sub">${esc(t('ncNone'))}</p>`}
      <details ${f && !f.mq && !H[f.binId] ? 'open' : ''}><summary>${esc(t('ncHoldOther'))}</summary>${free.map(row).join('')}</details></section>`;
  }
  // v2.23.0: amostra do CQ «reject» com bin de destino → a bin fica retida automaticamente (libertar só com PIN de Supervisor ou acima)
  async function autoHold(binId, sample) {
    const b = P.holdableBins(S.cfgP).find(x => x.id === binId); if (!b || holds()[binId]) return false;
    const tms = now();
    await DB.add('prodChanges', Object.assign(base(tms), { t: tms, kind: 'binHold', binId: b.id, binKind: b.kind, reason: t('ncAutoReason', { id: String(sample.id || '').slice(-6), p: C.prodName(sample.productId) }),
      by: sample.operator, role: 'qc', auto: true, sampleId: sample.id || null, productId: sample.productId || null }));
    await reload(); return true;
  }
  const productBinIds = () => (S.cfgP.bins || []).map(b => b.id);
  async function holdSave() {
    const f = S.holdForm, reason = ($('#hd_reason') || {}).value || '';
    const wh = await C.who(($('#hd_pin') || {}).value, ['sup', 'chief', 'head', 'pm']); if (wh.err) return C.toast(wh.err); const by = wh.title;
    const E = P.validateHold({ binId: f.binId, reason, by }, S.cfgP, holds(), f.release);
    if (E.length) return C.toast(E.map(x => t(x)).join(' · '));
    const r = await C.checkPin(($('#hd_pin') || {}).value);
    if (!r.ok) return C.toast(C.pinMsg(r));
    const b = P.holdableBins(S.cfgP).find(x => x.id === f.binId), tms = now();
    try { await DB.add('prodChanges', Object.assign(base(tms), { t: tms, kind: f.release ? 'binRelease' : 'binHold', binId: b.id, binKind: b.kind, reason: reason.trim(), by: by.trim(), role: 'qc', sampleUid: f.sampleUid || null,
      productId: b.kind === 'product' ? P.binState(b.id, S.binEvents).productId || null : null })); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = by.trim(); await DB.setConfig('operator', S.operator);
    S.holdForm = null; await reload(); C.toast(t(f.release ? 'holdReleased' : 'holdSaved', { b: b.id })); keepScroll();
  }
  function holdIssues() { const H = holds(); return Object.keys(H).map(id => t('holdIssue', { b: id, r: H[id].reason })); }
  function viewBins() {
    const a = S.binAct;
    // v2.18.0 (Zhax, 26-11-2026): Bin | Quantidade | Tipo | Grau | Data de enchimento | Retenção; o chefe de turno grava a quantidade; total por grau
    const qtyTbl = productsCard() + `<!-- v2.17 -->` + (false ? `<section class="card"><h3>${esc(t('binQtyTitle'))}</h3><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('bin'))}</th><th>${esc(t('product'))}</th><th>kg</th><th>%</th></tr>${S.cfgP.bins.map(b => {
      const st = P.binState(b.id, S.binEvents), lv = levelOf(b.id) || {};
      return `<tr><td><b>${esc(b.id)}</b></td><td>${esc(st.productId ? C.prodName(st.productId) : t('binEmpty'))}</td><td>${isNum(lv.kg) ? fmtKg(lv.kg) : '—'}</td><td>${isNum(lv.pct) ? esc(String(lv.pct).replace('.', ',')) + ' %' : '—'}</td></tr>`; }).join('')}</table></div></section>` : '');
    return qtyTbl + totalsCard() +   // v2.22.0: retenções no Controlo de Qualidade
      `<section class="card"><h3>${esc(t('ptab_bins'))}</h3>
      ${S.cfgP.bins.map(b => {
        const st = P.binState(b.id, S.binEvents);
        const job = st.jobUid ? S.jobs.find(j => j.uid === st.jobUid) : null;
        const mine = a && a.id === b.id ? a.mode : null;
        return `<div class="rowitem"><div class="row between"><span><b>${esc(b.id)}</b> <small>${esc(t('fedBy'))} ${esc(b.lines.join('/'))}${isNum(b.capKg) ? ' · ' + fmtKg(b.capKg) + ' kg' : ''}</small></span>
          <span class="chip ${st.productId ? 'd-warn' : 'd-accept'}">${esc(st.productId ? C.prodName(st.productId) : t('binEmpty'))}</span></div>${levelBar(b.id)}
          ${st.since ? `<small>${esc(t('since'))} ${esc(C.fmtDT(st.since))}${job ? ' · ' + esc(C.lineName(job.lineId)) + (job.status === 'running' ? ' (' + esc(t('js_running')) + ')' : '') : ''}${st.last && st.last.by ? ' · ' + esc(st.last.by) : ''}</small>` : ''}
          ${mine ? `<div class="holdform">
            ${mine === 'out' ? `<div class="grid2"><label class="fld req">${esc(t('outKg'))}<input inputmode="decimal" id="ba_kg"></label>
              <label class="fld req">${esc(t('outDest'))}<select id="ba_dest">${P.OUT_DESTS.map(d => `<option value="${d}">${esc(t('dest_' + d))}</option>`).join('')}</select></label></div>
              <label class="fld">${esc(t('notes'))}<input id="ba_note"></label>` : ''}
            ${mine === 'qty' ? `<label class="fld req">${esc(t('binQtyKg'))}<input inputmode="decimal" id="ba_qkg"></label>` : ''}
            ${mine === 'set' || (mine === 'qty' && !st.productId) ? `<label class="fld ${mine === 'set' ? 'req' : ''}">${esc(t('product'))}<select id="ba_prod"><option value="">—</option>${C.products().map(p => `<option value="${esc(p.id)}">${esc(C.prodName(p.id))}</option>`).join('')}</select></label>` : ''}
            ${mine === 'zero' ? `<p><b>${esc(t('binZeroAsk', { b: b.id }))}</b></p>` : ''}

            ${mine === 'empty' ? `<p class="sub">${esc(t('emptyBinNote'))}</p>` : ''}${C.pinFld('ba_pin')}
            <button class="btn primary small" data-pact="${mine === 'set' ? 'setbin' : mine === 'out' ? 'outbin' : mine === 'qty' || mine === 'zero' ? 'qtybin' : 'emptybin'}">${esc(t('save'))}</button> <button class="btn ghost small" data-pact="cancelba">${esc(t('cancel'))}</button></div>`
          : `<div class="row">${st.productId ? `<button class="btn small" data-binact="out" data-bin="${esc(b.id)}">${esc(t('binOutBtn'))}</button>` : ''}${st.productId ? `<button class="btn ghost small" data-binact="empty" data-bin="${esc(b.id)}">${esc(t('binEmptyBtn'))}</button>` : ''}<button class="btn ghost small" data-binact="set" data-bin="${esc(b.id)}">${esc(t('binSetBtn'))}</button><button class="btn small" data-binact="qty" data-bin="${esc(b.id)}">${esc(t('binQtyBtn'))}</button><button class="btn ghost small" data-binact="zero" data-bin="${esc(b.id)}">${esc(t('binZeroBtn'))}</button></div>`}</div>`;
      }).join('')}</section>`;
  }
  const PTYPES = ['Branco', 'Amarelo'], PGRADES = ['1', '2'];
  function productRow(b) {
    const st = P.binState(b.id, S.binEvents), lv = lastLevel(b.id) || {}, lvl = levelOf(b.id) || {};
    const g0 = /([12])$/.exec(String(st.productId || '')), H = holds()[b.id];
    return { id: b.id, productId: st.productId, kg: isNum(lvl.kg) ? lvl.kg : lv.kg, colour: lv.colour || '', grade: lv.grade || (g0 ? g0[1] : ''), filled: st.productId ? st.since : null, hold: H || null };
  }
  function productsCard() {
    const rows = S.cfgP.bins.map(productRow), f = S.pqForm;
    const opt = (list, v, lab) => `<option value="">—</option>` + list.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(lab ? lab(x) : x)}</option>`).join('');
    return `<section class="card"><h3>${esc(t('ptab_bins'))}</h3><div class="tablewrap"><table class="tbl"><tr><th>${esc(t('bin'))}</th><th>${esc(t('quantityKg'))}</th><th>${esc(t('mzType'))}</th><th>${esc(t('mzGrade'))}</th><th>${esc(t('dateFilled'))}</th><th>${esc(t('holdCol'))}</th></tr>
      ${rows.map(r => { const x = f ? (f[r.id] || {}) : null;
        return `<tr><td><b>${esc(r.id)}</b>${r.productId ? '<br>' + esc(C.prodName(r.productId)) : x ? `<br><select data-pq="${esc(r.id)}|productId"><option value="">${esc(t('product'))}</option>${C.products().map(pp => `<option value="${esc(pp.id)}" ${x.productId === pp.id ? 'selected' : ''}>${esc(C.prodName(pp.id))}</option>`).join('')}</select>` : ''}</td>
          <td>${x ? `<input inputmode="decimal" data-pq="${esc(r.id)}|kg" value="${esc(x.kg || '')}" style="max-width:100px">` : isNum(r.kg) ? fmtKg(r.kg) : '—'}</td>
          <td>${x ? `<select data-pq="${esc(r.id)}|colour">${opt(PTYPES, x.colour !== undefined ? x.colour : r.colour, typeName)}</select>` : esc(typeName(r.colour))}</td>
          <td>${x ? `<select data-pq="${esc(r.id)}|grade">${opt(PGRADES, x.grade !== undefined ? x.grade : r.grade)}</select>` : dash(r.grade)}</td>
          <td>${r.filled ? esc(C.fmtDT(r.filled).slice(0, 10)) : '—'}</td><td>${r.hold ? `<span class="chip d-reject">${esc(t('onHold'))}</span>` : '—'}</td></tr>`; }).join('')}</table></div>
      ${f ? `${C.pinFld('pq_pin')}<button class="btn primary big" data-pact="pqsave">${esc(t('save'))}</button><button class="btn ghost" data-pact="pqcancel">${esc(t('cancel'))}</button>`
        : `<button class="btn primary" data-pact="pqnew">${esc(t('pqNew'))}</button>`}
      <h4>${esc(t('gradeTotals'))}</h4>${gradeTotals(rows)}</section>`;
  }
  async function saveProducts() {
    const f = S.pqForm, w = await whoP('pq_pin'); if (!w) return;
    const levels = {};
    S.cfgP.bins.forEach(b => { const x = f[b.id] || {}; if (String(x.kg || '').trim() !== '') { const r = productRow(b);
      levels[b.id] = { kg: x.kg, productId: r.productId || x.productId || '', colour: x.colour !== undefined ? x.colour : r.colour, grade: x.grade !== undefined ? x.grade : r.grade }; } });
    if (!Object.keys(levels).length) return C.toast(t('pqNone'));
    S.pqForm = null;
    return stockSave({ levels, by: w.title, scope: 'products' });
  }
  // ---------- totais das bins de manhã (v2.4.0) ----------
  const LV_CLS = { FULL: 'd-reject', OVER: 'd-reject', NEG: 'd-reject', EMPTY: 'd-accept', OK: '', UNKNOWN: 'd-record' };
  function levelBar(id) {
    const lv = levelOf(id);
    if (!lv) return '';
    if (!isNum(lv.kg)) return `<small class="sub">${esc(t('stockUnknown'))}</small>`;
    const pct = Math.max(0, Math.min(100, lv.pct || 0));
    const col = pct >= 100 ? 'var(--rej)' : pct >= 90 ? 'var(--warn)' : 'var(--ok)';
    const st = lv.state === 'FULL' ? t('stockFull') : lv.state === 'OVER' ? t('stockOver') : t('stockFree') + ' ' + fmtKg(lv.freeKg) + ' kg';
    return `<div class="lvbar"><div style="width:${pct}%;background:${col}"></div></div>
      <small>${fmtKg(lv.kg)} kg (${esc(String(lv.pct).replace('.', ','))} %) · <span class="chip ${LV_CLS[lv.state] || ''}">${esc(st)}</span>${lv.reading ? ' · ' + esc(t('stockLast')) + ' ' + esc(C.fmtDT(lv.reading.t)) + (lv.inKg || lv.outKg ? ' (+' + fmtKg(lv.inKg) + ' −' + fmtKg(lv.outKg) + ' kg ' + esc(t('stockSince')) + ')' : '') : ''}</small>`;
  }
  function stockCard() {
    const f = S.stockForm, B = P.stockBins(S.cfgP);
    const last = (S.stocks || []).slice().sort((x, y) => y.t - x.t)[0];
    let h = `<section class="card"><h3>${esc(t('stockTitle'))}</h3>
      <p class="sub">${last ? esc(t('stockLast')) + ': <b>' + esc(C.fmtDT(last.t)) + '</b> · ' + esc(last.by) : esc(t('stockNone'))}</p>`;
    if (!f) return h + `<button class="btn primary" data-pact="stocknew">${esc(t('stockNew'))}</button></section>`;
    h += ``;
    P.STOCK_KINDS.filter(k => k === 'product').forEach(k => {   // v2.17.0: bins D/M e C/M no separador Milho (mergulhos)
      h += `<h4>${esc(t('stockKind_' + k))}</h4><table class="tbl stock"><tr><th></th><th>${esc(t('stockKg'))}</th>${k === 'product' ? `<th>${esc(t('product'))}</th>` : ''}</tr>` +
        B.filter(b => b.kind === k).map(b => { const x = f.levels[b.id] || {};
          const dip = k === 'dirty' && P.DIP.bins.indexOf(b.id) >= 0, dk = dip && String(x.dipM || '').trim() !== '' ? P.dipKg(x.dipM) : null;
          const kgCell = dip ? `<label class="fld">${esc(t('dipD'))}<input inputmode="decimal" data-stk="${esc(b.id)}|dipM" value="${esc(x.dipM || '')}"></label><small id="dipkg_${esc(b.id)}">${dipKgText(x.dipM, dk)}</small>`
            : `<input inputmode="decimal" data-stk="${esc(b.id)}|kg" value="${esc(x.kg || '')}">`;
          return `<tr><td><b>${esc(b.id)}</b><br><small>${isNum(b.capKg) ? fmtKg(b.capKg) + ' kg' : ''}</small></td><td>${kgCell}</td>${k === 'product'
            ? `<td><select data-stk="${esc(b.id)}|productId"><option value="">—</option>${C.products().map(p => `<option value="${esc(p.id)}" ${x.productId === p.id ? 'selected' : ''}>${esc(C.prodName(p.id))}</option>`).join('')}</select></td>` : ''}</tr>`; }).join('') + '</table>';
    });
    return h + `${C.pinFld('stk_pin')}
      <button class="btn primary big" data-pact="stocksave">${esc(t('save'))}</button><button class="btn ghost" data-pact="stockcancel">${esc(t('cancel'))}</button></section>`;
  }
  // v2.6.0: mergulho das bins de milho sujo, (20 − D) × 6 750 kg
  const dipKgText = (raw, kg) => String(raw || '').trim() === '' ? esc(t('dipHint')) : isNum(kg) ? fmtKg(kg) + ' kg' : esc(t('dipBad'));
  function newStockForm() {
    const levels = {};
    P.stockBins(S.cfgP).filter(b => b.kind === 'product').forEach(b => { const st = P.binState(b.id, S.binEvents); levels[b.id] = { kg: '', productId: st.productId || '' }; });
    S.stockForm = { levels, by: S.operator };
  }
  const stockMsg = e => t((e.warn ? 'jw_' : 'je_') + e.code, { bin: e.bin, cap: isNum(e.cap) ? fmtKg(e.cap) : '', kg: isNum(e.kg) ? fmtKg(e.kg) : '', max: e.max || '', current: e.current ? C.prodName(e.current) : '' });
  // v2.16.0: quantidade ou zero de uma só bin (separador Silos de produto) grava-se como leitura dessa bin
  async function binQty() {
    const a = S.binAct, st = P.binState(a.id, S.binEvents);
    const kg = a.mode === 'zero' ? '0' : (($('#ba_qkg') || {}).value || '').trim();
    if (!kg) return C.toast(t('binQtyKg'));
    const w = await whoP('ba_pin'); if (!w) return;
    return stockSave({ levels: { [a.id]: { kg, productId: st.productId || (($('#ba_prod') || {}).value) || '' } }, by: w.title, scope: 'bin' });
  }
  async function stockSave(fo) {
    const f = fo || S.stockForm;
    if (!fo) { const w = await whoP('stk_pin'); if (!w) return; f.by = w.title; }
    const r = P.validateBinStock(f, S.cfgP, { binEvents: S.binEvents, jobs: S.jobs });
    if (r.errors.length) return C.toast(r.errors.map(stockMsg).join(' · '));
    Object.keys(r.values).forEach(id => { const x = (f.levels || {})[id] || {}; if (x.colour !== undefined) r.values[id].colour = x.colour || ''; if (x.grade !== undefined) r.values[id].grade = x.grade || ''; });
    const tms = now(), by = String(f.by).trim();
    // leitura + conteúdo das bins de produto (SET/EMPTY), tudo-ou-nada
    const ops = [{ store: 'binStock', op: 'add', obj: Object.assign(base(tms), { kind: 'stock', t: tms, levels: r.values, by, scope: f.scope || 'all', warnings: r.warnings.map(w => w.code + ':' + w.bin) }) }].concat(r.binOps.map((o, i) =>
      ({ store: 'binEvents', op: 'add', obj: Object.assign(base(tms), { binId: o.binId, type: o.type, productId: o.productId, t: tms, seq: i + 1, by, previous: o.previous, source: 'stock' }) })));
    try { await DB.batch(ops); } catch (e) { return C.toast(t('saveFailed')); }
    S.operator = String(f.by).trim(); await DB.setConfig('operator', S.operator);
    if (fo) S.binAct = null; else S.stockForm = null; await reload();
    C.toast(r.warnings.length ? t('stockSaved') + ' — ' + r.warnings.map(w => stockMsg(Object.assign({ warn: true }, w))).join(' · ') : t('stockSaved')); keepScroll();
  }
  // Aviso na página inicial: leitura do dia de produção em falta
  const stockDue = () => !P.stockDone(S.stocks, L.prodDay(now()));

  // v2.6.0: saída de produto da bin durante o dia (ensaque, granel, transferência, outra); baixa o nível, não muda o conteúdo
  async function binOut() {
    const id = S.binAct.id;
    const w = await whoP('ba_pin'); if (!w) return;
    const r = P.validateDispatch({ binId: id, kg: $('#ba_kg').value, dest: $('#ba_dest').value, by: w.title, note: $('#ba_note').value }, S.cfgP, S.binEvents, holds());
    if (r.errors.length) return C.toast(r.errors.map(e => t('je_' + e.code, { bin: e.bin, field: e.field ? t('f_' + e.field) : '' })).join(' · '));
    const tms = now(), v = r.values;
    try { await DB.add('binEvents', Object.assign(base(tms), { binId: id, type: 'OUT', productId: v.productId, kg: v.kg, dest: v.dest, note: v.note, t: tms, seq: 0, by: v.by })); }
    catch (e) { return C.toast(t('saveFailed')); }
    S.operator = v.by; await DB.setConfig('operator', S.operator);
    S.binAct = null; await reload(); C.toast(t('outSaved', { kg: fmtKg(v.kg), b: id })); keepScroll();
  }
  async function binAction(mode) {
    const id = S.binAct.id, w = await whoP('ba_pin', mode === 'set' ? ['sup', 'chief', 'head', 'pm'] : null); if (!w) return; const by = w.title;
    const st = P.binState(id, S.binEvents);
    if (mode === 'empty') {
      const job = st.jobUid ? S.jobs.find(j => j.uid === st.jobUid) : null;
      if (job && job.status === 'running') return C.toast(t('binInUse'));
    }
    let productId = null;
    if (mode === 'set') {
      productId = $('#ba_prod').value;
      if (!productId) return C.toast(t('selectProductFirst'));
    }
    const tms = now();
    try { await DB.add('binEvents', Object.assign(base(tms), { binId: id, type: mode === 'set' ? 'SET' : 'EMPTY', productId, t: tms, seq: 0, by, previous: st.productId })); }
    catch (e) { return C.toast(t('saveFailed')); }
    S.binAct = null; await reload(); C.toast(t('saved')); keepScroll();
  }

  // ---------- definições de produção ----------
  function settingsCard() {
    const c = S.cfgP;
    const ctxCard = `<section class="card"><h3>${esc(t('ctxTitle'))}</h3>
      <label class="fld">${esc(t('ctxOperator'))}<input data-ctx="operatorId" value="${esc((S.ctx && S.ctx.operatorId) || '')}" maxlength="40"></label>
      <label class="chk"><input type="checkbox" data-ctx="testMode" ${S.ctx && S.ctx.testMode ? 'checked' : ''}> ${esc(t('ctxTest'))}</label></section>`;
    return ctxCard + `<section class="card"><h3>${esc(t('prodSettings'))}</h3>
      <p class="sub">${esc(t('prodSettingsSummary', { c: lineIds().map(id => id + ' ' + fmtKg(c.lineKgDay[id]) + ' kg/d').join(' · '), d: lineIds().map(id => id + ' ' + fmtKg(P.dampenerMax(c, id))).join(' · '), b: c.bins.length }))}</p>
      <button class="btn" data-nav="prodset">${esc(t('editProdSettings'))}</button></section>
      <section class="card"><h3>${esc(t('dx_title'))}</h3>
      <p class="sub">${esc(dbSess() && dbSess().refreshToken ? t('dx_on') : t('dx_off'))}</p>
      ${daySyncLine()}
      <button class="btn" data-pact="dbsignin">${esc(t('dx_connect'))}</button> <button class="btn" data-pact="dbsyncnow">${esc(t('dx_sendnow'))}</button> <button class="btn ghost" data-pact="dbsignout">${esc(t('dx_disconnect'))}</button></section>
      <section class="card"><h3>${esc(t('srdTitle'))}</h3>
      <p class="sub">${esc(srSess() ? t('srdOn') : t('srdNotConnected'))}</p>
      <p class="sub">${esc(S.autoSilo ? t('srdLast', { e: C.fmtDT(Date.parse(S.autoSilo.exportedAt)), f: C.fmtDT(S.autoSilo.fetchedAt), n: S.autoSilo.moves.length }) : t('srdNone'))}${S.autoSiloErr ? ' · ' + esc(S.autoSiloErr) : ''}</p>
      <button class="btn" data-pact="srdsignin">${esc(t('srdConnect'))}</button> <button class="btn" data-pact="srdnow">${esc(t('srdReadNow'))}</button></section>
      <section class="card"><h3>${esc(t('codesTitle'))}</h3>
      <p class="sub">${esc(t('codesSummary', { n: codes().filter(c => c.active !== false).length, s: S.cfgP.codesSource || '', pt: codes().filter(c => c.namePt).length, o: codes().filter(c => c.oee).length }))}</p>
      <button class="btn" data-nav="codes">${esc(t('editCodes'))}</button></section>`;
  }
  function viewProdSet() {
    if (!S.prodDraft) S.prodDraft = JSON.parse(JSON.stringify(S.cfgP));
    const d = S.prodDraft;
    return `<section class="card"><h2>${esc(t('prodSettings'))}</h2>
      <div class="grid2">${lineIds().map(id => `<label class="fld">${esc(t('lineCap', { l: C.lineName(id) }))}<input inputmode="decimal" data-ps="tpd|${esc(id)}" value="${esc(C.fmtNum(d.lineKgDay[id]))}"></label>`).join('')}
      ${lineIds().map(id => `<label class="fld">${esc(t('dampenerMaxLine', { l: C.lineName(id) }))}<input inputmode="decimal" data-ps="dampl|${esc(id)}" value="${esc(C.fmtNum(P.dampenerMax(d, id)))}"></label>`).join('')}</div></section>
      <section class="card"><h3>${esc(t('masterData'))}</h3>
        <label class="fld">${esc(t('grainSilosList'))}<textarea rows="2" data-ps="grainSilos">${esc((d.grainSilos || []).join(', '))}</textarea></label>
        
        <label class="fld">${esc(t('dirtyBins'))}<textarea rows="2" data-ps="dirtyBins">${esc(P.binsText(d.dirtyBins || []))}</textarea></label>
        <label class="fld">${esc(t('temperedBins'))}<textarea rows="2" data-ps="temperedBins">${esc(P.binsText(d.temperedBins || []))}</textarea></label>
        <label class="fld">${esc(t('ptab_bins'))}<textarea rows="4" data-ps="bins">${esc(P.binsText(d.bins))}</textarea></label>
        <h3>${esc(t('leaders'))}</h3>
        <div class="grid2">${['A', 'B', 'C', 'D'].map(k => `<label class="fld">${esc(t('crew'))} ${k}<input data-ps="leader|${k}" value="${esc((d.leaders || {})[k] || '')}" maxlength="60"></label>`).join('')}</div>
        
        <h3>${esc(t('floors'))}</h3>
        <label class="fld"><input data-ps="floors" value="${esc((d.floors || []).join(', '))}"></label>
        <h3>${esc(t('rpSection'))}</h3>
        <label class="fld">${esc(t('rpSecList'))}<textarea rows="2" data-ps="pneuSec">${esc(P.pneuSections(d).join(', '))}</textarea></label>
        <h3>${esc(t('mqTitle'))} · ${esc(t('mqLimits'))}</h3><p class="sub">${esc(t('mqLimHelp'))}</p>
        ${Object.keys(P.MZQC_STAGES).map(st => { const LM = P.maizeQcLimits(d)[st]; return `<h4>${esc(t('mqs_' + st))}</h4><div class="tablewrap"><table class="tbl"><tr><th></th>${P.MZQC_LIM_KEYS.map(x => `<th>${esc(t('mql_' + x))}</th>`).join('')}</tr>
          ${P.MZQC_STAGES[st].nums.map(k => `<tr><td>${esc(t('mq_' + k))}</td>${P.MZQC_LIM_KEYS.map(x => `<td><input inputmode="decimal" style="max-width:70px" data-ps="mzl|${st}|${k}|${x}" value="${esc(LM[k] && isNum(LM[k][x]) ? C.fmtNum(LM[k][x]) : '')}"></td>`).join('')}</tr>`).join('')}</table></div>`; }).join('')}
        <h4>${esc(t('mqs_cm_b1'))} · ${esc(t('mqTargetT'))}</h4>
        <div class="grid2"><label class="fld">${esc(t('mqTargetM'))}<input inputmode="decimal" data-ps="b1t|moisture" value="${esc(C.fmtNum(P.b1Target(d).moisture))}"></label>
          <label class="fld">${esc(t('mqTargetTol'))}<input inputmode="decimal" data-ps="b1t|tol" value="${esc(P.b1Target(d).tol === null ? '' : C.fmtNum(P.b1Target(d).tol))}"></label></div>
        <h3>${esc(t('procTitle'))}</h3>
        ${P.PROC_GROUPS.map(g => { const c = P.procMaintCfg(d)[g]; return `<h4>${esc(t('pg_' + g))}</h4>
          <label class="fld">${esc(t('procSections'))}<textarea rows="2" data-ps="procSec|${g}">${esc(c.sections.join(', '))}</textarea></label>
          <label class="fld">${esc(t('procTasks'))}<textarea rows="2" data-ps="procTask|${g}">${esc(c.tasks.map(procTaskLabel).join(', '))}</textarea></label>`; }).join('')}</section>
      <section class="card">
        <label class="fld req">${esc(t('reason'))}<input id="psReason"></label>
        <label class="fld req">${esc(t('pin'))}<input type="password" maxlength="4" id="psPin"></label>
        <button class="btn primary big" data-pact="saveprodset">${esc(t('save'))}</button>
        <button class="btn ghost" data-nav="settings">${esc(t('cancel'))}</button></section>`;
  }
  async function saveProdSet() {
    const reason = $('#psReason').value.trim();
    if (!reason) return C.toast(t('needByReason'));
    const wp = await whoP('psPin', ['sup', 'chief', 'head', 'pm']); if (!wp) return; const by = wp.title;
    const n = JSON.parse(JSON.stringify(S.cfgP));
    const bad = [];
    document.querySelectorAll('[data-ps]').forEach(el => {
      const [k, a, b] = el.dataset.ps.split('|');
      if (k === 'tpd') { const v = P.num(el.value); if (v === null || isNaN(v) || v <= 0) bad.push(t('lineCap', { l: a })); else n.lineKgDay[a] = v; }
      if (k === 'dampl') { const v = P.num(el.value); if (v === null || isNaN(v) || v <= 0) bad.push(t('dampenerMaxLine', { l: a })); else { n.dampenerMaxLhByLine = Object.assign({}, n.dampenerMaxLhByLine); n.dampenerMaxLhByLine[a] = v; } }
      if (k === 'bins') { const r = P.parseBins(el.value, lineIds()); if (r.errors.length || !r.bins.length) bad.push(t('ptab_bins') + ': ' + (r.errors.join(' | ') || '—')); else n.bins = r.bins; }
      if (k === 'dirtyBins' || k === 'temperedBins') { const r = P.parseBins(el.value, lineIds()); if (r.errors.length || !r.bins.length) bad.push(t(k) + ': ' + (r.errors.join(' | ') || '—')); else n[k] = r.bins; }
      if (k === 'grainSilos') { const r = P.parseSiloList(el.value); if (r.errors.length || !r.silos.length) bad.push(t('grainSilosList') + ': ' + (r.errors.join(' | ') || '—')); else n.grainSilos = r.silos; }
      if (k === 'leader') { n.leaders = Object.assign({}, n.leaders); n.leaders[a] = el.value.trim().replace(/\s+/g, ' '); }
      if (k === 'procSec' || k === 'procTask') {
        n.procMaint = Object.assign({}, P.procMaintCfg(n), n.procMaint);
        const g = Object.assign({}, P.procMaintCfg(n)[a]);
        if (k === 'procSec') g.sections = P.expandSections(el.value);
        else {
          // nome igual ao de uma tarefa da app → guarda o código (mostra-se na língua de quem lê); outro → texto como escrito
          g.tasks = el.value.split(/[,\n;]/).map(x => x.trim()).filter(Boolean).map(x => { const c = P.PROC_TASK_CODES.find(k2 => t('pt_' + k2).toLowerCase() === x.toLowerCase()); return c ? '@' + c : x; }).filter((x, i, arr) => arr.indexOf(x) === i);
          if (!g.tasks.length) bad.push(t('pg_' + a) + ': ' + t('procTasks'));
        }
        n.procMaint[a] = g;
      }
      if (k === 'b1t') {
        const raw = el.value.trim(), v = raw ? P.num(raw) : null;
        n.b1Target = Object.assign({}, P.b1Target(n.b1Target ? n : S.cfgP));
        if (a === 'moisture') { if (v === null || isNaN(v) || v <= 0 || v > 100) bad.push(t('mqTargetM')); else n.b1Target.moisture = v; }
        else { if (raw && (v === null || isNaN(v) || v < 0)) bad.push(t('mqTargetTol')); else n.b1Target.tol = v; }
      }
      if (k === 'pneuSec') { const L = el.value.split(/[,\n;]/).map(x => x.trim()).filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i); if (!L.length) bad.push(t('rpSecList')); else n.pneuSections = L; }
      if (k === 'mzl') {   // a|b|c = etapa|valor|tipo de limite; vazio = sem esse limite
        const [st, par, lk] = [a, b, el.dataset.ps.split('|')[3]];
        n.maizeLimits = n.maizeLimits || JSON.parse(JSON.stringify(P.maizeQcLimits(S.cfgP)));
        const raw = el.value.trim(), v = raw ? P.num(raw) : null;
        if (raw && (v === null || isNaN(v) || v < 0)) { bad.push(t('mqs_' + st) + ' · ' + t('mq_' + par)); return; }
        n.maizeLimits[st] = n.maizeLimits[st] || {}; const m = Object.assign({}, n.maizeLimits[st][par]);
        if (v === null) delete m[lk]; else m[lk] = v;
        if (Object.keys(m).length) n.maizeLimits[st][par] = m; else delete n.maizeLimits[st][par];
      }
      if (k === 'floors') n.floors = el.value.split(',').map(x => x.trim()).filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i);
    });
    if (bad.length) return C.toast(t('limitErrors') + ': ' + bad.join('; '));
    const errs = P.validateProdConfig(n);
    if (errs.length) return C.toast(t('limitErrors') + ': ' + errs.join(', '));
    if (JSON.stringify(n.bins) !== JSON.stringify(S.cfgP.bins)) n.binSource = t('changedBy', { by, d: C.fmtDT(now()).slice(0, 10) });
    if (['grainSilos', 'dirtyBins', 'temperedBins'].some(k => JSON.stringify(n[k]) !== JSON.stringify(S.cfgP[k]))) n.masterSource = P.MASTER_SOURCE + ' + ' + t('changedBy', { by, d: C.fmtDT(now()).slice(0, 10) });
    const newPins = [];
    const diff = P.prodConfigDiff(S.cfgP, n);
    if (!diff.length && !newPins.length) return C.toast(t('noChanges'));
    const r = await C.checkPin($('#psPin').value);
    if (!r.ok) return C.toast(C.pinMsg(r));
    const tms = now();
    try {
      // o PIN não vai para os registos: só fica a nota de que foi mudado, por quem e porquê
      const pinRecs = newPins.map(x => ({ field: 'leaderPin.' + x.crew, old: JSON.stringify((S.leaderPins || {})[x.crew] ? 'set' : null), new: JSON.stringify('set') }));
      if (diff.length || pinRecs.length) await DB.batch(diff.concat(pinRecs).map(x => ({ store: 'prodChanges', op: 'add', obj: Object.assign(base(tms), { t: tms, by, reason }, x) })));
      await DB.setConfig('cfgP', n);
      if (newPins.length) { const lp = Object.assign({}, S.leaderPins); for (const x of newPins) lp[x.crew] = await makeLeaderPin(x.pin); await DB.setConfig('leaderPins', lp); S.leaderPins = lp; }
    } catch (e) { return C.toast(t('saveFailed')); }
    S.cfgP = n; S.prodDraft = null; await reload();
    C.toast(t('limitsSaved', { n: diff.length + newPins.length })); S.view = 'settings'; C.render(); window.scrollTo(0, 0);
  }

  // ---------- códigos de paragem: editor (autorização) ----------
  function viewCodes() {
    const opt = (list, v, lab) => `<option value="">—</option>` + list.map(x => `<option value="${esc(x)}" ${v === x ? 'selected' : ''}>${esc(lab ? lab(x) : x)}</option>`).join('');
    return `<section class="card"><h2>${esc(t('codesTitle'))}</h2>
      ${(S.cfgP.codesDropped || []).length ? `<p class="sub"><b>${esc(t('codesDroppedNote', { c: S.cfgP.codesDropped.join(', ') }))}</b></p>` : ''}</section>
      ${codes().map((c, i) => `<details class="card code-ed ${c.active === false ? 'inactive' : ''}"><summary><b>${esc(c.code)}</b> ${esc(cName(c))} <small>· ${esc(tierLabel(c.tier3))} · ${esc(oeeLabel(c.oee))}${c.active === false ? ' · ' + esc(t('inactive')) : ''}</small></summary>
        <div class="grid2">
          <label class="fld">${esc(t('codeName'))} (EN)<input data-cd="${i}|name" value="${esc(c.name)}"></label>
          <label class="fld">${esc(t('codeNamePt'))}<input data-cd="${i}|namePt" value="${esc(c.namePt || '')}"></label>
          <label class="fld">Tier 3<select data-cd="${i}|tier3">${opt(P.TIER3, c.tier3)}</select></label>
          <label class="fld">${esc(t('oeeTreat'))}<select data-cd="${i}|oee">${opt(P.OEE_TREAT, c.oee, o => t('oee_' + P.OEE_KEY[o]))}</select></label>
          <label class="chk"><input type="checkbox" data-cd="${i}|active" ${c.active !== false ? 'checked' : ''}> ${esc(t('activeCode'))}</label>
        </div></details>`).join('')}
      <section class="card"><h3>${esc(t('newCode'))}</h3><div class="grid2">
        <label class="fld">${esc(t('downtimeCode'))}<input id="nc_code" placeholder="P25"></label>
        <label class="fld">${esc(t('codeName'))} (EN)<input id="nc_name"></label></div></section>
      <section class="card">
        <label class="fld req">${esc(t('reason'))}<input id="cdReason"></label>
        <label class="fld req">${esc(t('pin'))}<input type="password" maxlength="4" id="cdPin"></label>
        <button class="btn primary big" data-pact="savecodes">${esc(t('save'))}</button>
        <button class="btn ghost" data-nav="settings">${esc(t('cancel'))}</button></section>`;
  }
  async function saveCodes() {
    const reason = $('#cdReason').value.trim();
    if (!reason) return C.toast(t('needByReason'));
    const wp = await whoP('cdPin', ['sup', 'chief', 'head', 'pm']); if (!wp) return; const by = wp.title;
    const list = JSON.parse(JSON.stringify(codes()));
    document.querySelectorAll('[data-cd]').forEach(el => {
      const [i, f] = el.dataset.cd.split('|'); const c = list[Number(i)]; if (!c) return;
      if (f === 'active') c.active = el.checked;
      else { const v = el.value.trim(); c[f] = v === '' ? (f === 'name' ? '' : null) : v; }
    });
    const nc = $('#nc_code').value.trim().toUpperCase(), nn = $('#nc_name').value.trim();
    if (nc || nn) list.push({ code: nc, name: nn, namePt: null, tier3: null, oee: null, active: true });
    const errs = P.validateCodes(list);
    if (errs.length) return C.toast(t('limitErrors') + ': ' + errs.join(', '));
    const n = Object.assign({}, S.cfgP, { downtimeCodes: list });
    const diff = P.prodConfigDiff(S.cfgP, n);
    if (!diff.length) return C.toast(t('noChanges'));
    const r = await C.checkPin($('#cdPin').value);
    if (!r.ok) return C.toast(C.pinMsg(r));
    n.codesSource = (P.DOWNTIME_SOURCE) + ' + ' + t('changedBy', { by, d: C.fmtDT(now()).slice(0, 10) });
    const tms = now();
    try {
      await DB.batch(diff.map(x => ({ store: 'prodChanges', op: 'add', obj: Object.assign(base(tms), { t: tms, by, reason }, x) })));
      await DB.setConfig('cfgP', n);
    } catch (e) { return C.toast(t('saveFailed')); }
    S.cfgP = n; await reload(); C.toast(t('limitsSaved', { n: diff.length })); S.view = 'settings'; C.render(); window.scrollTo(0, 0);
  }

  // ---------- início: resumo por linha ----------
  function homeLine(lineId) {
    const j = runningJob(lineId);
    if (!j) return '';
    const rs = (j.readings || []), lw = rs.length ? rs[rs.length - 1].waterLh : j.waterLh;
    return `<div class="banner b-info" data-nav="prod">▶ ${esc(t('jobOnLine', { p: prodNames(j), kg: fmtKg(j.grainKg), w: fmtKg(lw), h: C.fmtTime(j.startedAt) }))}</div>
      ${P.needsShiftReading(j, L.shiftOf(now()).start) ? `<div class="banner b-warn" data-nav="prod">${esc(t('needReading'))}</div>` : ''}`;
  }

  // ---------- eventos ----------
  const CLICK_SEL = '[data-ptab],[data-pact],[data-closejob],[data-jsrc],[data-jrc],[data-jrg],[data-jobin],[data-joutdel],[data-jtemp],[data-trsilo],[data-emptydirty],[data-jmode],[data-logact],[data-binact],[data-jfq],[data-shsel],[data-hold]';
  async function onClick(el) {
    if (el.dataset.ptab) { S.prodTab = el.dataset.ptab; if (el.dataset.nav) { S.view = el.dataset.nav; window.scrollTo(0, 0); } C.render(); return; }
    if (el.dataset.closejob) { S.closeJob = el.dataset.closejob; S.closeStop = el.dataset.stop === '1'; keepScroll(); return; }
    if (el.dataset.jsrc) { const f = S.jobForm, i = f.sources.indexOf(el.dataset.jsrc); if (i >= 0) { f.sources.splice(i, 1); delete f.blend[el.dataset.jsrc]; if (f.feedQueue) delete f.feedQueue[el.dataset.jsrc]; } else f.sources.push(el.dataset.jsrc); keepScroll(); return; }
    if (el.dataset.jfq) { const [b, sid] = el.dataset.jfq.split('|'), f = S.jobForm; f.feedQueue = f.feedQueue || {}; const q = f.feedQueue[b] = f.feedQueue[b] || []; const k = q.indexOf(sid); if (k >= 0) q.splice(k, 1); else q.push(sid); keepScroll(); return; }
    if (el.dataset.jobin) {
      const [i, id] = el.dataset.jobin.split('|'), f = S.jobForm, o = f.outputs[+i];
      if (!o) return;
      const k = o.bins.indexOf(id);
      if (k >= 0) o.bins.splice(k, 1);
      else if (holds()[id]) return C.toast(t('je_bin_hold', { bin: id }));   // v2.13.0
      else if (f.outputs.some((x, n) => n !== +i && x.bins.indexOf(id) >= 0)) return C.toast(t('binTaken', { bin: id }));
      else o.bins.push(id);
      keepScroll(); return;
    }
    if (el.dataset.joutdel !== undefined) { const f = S.jobForm; if (f.outputs.length > 1) f.outputs.splice(+el.dataset.joutdel, 1); keepScroll(); return; }
    if (el.dataset.jrc || el.dataset.jrg) {
      const list = el.dataset.jrc ? S.jobForm.recipe.colours : S.jobForm.recipe.grades, v = el.dataset.jrc || el.dataset.jrg;
      const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); keepScroll(); return;
    }
    if (el.dataset.jtemp) { const f = S.jobForm, i = f.tempered.indexOf(el.dataset.jtemp); if (i >= 0) f.tempered.splice(i, 1); else f.tempered.push(el.dataset.jtemp); keepScroll(); return; }
    if (el.dataset.trsilo) { const f = S.trForm, i = f.silos.indexOf(el.dataset.trsilo); if (i >= 0) f.silos.splice(i, 1); else f.silos.push(el.dataset.trsilo); f.silosConfirmed = false; keepScroll(); return; }
    if (el.dataset.emptydirty) { S.emptyBin = el.dataset.emptydirty; keepScroll(); return; }
    if (el.dataset.jmode) { S.jobForm.mode = el.dataset.jmode === 'blend' ? 'blend' : 'seq'; keepScroll(); return; }
    if (el.dataset.logact) { S.logAct = { uid: el.dataset.uid, mode: el.dataset.logact === 'close' ? 'close' : 'void' }; keepScroll(); return; }
    if (el.dataset.shsel) { const [d, p] = el.dataset.shsel.split('|'); S.shiftSel = { day: d, period: p === 'N' ? 'N' : 'D' }; keepScroll(); return; }
    if (el.dataset.hold) { S.holdForm = { binId: el.dataset.hold, release: !!el.dataset.release, mq: !!el.dataset.mqhold, sampleUid: el.dataset.suid || null, reason: el.dataset.reason || '' }; keepScroll(); return; }
    if (el.dataset.binact) { S.binAct = { id: el.dataset.bin, mode: ['set', 'out', 'qty', 'zero'].indexOf(el.dataset.binact) >= 0 ? el.dataset.binact : 'empty' }; keepScroll(); return; }
    switch (el.dataset.pact) {
      case 'newjob': newJobForm(); keepScroll(); return;
      case 'rpnew': S.rpForm = {}; keepScroll(); return;
      case 'rpcancel': S.rpForm = null; keepScroll(); return;
      case 'rpsave': return saveReproc();
      case 'mqstage': S.mqStage = el.dataset.v; S.mqForm = {}; keepScroll(); return;
      case 'mqsave': return saveMaizeQc();
      case 'addoutput': S.jobForm.outputs.push(newOutput()); keepScroll(); return;
      case 'newtransfer': newTransferForm(); keepScroll(); return;
      case 'stocknew': newStockForm(); keepScroll(); return;
      case 'stocksave': return stockSave();
      case 'stockcancel': S.stockForm = null; keepScroll(); return;
      case 'canceltransfer': S.trForm = null; keepScroll(); return;
      case 'savetransfer': return saveTransfer();
      case 'emptydirty': return emptyDirty();
      case 'cancelempty': S.emptyBin = null; keepScroll(); return;
      case 'canceljob': S.jobForm = null; keepScroll(); return;
      case 'startjob': return startJob();
      case 'closejob': return closeJob();
      case 'cancelclose': S.closeJob = null; keepScroll(); return;
      case 'newissue': newLogForm('issue'); keepScroll(); return;
      case 'newact': newLogForm('activity'); keepScroll(); return;
      case 'newsafety': newLogForm('safety'); keepScroll(); return;
      case 'cancellog': S.logForm = null; keepScroll(); return;
      case 'savelog': return saveLog();
      case 'closeissue': return logAction('close');
      case 'voidlog': return logAction('void');
      case 'cancella': S.logAct = null; keepScroll(); return;
      case 'shiftxlsx': return shiftExcel();
      case 'shiftlogin': return shiftLogin();
      case 'lgjobadd': return addLgJob();
      case 'saveproc': return saveProc();
      case 'qtybin': return binQty();
      case 'sctab': S.scTab = el.dataset.v; keepScroll(); return;
      case 'mznew': { const lv = {}; dmIds().concat(cmIds()).forEach(id => { const last = (S.stocks || []).filter(x => x.levels && x.levels[id]).sort((a, b) => b.t - a.t)[0]; const L0 = last ? last.levels[id] : {}; lv[id] = { colour: L0.colour || '', grade: L0.grade || '' }; }); S.mzForm = { levels: lv, by: S.operator }; keepScroll(); return; }
      case 'mzcancel': S.mzForm = null; keepScroll(); return;
      case 'mzsave': return saveMaize();
      case 'pqnew': S.pqForm = {}; keepScroll(); return;
      case 'pqcancel': S.pqForm = null; keepScroll(); return;
      case 'pqsave': return saveProducts();
      case 'saverun': return saveRun();
      case 'lgjobrm': { (S.lgJobs || []).splice(Number(el.dataset.i), 1); const c = $('#lg_jobs'); if (c) c.innerHTML = jobChips(); return; }
      case 'savedips': return saveDips();
      case 'shiftlogout': return shiftLogout();
      case 'savestop': return saveStop();
      case 'srdsignin': return siloSignIn();
      case 'srdnow': return refreshSilos().then(ok => { C.toast(ok ? t('srdRead') : t('srdFailed', { e: S.autoSiloErr || t('srdNotConnected') })); keepScroll(); });
      case 'emptybin': return binAction('empty');
      case 'setbin': return binAction('set');
      case 'outbin': return binOut();
      case 'holdsave': return holdSave();
      case 'holdcancel': S.holdForm = null; return keepScroll();
      case 'cancelba': S.binAct = null; keepScroll(); return;
      case 'saveprodset': return saveProdSet();
      case 'dbsignin': return dropboxSignIn();
      case 'dbsignout': dropboxSignOut(); keepScroll(); return;
      case 'dbsyncnow': syncDays(true); return;
      case 'savecodes': return saveCodes();
      case 'savereading': return saveReading(el.dataset.uid);
      case 'newsr': newSrForm(); keepScroll(); return;
      case 'cancelsr': S.srForm = null; keepScroll(); return;
      case 'savesr': return saveSr();
      case 'srfix': { const r = (S.readings || []).find(x => x.uid === el.dataset.uid); if (r) { newSrForm(r); keepScroll(); } return; }
    }
  }
  function stockField(el) {
    const k = el.dataset.stk;
    if (k === 'by') { S.stockForm.by = el.value; return; }
    const [id, f] = k.split('|'); S.stockForm.levels[id] = Object.assign({}, S.stockForm.levels[id], { [f]: el.value });
    if (f === 'dipM') { const o = $('#dipkg_' + CSS.escape(id)); if (o) o.innerHTML = dipKgText(el.value, P.dipKg(el.value)); }
  }
  function onInput(el) {
    if (el.dataset && el.dataset.mz && S.mzForm) return onChange(el);
    if (el.dataset && el.dataset.pq && S.pqForm) return onChange(el);
    if (($('#lo_check')) && (/^lo_|^los_/.test(el.id || '') || el.classList.contains('lo_pct'))) { const sel = shiftSel(), li = shiftRec('login', sel.day, sel.period); if (li) $('#lo_check').innerHTML = logoutCheckHtml(li, sel.day, sel.period); }
    if (el.id === 'st_start' || el.id === 'st_end') { stopDur(); return true; }
    if (el.dataset.dip) { const o = $('#dipv_' + el.dataset.dip); if (o) o.innerHTML = dipKgText(el.value, P.dipKg(el.value)); return true; }
    if (el.dataset.jbl && S.jobForm) {
      const [id, k] = el.dataset.jbl.split('|');
      S.jobForm.blend[id] = Object.assign({}, S.jobForm.blend[id], { [k]: el.value });
      const b = $('#jobCheck'); if (b) b.innerHTML = jobCheckHtml(); return true;
    }
    if (el.dataset.rd) {
      S.readForm = { uid: el.dataset.rd, m0: el.value };
      const j = S.jobs.find(x => x.uid === el.dataset.rd), box = document.getElementById('rdc_' + el.dataset.rd);
      if (j && box) box.innerHTML = readPreview(j, P.readingCalc(j, el.value, S.cfgP)); return true;
    }
    if (el.dataset.jfl && S.jobForm && el.tagName === 'INPUT') { S.jobForm.leader = el.value; const b = $('#jobCheck'); if (b) b.innerHTML = jobCheckHtml(); return true; }
    if (el.dataset.tri && S.trForm) { S.trForm[el.dataset.tri] = el.value; const b = $('#trCheck'); if (b) b.innerHTML = trCheckHtml(); return true; }
    if (el.dataset.joi && S.jobForm) { const [i, k] = el.dataset.joi.split('|'); if (S.jobForm.outputs[+i]) S.jobForm.outputs[+i][k] = el.value; const b = $('#jobCheck'); if (b) b.innerHTML = jobCheckHtml(); return true; }
    if (el.dataset.jbk && S.jobForm) { S.jobForm.binKg = Object.assign({}, S.jobForm.binKg, { [el.dataset.jbk]: el.value }); return true; }
    if (el.dataset.cbk) { S.closeBinKg = Object.assign({}, S.closeBinKg, { [el.dataset.cbk]: el.value }); return true; }
    if (el.dataset.jfi && S.jobForm) { S.jobForm[el.dataset.jfi] = el.value; const b = $('#jobCheck'); if (b) b.innerHTML = jobCheckHtml(); return true; }
    if (el.dataset.lf && S.logForm && el.tagName !== 'SELECT') { S.logForm[el.dataset.lf] = el.value; return true; }
    if (el.dataset.sr && S.srForm && el.tagName !== 'SELECT') { S.srForm[el.dataset.sr] = el.value; return true; }
    if (el.dataset.stk && S.stockForm) { stockField(el); return true; }
    return false;
  }
  async function saveCtx(k, v) {
    S.ctx = Object.assign({ operatorId: '', testMode: false }, S.ctx, { [k]: v });
    await DB.setConfig('ctx', S.ctx);
    applyCtx();
    C.render();
  }
  function onChange(el) {
    if (el.dataset.scale) { const v = P.scaleNum(el.value); if (isNum(v) && v >= 0) el.value = P.fmtScale(v); return true; }   // v2.9.0: 1,234,567
    if (el.id === 'st_cat') { const c = $('#st_code'); if (c) c.innerHTML = codeOpts(el.value); return true; }
    if (el.id === 'st_start' || el.id === 'st_end') { stopDur(); return true; }
    if (el.dataset && el.dataset.runsel) { const [p, ar] = el.dataset.runsel.split('|'); const b = $('#' + p + '_box_' + ar); if (b && p !== 'rc') b.hidden = el.value !== '1'; return true; }
    if (el.dataset && el.dataset.mq) { S.mqForm = Object.assign(S.mqForm || {}, { [el.dataset.mq]: el.value }); return true; }
    if (el.id === 'mzDay') { if (el.value) S.mzDay = el.value; keepScroll(); return true; }
    if (el.classList && el.classList.contains('lg_proc')) { const d = el.dataset.g === 'plansifter' ? $('#lg_psecs') : $('#lg_pu_' + el.dataset.g); if (d) d.hidden = !el.checked; return true; }
    if (el.dataset && el.dataset.pq && S.pqForm) { const [id, k] = el.dataset.pq.split('|'); S.pqForm[id] = Object.assign(S.pqForm[id] || {}, { [k]: el.value }); return true; }
    if (el.dataset && el.dataset.mz && S.mzForm) { const [id, k] = el.dataset.mz.split('|'); if (k === undefined) S.mzForm[id] = el.value; else { S.mzForm.levels[id] = Object.assign(S.mzForm.levels[id] || {}, { [k]: el.value }); if (k === 'dipM') { const o = $('#mzkg_' + id); if (o) { const v = el.value; o.innerHTML = dipKgText(v, String(v).trim() ? P.dipKg(v, P.dipSpec(id, S.cfgP)) : null); } } } return true; }
    if (el.id === 'pm_group') { S.procForm = { group: el.value }; keepScroll(); return true; }
    if (el.id === 'pm_section' || el.id === 'pm_task') { S.procForm = Object.assign(S.procForm || {}, el.id === 'pm_task' ? { task: el.value } : { section: el.value }); return true; }
    if (el.id === 'shDay' || el.id === 'shPeriod') { const s = shiftSel(); if (el.id === 'shDay') { if (el.value) s.day = el.value; } else s.period = el.value === 'N' ? 'N' : 'D'; keepScroll(); return true; }
    if (el.dataset.jo && S.jobForm) { const [i, k] = el.dataset.jo.split('|'); if (S.jobForm.outputs[+i]) S.jobForm.outputs[+i][k] = el.value; keepScroll(); return true; }
    if (el.dataset.ctx) { saveCtx(el.dataset.ctx, el.type === 'checkbox' ? el.checked : el.value.trim().slice(0, 40)); return true; }
    if (el.dataset.jf && S.jobForm) {
      const k = el.dataset.jf;
      S.jobForm[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'lineId') {
        const keep = (list, id) => { const b = list.find(x => x.id === id); return b && b.lines.indexOf(el.value) >= 0; };
        S.jobForm.outputs.forEach(o => { o.bins = o.bins.filter(b => keep(S.cfgP.bins, b)); });
        S.jobForm.tempered = S.jobForm.tempered.filter(b => keep(S.cfgP.temperedBins, b));
        S.jobForm.sources = S.jobForm.sources.filter(b => keep(S.cfgP.dirtyBins, b));
      }
      keepScroll(); return true;
    }
    if (el.dataset.jfl && S.jobForm) { S.jobForm.leader = el.value; const b = $('#jobCheck'); if (b) b.innerHTML = jobCheckHtml(); return true; }
    if (el.dataset.trf && S.trForm) { S.trForm[el.dataset.trf] = el.type === 'checkbox' ? el.checked : el.value; keepScroll(); return true; }
    if (el.dataset.lf && S.logForm && el.tagName === 'SELECT') { S.logForm[el.dataset.lf] = el.value; keepScroll(); return true; }
    if (el.dataset.sr && S.srForm && el.tagName === 'SELECT') { S.srForm[el.dataset.sr] = el.value; keepScroll(); return true; }
    if (el.dataset.stk && S.stockForm) { stockField(el); return true; }
    if (el.id === 'importSilos') { importSilos(el.files[0]); el.value = ''; return true; }
    return false;
  }

  // v2.6.0: aviso de envio na página inicial — telemóvel sem ligação ao Dropbox, último envio falhado, ou dia de ontem por enviar
  function uploadIssue() {
    if (!window.DayRecords || !dbCfg()) return null;
    if (!dbSess()) return t('upNotConnected');
    const s = dayStatus();
    if (s.failed) return t('upFailed', { e: s.lastError || '' });
    const y = L.prodDay(now() - 24 * 3600000);
    if (!lsGet(DAY_SENT_KEY, {})[window.DayRecords.dayPath(dbCfg().recordsDir, y)]) return t('upNotSent', { d: y });
    return null;
  }
  const newRec = tms => base(tms);
  return { maizeQcCard, holdsCard, autoHold, productBinIds, prodOn, logoutIssue, holdIssues, siloFeedIssue, shiftIssue, load, reload, view, viewProdSet, viewCodes, settingsCard, homeLine, onClick, onInput, onChange, CLICK_SEL, dropboxToken, stockDue, uploadIssue, newRec };
};
