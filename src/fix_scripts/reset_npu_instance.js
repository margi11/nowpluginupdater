/**
 * Now Plugin Updater — reset completo dell'istanza di test (disinstallazione)
 * ---------------------------------------------------------------------------
 * PERCHE'
 * L'app e' in scope Global: non esiste un "Uninstall" in App Manager. Per
 * ripetere un test di installazione da zero senza chiedere ogni volta una
 * nuova istanza, bisogna togliere non solo i record dell'app ma anche la loro
 * storia. Se restano sys_update_version o sys_metadata_delete con gli stessi
 * nomi, la preview del nuovo update set li vede come "cancellazione locale piu'
 * recente" e non come inserimenti puliti. Se resta l'update set locale da cui
 * e' stato fatto l'export (stesso remote_sys_id), l'import mostra un falso
 * successo (vedi spec §18 e la lezione della v1.6.5).
 *
 * COSA FA
 *  0) Guardia: gira SOLO sull'istanza in ALLOWED_INSTANCE.
 *  1) Inventario: raccoglie i nomi (sys_update_name) di tutti gli oggetti
 *     presenti negli update set NPU, locali e remoti. Cosi' copre ogni oggetto
 *     mai rilasciato, senza un elenco scritto a mano. Esclude le property
 *     mcp.bg_result.* finite per errore negli update set (artefatti del tool MCP).
 *  2) Dati runtime: sys_trigger e sysauto_script creati dall'app, property
 *     x_npu.sync_state / __npu_sync_job_id, righe dell'install-log.
 *  3) Oggetti dell'app, figli prima dei padri (ruoli ACL, ACL, modulo, menu,
 *     UI Page, Script Include, job, etichette, choice, tabella per ultima).
 *  4) Storia: sys_update_xml, sys_update_version, sys_metadata_delete con quei
 *     nomi (incluse le voci DELETE appena catturate nell'update set corrente),
 *     poi gli update set NPU locali e remoti con le loro voci.
 *
 * COME SI USA (Scripts - Background, come admin)
 *   1) MODE = 'dryrun'  : non scrive nulla, stampa inventario e conteggi.
 *   2) MODE = 'execute' : esegue i passi 2-4. Le ACL richiedono la sessione
 *      elevata a security_admin: senza, deleteRecord() fallisce e lo script lo
 *      segnala nel riepilogo.
 *   3) MODE = 'verify'  : in un'esecuzione separata (cache e dizionario gia'
 *      aggiornati) ricontrolla che tutto sia a zero e che la tabella non esista.
 *
 * Scope: global. Distruttivo e irreversibile in MODE = 'execute'.
 */
