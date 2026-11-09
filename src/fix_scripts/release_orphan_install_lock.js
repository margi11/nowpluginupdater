/**
 * Now Plugin Updater — sblocco di una coda di installazione bloccata da lock orfani (v1.7.0)
 * ---------------------------------------------------------------------------
 * PERCHE'
 * La piattaforma esegue le operazioni di installazione (Application Manager, CICD,
 * Now Plugin Updater) da una coda NowMQ (subject sys.applifecycle.operation), una
 * alla volta. Ogni operazione prende dei lock di risorsa su sys_padlock con
 * lock_key = 'r*' + <sys_id del tracker radice>. Se il thread di
 * un'installazione muore a meta', quei padlock restano: ogni operazione in coda
 * viene ritentata circa una volta al secondo senza ottenerli, e tutte le
 * installazioni restano Queued per giorni.
 *
 * E' l'alternativa da Scripts - Background al pulsante "Release blocked
 * operation..." del Monitor: stesse verifiche, stesso effetto. Non dipende dallo
 * Script Include, quindi funziona anche se l'app non e' installata o la pagina
 * non si apre.
 *
 * COSA FA
 *   1. trova i padlock di operazione (lock_key 'r*') e ne valuta i proprietari;
 *      con TRACKER_ID vuoto li elenca tutti e sceglie da solo SOLO se c'e'
 *      esattamente un'operazione sbloccabile;
 *   2. verifica: radice di un'operazione di install, Running, albero di al massimo
 *      500 tracker, nessun tracker aggiornato entro STALE_HOURS, padlock piu'
 *      vecchi di STALE_HOURS;
 *   3. stampa il backup JSON dei record che cambiera' (e in APPLY lo salva anche
 *      come allegato sul tracker radice: se non riesce, non cambia nulla);
 *   4. in APPLY: porta a Failed i tracker Running/Pending dell'albero e cancella
 *      SOLO i padlock con quella lock_key; poi verifica e scrive una riga di audit.
 *
 * COSA NON FA, MAI
 *   Non tocca i messaggi NowMQ, i latch e gli altri padlock (lock_key vuota o
 *   diversa), i tracker fuori dall'albero, i trigger. Non termina transazioni e
 *   non riavvia nodi. Da script server non si puo' sapere se il thread e' vivo
 *   (v_cluster_transaction restituisce 0 righe): lo deve controllare l'admin.
 *
 * COME SI USA
 *   1) Esegui cosi' com'e' (MODE = 'DRY_RUN'): non scrive nulla, elenca i
 *      candidati, le verifiche, il backup e il piano.
 *   2) Apri System Diagnostics > Active Transactions (v_cluster_transaction_list.do)
 *      e controlla che non ci sia una transazione dell'installazione bloccata
 *      (stesso nodo, avviata all'ora indicata).
 *   3) Imposta MODE = 'APPLY' e CONFIRM_NO_ACTIVE_TX = true, lascia attivo
 *      "Record for rollback" e riesegui. Rieseguirlo dopo e' innocuo: se non c'e'
 *      piu' niente da sbloccare lo dice.
 *   Le installazioni in coda ripartono entro un paio di minuti; quella bloccata
 *   non si e' completata e va rilanciata.
 *
 * Scope: global. Da lanciare in Scripts - Background come admin. ES5.
 * Nota Rhino: i valori delle API Glide sono stringhe Java (convertirle con '' +
 * prima di usare metodi JS) e un array vuoto e' falsy (testare sempre .length).
 */
