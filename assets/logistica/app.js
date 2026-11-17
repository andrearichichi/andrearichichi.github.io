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
    { key: 'riservato', label: 'Riservato', campo: 'data_riservato', desc: 'Bloccato per un acquirente' },
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
  function SupabaseBackend(pass) {
    var sb = window.supabase.createClient(CFG.url, CFG.key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-logistica-pass': pass } }
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

  function DemoBackend(pass) {
    var KEY = 'lg-demo-db';
    var db = null;
    function persist() { store(KEY, JSON.stringify(db)); }
    function ensure() {
      if (db) return Promise.resolve();
      var saved = store(KEY);
      if (saved) { try { db = JSON.parse(saved); return Promise.resolve(); } catch (e) {} }
      return fetch(CFG.base + 'seed.json', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('seed.json mancante');
        return r.json();
      }).then(function (seed) { db = { paia: seed.paia, imp: seed.impostazioni, allegati: [] }; persist(); });
    }
    var bc = null; try { bc = new BroadcastChannel('lg-demo'); } catch (e) {}
    return {
      verify: function () { return Promise.resolve(!!pass); }, // demo locale: nessuna password reale nel codice
      load: function () { return ensure().then(function () { return { paia: clone(db.paia), imp: clone(db.imp) }; }); },
      savePaio: function (p) {
        return ensure().then(function () {
          var d = clone(p); delete d._agg; d._aggLocal = new Date().toISOString();
          db.paia = db.paia.map(function (x) { return x.id === p.id ? d : x; }); persist();
        });
      },
      saveImp: function (k, v) { return ensure().then(function () { db.imp[k] = v; persist(); }); },
      listAllegati: function (id) {
        return ensure().then(function () {
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
          db.allegati.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), paio_id: id, nome: a.nome, tipo: a.tipo, dimensione: a.dimensione, dati: a.dati, creato: new Date().toISOString() });
          persist();
        });
      },
      delAllegato: function (aid) { return ensure().then(function () { db.allegati = db.allegati.filter(function (x) { return x.id !== aid; }); persist(); }); },
      subscribe: function (cb) { if (bc) bc.onmessage = function (e) { db = null; cb(e.data || {}); }; },
      notify: function (payload) { if (bc) bc.postMessage(payload || {}); }
    };
  }

  /* =====================================================================
     Stato app
     ===================================================================== */
  var S = {
    be: null, paia: [], imp: {}, loaded: false, lastSync: null, syncing: false,
    stato: '', editing: false, pendingRefresh: false, allegati: {}, allegatiFor: null
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

  function start(pw, interactive) {
    var be = DEMO ? DemoBackend(pw) : SupabaseBackend(pw);
    return be.verify().then(function (ok) {
      if (!ok) { store('lg-pass', null); throw new Error('bad'); }
      store('lg-pass', pw);
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
    return S.be.load().then(function (d) {
      S.paia = d.paia.sort(sortById); S.imp = d.imp || {}; S.loaded = true; S.lastSync = new Date();
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

  function addStorico(p, testo) {
    p.storico = (p.storico || []).concat([{ data: oggi(), evento: testo }]);
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
      '<span class="lg-topbar-r"><button type="button" class="lg-link" id="lg-refresh">Aggiorna</button>' +
      '<button type="button" class="lg-link" id="lg-logout">Esci</button></span></div>';
  }
  function bindTopbar() {
    var r = $('#lg-refresh'); if (r) r.onclick = function () { refresh().then(function () { toast('Aggiornato'); }); };
    var l = $('#lg-logout'); if (l) l.onclick = logout;
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
    var cols = ['id', 'codice', 'nome', 'sesso', 'taglia', 'listino', 'pagato', 'costo_reale', 'stato', 'vendita', 'commissioni', 'costo_spedizione', 'margine', 'canale', 'acquirente', 'contatto', 'metodo_pagamento', 'pagamento_ricevuto', 'data_riservato', 'data_vendita', 'data_spedizione', 'data_consegna', 'data_conclusione', 'corriere', 'tracking', 'posizione', 'note'];
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
  function bilancioHTML(paia, imp, incassato) {
    var b = imp.bilancio || { fee_percentuale: 5, soci: {} }, so = b.soci || {};
    var feeP = num(b.fee_percentuale), cap = num((imp.acquisto || {}).totale);
    var fee = incassato * feeP / 100, dopo = incassato - fee, rimb = Math.min(dopo, cap), ut = Math.max(0, dopo - cap), half = ut / 2;
    var rientro = cap ? 100 * rimb / cap : 0;
    var A = esc(so.andrea || 'Socio A'), B = esc(so.benedetto || 'Socio B'), G = esc(so.gianluigi || 'Commerciale');
    return '<section class="lg-section lg-bil"><header class="lg-bil-h"><div><h2>Bilancio e ripartizione</h2>' +
      '<p class="lg-sub">Valori in euro. La colonna <i>Attuale</i> considera solo gli importi effettivamente incassati.</p></div>' +
      '<div class="lg-bil-cap"><span>Rientro capitale</span><b>' + pct(rientro) + '</b><div class="lg-bar"><i style="width:' + Math.min(100, rientro) + '%"></i></div></div></header>' +
      '<table class="lg-fin" id="sim"><thead><tr><th></th><th>Attuale</th><th>Proiezione<span class="lg-fin-in">' + paia.length + ' paia × <span class="lg-eur"><span>€</span><input id="sim-p" type="number" min="0" step="10" value="' + esc(store('lg-sim') || 200) + '" inputmode="numeric" aria-label="Prezzo medio di vendita a paio"></span></span></th></tr></thead>' +
      '<tbody><tr class="sum"><th>Incassato dalle vendite</th><td>' + n2(incassato) + '</td><td data-k="tot"></td></tr>' +
      '<tr><th>Fee commerciale ' + G + ' (' + feeP + '%)</th><td>(' + n2(fee) + ')</td><td data-k="fee"></td></tr>' +
      '<tr><th>Rimborso capitale ' + B + '</th><td>(' + n2(rimb) + ')</td><td data-k="cap"></td></tr>' +
      '<tr class="sum"><th>Utile da ripartire</th><td>' + n2(ut) + '</td><td data-k="ut"></td></tr></tbody>' +
      '<tbody class="lg-fin-split"><tr class="grp"><th colspan="3">Ripartizione per socio</th></tr>' +
      '<tr><th>' + A + "<small>50% dell'utile</small></th><td>" + n2(half) + '</td><td data-k="a"></td></tr>' +
      '<tr><th>' + B + "<small>Rimborso capitale + 50% dell'utile</small></th><td>" + n2(rimb + half) + '</td><td data-k="b"></td></tr>' +
      '<tr><th>' + G + '<small>Fee ' + feeP + "% sull'incassato</small></th><td>" + n2(fee) + '</td><td data-k="g"></td></tr>' +
      '<tr class="total"><th>Totale</th><td>' + n2(incassato) + '</td><td data-k="tot2"></td></tr></tbody></table>' +
      '<p class="lg-fin-note">Criterio di ripartizione: sull\'incassato si applica una fee del ' + feeP + '% a favore di ' + G + '; il residuo rimborsa in via prioritaria il capitale anticipato da ' + B + ' (' + eur(cap) + "); l'utile eccedente è ripartito in parti uguali tra " + A + ' e ' + B + '. Il capitale è interamente rimborsato al raggiungimento di ' + eur(cap / (1 - feeP / 100)) + ' di incassato.</p></section>';
  }
  function bindBilancio(n, imp) {
    var box = $('#sim'), inp = $('#sim-p'); if (!box) return;
    var b = imp.bilancio || {}, feeP = num(b.fee_percentuale), cap = num((imp.acquisto || {}).totale);
    function set(k, v) { $('[data-k=' + k + ']', box).textContent = v; }
    function calcSim() {
      var p = Math.max(0, num(inp.value)), tot = n * p, fee = tot * feeP / 100, dopo = tot - fee, rimb = Math.min(dopo, cap), half = Math.max(0, dopo - cap) / 2;
      set('tot', n2(tot)); set('fee', '(' + n2(fee) + ')'); set('cap', '(' + n2(rimb) + ')'); set('ut', n2(half * 2));
      set('a', n2(half)); set('b', n2(rimb + half)); set('g', n2(fee)); set('tot2', n2(tot));
      store('lg-sim', inp.value);
    }
    inp.addEventListener('input', calcSim); calcSim();
  }

  /* =====================================================================
     DETTAGLIO
     ===================================================================== */
  function kv(label, value, cls) {
    if (value === '' || value == null) return '';
    return '<div' + (cls ? ' class="' + cls + '"' : '') + '><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  }

  function renderDetail(p) {
    var paia = S.paia, imp = S.imp, c = calc(p, paia, imp), acq = imp.acquisto || {};
    var idx = paia.indexOf(p), prev = paia[idx - 1], next = paia[idx + 1];
    var cur = Math.max(0, ORDER.indexOf(p.stato));
    var nextStato = STATI[cur + 1];

    var h = topbar();
    h += '<div class="lg-detail"><nav class="lg-nav"><a href="#/" class="lg-back">← Tutte le paia</a><span class="lg-prevnext">' +
      (prev ? '<a href="#/' + prev.id + '" title="' + esc(prev.nome) + ' (tasto ←)">‹ ' + prev.id + '</a>' : '') +
      '<span class="lg-pos">' + (idx + 1) + ' / ' + paia.length + '</span>' +
      (next ? '<a href="#/' + next.id + '" title="' + esc(next.nome) + ' (tasto →)">' + next.id + ' ›</a>' : '') + '</span></nav>';

    // Testata
    h += '<section class="lg-hero"><div class="lg-ph lg-hero-ph"><img src="' + foto(p) + '" alt="' + esc(p.nome) + '" width="1200" height="900"></div><div class="lg-hero-b">' +
      '<div class="lg-hero-top"><span class="lg-id big">' + esc(p.id) + '</span><span class="lg-status s-' + esc(p.stato) + '"><i class="lg-dot"></i>' + esc(LABEL[p.stato]) + '</span></div>' +
      '<h1>' + esc(p.nome) + '</h1><div class="lg-tags"><span class="lg-tag big">Taglia <b>' + esc(p.taglia) + '</b></span><span class="lg-tag">' + esc(p.sesso) + '</span><span class="lg-tag mono">' + esc(p.codice) + '</span></div>' +
      '<div class="lg-nums"><div><span>Costo reale</span><b>' + eur(c.costo) + '</b></div><div><span>Prezzo di listino</span><b>' + eur(p.listino) + '</b></div>' +
      (p.vendita
        ? '<div><span>Venduta a</span><b>' + eur(p.vendita) + '</b></div><div class="hl"><span>Guadagno netto</span><b class="' + (c.margine < 0 ? 'neg' : 'pos') + '">' + (c.margine > 0 ? '+' : '') + eur(c.margine) + '</b></div>'
        : '<div><span>Venduta a</span><b class="lg-na">—</b></div><div class="hl"><span>Guadagno max (a listino)</span><b class="pos">+' + eur(num(p.listino) - c.costo) + '</b></div>') +
      '</div><div class="lg-actions">' +
      (nextStato ? '<button type="button" class="lg-btn primary" id="act-next">Segna come ' + nextStato.label.toLowerCase() + ' →</button>' : '') +
      '<button type="button" class="lg-btn" id="act-edit">Modifica dati</button>' +
      (c.venduta && !c.incassato ? '<button type="button" class="lg-btn" id="act-paid">Pagamento ricevuto ✓</button>' : '') +
      '</div></div></section>';

    // Stepper
    h += '<section class="lg-box"><h2>A che punto è</h2><ol class="lg-steps">';
    STATI.forEach(function (s, i) {
      var date = s.key === 'disponibile' ? acq.data : p[s.campo];
      h += '<li class="s-' + s.key + ' ' + (i < cur ? 'done' : i === cur ? 'now' : '') + '"><button type="button" class="lg-step" data-stato="' + s.key + '" title="Imposta stato: ' + s.label + '"><i>' + (i < cur ? '✓' : i + 1) + '</i><b>' + s.label + '</b><small>' + (date ? dataIt(date) : i <= cur ? 'senza data' : '&nbsp;') + '</small></button></li>';
    });
    h += '</ol><p class="lg-stepnote">Stato attuale: <b>' + esc(LABEL[p.stato]) + '</b> — ' + esc((STATI[cur] || {}).desc || '') + '. Clicca un passaggio per impostarlo.</p></section>';

    // Edit form (nascosto) + riquadri
    h += '<div id="lg-editwrap" hidden>' + editForm(p) + '</div>';
    h += '<div id="lg-view">' + detailBoxes(p, c, acq) + '</div>';

    // Allegati
    h += '<section class="lg-box" id="lg-att"><div class="lg-box-h"><h2>Screenshot e documenti <small id="att-n"></small></h2>' +
      '<label class="lg-btn"><input type="file" id="att-file" accept="image/*,application/pdf" multiple hidden>+ Carica file</label></div>' +
      '<div class="lg-drop" id="att-drop"><div class="lg-shots" id="att-list"><p class="lg-empty">Caricamento…</p></div>' +
      '<p class="lg-drop-hint">Trascina qui i file, oppure incolla uno screenshot con <kbd>⌘V</kbd> / <kbd>Ctrl+V</kbd>.</p></div></section>';

    // Note + Diario
    h += '<div class="lg-cols"><section class="lg-box"><h2>Note</h2>' +
      (p.note ? '<div class="lg-notes">' + esc(p.note).replace(/\n/g, '<br>') + '</div>' : '<p class="lg-empty">Nessuna nota. Aggiungila da "Modifica dati".</p>') + '</section>' +
      '<section class="lg-box"><h2>Diario</h2><ul class="lg-log">' +
      (p.storico && p.storico.length ? p.storico.slice().reverse().map(function (e) { return '<li><time>' + esc(dataIt(e.data)) + '</time><span>' + esc(e.evento) + '</span></li>'; }).join('') : '<li class="lg-empty">Nessun evento.</li>') +
      '</ul><form class="lg-logadd" id="log-add"><input type="date" name="d" value="' + oggi() + '" aria-label="Data"><input type="text" name="t" placeholder="Aggiungi un evento…" aria-label="Evento" required><button class="lg-btn">Aggiungi</button></form></section></div>';

    // Stesso modello
    var same = paia.filter(function (x) { return x.codice === p.codice; });
    if (same.length > 1) {
      h += '<section class="lg-box"><h2>Stesso modello, altre paia</h2><div class="lg-pills">' +
        same.slice().sort(function (a, b) { return num(a.taglia) - num(b.taglia); }).map(function (x) {
          return '<a href="#/' + x.id + '" class="lg-pill wide s-' + esc(x.stato) + (x.id === p.id ? ' me' : '') + '" title="' + esc(LABEL[x.stato]) + '">' + x.id + ' · Tg ' + esc(x.taglia) + '</a>';
        }).join('') + '</div></section>';
    }

    // Annuncio
    h += '<section class="lg-box"><h2>Testo per l\'annuncio</h2><textarea id="ad" rows="5">Golden Goose – ' + esc(p.nome) + '\nTaglia ' + esc(p.taglia) + ' EU (' + esc(p.sesso) + ')\nNuove, mai indossate, con scatola originale.\nCodice articolo: ' + esc(p.codice) + '\nPrezzo di listino: ' + eur(p.listino) + '</textarea>' +
      '<button type="button" class="lg-btn primary" id="copy-ad">Copia testo</button></section></div>';

    h += '<dialog id="lb" class="lg-lb"><img alt=""><form method="dialog"><button aria-label="Chiudi">✕</button></form></dialog>';
    root.innerHTML = h;
    bindTopbar();
    bindDetail(p, prev, next);
    loadAllegati(p.id);
  }

  function detailBoxes(p, c, acq) {
    var hasV = p.acquirente || p.contatto || p.canale || p.vendita || c.venduta;
    var hasS = p.modalita_consegna || p.corriere || p.tracking || p.data_spedizione || p.data_consegna || p.indirizzo;
    var h = '<div class="lg-cols">';
    h += '<section class="lg-box"><h2>Vendita</h2>';
    if (hasV) {
      h += '<dl class="lg-kv">' + kv('Acquirente', p.acquirente ? '<b>' + esc(p.acquirente) + '</b>' : '') + kv('Contatto', esc(p.contatto || '')) + kv('Canale', esc(p.canale || ''));
      if (p.vendita) {
        h += kv('Prezzo di vendita', '<b>' + eur(p.vendita) + '</b>') +
          (c.commissioni ? kv('Commissioni', '−' + eur(c.commissioni)) : '') +
          (c.spedVendita ? kv('Spedizione pagata da te', '−' + eur(c.spedVendita)) : '') +
          (c.commissioni || c.spedVendita ? kv('Netto incassato', eur(c.netto)) : '') +
          kv('Costo reale', '−' + eur(c.costo)) +
          kv('Guadagno netto', '<b class="' + (c.margine < 0 ? 'neg' : 'pos') + '">' + eur(c.margine) + '</b> <small>(' + pct(100 * c.margine / c.costo) + ' sul costo)</small>', 'tot');
      } else h += kv('Prezzo di vendita', '<span class="lg-wait">Da definire</span>');
      h += '</dl>';
    } else {
      h += '<p class="lg-empty-big">Non ancora venduta.</p><p class="lg-empty">Al prezzo di listino guadagneresti fino a <b class="pos">+' + eur(num(p.listino) - c.costo) + '</b>.</p>';
    }
    h += '</section>';

    h += '<section class="lg-box"><h2>Pagamento e date</h2><dl class="lg-kv">' +
      (c.venduta ? kv('Pagamento', c.incassato ? '<span class="lg-ok">✓ Ricevuto</span>' : '<span class="lg-wait">In attesa</span>') : '') +
      kv('Metodo', esc(p.metodo_pagamento || '')) + kv('Pagata il', dataIt(p.data_pagamento)) +
      kv('Acquistata il', dataIt(acq.data)) + kv('Riservata il', dataIt(p.data_riservato)) + kv('Venduta il', dataIt(p.data_vendita)) +
      kv('Spedita il', dataIt(p.data_spedizione)) + kv('Consegnata il', dataIt(p.data_consegna)) + kv('Conclusa il', dataIt(p.data_conclusione)) +
      kv('Dove si trova', esc(p.posizione || '')) + '</dl></section>';

    h += '<section class="lg-box"><h2>Spedizione al cliente</h2>';
    if (hasS) {
      var tr = p.tracking ? (p.tracking_url ? '<a href="' + esc(p.tracking_url) + '" target="_blank" rel="noopener">' + esc(p.tracking) + ' ↗</a>' : esc(p.tracking)) : '';
      h += '<dl class="lg-kv">' + kv('Modalità', esc(p.modalita_consegna || '')) + kv('Corriere', p.corriere ? '<b>' + esc(p.corriere) + '</b>' : '') +
        kv('Tracking', tr ? '<span class="mono">' + tr + '</span>' : '') + kv('Spedita il', dataIt(p.data_spedizione)) + kv('Consegnata il', dataIt(p.data_consegna)) + kv('Indirizzo', esc(p.indirizzo || '')) + '</dl>';
    } else h += '<p class="lg-empty-big">Non ancora spedita.</p><p class="lg-empty">Quando la spedisci aggiungi corriere, tracking e date da "Modifica dati".</p>';
    h += '</section>';

    h += '<section class="lg-box"><h2>Prodotto e costo</h2><dl class="lg-kv">' +
      kv('Codice articolo', '<span class="mono">' + esc(p.codice) + '</span>') + kv('Uomo / Donna', esc(p.sesso)) + kv('Taglia (EU)', '<b>' + esc(p.taglia) + '</b>') +
      kv('Condizione', esc(p.condizione || 'Nuova')) + kv('Prezzo di listino', eur(p.listino)) +
      kv('Prezzo pagato', eur(p.pagato) + ' <small>(−' + pct(c.sconto) + ')</small>') +
      kv('+ Quota spedizione', eur(c.quota) + ' <small>(' + eur(acq.spedizione) + ' ÷ ' + S.paia.length + ')</small>') +
      kv('= Costo reale', '<b>' + eur(c.costo) + '</b>', 'tot') + '</dl></section></div>';
    return h;
  }

  /* ---------------- Form di modifica ---------------- */
  var F = function (name, label, type, p, extra) {
    var v = p[name] == null ? '' : p[name];
    extra = extra || {};
    var id = 'f-' + name;
    var input;
    if (type === 'select') input = '<select id="' + id + '" name="' + name + '">' + extra.options.map(function (o) { var val = o.v != null ? o.v : o; var lab = o.l || o; return '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(lab) + '</option>'; }).join('') + '</select>';
    else if (type === 'textarea') input = '<textarea id="' + id + '" name="' + name + '" rows="3">' + esc(v) + '</textarea>';
    else if (type === 'checkbox') return '<label class="lg-f lg-f-check"><input type="checkbox" id="' + id + '" name="' + name + '"' + (v ? ' checked' : '') + '><span>' + label + '</span></label>';
    else input = '<input id="' + id + '" name="' + name + '" type="' + type + '" value="' + esc(v) + '"' + (extra.list ? ' list="' + extra.list + '"' : '') + (type === 'number' ? ' step="0.01" min="0" inputmode="decimal"' : '') + (extra.ph ? ' placeholder="' + esc(extra.ph) + '"' : '') + '>';
    return '<label class="lg-f' + (extra.wide ? ' wide' : '') + '" for="' + id + '"><span>' + label + '</span>' + input + '</label>';
  };

  function editForm(p) {
    return '<form class="lg-box lg-edit" id="lg-edit" novalidate>' +
      '<div class="lg-box-h"><h2>Modifica ' + esc(p.id) + '</h2><span><button type="button" class="lg-btn" id="ed-cancel">Annulla</button> <button type="submit" class="lg-btn primary">Salva</button></span></div>' +
      '<fieldset><legend>Stato</legend><div class="lg-fgrid">' +
      F('stato', 'Stato', 'select', p, { options: STATI.map(function (s) { return { v: s.key, l: s.label }; }) }) +
      F('posizione', 'Dove si trova', 'text', p, { ph: 'Es. Scatola 3, armadio' }) +
      F('condizione', 'Condizione', 'text', p, { ph: 'Nuova' }) +
      '</div></fieldset>' +
      '<fieldset><legend>Vendita</legend><div class="lg-fgrid">' +
      F('acquirente', 'Acquirente', 'text', p) + F('contatto', 'Contatto', 'text', p, { ph: '@instagram, telefono…' }) +
      F('canale', 'Canale', 'text', p, { list: 'dl-canali' }) +
      F('vendita', 'Prezzo di vendita (€)', 'number', p) + F('commissioni', 'Commissioni piattaforma (€)', 'number', p) +
      F('metodo_pagamento', 'Metodo di pagamento', 'text', p, { list: 'dl-pag' }) +
      F('data_riservato', 'Riservata il', 'date', p) + F('data_vendita', 'Venduta il', 'date', p) + F('data_pagamento', 'Pagata il', 'date', p) +
      F('pagamento_ricevuto', 'Pagamento ricevuto', 'checkbox', p) +
      '</div></fieldset>' +
      '<fieldset><legend>Spedizione al cliente</legend><div class="lg-fgrid">' +
      F('modalita_consegna', 'Modalità', 'select', p, { options: ['', 'Spedizione', 'A mano'] }) +
      F('corriere', 'Corriere', 'text', p, { list: 'dl-corr' }) + F('tracking', 'Codice tracking', 'text', p) +
      F('tracking_url', 'Link tracking', 'url', p, { ph: 'https://…' }) + F('costo_spedizione', 'Spedizione pagata da te (€)', 'number', p) +
      F('data_spedizione', 'Spedita il', 'date', p) + F('data_consegna', 'Consegnata il', 'date', p) + F('data_conclusione', 'Conclusa il', 'date', p) +
      F('indirizzo', 'Indirizzo', 'text', p, { wide: true }) +
      '</div></fieldset>' +
      '<fieldset><legend>Note</legend>' + F('note', 'Note', 'textarea', p, { wide: true }) + '</fieldset>' +
      '<details><summary>Dati prodotto (di solito non serve toccarli)</summary><div class="lg-fgrid">' +
      F('nome', 'Modello', 'text', p, { wide: true }) + F('codice', 'Codice articolo', 'text', p) +
      F('sesso', 'Uomo / Donna', 'select', p, { options: ['Uomo', 'Donna'] }) + F('taglia', 'Taglia', 'number', p) +
      F('listino', 'Prezzo di listino (€)', 'number', p) + F('pagato', 'Prezzo pagato (€)', 'number', p) +
      '</div></details>' +
      '<datalist id="dl-canali"><option>Vinted</option><option>Instagram</option><option>WhatsApp</option><option>Subito</option><option>Di persona</option></datalist>' +
      '<datalist id="dl-pag"><option>PayPal</option><option>Bonifico</option><option>Contanti</option><option>Satispay</option><option>Revolut</option><option>Vinted</option></datalist>' +
      '<datalist id="dl-corr"><option>BRT</option><option>GLS</option><option>Poste Italiane</option><option>SDA</option><option>InPost</option><option>DHL</option><option>UPS</option></datalist>' +
      '<div class="lg-edit-foot"><button type="button" class="lg-btn" id="ed-cancel2">Annulla</button> <button type="submit" class="lg-btn primary">Salva modifiche</button></div>' +
      '</form>';
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
    return d;
  }

  function bindDetail(p, prev, next) {
    var view = $('#lg-view'), wrap = $('#lg-editwrap'), form = $('#lg-edit');
    function openEdit() { S.editing = true; wrap.hidden = false; view.hidden = true; wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    function closeEdit() { S.editing = false; if (S.pendingRefresh) { S.pendingRefresh = false; rerender(); } else { wrap.hidden = true; view.hidden = false; } showSyncBadge(); }
    $('#act-edit').onclick = openEdit;
    $('#ed-cancel').onclick = closeEdit; $('#ed-cancel2').onclick = closeEdit;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = readForm(form, p);
      if (d.stato !== p.stato) {
        addStorico(d, 'Stato: ' + LABEL[p.stato] + ' → ' + LABEL[d.stato]);
        var campo = (STATI[ORDER.indexOf(d.stato)] || {}).campo;
        if (campo && !d[campo]) d[campo] = oggi();
      }
      if (d.vendita && d.vendita !== p.vendita) addStorico(d, 'Prezzo di vendita: ' + eur(d.vendita));
      if (d.pagamento_ricevuto && !p.pagamento_ricevuto) { addStorico(d, 'Pagamento ricevuto'); if (!d.data_pagamento) d.data_pagamento = oggi(); }
      $$('button[type=submit]', form).forEach(function (b) { b.disabled = true; b.textContent = 'Salvataggio…'; });
      savePaio(d, 'Modifiche salvate').catch(function () { $$('button[type=submit]', form).forEach(function (b) { b.disabled = false; b.textContent = 'Salva'; }); });
    });

    function setStato(k) {
      if (k === p.stato) return;
      var d = clone(p);
      var campo = (STATI[ORDER.indexOf(k)] || {}).campo;
      if (campo && !d[campo]) d[campo] = oggi();
      addStorico(d, 'Stato: ' + LABEL[p.stato] + ' → ' + LABEL[k]);
      d.stato = k;
      savePaio(d, 'Stato aggiornato: ' + LABEL[k]);
    }
    var nx = $('#act-next');
    if (nx) nx.onclick = function () { var ns = STATI[ORDER.indexOf(p.stato) + 1]; if (ns) setStato(ns.key); };
    $$('.lg-step').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.stato; if (k === p.stato) return;
        if (confirm('Impostare lo stato di ' + p.id + ' su "' + LABEL[k] + '"?')) setStato(k);
      };
    });
    var paid = $('#act-paid');
    if (paid) paid.onclick = function () {
      var d = clone(p); d.pagamento_ricevuto = true; if (!d.data_pagamento) d.data_pagamento = oggi();
      addStorico(d, 'Pagamento ricevuto'); savePaio(d, 'Pagamento registrato');
    };

    $('#log-add').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = e.target.t.value.trim(); if (!t) return;
      var d = clone(p); d.storico = (d.storico || []).concat([{ data: e.target.d.value || oggi(), evento: t }]);
      savePaio(d, 'Evento aggiunto');
    });

    $('#copy-ad').onclick = function () {
      var b = this; navigator.clipboard.writeText($('#ad').value).then(function () { var o = b.textContent; b.textContent = 'Copiato ✓'; setTimeout(function () { b.textContent = o; }, 1500); });
    };

    // Allegati
    var fileIn = $('#att-file'), drop = $('#att-drop');
    fileIn.addEventListener('change', function () { uploadFiles(p.id, fileIn.files); fileIn.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(p.id, e.dataTransfer.files); });
    document.onpaste = function (e) {
      if (currentId() !== p.id || S.editing) return;
      var items = (e.clipboardData || {}).items || [], files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); uploadFiles(p.id, files); }
    };

    // Lightbox
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
      if (!rows.length) { list.innerHTML = '<p class="lg-empty">Nessun file. Carica la chat con l\'acquirente, la ricevuta del pagamento, l\'etichetta di spedizione…</p>'; return; }
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
          S.be.delAllegato(a.id).then(function () { delete thumbCache[a.id]; S.be.notify({ id: id }); toast('File eliminato'); loadAllegati(id); })
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
        if (p) { var d = clone(p); addStorico(d, ok === 1 ? 'Caricato 1 file' : 'Caricati ' + ok + ' file'); S.be.savePaio(d).then(function () { S.be.notify({ id: id }); refresh(); }); }
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