(function () {
    var MODE = 'dryrun';                      // 'dryrun' | 'execute' | 'verify'
    var ALLOWED_INSTANCE = 'empgmarongiu1';

    var SET_PREFIX = 'Now Plugin Updater';
    var LOG_TABLE = 'u_plugin_updater_install_log';
    var JOB_PREFIX = 'Plugin Updater - ';
    var RUNTIME_PROPS = ['x_npu.sync_state', '__npu_sync_job_id'];

    // Ordine di cancellazione per tabella: figli prima dei padri, tabella per ultima.
    // sys_dictionary non compare: le colonne cadono con la tabella; eventuali
    // residui vengono rimossi nel passo successivo.
    var ORDER = ['sys_security_acl_role', 'sys_security_acl', 'sys_app_module',
                 'sys_app_application', 'sys_ui_page', 'sys_script_include',
                 'sysauto_script', 'sys_documentation', 'sys_choice', 'sys_db_object'];

    var out = [];
    function log(s) { out.push(s); }
    function count(table, q) {
        var ga = new GlideAggregate(table);
        ga.addEncodedQuery(q);
        ga.addAggregate('COUNT');
        ga.query();
        return ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;
    }
    function ids(table, q) {
        var r = [], gr = new GlideRecord(table);
        gr.addEncodedQuery(q);
        gr.query();
        while (gr.next()) { r.push(gr.getUniqueValue()); }
        return r;
    }
    // Riporta il numero effettivamente cancellato (prima - dopo), non il conteggio
    // iniziale: alcune tabelle rifiutano la cancellazione senza eccezioni.
    // oneByOne: sys_properties non accetta deleteMultiple ("Not allowing multiple
    // record update to sys_property").
    function purge(table, q, label, oneByOne) {
        var n = count(table, q);
        if (MODE !== 'execute') { log('would delete ' + n + '  ' + label); return; }
        if (n > 0) {
            var gr = new GlideRecord(table);
            gr.addEncodedQuery(q);
            if (oneByOne) {
                gr.query();
                while (gr.next()) { gr.deleteRecord(); }
            } else {
                gr.setWorkflow(false);
                gr.deleteMultiple();
            }
        }
        var left = count(table, q);
        log('deleted ' + (n - left) + '  ' + label + (left ? '  (LEFT ' + left + ')' : ''));
    }

    // --- 0) Guardia -------------------------------------------------------
    var inst = gs.getProperty('instance_name', '');
    if (inst !== ALLOWED_INSTANCE) {
        gs.error('[NPU reset] blocked: instance "' + inst + '" is not ' + ALLOWED_INSTANCE);
        return;
    }
    log('[NPU reset] MODE=' + MODE + ' instance=' + inst);

    // --- 1) Inventario ----------------------------------------------------
    var localSets = ids('sys_update_set', 'nameSTARTSWITH' + SET_PREFIX);
    var remoteSets = ids('sys_remote_update_set', 'nameSTARTSWITH' + SET_PREFIX);
    log('local update sets: ' + localSets.length + '  remote update sets: ' + remoteSets.length);

    var names = {}, nameList = [];
    var x = new GlideRecord('sys_update_xml');
    x.addEncodedQuery('update_setIN' + localSets.join(',') + '^NQremote_update_setIN' + remoteSets.join(','));
    x.query();
    while (x.next()) {
        var n = '' + x.getValue('name');
        if (n.indexOf('sys_properties_') === 0) { continue; }   // mcp.bg_result.*: non e' l'app
        var key = n.toLowerCase();                                // _NULL e _null sono lo stesso nome
        if (!names[key]) { names[key] = n; nameList.push(n); }
    }
    // Le property runtime non stanno negli update set NPU ma vanno pulite con la loro storia.
    var p = new GlideRecord('sys_properties');
    p.addQuery('name', 'IN', RUNTIME_PROPS.join(','));
    p.query();
    var propNames = [];
    while (p.next()) { propNames.push('sys_properties_' + p.getUniqueValue()); }
    var historyNames = nameList.concat(propNames);
    nameList.sort();
    log('app objects in inventory: ' + nameList.length);

    // --- verify: solo controlli ------------------------------------------
    if (MODE === 'verify') {
        var tbl = new GlideRecord(LOG_TABLE);
        log('table ' + LOG_TABLE + ' valid: ' + tbl.isValid());
        log('sys_db_object ' + LOG_TABLE + ': ' + count('sys_db_object', 'name=' + LOG_TABLE));
        log('sys_dictionary ' + LOG_TABLE + ': ' + count('sys_dictionary', 'name=' + LOG_TABLE));
        log('sys_documentation ' + LOG_TABLE + ': ' + count('sys_documentation', 'name=' + LOG_TABLE));
        log('sys_choice ' + LOG_TABLE + ': ' + count('sys_choice', 'name=' + LOG_TABLE));
        log('sys_choice_set ' + LOG_TABLE + ': ' + count('sys_choice_set', 'name=' + LOG_TABLE));
        log('sys_metadata (any app name): ' + count('sys_metadata', 'sys_update_nameLIKE' + LOG_TABLE +
            '^ORsys_update_nameLIKEc14be11ceb310310a9e2f5b9bad0cde1^ORsys_update_nameLIKE37d62d14877103103ad5851d8bbb3547'));
        log('sys_ui_page pgi_plugin_updater: ' + count('sys_ui_page', 'name=pgi_plugin_updater'));
        log('sys_script_include PluginUpdaterAjax: ' + count('sys_script_include', 'name=PluginUpdaterAjax'));
        log('sys_app_application Now Plugin Updater: ' + count('sys_app_application', 'title=Now Plugin Updater'));
        log('sysauto_script ' + JOB_PREFIX + '*: ' + count('sysauto_script', 'nameSTARTSWITH' + JOB_PREFIX));
        log('sys_trigger ' + JOB_PREFIX + '*: ' + count('sys_trigger', 'nameSTARTSWITH' + JOB_PREFIX));
        log('sys_security_acl ' + LOG_TABLE + '*/pgi_plugin_updater: ' +
            count('sys_security_acl', 'nameSTARTSWITH' + LOG_TABLE + '^ORname=pgi_plugin_updater'));
        log('sys_properties runtime: ' + count('sys_properties', 'nameIN' + RUNTIME_PROPS.join(',')));
        log('sys_update_set NPU: ' + localSets.length + '  sys_remote_update_set NPU: ' + remoteSets.length);
        log('sys_update_xml (names): ' + count('sys_update_xml', 'nameLIKE' + LOG_TABLE +
            '^ORnameLIKEc14be11ceb310310a9e2f5b9bad0cde1^ORnameLIKE37d62d14877103103ad5851d8bbb3547'));
        log('sys_update_version (names): ' + count('sys_update_version', 'nameLIKE' + LOG_TABLE +
            '^ORnameLIKEc14be11ceb310310a9e2f5b9bad0cde1^ORnameLIKE37d62d14877103103ad5851d8bbb3547'));
        log('sys_metadata_delete (names): ' + count('sys_metadata_delete', 'sys_update_nameLIKE' + LOG_TABLE +
            '^ORsys_update_nameLIKEc14be11ceb310310a9e2f5b9bad0cde1^ORsys_update_nameLIKE37d62d14877103103ad5851d8bbb3547'));
        log('sys_update_xml DELETE on app targets (cascade): ' + count('sys_update_xml',
            'action=DELETE^target_nameSTARTSWITH' + LOG_TABLE + '^ORtarget_nameSTARTSWITHpgi_plugin_updater'));
        gs.info(out.join('\n'));
        return;
    }

    // --- 2) Dati runtime --------------------------------------------------
    purge('sys_trigger', 'nameSTARTSWITH' + JOB_PREFIX, 'sys_trigger ' + JOB_PREFIX + '*');
    purge('sys_properties', 'nameIN' + RUNTIME_PROPS.join(','), 'runtime properties', true);
    if (new GlideRecord(LOG_TABLE).isValid()) {
        purge(LOG_TABLE, '', LOG_TABLE + ' rows');
    }

    // --- 3) Oggetti dell'app ---------------------------------------------
    // Risolve ogni nome nel record reale: <tabella>_<sys_id> per i nomi con
    // sys_id, sys_metadata.sys_update_name per dizionario ed etichette.
    var targets = [], unresolved = [];
    for (var i = 0; i < nameList.length; i++) {
        var nm = nameList[i], m = nm.match(/^(.+)_([0-9a-f]{32})$/);
        if (m) {
            targets.push({ table: m[1], id: m[2], name: nm });
        } else if (nm.indexOf('sys_choice_') === 0) {
            continue;   // gestite a parte: sys_choice non ha un record per nome
        } else {
            var md = new GlideRecord('sys_metadata');
            md.addQuery('sys_update_name', nm);
            md.setLimit(1);
            md.query();
            if (md.next()) {
                targets.push({ table: '' + md.getValue('sys_class_name'), id: md.getUniqueValue(), name: nm });
            } else {
                unresolved.push(nm);
            }
        }
    }
    targets.sort(function (a, b) {
        var ia = ORDER.indexOf(a.table), ib = ORDER.indexOf(b.table);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    var deleted = 0, missing = 0, skipped = [], failed = [];
    for (var j = 0; j < targets.length; j++) {
        var t = targets[j];
        if (t.table === 'sys_dictionary') { skipped.push(t.name); continue; }  // cade con la tabella
        var gr = new GlideRecord(t.table);
        if (!gr.isValid() || !gr.get(t.id)) { missing++; continue; }
        if (MODE !== 'execute') { deleted++; continue; }
        if (gr.deleteRecord()) { deleted++; } else { failed.push(t.name); }
    }
    log((MODE === 'execute' ? 'deleted ' : 'would delete ') + deleted + '  app records (' +
        missing + ' already absent, ' + skipped.length + ' dictionary entries left to the table drop)');
    if (unresolved.length) { log('not found by sys_update_name (already absent): ' + unresolved.length); }
    if (failed.length) {
        // Ci si ferma prima della storia: l'inventario nasce dagli update set NPU,
        // se li cancellassimo ora una seconda esecuzione non saprebbe piu' cosa togliere.
        log('FAILED (elevate to security_admin and rerun): ' + failed.join(', '));
        log('STOPPED before steps 3b-4: update sets kept so the rerun can rebuild the inventory');
        gs.error(out.join('\n'));
        return;
    }
    purge('sys_choice', 'name=' + LOG_TABLE, 'sys_choice ' + LOG_TABLE);
    // Il contenitore della choice list (sys_choice_set, sys_update_name
    // sys_choice_<tabella>_<campo>) non cade con la tabella ne' con le sys_choice:
    // sopravvissuto a ogni reset, faceva risultare la choice list come "update".
    purge('sys_choice_set', 'name=' + LOG_TABLE, 'sys_choice_set ' + LOG_TABLE, true);
    purge('sys_documentation', 'name=' + LOG_TABLE, 'sys_documentation leftovers');
    purge('sys_dictionary', 'name=' + LOG_TABLE, 'sys_dictionary leftovers');
    purge('sysauto_script', 'nameSTARTSWITH' + JOB_PREFIX, 'sysauto_script ' + JOB_PREFIX + '* leftovers');

    // --- 4) Storia ---------------------------------------------------------
    // Le cancellazioni a cascata colpiscono record che non stanno in nessun update
    // set NPU (ruoli ACL snc_internal creati dal fallback di piattaforma,
    // ua_table_licensing_config creato con la tabella): si riconoscono dalla voce
    // DELETE catturata sul target dell'app, ovunque sia finita.
    var DELETE_TARGETS = 'action=DELETE^target_nameSTARTSWITH' + LOG_TABLE +
                         '^ORtarget_nameSTARTSWITHpgi_plugin_updater';
    var cx = new GlideRecord('sys_update_xml');
    cx.addEncodedQuery(DELETE_TARGETS);
    cx.query();
    var cascade = 0;
    while (cx.next()) {
        var cn = '' + cx.getValue('name');
        if (!names[cn.toLowerCase()]) { names[cn.toLowerCase()] = cn; historyNames.push(cn); cascade++; }
    }
    log('cascade-deleted names added to history cleanup: ' + cascade);
    var inNames = historyNames.join(',');
    purge('sys_update_xml', 'nameIN' + inNames, 'sys_update_xml with app names (all sets)');
    purge('sys_update_version', 'nameIN' + inNames, 'sys_update_version');
    purge('sys_metadata_delete', 'sys_update_nameIN' + inNames, 'sys_metadata_delete');
    // Varianti di nome storiche (es. sys_choice_<tabella>_null della v1.4.0) e voci
    // DELETE con target non riconoscibile (es. quella del sys_choice_set).
    purge('sys_update_xml', 'nameLIKE' + LOG_TABLE, 'sys_update_xml name variants');
    purge('sys_update_version', 'nameLIKE' + LOG_TABLE, 'sys_update_version name variants');
    purge('sys_metadata_delete', 'sys_update_nameLIKE' + LOG_TABLE, 'sys_metadata_delete name variants');
    if (remoteSets.length) {
        purge('sys_update_xml', 'remote_update_setIN' + remoteSets.join(','), 'sys_update_xml in NPU remote sets');
        purge('sys_remote_update_set', 'sys_idIN' + remoteSets.join(','), 'sys_remote_update_set NPU');
    }
    if (localSets.length) {
        purge('sys_update_xml', 'update_setIN' + localSets.join(','), 'sys_update_xml in NPU local sets');
        purge('sys_update_set', 'sys_idIN' + localSets.join(','), 'sys_update_set NPU');
    }

    if (MODE === 'dryrun') { log('inventory:\n  ' + nameList.join('\n  ')); }
    gs.info(out.join('\n'));
})();