(function () {
    'use strict';

    // ---- Configurazione -----------------------------------------------------
    var MODE = 'DRY_RUN';              // 'DRY_RUN' | 'APPLY'
    var CONFIRM_NO_ACTIVE_TX = false;  // true solo dopo il controllo del punto 2
    var TRACKER_ID = '';               // vuoto = rilevamento automatico
    var STALE_HOURS = parseFloat(gs.getProperty('x_npu.stuck_op_hours', '6'));
    if (isNaN(STALE_HOURS)) { STALE_HOURS = 6; }
    if (STALE_HOURS < 1) { STALE_HOURS = 1; }

    var SUBJECT = 'sys.applifecycle.operation';
    var TREE_CAP = 500, TREE_DEPTH = 8, LOCK_CAP = 100;
    var APPLY = (MODE === 'APPLY');
    var P = '[PluginUpdater release] ';

    // ---- Utility ------------------------------------------------------------
    function log(s) { gs.info(P + s); }
    function stop(s) { log('STOP: ' + s + ' -> nessuna modifica eseguita.'); }
    function str(v) { return '' + (v === null || v === undefined ? '' : v); }
    function ageHours(utc) {
        if (!utc) { return -1; }
        return (new GlideDateTime().getNumericValue() - new GlideDateTime(str(utc)).getNumericValue()) / 3600000;
    }
    function fmtH(h) { return (h < 1) ? (Math.max(0, Math.round(h * 60)) + ' min') : ((Math.round(h * 10) / 10) + ' h'); }

    function toObj(gr) {
        var o = { _table: str(gr.getTableName()) }, els = gr.getElements(), n = els.size ? els.size() : els.length;
        for (var i = 0; i < n; i++) {
            var el = els.get ? els.get(i) : els[i], name = str(el.getName()), v = gr.getValue(name);
            if (v !== null && v !== '') { o[name] = str(v); }
        }
        return o;
    }

    // Valori di sys_execution_tracker.state da sys_choice (lingua en).
    function trackerStates() {
        var v = { pending: '0', running: '1', successful: '2', failed: '3', cancelled: '4' };
        var c = new GlideRecord('sys_choice');
        c.addQuery('name', 'sys_execution_tracker');
        c.addQuery('element', 'state');
        c.addQuery('language', 'en');
        c.setLimit(20);
        c.query();
        while (c.next()) {
            var k = str(c.getValue('label')).toLowerCase();
            if (v.hasOwnProperty(k)) { v[k] = str(c.getValue('value')); }
        }
        return v;
    }

    function schemaMissing() {
        var need = {
            sys_padlock: ['resource_type', 'resource_id', 'lock_key'],
            sys_execution_tracker: ['state', 'parent', 'node', 'type', 'message', 'detail_message', 'percent_complete'],
            sys_nowmq_message: ['subject', 'state', 'attempt_count']
        }, miss = [];
        for (var t in need) {
            if (!need.hasOwnProperty(t)) { continue; }
            var g = new GlideRecord(t);
            if (!g.isValid()) { miss.push(t); continue; }
            for (var i = 0; i < need[t].length; i++) { if (!g.isValidField(need[t][i])) { miss.push(t + '.' + need[t][i]); } }
        }
        return miss;
    }

    // Albero dei tracker, un livello per query. truncated = non verificabile per intero.
    function opTree(rootId) {
        var root = new GlideRecord('sys_execution_tracker');
        if (!root.get(rootId)) { return null; }
        var nodes = [{ id: rootId, state: str(root.getValue('state')), updated: str(root.getValue('sys_updated_on')) }];
        var seen = {}, frontier = [rootId], truncated = false;
        seen[rootId] = true;
        for (var d = 0; d < TREE_DEPTH && frontier.length && !truncated; d++) {
            var g = new GlideRecord('sys_execution_tracker');
            g.addQuery('parent', 'IN', frontier.join(','));
            g.setLimit(TREE_CAP + 1);
            g.query();
            var next = [];
            while (g.next()) {
                var id = str(g.getUniqueValue());
                if (seen.hasOwnProperty(id)) { continue; }
                if (nodes.length >= TREE_CAP) { truncated = true; break; }
                seen[id] = true;
                nodes.push({ id: id, state: str(g.getValue('state')), updated: str(g.getValue('sys_updated_on')) });
                next.push(id);
            }
            frontier = next;
        }
        if (!truncated && frontier.length) {
            var more = new GlideRecord('sys_execution_tracker');
            more.addQuery('parent', 'IN', frontier.join(','));
            more.setLimit(1);
            more.query();
            truncated = more.hasNext();
        }
        var last = '';
        for (var i = 0; i < nodes.length; i++) { if (nodes[i].updated > last) { last = nodes[i].updated; } }
        return { root: root, nodes: nodes, last: last, truncated: truncated };
    }

    // Verifiche su un proprietario: restituisce { ok, reasons[], plan }
    function evaluate(rootId, st) {
        var key = 'r*' + rootId, res = { id: rootId, key: key, ok: false, reasons: [], locks: [], toFail: [], tree: null };
        var p = new GlideRecord('sys_padlock');
        p.addQuery('lock_key', key);
        p.setLimit(LOCK_CAP);
        p.query();
        while (p.next()) { res.locks.push(toObj(p)); }
        if (!res.locks.length) { res.reasons.push('nessun padlock con lock_key ' + key + ': niente da sbloccare'); res.nothing = true; return res; }
        var tree = opTree(rootId);
        res.tree = tree;
        if (!tree) { res.reasons.push('tracker radice non trovato (proprietario mancante): sblocco manuale'); return res; }
        var root = tree.root, rs = str(root.getValue('state'));
        res.info = 'state=' + rs + ' ' + str(root.getValue('percent_complete')) + '% | node=' + str(root.getValue('node')) +
                   ' | ultimo aggiornamento albero=' + tree.last + ' UTC (' + fmtH(ageHours(tree.last)) + ' fa) | tracker=' + tree.nodes.length +
                   ' | ' + str(root.getValue('detail_message')).substring(0, 160);
        if (str(root.getValue('parent')).length) { res.reasons.push('il tracker non e\' la radice dell\'operazione'); }
        if (str(root.getValue('type')) !== SUBJECT) { res.reasons.push('il tracker non e\' un\'operazione di installazione (type=' + str(root.getValue('type')) + ')'); }
        if (rs !== st.running) { res.reasons.push('l\'operazione non e\' Running (state=' + rs + ')'); }
        if (tree.truncated) { res.reasons.push('albero troppo grande da verificare (oltre ' + TREE_CAP + ' tracker)'); }
        for (var i = 0; i < tree.nodes.length; i++) {
            var a = ageHours(tree.nodes[i].updated);
            if (STALE_HOURS > a) { res.reasons.push('tracker ' + tree.nodes[i].id + ' aggiornato ' + fmtH(a) + ' fa: l\'installazione potrebbe essere viva'); }
            if (tree.nodes[i].state === st.running || tree.nodes[i].state === st.pending) { res.toFail.push(tree.nodes[i].id); }
        }
        for (var j = 0; j < res.locks.length; j++) {
            var lu = res.locks[j].sys_updated_on || '', lc = res.locks[j].sys_created_on || '';
            var la = ageHours(lu > lc ? lu : lc);
            if (STALE_HOURS > la) { res.reasons.push('padlock ' + res.locks[j].sys_id + ' recente (' + fmtH(la) + ')'); }
        }
        res.ok = !res.reasons.length;
        return res;
    }

    // ---- 0. Ambiente --------------------------------------------------------
    log('=========================================================');
    log('MODE=' + MODE + ' | CONFIRM_NO_ACTIVE_TX=' + CONFIRM_NO_ACTIVE_TX + ' | STALE_HOURS=' + STALE_HOURS +
        ' | TRACKER_ID=' + (TRACKER_ID || '(automatico)') + ' | ora UTC=' + str(new GlideDateTime().getValue()));
    var miss = schemaMissing();
    if (miss.length) { stop('tabelle o campi attesi assenti su questa release: ' + miss.join(', ')); return; }
    var st = trackerStates();

    // ---- 1. Coda e padlock di operazione ------------------------------------
    var mq = new GlideAggregate('sys_nowmq_message');
    mq.addQuery('subject', SUBJECT);
    mq.addQuery('state', '!=', 'DELIVERED');
    mq.addAggregate('COUNT');
    mq.addAggregate('MAX', 'attempt_count');
    mq.query();
    var waiting = 0, maxAtt = 0;
    if (mq.next()) { waiting = parseInt(mq.getAggregate('COUNT'), 10) || 0; maxAtt = parseInt(mq.getAggregate('MAX', 'attempt_count'), 10) || 0; }
    log('coda ' + SUBJECT + ': ' + waiting + ' operazioni in attesa, tentativi massimi ' + maxAtt);

    var keys = [], seenKey = {};
    var pl = new GlideRecord('sys_padlock');
    pl.addQuery('lock_key', 'STARTSWITH', 'r*');
    pl.orderBy('sys_created_on');
    pl.setLimit(LOCK_CAP);
    pl.query();
    while (pl.next()) {
        var k = str(pl.getValue('lock_key'));
        if (!seenKey.hasOwnProperty(k)) { seenKey[k] = true; keys.push(k); }
    }
    log('padlock di operazione (lock_key r*): ' + keys.length + ' proprietari');

    // ---- 2. Valutazione dei proprietari -------------------------------------
    var target = null, candidates = 0;
    var ids = [];
    if (TRACKER_ID) {
        if (!/^[0-9a-f]{32}$/i.test(TRACKER_ID)) { stop('TRACKER_ID non e\' un sys_id'); return; }
        ids.push(TRACKER_ID);
    } else {
        for (var q = 0; q < keys.length; q++) { ids.push(keys[q].substring(2)); }
    }
    if (!ids.length) { log('nessun lock di operazione: la coda non e\' bloccata da lock orfani. Niente da fare.'); return; }
    for (var e = 0; e < ids.length; e++) {
        var r = evaluate(ids[e], st);
        log('---- proprietario ' + r.id + ': ' + (r.ok ? 'SBLOCCABILE' : 'non sbloccabile'));
        if (r.info) { log('     ' + r.info); }
        log('     padlock: ' + r.locks.length + ' | tracker da portare a Failed: ' + r.toFail.length);
        for (var m = 0; m < r.reasons.length; m++) { log('     - ' + r.reasons[m]); }
        if (r.ok) { candidates++; target = r; }
        if (TRACKER_ID && r.nothing) { log('Niente da sbloccare per ' + TRACKER_ID + ' (forse gia\' sbloccato).'); return; }
    }
    if (!candidates) { log('Nessuna operazione sbloccabile con le verifiche attuali. Niente da fare.'); return; }
    if (candidates > 1) { stop(candidates + ' operazioni sbloccabili: imposta TRACKER_ID per sceglierne una'); return; }

    // ---- 3. Backup ----------------------------------------------------------
    var trackers = [];
    for (var b = 0; b < target.toFail.length; b++) {
        var tg = new GlideRecord('sys_execution_tracker');
        if (tg.get(target.toFail[b])) { trackers.push(toObj(tg)); }
    }
    var now = str(new GlideDateTime().getValue()), user = str(gs.getUserName());
    var backup = { _note: 'Now Plugin Updater - release_orphan_install_lock.js backup. trackers_to_fail are shown with their state before the change; padlocks_to_delete are the sys_padlock records to delete.',
                   taken_utc: now, by: user, threshold_hours: STALE_HOURS, root: target.id, lock_key: target.key,
                   trackers_to_fail: trackers, padlocks_to_delete: target.locks };
    var json = JSON.stringify(backup);
    log('BEGIN BACKUP (' + json.length + ' caratteri)');
    gs.info(json);
    log('END BACKUP');

    // ---- 4. Piano / esecuzione ----------------------------------------------
    log('PIANO: ' + target.toFail.length + ' tracker -> Failed; ' + target.locks.length + ' padlock con lock_key ' + target.key + ' da cancellare');
    if (!APPLY) { log('DRY_RUN completato. Nessuna modifica. Per applicare: MODE = \'APPLY\' e CONFIRM_NO_ACTIVE_TX = true.'); return; }
    if (!CONFIRM_NO_ACTIVE_TX) { stop('CONFIRM_NO_ACTIVE_TX non e\' true: controlla prima Active Transactions'); return; }

    var fileName = 'npu_release_backup_' + now.replace(/[^0-9]/g, '') + '.json';
    var attId = '';
    try { attId = str(new GlideSysAttachment().write(target.tree.root, fileName, 'application/json', json)); } catch (eA) { log('errore backup: ' + eA); }
    if (!/^[0-9a-f]{32}$/i.test(attId)) { stop('backup non salvato come allegato'); return; }
    log('backup salvato: ' + fileName + ' (sys_attachment ' + attId + ') sul tracker ' + target.id);

    var note = ('Marked Failed by Now Plugin Updater release_orphan_install_lock.js (' + user + ', ' + now + ' UTC): no progress since ' +
                target.tree.last + ' UTC and its resource locks were blocking the install queue. Backup: ' + fileName + ' on this tracker.').substring(0, 4000);
    var failed = 0, failErr = 0;
    for (var f = 0; f < target.toFail.length; f++) {
        var u = new GlideRecord('sys_execution_tracker');
        if (!u.get(target.toFail[f])) { failErr++; continue; }
        var s = str(u.getValue('state'));
        if (s !== st.running && s !== st.pending) { continue; }
        u.setValue('state', st.failed);
        u.setValue('message', note);
        if (u.update()) { failed++; } else { failErr++; }
    }
    var del = 0, delErr = 0;
    var dp = new GlideRecord('sys_padlock');
    dp.addQuery('lock_key', target.key);
    dp.setLimit(LOCK_CAP);
    dp.query();
    while (dp.next()) { dp.setWorkflow(false); if (dp.deleteRecord()) { del++; } else { delErr++; } }

    var left = new GlideAggregate('sys_padlock');
    left.addQuery('lock_key', target.key);
    left.addAggregate('COUNT');
    left.query();
    var nLeft = left.next() ? (parseInt(left.getAggregate('COUNT'), 10) || 0) : 0;

    gs.info('[PluginUpdater] release_orphan_install_lock tracker=' + target.id + ' by=' + user + ' trackersFailed=' + failed + '/' +
            target.toFail.length + ' locksDeleted=' + del + '/' + target.locks.length + ' locksLeft=' + nLeft + ' backup=sys_attachment:' + attId);
    log('=========================================================');
    log((nLeft === 0 && !failErr && !delErr ? 'APPLICATO' : 'APPLICATO CON ERRORI') + ': tracker a Failed ' + failed + '/' + target.toFail.length +
        ' (errori ' + failErr + ') | padlock cancellati ' + del + '/' + target.locks.length + ' (errori ' + delErr + ') | residui ' + nLeft);
    log('Le installazioni in coda dovrebbero ripartire entro un paio di minuti; quella bloccata va rilanciata.');
})();
