/* =====================================================================
   Logistica — app client-side
   - Dati su Supabase (protetti da password lato server, header x-logistica-pass)
   - Senza configurazione Supabase: modalità demo locale (localStorage + seed.json)
   ===================================================================== */
(function () {
  'use strict';

  var root = document.getElementById('lg-app');
  if (!root) return;
  var CFG = {
    url: root.dataset.supabaseUrl || '',
    key: root.dataset.supabaseKey || '',
    base: root.dataset.base || '/logistica/'
  };
  var DEMO = !(CFG.url && CFG.key);

  var STATI = [
    { key: 'disponibile', label: 'Disponibile', campo: '', desc: 'In magazzino, in vendita' },
    { key: 'venduto', label: 'Venduto', campo: 'data_vendita', desc: 'Accordo chiuso, da spedire/consegnare' },
    { key: 'spedito', label: 'Spedito', campo: 'data_spedizione', desc: "In viaggio verso l'acquirente" },
    { key: 'concluso', label: 'Concluso', campo: 'data_conclusione', desc: 'Consegnato e pagato, pratica chiusa' }
  ];
  var LABEL = {}; STATI.forEach(function (s) { LABEL[s.key] = s.label; });
  var ORDER = STATI.map(function (s) { return s.key; });

  /* ---------------- utilità ---------------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function groupIt(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function eur(v, forceDec) {
    v = Math.round(num(v) * 100) / 100;
    var neg = v < 0; v = Math.abs(v);
    var dec = forceDec || v % 1 ? 2 : 0;
    var p = v.toFixed(dec).split('.');
    var s = groupIt(p[0]) + (p[1] ? ',' + p[1] : '');
    return (neg ? '−€ ' : '€ ') + s;
  }
  function n2(v) { var p = (Math.round(num(v) * 100) / 100).toFixed(2).split('.'); return groupIt(p[0]) + ',' + p[1]; }
  function pct(v) { return Math.round(num(v)).toLocaleString('it-IT') + '%'; }
  function dataIt(s) {
    if (!s) return '';
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : String(s);
  }
  function oggi() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function foto(p) { return CFG.base + encodeURIComponent(p.codice) + '.jpg'; }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- calcoli ---------------- */
  function calc(p, all, imp) {
    var acq = (imp && imp.acquisto) || {};
    var n = Math.max(1, all.length);
    var quota = num(acq.spedizione) / n;
    var costo = num(p.pagato) + quota;
    var venduta = ['venduto', 'spedito', 'concluso'].indexOf(p.stato) !== -1;
    var vendita = num(p.vendita), sped = num(p.costo_spedizione), comm = num(p.commissioni);
    var netto = vendita - sped - comm;
    return {
      quota: quota, costo: costo, venduta: venduta, vendita: vendita, spedVendita: sped, commissioni: comm,
      netto: netto, margine: netto - costo,
      incassato: venduta && (!!p.pagamento_ricevuto || p.stato === 'concluso'),
      sconto: p.listino ? 100 * (1 - num(p.pagato) / num(p.listino)) : 0
    };
  }

  /* =====================================================================
     Backend
     ===================================================================== */
  function SupabaseBackend(pass, chi) {
    var sb = window.supabase.createClient(CFG.url, CFG.key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-logistica-pass': pass, 'x-logistica-utente': chi || '' } }
    });
    var chan = null;
    function chk(r) { if (r.error) throw r.error; return r.data; }
    return {
      verify: function () {
        return sb.rpc('verifica_password', { p: pass }).then(function (r) { return !r.error && r.data === true; });
      },
      load: function () {
        return Promise.all([
          sb.from('paia').select('id,dati,aggiornato').then(chk),
          sb.from('impostazioni').select('chiave,valore').then(chk)
        ]).then(function (res) {
          var imp = {}; res[1].forEach(function (r) { imp[r.chiave] = r.valore; });
          return { paia: res[0].map(function (r) { var d = r.dati; d.id = r.id; d._agg = r.aggiornato; return d; }), imp: imp };
        });
      },
      registro: function (o) {
        o = o || {};
        var q = sb.from('registro').select('id,quando,chi,tipo,paio_id,dettagli').order('id', { ascending: false }).limit(o.limit || 200);
        if (o.paio) q = q.eq('paio_id', o.paio);
        return q.then(function (r) { return r.error ? null : r.data; });   // null = registro non ancora attivo
      },
      nota: function (paio, testo) { return sb.rpc('aggiungi_evento', { p_paio: paio, p_testo: testo }).then(chk); },
      savePaio: function (p) {
        var d = clone(p); delete d._agg;
        return sb.from('paia').update({ dati: d, aggiornato: new Date().toISOString() }).eq('id', p.id).select('id').then(chk)
          .then(function (rows) { if (!rows || !rows.length) throw new Error('Salvataggio rifiutato (password cambiata?)'); });
      },
      saveImp: function (chiave, valore) {
        return sb.from('impostazioni').upsert({ chiave: chiave, valore: valore }).then(chk);
      },
      listAllegati: function (id) {
        return sb.from('allegati').select('id,nome,tipo,dimensione,creato').eq('paio_id', id).order('creato').then(chk);
      },
      getAllegato: function (aid) {
        return sb.from('allegati').select('dati,tipo').eq('id', aid).single().then(chk);
      },
      addAllegato: function (id, a) {
        return sb.from('allegati').insert({ paio_id: id, nome: a.nome, tipo: a.tipo, dimensione: a.dimensione, dati: a.dati }).then(chk);
      },
      delAllegato: function (aid) { return sb.from('allegati').delete().eq('id', aid).then(chk); },
      subscribe: function (cb) {
        try {
          chan = sb.channel('logistica-sync', { config: { broadcast: { self: false } } })
            .on('broadcast', { event: 'changed' }, function (m) { cb(m.payload || {}); })
            .subscribe();
        } catch (e) { chan = null; }
      },
      notify: function (payload) { if (chan) try { chan.send({ type: 'broadcast', event: 'changed', payload: payload || {} }); } catch (e) {} }
    };
  }

  // Demo locale: emula anche il registro (scritto dal "server" finto, mai modificabile dall'interfaccia)
  function DemoBackend(pass, chi) {
    var KEY = 'lg-demo-db';
    var db = null;
    function persist() { store(KEY, JSON.stringify(db)); }
    function reload() { try { db = JSON.parse(store(KEY)); } catch (e) {} }
    function ensure() {
      if (db) return Promise.resolve();
      var saved = store(KEY);
      if (saved) { try { db = JSON.parse(saved); if (!db.registro) db.registro = []; return Promise.resolve(); } catch (e) {} }
      return fetch(CFG.base + 'seed.json', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('seed.json mancante');
        return r.json();
      }).then(function (seed) { db = { paia: seed.paia, imp: seed.impostazioni, allegati: [], registro: [] }; persist(); });
    }
    function log(tipo, paio, dett) {
      var id = db.registro.length ? db.registro[db.registro.length - 1].id + 1 : 1;
      db.registro.push({ id: id, quando: new Date().toISOString(), chi: chi || null, tipo: tipo, paio_id: paio, dettagli: dett || {} });
    }
    var bc = null; try { bc = new BroadcastChannel('lg-demo'); } catch (e) {}
    return {
      verify: function () { return Promise.resolve(!!pass); }, // demo locale: nessuna password reale nel codice
      load: function () { return ensure().then(function () { reload(); return { paia: clone(db.paia), imp: clone(db.imp) }; }); },
      registro: function (o) {
        o = o || {};
        return ensure().then(function () {
          reload();
          return db.registro.filter(function (r) { return !o.paio || r.paio_id === o.paio; }).slice().reverse().slice(0, o.limit || 200);
        });
      },
      nota: function (paio, testo) { return ensure().then(function () { reload(); log('nota', paio, { testo: testo }); persist(); }); },
      savePaio: function (p) {
        return ensure().then(function () {
          reload();
          var d = clone(p); delete d._agg;
          var old = db.paia.filter(function (x) { return x.id === p.id; })[0] || {};
          var cambi = {};
          Object.keys(Object.assign({}, old, d)).forEach(function (k) {
            if (k === 'storico' || k === '_aggLocal') return;
            if (JSON.stringify(old[k]) !== JSON.stringify(d[k])) cambi[k] = [old[k] === undefined ? null : old[k], d[k] === undefined ? null : d[k]];
          });
          if (Object.keys(cambi).length) log('modifica', p.id, cambi);
          db.paia = db.paia.map(function (x) { return x.id === p.id ? d : x; }); persist();
        });
      },
      saveImp: function (k, v) { return ensure().then(function () { reload(); db.imp[k] = v; persist(); }); },
      listAllegati: function (id) {
        return ensure().then(function () {
          reload();
          return db.allegati.filter(function (a) { return a.paio_id === id; }).map(function (a) {
            return { id: a.id, nome: a.nome, tipo: a.tipo, dimensione: a.dimensione, creato: a.creato };
          });
        });
      },
      getAllegato: function (aid) {
        return ensure().then(function () { var a = db.allegati.filter(function (x) { return x.id === aid; })[0]; return { dati: a.dati, tipo: a.tipo }; });
      },
      addAllegato: function (id, a) {
        return ensure().then(function () {
          reload();
          db.allegati.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), paio_id: id, nome: a.nome, tipo: a.tipo, dimensione: a.dimensione, dati: a.dati, creato: new Date().toISOString() });
          log('file_aggiunto', id, { nome: a.nome, tipo: a.tipo });
          persist();
        });
      },
      delAllegato: function (aid) {
        return ensure().then(function () {
          reload();
          var a = db.allegati.filter(function (x) { return x.id === aid; })[0];
          db.allegati = db.allegati.filter(function (x) { return x.id !== aid; });
          if (a) log('file_eliminato', a.paio_id, { nome: a.nome, tipo: a.tipo });
          persist();
        });
      },
      subscribe: function (cb) { if (bc) bc.onmessage = function (e) { db = null; cb(e.data || {}); }; },
      notify: function (payload) { if (bc) bc.postMessage(payload || {}); }
    };
  }

  /* =====================================================================
     Stato app
     ===================================================================== */
  var S = {
    be: null, paia: [], imp: {}, loaded: false, lastSync: null, syncing: false,
    stato: '', editing: false, pendingRefresh: false, allegati: {}, allegatiFor: null, reg: null, chi: store('lg-chi') || ''
  };
  var filters = (function () { try { return JSON.parse(store('lg-filters') || '{}') || {}; } catch (e) { return {}; } })();
  S.stato = filters.st || '';

  function byId(id) { for (var i = 0; i < S.paia.length; i++) if (S.paia[i].id === id) return S.paia[i]; return null; }
  function sortById(a, b) { return a.id.localeCompare(b.id, undefined, { numeric: true }); }

  /* =====================================================================
     Login
     ===================================================================== */
  function renderLogin(err) {
    root.innerHTML =
      '<div class="lg-login">' +
      '  <form class="lg-login-box" autocomplete="off">' +
      '    <h1>Logistica</h1>' +
      '    <p class="lg-sub">Area riservata. Inserisci la password per continuare.</p>' +
      '    <input type="password" name="pw" placeholder="Password" aria-label="Password" autofocus required>' +
      (err ? '<p class="lg-login-err">' + esc(err) + '</p>' : '') +
      '    <button type="submit" class="lg-btn primary">Entra</button>' +
      (DEMO ? '<p class="lg-demo-note">Modalità demo locale (Supabase non configurato): i dati restano in questo browser.</p>' : '') +
      '  </form>' +
      '</div>';
    var f = $('form', root);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = f.pw.value.trim(); if (!pw) return;
      var btn = $('button', f); btn.disabled = true; btn.textContent = 'Verifica…';
      start(pw, true).catch(function () { renderLogin('Password errata.'); });
    });
    setTimeout(function () { var i = $('input', root); if (i) i.focus(); }, 30);
  }

  function nomiSoci(imp) { return ((imp || {}).bilancio || {}).soci || {}; }
  function nomeDi(chi) { var so = nomiSoci(S.imp); return (chi && so[chi]) || (chi ? chi : 'Sconosciuto'); }

  function renderChi(pw, imp, cambio) {
    var so = nomiSoci(imp), keys = Object.keys(so);
    root.innerHTML = '<div class="lg-login"><div class="lg-login-box"><h1>Chi sei?</h1>' +
      '<p class="lg-sub">Serve per il registro attività: ogni modifica viene firmata con il tuo nome. Lo chiediamo una volta sola su questo dispositivo.</p>' +
      '<div class="lg-chi">' + keys.map(function (k) { return '<button type="button" class="lg-btn" data-chi="' + esc(k) + '">' + esc(so[k]) + '</button>'; }).join('') + '</div>' +
      (cambio ? '<button type="button" class="lg-link" id="chi-annulla">Annulla</button>' : '') + '</div></div>';
    $$('[data-chi]').forEach(function (b) {
      b.onclick = function () { store('lg-chi', b.dataset.chi); S.chi = b.dataset.chi; location.reload(); };
    });
    var an = $('#chi-annulla'); if (an) an.onclick = function () { rerender(); };
  }

  function start(pw, interactive) {
    var be = DEMO ? DemoBackend(pw, S.chi) : SupabaseBackend(pw, S.chi);
    return be.verify().then(function (ok) {
      if (!ok) { store('lg-pass', null); throw new Error('bad'); }
      store('lg-pass', pw);
      if (!S.chi) { return be.load().then(function (d) { renderChi(pw, d.imp); }); }
      S.be = be;
      root.innerHTML = '<p class="lg-loading">Caricamento…</p>';
      be.subscribe(function (payload) { refresh(payload && payload.id); });
      return refresh().then(function () {
        window.addEventListener('hashchange', route);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
        setInterval(function () { if (!document.hidden) refresh(); }, 20000);
        route();
      });
    });
  }

  function logout() {
    store('lg-pass', null);
    location.hash = '';
    location.reload();
  }

  /* =====================================================================
     Sincronizzazione
     ===================================================================== */
  function refresh(changedId) {
    if (!S.be || S.syncing) return Promise.resolve();
    S.syncing = true;
    return Promise.all([S.be.load(), S.be.registro({ limit: 200 })]).then(function (res) {
      var d = res[0]; S.reg = res[1];
      S.paia = d.paia.sort(sortById); S.imp = d.imp || {}; S.loaded = true; S.lastSync = new Date();
      updateBell();
      S.syncing = false;
      if (changedId && S.allegatiFor === changedId) S.allegatiFor = null;
      if (S.editing) { S.pendingRefresh = true; showSyncBadge(); return; }
      rerender();
    }).catch(function (e) {
      S.syncing = false;
      toast('Errore di sincronizzazione: ' + (e.message || e), true);
    });
  }

  function showSyncBadge() {
    var b = $('#lg-sync');
    if (!b) return;
    if (S.pendingRefresh) { b.textContent = 'Altri hanno fatto modifiche: verranno mostrate al salvataggio'; b.className = 'lg-sync warn'; return; }
    var t = S.lastSync ? S.lastSync.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';
    b.textContent = (DEMO ? 'Demo locale · ' : 'Sincronizzato · ') + t;
    b.className = 'lg-sync';
  }

  function savePaio(p, msg) {
    return S.be.savePaio(p).then(function () {
      S.be.notify({ id: p.id });
      toast(msg || 'Salvato');
      S.editing = false; S.pendingRefresh = false;
      return refresh();
    }).catch(function (e) { toast('Salvataggio non riuscito: ' + (e.message || e), true); throw e; });
  }

  /* =====================================================================
     Registro attività (scritto dal database, immodificabile)
     ===================================================================== */
  var CAMPI = {
    stato: 'Stato', vendita: 'Prezzo di vendita', canale: 'Dove venduta', data_vendita: 'Data vendita',
    data_spedizione: 'Data spedizione', data_conclusione: 'Data chiusura', note: 'Note', nome: 'Modello',
    codice: 'Codice', sesso: 'Uomo/Donna', taglia: 'Taglia', listino: 'Listino', pagato: 'Pagato',
    condizione: 'Condizione', posizione: 'Dove si trova', pagamento_ricevuto: 'Pagamento ricevuto',
    data_pagamento: 'Data pagamento', commissioni: 'Commissioni', acquirente: 'Acquirente'
  };
  var SOLDI = ['vendita', 'listino', 'pagato', 'commissioni', 'costo_spedizione'];
  function valore(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'stato') return LABEL[v] || v;
    if (SOLDI.indexOf(k) !== -1) return eur(v);
    if (/^data_/.test(k)) return dataIt(v);
    if (v === true) return 'sì'; if (v === false) return 'no';
    return String(v);
  }
  function descrivi(ev) {
    var d = ev.dettagli || {};
    switch (ev.tipo) {
      case 'modifica':
        var parti = [];
        if (d.stato) parti.push('<b>' + esc(valore('stato', d.stato[0])) + ' → ' + esc(valore('stato', d.stato[1])) + '</b>');
        Object.keys(d).forEach(function (k) {
          if (k === 'stato') return;
          parti.push(esc(CAMPI[k] || k) + ': ' + esc(valore(k, d[k][0])) + ' → ' + esc(valore(k, d[k][1])));
        });
        return parti.join(' · ');
      case 'file_aggiunto': return 'Caricato file <b>' + esc(d.nome || '') + '</b>';
      case 'file_eliminato': return 'Eliminato file <b>' + esc(d.nome || '') + '</b>';
      case 'nota': return '📝 ' + esc(d.testo || '');
      case 'impostazioni': return 'Impostazioni modificate (' + esc(d.chiave || '') + ')';
      case 'paio_aggiunto': return 'Paio aggiunto';
      case 'paio_eliminato': return 'Paio eliminato';
      default: return esc(ev.tipo);
    }
  }
  function quandoIt(t) {
    var d = new Date(t);
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  function eventoHTML(ev, conPaio) {
    return '<li><div class="lg-ev-h"><b>' + esc(nomeDi(ev.chi)) + '</b>' + (conPaio && ev.paio_id ? ' · <a href="#/' + esc(ev.paio_id) + '">' + esc(ev.paio_id) + '</a>' : '') +
      '<time>' + esc(quandoIt(ev.quando)) + '</time></div><div class="lg-ev-d">' + descrivi(ev) + '</div></li>';
  }
  function nonViste() {
    if (!S.reg) return 0;
    var seen = num(store('lg-seen'));
    return S.reg.filter(function (e) { return e.id > seen && e.chi !== S.chi; }).length;
  }
  function updateBell() {
    var b = $('#lg-bell-n'); if (!b) return;
    var n = nonViste(); b.textContent = n > 99 ? '99+' : n; b.hidden = !n;
  }
  function apriAttivita() {
    var old = $('#lg-panel'); if (old) { old.remove(); return; }
    var el = document.createElement('div'); el.id = 'lg-panel'; el.className = 'lg-panel-wrap';
    var seen = num(store('lg-seen'));
    el.innerHTML = '<div class="lg-panel" role="dialog" aria-label="Attività"><div class="lg-panel-h"><h2>Attività</h2><button type="button" class="lg-link" id="lg-panel-x">Chiudi</button></div>' +
      (S.reg === null ? '<p class="lg-empty">Il registro attività non è ancora attivo sul database.</p>'
        : '<p class="lg-panel-s">Registro scritto dal database: nessuno può modificarlo o cancellarlo.</p><ul class="lg-ev">' +
          (S.reg.length ? S.reg.map(function (e) { return eventoHTML(e, true).replace('<li>', '<li class="' + (e.id > seen && e.chi !== S.chi ? 'new' : '') + '">'); }).join('') : '<li class="lg-empty">Nessuna attività.</li>') + '</ul>') +
      '</div>';
    document.body.appendChild(el);
    if (S.reg && S.reg.length) { store('lg-seen', String(S.reg[0].id)); updateBell(); }
    el.addEventListener('click', function (e) { if (e.target === el || e.target.id === 'lg-panel-x' || e.target.closest('.lg-ev a')) el.remove(); });
  }

  /* =====================================================================
     Router
     ===================================================================== */
  function currentId() {
    var m = location.hash.match(/^#\/?([A-Za-z]+-\d+)/);
    return m ? m[1].toUpperCase() : null;
  }
  function route() {
    S.editing = false; S.pendingRefresh = false;
    rerender();
    window.scrollTo(0, 0);
  }
  function rerender() {
    if (!S.loaded) return;
    var id = currentId();
    if (id && byId(id)) renderDetail(byId(id)); else renderList();
    showSyncBadge();
  }

  function topbar() {
    return '<div class="lg-topbar"><span id="lg-sync" class="lg-sync"></span>' +
      '<span class="lg-topbar-r"><button type="button" class="lg-bell" id="lg-bell" title="Attività">🔔 Attività <span id="lg-bell-n" hidden></span></button>' +
      '<button type="button" class="lg-link" id="lg-chi" title="Cambia utente">' + esc(nomeDi(S.chi).split(' ')[0]) + '</button>' +
      '<button type="button" class="lg-link" id="lg-refresh">Aggiorna</button>' +
      '<button type="button" class="lg-link" id="lg-logout">Esci</button></span></div>';
  }
  function bindTopbar() {
    var r = $('#lg-refresh'); if (r) r.onclick = function () { refresh().then(function () { toast('Aggiornato'); }); };
    var l = $('#lg-logout'); if (l) l.onclick = logout;
    var b = $('#lg-bell'); if (b) b.onclick = apriAttivita;
    var c = $('#lg-chi'); if (c) c.onclick = function () { if (confirm('Cambiare utente su questo dispositivo?')) { store('lg-chi', null); location.reload(); } };
    updateBell();
  }

  /* =====================================================================
     LISTA
     ===================================================================== */
  function renderList() {
    var paia = S.paia, imp = S.imp;
    var tot = { costo: 0, listino: 0, incassato: 0, daInc: 0, margine: 0, magListino: 0, vendute: 0 };
    var count = {}, taglie = {};
    paia.forEach(function (p) {
      var c = calc(p, paia, imp);
      tot.costo += c.costo; tot.listino += num(p.listino);
      if (c.venduta) { tot.vendute++; tot.margine += c.margine; if (c.incassato) tot.incassato += c.netto; else tot.daInc += c.netto; }
      else tot.magListino += num(p.listino);
      count[p.stato] = (count[p.stato] || 0) + 1;
      taglie[p.taglia] = 1;
    });
    var recupero = tot.costo ? 100 * tot.incassato / tot.costo : 0;
    var acq = imp.acquisto || {};

    var h = topbar();
    h += '<header class="lg-head"><h1>Logistica</h1><p class="lg-sub">' + paia.length + ' paia Golden Goose acquistate il ' + esc(dataIt(acq.data)) + '. Clicca un paio per vedere e modificare tutti i dettagli.</p></header>';

    h += '<section class="lg-kpis">' +
      kpi('Speso', eur(tot.costo), paia.length + ' paia, spedizione inclusa') +
      kpi('Da vendere', (paia.length - tot.vendute) + ' <em>paia</em>', 'Valore di listino ' + eur(tot.magListino)) +
      kpi('Incassato', eur(tot.incassato), tot.daInc > 0 ? 'Ancora da incassare ' + eur(tot.daInc) : (tot.vendute === 1 ? '1 paio venduto' : tot.vendute + ' paia vendute')) +
      '<div class="lg-kpi"><span class="lg-kpi-l">Guadagno netto</span><b class="' + (tot.margine < 0 ? 'neg' : tot.margine > 0 ? 'pos' : '') + '">' + eur(tot.margine) + '</b>' +
      '<div class="lg-bar"><i style="width:' + Math.min(100, recupero) + '%"></i></div><small>Recuperato ' + pct(recupero) + " dell'investimento</small></div>" +
      '</section>';

    h += '<nav class="lg-pipe" aria-label="Filtra per stato"><button type="button" class="lg-chip' + (S.stato ? '' : ' on') + '" data-stato=""><span class="lg-chip-n">' + paia.length + '</span><span class="lg-chip-l">Tutte</span></button>';
    STATI.forEach(function (s) {
      h += '<button type="button" class="lg-chip s-' + s.key + (S.stato === s.key ? ' on' : '') + '" data-stato="' + s.key + '" title="' + esc(s.desc) + '"><span class="lg-chip-n">' + (count[s.key] || 0) + '</span><span class="lg-chip-l"><i class="lg-dot"></i>' + s.label + '</span></button>';
    });
    h += '</nav>';

    var tg = Object.keys(taglie).map(Number).sort(function (a, b) { return a - b; });
    h += '<section class="lg-tools">' +
      '<input id="q" type="search" placeholder="Cerca per ID, modello, codice, acquirente…" aria-label="Cerca" value="' + esc(filters.q || '') + '">' +
      '<select id="f-sesso" aria-label="Uomo o donna"><option value="">Uomo e donna</option><option>Uomo</option><option>Donna</option></select>' +
      '<select id="f-taglia" aria-label="Taglia"><option value="">Tutte le taglie</option>' + tg.map(function (t) { return '<option value="' + t + '">Taglia ' + t + '</option>'; }).join('') + '</select>' +
      '<select id="f-sort" aria-label="Ordina"><option value="id">Ordina: ID</option><option value="taglia">Ordina: taglia</option><option value="nome">Ordina: modello</option><option value="stato">Ordina: stato</option><option value="listino-desc">Ordina: listino più alto</option><option value="vendita-desc">Ordina: venduto a di più</option><option value="margine-desc">Ordina: guadagno più alto</option></select>' +
      '<button type="button" id="csv" class="lg-btn">Esporta CSV</button>' +
      '</section>' +
      '<div class="lg-countbar"><span id="count"></span><button type="button" id="reset" class="lg-link" hidden>Azzera filtri</button></div>';

    h += '<section id="list" class="lg-cards">';
    paia.forEach(function (p) {
      var c = calc(p, paia, imp);
      h += '<a class="lg-card s-' + esc(p.stato) + '" href="#/' + esc(p.id) + '" data-id="' + esc(p.id) + '" data-sesso="' + esc(p.sesso) + '" data-stato="' + esc(p.stato) + '" data-taglia="' + esc(p.taglia) + '"' +
        ' data-listino="' + num(p.listino) + '" data-vendita="' + c.vendita + '" data-margine="' + (c.venduta ? c.margine : -99999) + '" data-nome="' + esc(p.nome) + '"' +
        ' data-search="' + esc([p.id, p.codice, p.nome, p.sesso, p.acquirente, p.canale, p.tracking, p.note].join(' ').toLowerCase()) + '">' +
        '<div class="lg-ph"><img src="' + foto(p) + '" alt="' + esc(p.nome) + '" loading="lazy" width="1200" height="900"><span class="lg-status s-' + esc(p.stato) + '"><i class="lg-dot"></i>' + esc(LABEL[p.stato] || p.stato) + '</span></div>' +
        '<div class="lg-cb"><div class="lg-cb-top"><span class="lg-id">' + esc(p.id) + '</span><span class="lg-tg"><small>' + esc(p.sesso) + '</small> Tg <b>' + esc(p.taglia) + '</b></span></div>' +
        '<h3 class="lg-name">' + esc(p.nome) + '</h3><div class="lg-money">' +
        (c.venduta
          ? '<div><span>Venduta a</span><b>' + eur(c.vendita) + '</b></div><div><span>Guadagno</span><b class="' + (c.margine < 0 ? 'neg' : 'pos') + '">' + (c.margine > 0 ? '+' : '') + eur(c.margine) + '</b></div>'
          : '<div><span>Costo</span><b>' + eur(c.costo) + '</b></div><div><span>Listino</span><b>' + eur(p.listino) + '</b></div>') +
        '</div>' + (p.acquirente ? '<p class="lg-buyer">Acquirente: <b>' + esc(p.acquirente) + '</b></p>' : '') + '</div></a>';
    });
    h += '</section><p id="empty" class="lg-emptyres" hidden>Nessun paio corrisponde ai filtri.</p>';

    h += bilancioHTML(paia, imp, tot.incassato);
    root.innerHTML = h;
    bindTopbar();
    bindList();
    bindBilancio(paia.length, imp);
  }

  function kpi(l, v, s) { return '<div class="lg-kpi"><span class="lg-kpi-l">' + l + '</span><b>' + v + '</b><small>' + s + '</small></div>'; }

  function bindList() {
    var q = $('#q'), fs = $('#f-sesso'), ft = $('#f-taglia'), so = $('#f-sort'), list = $('#list'), count = $('#count'), empty = $('#empty'), reset = $('#reset');
    fs.value = filters.s || ''; ft.value = filters.t || ''; so.value = filters.so || 'id';
    var cards = $$('.lg-card', list);
    function cmp(a, b) {
      var A = a.dataset, B = b.dataset;
      switch (so.value) {
        case 'taglia': return num(A.taglia) - num(B.taglia) || A.id.localeCompare(B.id);
        case 'nome': return A.nome.localeCompare(B.nome) || num(A.taglia) - num(B.taglia);
        case 'listino-desc': return num(B.listino) - num(A.listino);
        case 'vendita-desc': return num(B.vendita) - num(A.vendita);
        case 'margine-desc': return num(B.margine) - num(A.margine);
        case 'stato': return ORDER.indexOf(A.stato) - ORDER.indexOf(B.stato) || A.id.localeCompare(B.id);
        default: return A.id.localeCompare(B.id, undefined, { numeric: true });
      }
    }
    function apply() {
      var term = q.value.trim().toLowerCase(), n = 0;
      cards.sort(cmp).forEach(function (c) {
        var d = c.dataset;
        var ok = (!term || d.search.indexOf(term) !== -1) && (!fs.value || d.sesso === fs.value) && (!ft.value || d.taglia === ft.value) && (!S.stato || d.stato === S.stato);
        c.hidden = !ok; if (ok) n++; list.appendChild(c);
      });
      var f = term || fs.value || ft.value || S.stato;
      count.textContent = f ? n + ' di ' + cards.length + ' paia' : cards.length + ' paia';
      reset.hidden = !f; empty.hidden = n > 0;
      filters = { q: q.value, s: fs.value, t: ft.value, so: so.value, st: S.stato };
      store('lg-filters', JSON.stringify(filters));
    }
    $$('.lg-chip').forEach(function (c) {
      c.addEventListener('click', function () {
        S.stato = c.dataset.stato === S.stato ? '' : c.dataset.stato;
        $$('.lg-chip').forEach(function (x) { x.classList.toggle('on', x.dataset.stato === S.stato); });
        apply();
      });
    });
    [q, fs, ft, so].forEach(function (el) { el.addEventListener('input', apply); });
    reset.addEventListener('click', function () { q.value = ''; fs.value = ''; ft.value = ''; S.stato = ''; $$('.lg-chip').forEach(function (x) { x.classList.toggle('on', x.dataset.stato === ''); }); apply(); });
    $('#csv').addEventListener('click', function () { exportCSV(cards.filter(function (c) { return !c.hidden; }).map(function (c) { return c.dataset.id; })); });
    apply();
  }

  function exportCSV(ids) {
    var cols = ['id', 'codice', 'nome', 'sesso', 'taglia', 'listino', 'pagato', 'costo_reale', 'stato', 'vendita', 'commissioni', 'costo_spedizione', 'margine', 'canale', 'acquirente', 'contatto', 'metodo_pagamento', 'pagamento_ricevuto', 'data_vendita', 'data_spedizione', 'data_consegna', 'data_conclusione', 'corriere', 'tracking', 'posizione', 'note'];
    var lines = [cols.join(';')];
    ids.forEach(function (id) {
      var p = byId(id), c = calc(p, S.paia, S.imp);
      var row = cols.map(function (k) {
        var v = k === 'costo_reale' ? n2(c.costo) : k === 'margine' ? (c.venduta ? n2(c.margine) : '') : p[k];
        if (v === true) v = 'sì'; if (v === false || v == null) v = '';
        v = String(v).replace(/"/g, '""');
        return /[;"\n]/.test(v) ? '"' + v + '"' : v;
      });
      lines.push(row.join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'logistica-' + oggi() + '.csv'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------------- Bilancio ---------------- */
  // Regola: fee% a Gianluigi su ogni incasso → Benny rientra del capitale → resto 50/50
  function ripartisci(incassato, feeP, cap) {
    var fee = incassato * feeP / 100, dopo = incassato - fee;
    var rimb = Math.min(dopo, cap), utile = Math.max(0, dopo - cap), half = utile / 2;
    return {
      incassato: incassato, fee: fee, rimb: rimb, utile: utile, half: half,
      andrea: half, benny: rimb + half, gianluigi: fee,
      breakEven: cap / (1 - feeP / 100), mancano: Math.max(0, cap / (1 - feeP / 100) - incassato),
      pctCap: cap ? Math.min(100, 100 * rimb / cap) : 0, raggiunto: dopo >= cap
    };
  }

  function bilancioVista(r, so, cap, feeP, prefisso) {
    var A = esc(so.andrea || 'Socio A'), B = esc(so.benedetto || 'Socio B'), G = esc(so.gianluigi || 'Commerciale');
    var id = function (k) { return prefisso + k; };
    return '' +
      // Fase 1
      '<div class="lg-phase ' + (r.raggiunto ? 'ok' : 'on') + '" id="' + id('f1') + '">' +
      '  <div class="lg-phase-h"><span class="lg-phase-n">1</span><div><b>' + B + ' rientra del capitale</b><small>Tutto l\'incassato (meno il ' + feeP + '% di ' + G + ') va a ' + B + ' fino a ' + eur(cap) + '</small></div>' +
      '  <span class="lg-phase-v" data-v="rimb">' + eur(r.rimb) + ' <small>/ ' + eur(cap) + '</small></span></div>' +
      '  <div class="lg-pbar"><i class="b" data-w="cap" style="width:' + r.pctCap + '%"></i></div>' +
      '  <p class="lg-phase-s" data-v="f1s">' + (r.raggiunto ? '✓ Break-even raggiunto: capitale interamente restituito.' : 'Mancano <b>' + eur(r.mancano) + '</b> di incassi per arrivare al break-even' + (r.incassato > 0 ? ' (si raggiunge a ' + eur(r.breakEven) + ' incassati in totale).' : '.')) + '</p>' +
      '</div>' +
      // Fase 2
      '<div class="lg-phase ' + (r.raggiunto ? 'on' : 'off') + '" id="' + id('f2') + '">' +
      '  <div class="lg-phase-h"><span class="lg-phase-n">2</span><div><b>Utile diviso a metà</b><small>Dopo il break-even ogni euro (meno il ' + feeP + '%) va metà ad Andrea e metà a ' + B + '</small></div>' +
      '  <span class="lg-phase-v" data-v="utile">' + eur(r.utile) + '</span></div>' +
      '  <div class="lg-split2"><div class="a"><span>' + A + '</span><b data-v="ha">' + eur(r.half) + '</b></div><div class="b"><span>' + B + '</span><b data-v="hb">' + eur(r.half) + '</b></div></div>' +
      '  <p class="lg-phase-s" data-v="f2s">' + (r.raggiunto ? 'In corso.' : 'Si sblocca dopo il break-even.') + '</p>' +
      '</div>' +
      // Totali
      '<div class="lg-tot3">' +
      '  <div class="a"><span>' + A + '</span><b data-v="ta">' + eur(r.andrea) + '</b><small>50% dell\'utile</small></div>' +
      '  <div class="b"><span>' + B + '</span><b data-v="tb">' + eur(r.benny) + '</b><small data-v="tbs">' + eur(r.rimb) + ' capitale + ' + eur(r.half) + ' utile</small></div>' +
      '  <div class="g"><span>' + G + '</span><b data-v="tg">' + eur(r.gianluigi) + '</b><small>' + feeP + '% di ' + '<span data-v="tgi">' + eur(r.incassato) + '</span></small></div>' +
      '</div>';
  }

  function bilancioHTML(paia, imp, incassato) {
    var b = imp.bilancio || { fee_percentuale: 5, soci: {} }, so = b.soci || {};
    var feeP = num(b.fee_percentuale), cap = num((imp.acquisto || {}).totale);
    var r = ripartisci(incassato, feeP, cap);
    return '<section class="lg-section lg-bil2">' +
      '<header class="lg-bil2-h"><h2>Bilancio</h2><p class="lg-sub">Incassato finora: <b>' + eur(incassato) + '</b>. Si aggiorna da solo a ogni vendita incassata.</p></header>' +
      '<div class="lg-bil2-now">' + bilancioVista(r, so, cap, feeP, 'now-') + '</div>' +
      '<div class="lg-sim2"><div class="lg-sim2-h"><h3>Simulazione</h3><label>Se vendo tutte le ' + paia.length + ' paia a una media di ' +
      '<span class="lg-eur"><span>€</span><input id="sim-p" type="number" min="0" step="10" value="' + esc(store('lg-sim') || 200) + '" inputmode="numeric" aria-label="Prezzo medio a paio"></span> a paio' +
      ' <span class="lg-sim2-tot">= <b id="sim-tot"></b> incassati</span></label></div>' +
      '<div id="sim-box">' + bilancioVista(r, so, cap, feeP, 'sim-') + '</div></div>' +
      '</section>';
  }

  function bindBilancio(n, imp) {
    var inp = $('#sim-p'), box = $('#sim-box'); if (!inp || !box) return;
    var b = imp.bilancio || {}, so = b.soci || {}, feeP = num(b.fee_percentuale), cap = num((imp.acquisto || {}).totale);
    function calcSim() {
      var tot = n * Math.max(0, num(inp.value));
      $('#sim-tot').textContent = eur(tot);
      box.innerHTML = bilancioVista(ripartisci(tot, feeP, cap), so, cap, feeP, 'sim-');
      store('lg-sim', inp.value);
    }
    inp.addEventListener('input', calcSim); calcSim();
  }

  /* =====================================================================
     DETTAGLIO — minimal, guidato passo per passo
     ===================================================================== */
  function kv(label, value, cls) {
    if (value === '' || value == null) return '';
    return '<div' + (cls ? ' class="' + cls + '"' : '') + '><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  }

  // Cosa si compila per arrivare a ogni stato
  var PASSI = {
    venduto: {
      quando: 'Quando hai venduto la scarpa.',
      campi: [
        ['vendita', 'Prezzo di vendita (€)', 'number', { req: true }],
        ['canale', 'Dove l\'hai venduta', 'text', { list: 'dl-canali' }],
        ['data_vendita', 'Data di vendita', 'date', { def: 'oggi' }]
      ],
      upload: 'Carica lo screenshot della vendita',
      file: 'lo screenshot della vendita'
    },
    spedito: {
      quando: 'Quando la scarpa è partita.',
      campi: [['data_spedizione', 'Data di spedizione', 'date', { def: 'oggi' }]],
      file: 'eventuali documenti di spedizione'
    },
    concluso: {
      quando: 'Quando l\'acquirente l\'ha ricevuta e la vendita è chiusa.',
      campi: [['data_conclusione', 'Data di chiusura', 'date', { def: 'oggi' }]],
      file: 'eventuali documenti finali'
    }
  };

  function campo(c, p, prefill) {
    var name = c[0], label = c[1], type = c[2], o = c[3] || {};
    var v = p[name];
    if ((v == null || v === '') && prefill && o.def === 'oggi') v = oggi();
    if (v == null) v = '';
    var id = 'f-' + name, cls = 'lg-f' + (o.sped ? ' sped' : '') + (o.req ? ' req' : '');
    if (type === 'checkbox') return '<label class="lg-f lg-f-check' + (o.req ? ' req' : '') + '"><input type="checkbox" id="' + id + '" name="' + name + '"' + (v ? ' checked' : '') + '><span>' + label + '</span></label>';
    var input;
    if (type === 'select') input = '<select id="' + id + '" name="' + name + '">' + o.options.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>';
    else input = '<input id="' + id + '" name="' + name + '" type="' + type + '" value="' + esc(v) + '"' + (o.list ? ' list="' + o.list + '"' : '') + (type === 'number' ? ' step="0.01" min="0" inputmode="decimal"' : '') + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + '>';
    return '<label class="' + cls + '" for="' + id + '"><span>' + label + (o.req ? ' <i>*</i>' : '') + '</span>' + input + '</label>';
  }

  var DATALISTS =
    '<datalist id="dl-canali"><option>Vinted</option><option>Instagram</option><option>WhatsApp</option><option>Subito</option><option>Di persona</option></datalist>' +
    '<datalist id="dl-pag"><option>PayPal</option><option>Bonifico</option><option>Contanti</option><option>Satispay</option><option>Revolut</option><option>Vinted</option></datalist>' +
    '<datalist id="dl-corr"><option>BRT</option><option>GLS</option><option>Poste Italiane</option><option>SDA</option><option>InPost</option><option>DHL</option><option>UPS</option></datalist>';

  function formPasso(key, p, modo) {
    // modo: 'avanza' (prossimo passo) | 'modifica' (passo già fatto)
    var P = PASSI[key];
    return '<form class="lg-stepform" data-passo="' + key + '" data-modo="' + modo + '" novalidate>' +
      '<div class="lg-fgrid">' + P.campi.map(function (c) { return campo(c, p, modo === 'avanza'); }).join('') + '</div>' +
      (P.upload ? '<div class="lg-stepup"><label class="lg-btn" for="att-file">📎 ' + P.upload + '</label><span class="lg-stepup-n" data-att-count></span></div>' : '') +
      '<p class="lg-form-err" hidden></p>' +
      '<div class="lg-form-foot">' +
      (modo === 'avanza'
        ? '<button type="submit" class="lg-btn primary big">Salva e segna come ' + LABEL[key].toLowerCase() + ' →</button><button type="button" class="lg-link" data-act="solo-salva">Salva senza cambiare stato</button>'
        : '<button type="submit" class="lg-btn primary">Salva</button><button type="button" class="lg-link" data-act="annulla">Annulla</button>') +
      '</div></form>';
  }

  function riepilogoPasso(key, p, c) {
    var r = '';
    if (key === 'venduto') r = kv('Prezzo', p.vendita ? '<b>' + eur(p.vendita) + '</b>' : '') + kv('Dove', esc(p.canale || '')) + kv('Data', dataIt(p.data_vendita));
    else if (key === 'spedito') r = kv('Data', dataIt(p.data_spedizione));
    else if (key === 'concluso') r = kv('Data', dataIt(p.data_conclusione));
    return r ? '<dl class="lg-kv sm">' + r + '</dl>' : '<p class="lg-empty">Nessun dato inserito.</p>';
  }

  function renderDetail(p) {
    var paia = S.paia, imp = S.imp, c = calc(p, paia, imp), acq = imp.acquisto || {};
    var idx = paia.indexOf(p), prev = paia[idx - 1], next = paia[idx + 1];
    var cur = Math.max(0, ORDER.indexOf(p.stato));
    var nextKey = (STATI[cur + 1] || {}).key;

    var h = topbar();
    h += '<div class="lg-detail lg-min"><nav class="lg-nav"><a href="#/" class="lg-back">← Tutte le paia</a><span class="lg-prevnext">' +
      (prev ? '<a href="#/' + prev.id + '" title="' + esc(prev.nome) + ' (tasto ←)">‹ ' + prev.id + '</a>' : '') +
      '<span class="lg-pos">' + (idx + 1) + ' / ' + paia.length + '</span>' +
      (next ? '<a href="#/' + next.id + '" title="' + esc(next.nome) + ' (tasto →)">' + next.id + ' ›</a>' : '') + '</span></nav>';

    // Intestazione compatta
    h += '<header class="lg-mhead"><div class="lg-ph lg-mhead-ph"><img src="' + foto(p) + '" alt="' + esc(p.nome) + '" width="1200" height="900"></div>' +
      '<div class="lg-mhead-b"><div class="lg-hero-top"><span class="lg-id big">' + esc(p.id) + '</span><span class="lg-status s-' + esc(p.stato) + '"><i class="lg-dot"></i>' + esc(LABEL[p.stato]) + '</span></div>' +
      '<h1>' + esc(p.nome) + '</h1><p class="lg-mhead-sub">' + esc(p.sesso) + ' · Taglia <b>' + esc(p.taglia) + '</b></p>' +
      '<dl class="lg-mnums"><div><dt>Costo</dt><dd>' + eur(c.costo) + '</dd></div><div><dt>Listino</dt><dd>' + eur(p.listino) + '</dd></div>' +
      (c.venduta && p.vendita
        ? '<div><dt>Venduta a</dt><dd>' + eur(p.vendita) + '</dd></div><div><dt>Guadagno</dt><dd class="' + (c.margine < 0 ? 'neg' : 'pos') + '">' + (c.margine > 0 ? '+' : '') + eur(c.margine) + '</dd></div>'
        : '') + '</dl></div></header>';

    // Avanzamento
    h += '<ol class="lg-steps four">';
    STATI.forEach(function (s, i) {
      var date = s.key === 'disponibile' ? acq.data : p[s.campo];
      h += '<li class="s-' + s.key + ' ' + (i < cur ? 'done' : i === cur ? 'now' : '') + '"><button type="button" class="lg-step" data-stato="' + s.key + '" title="Imposta stato: ' + s.label + '"><i>' + (i < cur ? '✓' : i + 1) + '</i><b>' + s.label + '</b><small>' + (date && i <= cur ? dataIt(date) : '&nbsp;') + '</small></button></li>';
    });
    h += '</ol>';

    // Prossimo passo
    if (nextKey) {
      var P = PASSI[nextKey];
      h += '<section class="lg-next s-' + nextKey + '"><div class="lg-next-h"><div class="lg-next-top"><span class="lg-next-tag">Prossimo passo</span>' + (cur > 0 ? '<button type="button" class="lg-back-step" data-back="' + STATI[cur - 1].key + '">↩ Torna a ' + STATI[cur - 1].label.toLowerCase() + '</button>' : '') + '</div><h2>' + (cur + 2) + '. ' + LABEL[nextKey] + '</h2>' +
        '<p>' + esc(P.quando) + ' Compila i campi e premi il pulsante.</p></div>' + formPasso(nextKey, p, 'avanza') +
        (nextKey === 'venduto' ? '<details class="lg-ad"><summary>Testo per l\'annuncio</summary><textarea id="ad" rows="5">Golden Goose – ' + esc(p.nome) + '\nTaglia ' + esc(p.taglia) + ' EU (' + esc(p.sesso) + ')\nNuove, mai indossate, con scatola originale.\nCodice articolo: ' + esc(p.codice) + '\nPrezzo di listino: ' + eur(p.listino) + '</textarea><button type="button" class="lg-btn" id="copy-ad">Copia testo</button></details>' : '') +
        '</section>';
    } else {
      h += '<section class="lg-next done"><div class="lg-next-h"><div class="lg-next-top"><span class="lg-next-tag">Completato</span><button type="button" class="lg-back-step" data-back="' + STATI[cur - 1].key + '">↩ Torna a ' + STATI[cur - 1].label.toLowerCase() + '</button></div><h2>Pratica chiusa</h2>' +
        '<p>Venduta a ' + eur(p.vendita) + ' · guadagno netto <b class="' + (c.margine < 0 ? 'neg' : 'pos') + '">' + eur(c.margine) + '</b>.</p></div></section>';
    }

    // Passi completati
    var fatti = STATI.slice(1, cur + 1);
    if (fatti.length) {
      h += '<section class="lg-done"><h3>Passi completati</h3>';
      fatti.forEach(function (s, i) {
        h += '<div class="lg-done-i s-' + s.key + '" data-passo="' + s.key + '"><div class="lg-done-h"><span><i class="lg-dot"></i><b>' + (i + 2) + '. ' + s.label + '</b></span><button type="button" class="lg-link" data-edit="' + s.key + '">Modifica</button></div>' +
          '<div class="lg-done-v">' + riepilogoPasso(s.key, p, c) + '</div><div class="lg-done-f" hidden>' + formPasso(s.key, p, 'modifica') + '</div></div>';
      });
      h += '</section>';
    }

    // File
    var fileHint = nextKey ? PASSI[nextKey].file : 'qualsiasi documento utile';
    h += '<section class="lg-files" id="lg-att"><div class="lg-box-h"><h3>File <small id="att-n"></small></h3>' +
      '<label class="lg-btn"><input type="file" id="att-file" accept="image/*,application/pdf" multiple hidden>+ Aggiungi file</label></div>' +
      '<div class="lg-drop" id="att-drop"><div class="lg-shots" id="att-list"><p class="lg-empty">Caricamento…</p></div>' +
      '<p class="lg-drop-hint">' + (nextKey ? 'In questo passo: carica ' + esc(fileHint) + '.' : 'Puoi caricare qualsiasi documento utile.') + ' Trascina qui o incolla con <kbd>⌘V</kbd>.</p></div></section>';

    // Altro (chiuso)
    h += '<section class="lg-hist"><div class="lg-box-h"><h3>Storico <small>· non modificabile</small></h3></div>' +
      '<ul class="lg-ev" id="lg-hist"><li class="lg-empty">Caricamento…</li></ul>' +
      '<form class="lg-logadd" id="log-add"><input type="text" name="t" placeholder="Aggiungi una nota allo storico…" aria-label="Nota" maxlength="500" required><button class="lg-btn">Aggiungi</button></form></section>';
    h += '<details class="lg-more"' + (p.note ? ' open' : '') + '><summary>Note</summary>' +
      '<form class="lg-note-f" id="note-f"><label class="lg-f wide"><span>Note (modificabili; ogni modifica resta nello storico)</span><textarea name="note" rows="3">' + esc(p.note || '') + '</textarea></label><button class="lg-btn">Salva nota</button></form></details>';
    h += '<details class="lg-more"><summary>Dettagli prodotto e costo</summary><dl class="lg-kv sm">' +
      kv('Codice articolo', '<span class="mono">' + esc(p.codice) + '</span>') + kv('Condizione', esc(p.condizione || 'Nuova')) + kv('Dove si trova', esc(p.posizione || '')) +
      kv('Prezzo pagato', eur(p.pagato) + ' <small>(−' + pct(c.sconto) + ' sul listino)</small>') +
      kv('Quota spedizione acquisto', eur(c.quota) + ' <small>(' + eur(acq.spedizione) + ' ÷ ' + paia.length + ')</small>') +
      kv('Costo reale', '<b>' + eur(c.costo) + '</b>', 'tot') + kv('Acquistata il', dataIt(acq.data)) + '</dl>' +
      '<details class="lg-sub-more"><summary>Modifica dati prodotto</summary><form id="prod-f" class="lg-stepform"><div class="lg-fgrid">' +
      campo(['nome', 'Modello', 'text'], p) + campo(['codice', 'Codice articolo', 'text'], p) + campo(['sesso', 'Uomo / Donna', 'select', { options: ['Uomo', 'Donna'] }], p) +
      campo(['taglia', 'Taglia', 'number'], p) + campo(['listino', 'Listino (€)', 'number'], p) + campo(['pagato', 'Pagato (€)', 'number'], p) +
      campo(['condizione', 'Condizione', 'text', { ph: 'Nuova' }], p) + campo(['posizione', 'Dove si trova', 'text', { ph: 'Es. Scatola 3' }], p) +
      '</div><div class="lg-form-foot"><button class="lg-btn primary">Salva</button></div></form></details></details>';

    h += DATALISTS + '</div><dialog id="lb" class="lg-lb"><img alt=""><form method="dialog"><button aria-label="Chiudi">✕</button></form></dialog>';
    root.innerHTML = h;
    bindTopbar();
    bindDetail(p, prev, next);
    loadAllegati(p.id);
    loadStorico(p.id);
  }

  function loadStorico(id) {
    var ul = $('#lg-hist'); if (!ul) return;
    S.be.registro({ paio: id, limit: 300 }).then(function (rows) {
      if (currentId() !== id || !$('#lg-hist')) return;
      if (rows === null) { ul.innerHTML = '<li class="lg-empty">Il registro attività non è ancora attivo sul database.</li>'; return; }
      ul.innerHTML = rows.length ? rows.map(function (e) { return eventoHTML(e, false); }).join('') : '<li class="lg-empty">Nessuna attività registrata.</li>';
    });
  }

  var NUMERIC = ['vendita', 'commissioni', 'costo_spedizione', 'taglia', 'listino', 'pagato'];

  function readForm(form, p) {
    var d = clone(p);
    $$('input,select,textarea', form).forEach(function (el) {
      if (!el.name) return;
      var v;
      if (el.type === 'checkbox') v = el.checked;
      else { v = el.value.trim(); if (NUMERIC.indexOf(el.name) !== -1 && v !== '') v = num(v.replace(',', '.')); }
      if (v === '' || v === false) delete d[el.name]; else d[el.name] = v;
    });
    if (d.modalita_consegna === 'A mano') ['corriere', 'tracking', 'tracking_url', 'costo_spedizione', 'indirizzo'].forEach(function (k) { delete d[k]; });
    return d;
  }

  function logModifiche(p, d) {
    if (d.pagamento_ricevuto && !p.pagamento_ricevuto && !d.data_pagamento) d.data_pagamento = oggi();
  }

  function setEditing(on) { S.editing = on; if (!on && S.pendingRefresh) { S.pendingRefresh = false; rerender(); } showSyncBadge(); }

  function bindDetail(p, prev, next) {
    // mostra/nascondi campi di spedizione se "A mano"
    $$('select[name=modalita_consegna]').forEach(function (sel) {
      var form = sel.form;
      function upd() { $$('.lg-f.sped', form).forEach(function (l) { l.hidden = sel.value === 'A mano'; }); }
      sel.addEventListener('change', upd); upd();
    });

    // i form segnano "sto modificando" appena si tocca un campo
    $$('.lg-stepform, #note-f').forEach(function (f) { f.addEventListener('input', function () { if (!S.editing) setEditing(true); }); });

    $$('.lg-stepform[data-passo]').forEach(function (form) {
      var key = form.dataset.passo, avanza = form.dataset.modo === 'avanza';
      var err = $('.lg-form-err', form);
      function salva(cambiaStato) {
        var d = readForm(form, p);
        if (cambiaStato) {
          var manca = PASSI[key].campi.filter(function (c) { return (c[3] || {}).req && !d[c[0]]; }).map(function (c) { return c[1]; });
          if (manca.length) { err.textContent = 'Per segnare come ' + LABEL[key].toLowerCase() + ' serve: ' + manca.join(', ') + '.'; err.hidden = false; return; }
          d.stato = key;
          var campoData = (STATI[ORDER.indexOf(key)] || {}).campo;
          if (campoData && !d[campoData]) d[campoData] = oggi();
        }
        logModifiche(p, d);
        $$('button', form).forEach(function (b) { b.disabled = true; });
        S.editing = false;
        savePaio(d, cambiaStato ? 'Segnata come ' + LABEL[key].toLowerCase() : 'Salvato').catch(function () { $$('button', form).forEach(function (b) { b.disabled = false; }); });
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); salva(avanza); });
      var solo = $('[data-act=solo-salva]', form); if (solo) solo.onclick = function () { salva(false); };
      var ann = $('[data-act=annulla]', form);
      if (ann) ann.onclick = function () {
        var box = form.closest('.lg-done-i'); $('.lg-done-f', box).hidden = true; $('.lg-done-v', box).hidden = false; setEditing(false);
      };
    });

    $$('[data-edit]').forEach(function (b) {
      b.onclick = function () {
        var box = b.closest('.lg-done-i'); $('.lg-done-v', box).hidden = true; $('.lg-done-f', box).hidden = false;
        var f = $('input,select', box); if (f) f.focus();
      };
    });

    function vaiA(k, conferma) {
      if (k === p.stato) return;
      var da = ORDER.indexOf(p.stato), a = ORDER.indexOf(k);
      var msg = a < da
        ? 'Riportare ' + p.id + ' a "' + LABEL[k] + '"?\nLe date dei passi successivi verranno tolte; prezzo, file e note restano.'
        : 'Impostare lo stato di ' + p.id + ' su "' + LABEL[k] + '"?';
      if (conferma && !confirm(msg)) return;
      var d = clone(p);
      d.stato = k;
      if (a < da) STATI.slice(a + 1).forEach(function (st) { if (st.campo) delete d[st.campo]; });
      else { var campoData = (STATI[a] || {}).campo; if (campoData && !d[campoData]) d[campoData] = oggi(); }
      savePaio(d, a < da ? 'Riportata a ' + LABEL[k].toLowerCase() : 'Stato: ' + LABEL[k]);
    }
    $$('.lg-step').forEach(function (b) { b.onclick = function () { vaiA(b.dataset.stato, true); }; });
    $$('[data-back]').forEach(function (b) { b.onclick = function () { vaiA(b.dataset.back, true); }; });

    $('#note-f').addEventListener('submit', function (e) {
      e.preventDefault(); var d = clone(p); var t = e.target.note.value.trim();
      if (t) d.note = t; else delete d.note; S.editing = false; savePaio(d, 'Nota salvata');
    });
    $('#prod-f').addEventListener('submit', function (e) { e.preventDefault(); S.editing = false; savePaio(readForm(e.target, p), 'Dati prodotto salvati'); });

    $('#log-add').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = e.target.t.value.trim(); if (!t) return;
      var btn = $('button', e.target); btn.disabled = true;
      S.be.nota(p.id, t).then(function () {
        e.target.t.value = ''; btn.disabled = false; S.be.notify({ id: p.id }); toast('Nota aggiunta allo storico'); loadStorico(p.id); refresh();
      }).catch(function (err) { btn.disabled = false; toast('Nota non salvata: ' + (err.message || err), true); });
    });

    var cp = $('#copy-ad');
    if (cp) cp.onclick = function () { var b = this; navigator.clipboard.writeText($('#ad').value).then(function () { var o = b.textContent; b.textContent = 'Copiato ✓'; setTimeout(function () { b.textContent = o; }, 1500); }); };

    // File
    var fileIn = $('#att-file'), drop = $('#att-drop');
    fileIn.addEventListener('change', function () { uploadFiles(p.id, fileIn.files); fileIn.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(p.id, e.dataTransfer.files); });
    document.onpaste = function (e) {
      if (currentId() !== p.id) return;
      var items = (e.clipboardData || {}).items || [], files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); uploadFiles(p.id, files); }
    };

    var lb = $('#lb');
    lb.addEventListener('click', function (e) { if (e.target === lb || e.target.tagName === 'IMG') lb.close(); });

    document.onkeydown = function (e) {
      if (currentId() !== p.id || lb.open || S.editing || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName)) return;
      if (e.key === 'ArrowLeft' && prev) location.hash = '#/' + prev.id;
      if (e.key === 'ArrowRight' && next) location.hash = '#/' + next.id;
    };
  }

  /* ---------------- Allegati ---------------- */
  var thumbCache = {};
  function loadAllegati(id) {
    var list = $('#att-list'); if (!list) return;
    S.be.listAllegati(id).then(function (rows) {
      if (currentId() !== id) return;
      $('#att-n').textContent = rows.length ? '· ' + rows.length : '';
      document.querySelectorAll('[data-att-count]').forEach(function (el) { el.textContent = rows.length ? (rows.length === 1 ? '1 file caricato ✓' : rows.length + ' file caricati ✓') : ''; });
      if (!rows.length) { list.innerHTML = '<p class="lg-empty">Nessun file ancora.</p>'; return; }
      list.innerHTML = rows.map(function (a) {
        var img = a.tipo.indexOf('image/') === 0;
        return '<div class="lg-shot" data-aid="' + esc(a.id) + '">' +
          (img ? '<button type="button" class="lg-shot-open" title="Apri"><img alt="' + esc(a.nome) + '" data-aid="' + esc(a.id) + '"></button>'
               : '<button type="button" class="lg-shot-open file" title="Apri"><b>' + esc((a.nome.split('.').pop() || 'FILE').toUpperCase()) + '</b></button>') +
          '<span class="lg-shot-meta"><span title="' + esc(a.nome) + '">' + esc(a.nome) + '</span><button type="button" class="lg-shot-del" title="Elimina">Elimina</button></span></div>';
      }).join('');
      rows.forEach(function (a) {
        var el = $('.lg-shot[data-aid="' + a.id + '"]', list);
        var img = $('img', el);
        function get() { return thumbCache[a.id] ? Promise.resolve(thumbCache[a.id]) : S.be.getAllegato(a.id).then(function (r) { thumbCache[a.id] = 'data:' + r.tipo + ';base64,' + r.dati; return thumbCache[a.id]; }); }
        if (img) get().then(function (u) { img.src = u; });
        $('.lg-shot-open', el).onclick = function () {
          get().then(function (u) {
            if (a.tipo.indexOf('image/') === 0) { var lb = $('#lb'); $('img', lb).src = u; lb.showModal(); }
            else { fetch(u).then(function (r) { return r.blob(); }).then(function (b) { window.open(URL.createObjectURL(b), '_blank'); }); }
          });
        };
        $('.lg-shot-del', el).onclick = function () {
          if (!confirm('Eliminare "' + a.nome + '"?')) return;
          S.be.delAllegato(a.id).then(function () { delete thumbCache[a.id]; S.be.notify({ id: id }); toast('File eliminato'); loadAllegati(id); loadStorico(id); refresh(); })
            .catch(function (e) { toast('Eliminazione non riuscita: ' + (e.message || e), true); });
        };
      });
    }).catch(function (e) { list.innerHTML = '<p class="lg-empty">Errore nel caricamento dei file: ' + esc(e.message || e) + '</p>'; });
  }

  function fileToPayload(file) {
    var isImg = /^image\//.test(file.type) && !/svg|gif/.test(file.type);
    if (!isImg) {
      if (file.size > 6 * 1024 * 1024) return Promise.reject(new Error(file.name + ': massimo 6 MB'));
      return readB64(file).then(function (b64) { return { nome: file.name, tipo: file.type || 'application/octet-stream', dimensione: file.size, dati: b64 }; });
    }
    // immagini: ridimensiono a max 2000px e comprimo in JPEG
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var max = 2000, w = im.naturalWidth, h = im.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * s); cv.height = Math.round(h * s);
        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(im, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) {
          readB64(b).then(function (b64) {
            var nome = (file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : 'screenshot-' + oggi()) + '.jpg';
            res({ nome: nome, tipo: 'image/jpeg', dimensione: b.size, dati: b64 });
          });
        }, 'image/jpeg', 0.85);
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error(file.name + ': immagine non leggibile')); };
      im.src = url;
    });
  }
  function readB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = rej; r.readAsDataURL(blob);
    });
  }
  function uploadFiles(id, files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    toast('Caricamento di ' + files.length + ' file…');
    var chain = Promise.resolve(), ok = 0;
    files.forEach(function (f) {
      chain = chain.then(function () { return fileToPayload(f); }).then(function (pl) { return S.be.addAllegato(id, pl); }).then(function () { ok++; })
        .catch(function (e) { toast('Upload non riuscito: ' + (e.message || e), true); });
    });
    chain.then(function () {
      if (ok) {
        var p = byId(id);
        S.be.notify({ id: id }); refresh().then(function () { loadStorico(id); });
        toast(ok === 1 ? 'File caricato' : ok + ' file caricati');
      }
      loadAllegati(id);
    });
  }

  /* ---------------- Toast ---------------- */
  var toastT;
  function toast(msg, err) {
    var t = $('#lg-toast');
    if (!t) { t = document.createElement('div'); t.id = 'lg-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'lg-toast show' + (err ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'lg-toast'; }, err ? 5000 : 2200);
  }

  /* =====================================================================
     Avvio
     ===================================================================== */
  if (!DEMO && !window.supabase) { root.innerHTML = '<p class="lg-loading">Impossibile caricare la libreria di sincronizzazione. Controlla la connessione e ricarica.</p>'; return; }
  var saved = store('lg-pass');
  if (saved) { root.innerHTML = '<p class="lg-loading">Caricamento…</p>'; start(saved).catch(function () { renderLogin(); }); }
  else renderLogin();
})();
