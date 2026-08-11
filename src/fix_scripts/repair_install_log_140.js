/**
 * Now Plugin Updater — riparazione dello storico install-log (v1.4.0)
 * ---------------------------------------------------------------------------
 * PERCHE'
 * Fino alla v1.3.7 monitorBatches() leggeva 'completion_code' su
 * sys_progress_worker: un campo che NON esiste su quella tabella (il campo di
 * esito e' 'state_code'). Il ramo che rilevava l'errore non scattava mai, quindi
 * ogni worker con state='complete' veniva finalizzato come 'complete' anche
 * quando l'installazione era fallita (state_code='error') o non era stata
 * applicata (versione invariata).
 *
 * Risultato: righe storiche che dichiarano 'complete' un aggiornamento mai
 * avvenuto. Correggere il codice non basta — lo storico resta fuorviante, ed e'
 * proprio quello che un admin consulta per capire se un update e' passato.
 *
 * COSA FA
 * Rilegge le righe 'complete' e le riclassifica come 'failed' quando la versione
 * installata non corrisponde al target, oppure quando il worker riporta
 * state_code di errore.
 *
 * COME SI USA
 *   1) Esegui cosi' com'e' (DRY_RUN = true): non scrive nulla, elenca solo cosa
 *      cambierebbe. Verifica l'output.
 *   2) Metti DRY_RUN = false e riesegui per applicare le correzioni.
 *
 * Scope: global. Da lanciare in Scripts - Background come admin.
 */
(function () {
    'use strict';

    // ---- Configurazione -----------------------------------------------------
    var DRY_RUN = true;   // <-- portare a false solo dopo aver letto l'output
    var LIMIT   = 5000;   // tetto di sicurezza sulle righe esaminate

    // ---- Utility ------------------------------------------------------------
    function currentVersion(appSysId, cache) {
        if (!appSysId || !/^[0-9a-f]{32}$/i.test(appSysId)) { return null; }
        if (cache.hasOwnProperty(appSysId)) { return cache[appSysId]; }
        var app = new GlideRecord('sys_store_app');
        cache[appSysId] = app.get(appSysId) ? (app.getValue('version') || '') : null;
        return cache[appSysId];
    }

    function workerOutcome(pid) {
        if (!pid || !/^[0-9a-f]{32}$/i.test(pid)) { return null; }
        var w = new GlideRecord('sys_progress_worker');
        if (!w.get(pid)) { return null; }
        return {
            state: (w.getValue('state') || '').toLowerCase(),
            code:  (w.getValue('state_code') || '').toLowerCase(),
            error: w.getValue('error_message') || '',
            msg:   w.getValue('message') || ''
        };
    }

    // ---- Scansione ----------------------------------------------------------
    var verCache = {};
    var stats = { examined: 0, repaired: 0, alreadyOk: 0, unverifiable: 0 };
    var changes = [];

    var gr = new GlideRecord('u_plugin_updater_install_log');
    gr.addQuery('u_status', 'complete');
    gr.orderByDesc('sys_created_on');
    gr.setLimit(LIMIT);
    gr.query();

    while (gr.next()) {
        stats.examined++;

        var appId  = gr.getValue('u_store_app_id');
        var target = gr.getValue('u_target_version') || '';
        var name   = gr.getValue('u_app_name') || '(unnamed)';
        var cur    = currentVersion(appId, verCache);

        // App non piu' presente (disinstallata o record rimosso): non giudicabile.
        if (cur === null) {
            stats.unverifiable++;
            continue;
        }

        var w = workerOutcome(gr.getValue('u_progress_id'));
        var codeFailed = !!(w && (w.code === 'error' || w.code === 'failed' || w.code === 'cancelled'));
        var versionMismatch = (cur !== target);

        if (!codeFailed && !versionMismatch) {
            stats.alreadyOk++;
            continue;
        }

        // Motivo leggibile, coerente con _failMessage() dello Script Include.
        var reason;
        if (w && w.error) {
            reason = w.error;
        } else if (versionMismatch) {
            reason = 'Install did not apply: still at ' + (cur || 'unknown') + ' (expected ' + target + ')';
        } else {
            reason = 'Install failed (worker state_code=' + ((w && w.code) || 'unknown') + ')';
        }
        reason = ('' + reason).substring(0, 1000);

        changes.push({
            sysId:  gr.getUniqueValue(),
            batch:  gr.getValue('u_session_id'),
            name:   name,
            target: target,
            actual: cur,
            code:   (w && w.code) || '-',
            reason: reason
        });

        if (!DRY_RUN) {
            gr.setValue('u_status', 'failed');
            gr.setValue('u_error_message', reason);
            gr.update();
        }
        stats.repaired++;
    }

    // ---- Report -------------------------------------------------------------
    gs.info('=========================================================');
    gs.info('[PluginUpdater repair] ' + (DRY_RUN ? 'DRY RUN — nessuna modifica scritta' : 'APPLICATO'));
    gs.info('[PluginUpdater repair] esaminate=' + stats.examined +
            ' da_correggere=' + stats.repaired +
            ' gia_corrette=' + stats.alreadyOk +
            ' non_verificabili=' + stats.unverifiable);
    gs.info('=========================================================');

    for (var i = 0; i < changes.length; i++) {
        var c = changes[i];
        gs.info('[' + (i + 1) + '] ' + c.name +
                ' | batch=' + c.batch +
                ' | target=' + c.target + ' actual=' + c.actual +
                ' | state_code=' + c.code +
                ' | ' + c.reason);
    }

    if (DRY_RUN && stats.repaired > 0) {
        gs.info('---------------------------------------------------------');
        gs.info('[PluginUpdater repair] Per applicare: DRY_RUN = false e rieseguire.');
    }
    if (stats.unverifiable > 0) {
        gs.info('[PluginUpdater repair] ' + stats.unverifiable +
                ' righe non verificabili (app non piu\' presente su sys_store_app): lasciate invariate.');
    }
})();
