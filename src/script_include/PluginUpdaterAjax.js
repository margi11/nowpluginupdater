var PluginUpdaterAjax = Class.create();
PluginUpdaterAjax.prototype = Object.extendsObject(AbstractAjaxProcessor, {

    // =======================================================================
    // Security helpers
    // Every client-callable method is gated behind the admin role, and every
    // sys_id taken from the client is validated to a 32-char hex before being
    // used in a query (prevents encoded-query injection).
    // =======================================================================
    _guard: function() { return gs.hasRole('admin'); },
    _forbidden: function() { return JSON.stringify({ error: 'forbidden: admin role required' }); },
    _sysId: function(v) { v = ('' + (v || '')).trim(); return /^[0-9a-f]{32}$/i.test(v) ? v : ''; },

    // Guard per i metodi eseguiti dallo Scheduled Job (contesto server, non client).
    // A differenza di _guard() logga a gs.error(): se il job venisse riconfigurato con
    // un "Run as" senza privilegi il monitoraggio si fermerebbe altrimenti in silenzio,
    // lasciando i batch appesi per sempre.
    _guardServer: function(who) {
        if (gs.hasRole('admin')) { return true; }
        gs.error('[PluginUpdater] ' + who + ' aborted: caller "' + gs.getUserName() +
                 '" lacks the admin role. Check the "Run as" user on the monitor Scheduled Job.');
        return false;
    },

    // -----------------------------------------------------------------------
    // getInstanceInfo
    // Returns { versionLabel, rawBuild, pluginCount, installsRunning,
    //           instanceName, dataCenter, dbType, lastUpgraded }
    // versionLabel: "Family · Patch N · Hot Fix M" parsed from glide.buildtag.
    // -----------------------------------------------------------------------
    getInstanceInfo: function() {
        if (!this._guard()) { return this._forbidden(); }
        var info = {};

        var buildtag  = gs.getProperty('glide.buildtag', '');
        var buildname = gs.getProperty('glide.buildname', '');
        info.rawBuild = buildtag;

        var family = '';
        if (buildname) {
            family = buildname;
        } else if (buildtag) {
            var famMatch = buildtag.match(/^glide-([a-z]+)-/i);
            if (famMatch) { family = famMatch[1].charAt(0).toUpperCase() + famMatch[1].slice(1); }
        }

        var patch = '', hotfix = '';
        if (buildtag) {
            var patchMatch = buildtag.match(/__patch(\d+)/i);
            if (patchMatch) { patch = patchMatch[1]; }
            var hfMatch = buildtag.match(/hotfix([0-9a-z]+)/i);
            if (hfMatch) { hotfix = hfMatch[1]; }
        }

        if (family) {
            var label = family;
            if (patch)  { label += ' · Patch ' + patch; }
            if (hotfix) { label += ' · Hot Fix ' + hotfix; }
            info.versionLabel = label;
        } else if (buildtag) {
            info.versionLabel = buildtag;
        } else {
            var uh = new GlideRecord('sys_upgrade_history');
            uh.orderByDesc('sys_created_on');
            uh.setLimit(1);
            uh.query();
            info.versionLabel = uh.next() ? (uh.getValue('to_version') || 'Unknown') : 'Unknown';
        }

        // NOTE: the platform-plugin count (two COUNT aggregates over the v_plugin
        // view) was removed in v1.3.2. The first v_plugin hit cost 10-40s on Home
        // load (cold view), and the value is no longer shown anywhere in the UI.

        // Installs actually running NOW (CICD worker state = running) — Home "In Progress" KPI.
        var rw = new GlideAggregate('sys_progress_worker');
        rw.addQuery('name', 'CICDAppRepoService$CICDInstallWorker');
        rw.addQuery('state', 'running');
        rw.addAggregate('COUNT');
        rw.query();
        info.installsRunning = rw.next() ? (parseInt(rw.getAggregate('COUNT'), 10) || 0) : 0;

        // --- Header context (instance identity) ---
        info.instanceName = gs.getProperty('instance_name', '');

        // Data center: parse the cluster node system_id (e.g. "app133037.ams101.service-now.com:inst001")
        // -> 2nd DNS label "ams101" -> "AMS101". Same host shown on stats.do.
        info.dataCenter = '';
        var cs = new GlideRecord('sys_cluster_state');
        cs.orderBy('system_id');
        cs.setLimit(1);
        cs.query();
        if (cs.next()) {
            var host = (cs.getValue('system_id') || '').split(':')[0];
            var labels = host.split('.');
            if (labels.length >= 2 && labels[1]) { info.dataCenter = labels[1].toUpperCase(); }
        }

        // Database engine (glide.db.rdbms); PostgreSQL is branded RaptorDB.
        var rdbms = (gs.getProperty('glide.db.rdbms', '') || '').toLowerCase();
        if (rdbms === 'mysql') {
            info.dbType = 'MySQL';
        } else if (rdbms === 'postgres' || rdbms === 'postgresql') {
            info.dbType = 'PostgreSQL (RaptorDB)';
        } else if (rdbms) {
            info.dbType = rdbms.charAt(0).toUpperCase() + rdbms.slice(1);
        } else {
            info.dbType = '';
        }

        // Last upgrade date (prefer completed, then started, then created).
        info.lastUpgraded = '';
        var lu = new GlideRecord('sys_upgrade_history');
        lu.orderByDesc('sys_created_on');
        lu.setLimit(1);
        lu.query();
        if (lu.next()) {
            var when = lu.getDisplayValue('completed') || lu.getDisplayValue('started') || lu.getDisplayValue('sys_created_on') || '';
            info.lastUpgraded = when ? when.split(' ')[0] : '';
        }

        // Last successful sync with the ServiceNow Store (App Manager parity).
        info.lastStoreSync = gs.getProperty('sn_appclient.apps_last_sync_time', '');

        return JSON.stringify(info);
    },

    // -----------------------------------------------------------------------
    // getUpdatableApps — { apps:[...], appsUpToDate, inFlight:[...] }
    // Count aligned with the native Application Manager.
    // -----------------------------------------------------------------------
    getUpdatableApps: function() {
        if (!this._guard()) { return this._forbidden(); }
        var result = {};

        var utd = new GlideAggregate('sys_store_app');
        utd.addQuery('active', true);
        utd.addQuery('update_available', false);
        utd.addQuery('hide_on_ui', false);
        utd.addAggregate('COUNT');
        utd.query();
        result.appsUpToDate = utd.next() ? (parseInt(utd.getAggregate('COUNT'), 10) || 0) : 0;

        // In-flight workers (pending + running) — used by the wizard to disable apps already being installed.
        var wGr = new GlideRecord('sys_progress_worker');
        wGr.addQuery('name', 'CICDAppRepoService$CICDInstallWorker');
        wGr.addQuery('state', 'IN', 'pending,running');
        wGr.query();
        var inFlight = [];
        while (wGr.next()) {
            inFlight.push({
                sys_id:           wGr.getUniqueValue(),
                state:            wGr.getValue('state'),
                message:          wGr.getValue('message') || '',
                percent_complete: parseInt(wGr.getValue('percent_complete'), 10) || 0
            });
        }
        result.inFlight = inFlight;

        var gr = new GlideRecord('sys_store_app');
        gr.addQuery('update_available', true);
        gr.addQuery('active', true);
        gr.addQuery('hide_on_ui', false);
        gr.orderBy('name');
        gr.query();

        var apps = [];
        while (gr.next()) {
            apps.push({
                sysId:    gr.getUniqueValue(),
                name:     gr.getValue('name') || '',
                scope:    gr.getValue('scope') || '',
                current:  gr.getValue('version') || '',
                latest:   gr.getValue('latest_version') || ''
            });
        }

        result.apps = apps;
        return JSON.stringify(result);
    },

    // -----------------------------------------------------------------------
    // syncStore — trigger the platform Store update check (App Manager "Sync now").
    // Fires the same event the daily "Check Scoped App Updates" job uses; the
    // sn_appclient handler runs UpdateChecker.checkAvailableUpdates(forceUpdate).
    // Asynchronous: the client polls getInstanceInfo.lastStoreSync for completion.
    // -----------------------------------------------------------------------
    syncStore: function() {
        if (!this._guard()) { return this._forbidden(); }
        gs.eventQueue('sn_appclient.check.for.update', null, '', '');
        // startedAt è il riferimento con cui il client distingue "sync finita" da
        // "sync mai partita": apps_sync_progress vale 0.00 in entrambi i casi, quindi
        // da solo è ambiguo. Il completamento si riconosce da lastSync > startedAt.
        return JSON.stringify({
            queued:    true,
            startedAt: '' + new GlideDateTime(),
            lastSync:  gs.getProperty('sn_appclient.apps_last_sync_time', '')
        });
    },

    // -----------------------------------------------------------------------
    // getSyncProgress — avanzamento reale della sincronizzazione con lo Store.
    // La piattaforma (sn_appclient.UpdateChecker._setAppsSyncProgress) scrive
    // sn_appclient.apps_sync_progress a ogni fase: 0.01 fixUpdateAvailableField,
    // 0.03 fetchAppUpdates, 0.20-0.70 updateAppRecords (incrementale), 0.85
    // refreshStoreResponseCache, 0.96 syncGoldenConfigs, poi 0.00 = 'finished'.
    // Restituisce { pct, running, lastSync } — pct 0 con lastSync aggiornato = finita.
    // -----------------------------------------------------------------------
    getSyncProgress: function() {
        if (!this._guard()) { return this._forbidden(); }
        var raw = gs.getProperty('sn_appclient.apps_sync_progress', '');
        var frac = parseFloat(raw);
        if (isNaN(frac)) { frac = 0; }
        var pct = Math.round(frac * 100);
        if (pct < 0) { pct = 0; }
        if (pct > 100) { pct = 100; }
        return JSON.stringify({
            pct:      pct,
            running:  pct > 0,
            lastSync: gs.getProperty('sn_appclient.apps_last_sync_time', '')
        });
    },

    // =======================================================================
    // BATCH ORCHESTRATION (unattended, credential-free)
    // =======================================================================

    // createBatch — param: apps (JSON array). Inserts one queued row per app.
    createBatch: function() {
        if (!this._guard()) { return this._forbidden(); }
        var appsJson = this.getParameter('sysparm_apps') || this.getParameter('apps') || '[]';
        var apps;
        try { apps = JSON.parse(appsJson); } catch (e) { apps = []; }
        if (!apps || !apps.length) { return JSON.stringify({ error: 'no apps', batch: '', rows: [] }); }
        if (apps.length > 1000) { apps = apps.slice(0, 1000); } // safety cap

        // u_session_id è un campo da 32 char: la chiave va tenuta corta con margine.
        // Timestamp in base36 (~8 char per i prossimi secoli) + 8 char di user id
        // => 'b_' + 8 + '_' + 8 = 19 char, contro i 28 della v1.3.7.
        // Number(...) forza il long Java di getNumericValue() a un numero JS prima
        // di toString(36) — su Rhino il metodo nativo del long non è affidabile.
        var batchKey = 'b_' + Number(new GlideDateTime().getNumericValue()).toString(36) +
                       '_' + ('' + gs.getUserID()).substring(0, 8);
        var now = new GlideDateTime();
        var rows = [];
        for (var i = 0; i < apps.length; i++) {
            var a = apps[i] || {};
            var gr = new GlideRecord('u_plugin_updater_install_log');
            gr.initialize();
            gr.setValue('u_app_name',         ('' + (a.name || '')).substring(0, 255));
            gr.setValue('u_app_scope',        ('' + (a.scope || '')).substring(0, 100));
            gr.setValue('u_store_app_id',     this._sysId(a.sysId));
            gr.setValue('u_previous_version', ('' + (a.current || '')).substring(0, 40));
            gr.setValue('u_target_version',   ('' + (a.latest || '')).substring(0, 40));
            gr.setValue('u_status',           'queued');
            gr.setValue('u_session_id',       batchKey);
            gr.setValue('u_triggered_by',     gs.getUserID());
            gr.setValue('u_started_at',       now);
            gr.setValue('u_percent_complete', 0);
            rows.push({ sysId: a.sysId, logSysId: gr.insert() });
        }
        return JSON.stringify({ batch: batchKey, total: apps.length, rows: rows });
    },

    // getMyLatestBatch — most recent batch key for the current user
    getMyLatestBatch: function() {
        if (!this._guard()) { return this._forbidden(); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_triggered_by', gs.getUserID());
        gr.addNotNullQuery('u_session_id');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(1);
        gr.query();
        return JSON.stringify({ batch: gr.next() ? gr.getValue('u_session_id') : '' });
    },

    // getActiveBatch — most recent batch of the current user that still has active rows
    getActiveBatch: function() {
        if (!this._guard()) { return this._forbidden(); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_triggered_by', gs.getUserID());
        gr.addQuery('u_status', 'IN', 'queued,installing,in_progress');
        gr.addNotNullQuery('u_session_id');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(1);
        gr.query();
        return JSON.stringify({ batch: gr.next() ? gr.getValue('u_session_id') : '' });
    },

    // listBatches — recent distinct batches for the current user (most recent 20),
    // each with app count and outcome so the selector is readable at a glance.
    // v1.4.0: una GlideAggregate raggruppata al posto della scansione di 3000 righe.
    listBatches: function() {
        if (!this._guard()) { return this._forbidden(); }
        var order = [], meta = {};

        var ag = new GlideAggregate('u_plugin_updater_install_log');
        ag.addQuery('u_triggered_by', gs.getUserID());
        ag.addNotNullQuery('u_session_id');
        ag.groupBy('u_session_id');
        ag.addAggregate('COUNT');
        ag.addAggregate('MAX', 'sys_created_on');
        ag.orderByAggregate('MAX', 'sys_created_on');
        ag.query();
        while (ag.next()) {
            var b = ag.getValue('u_session_id');
            if (!b) { continue; }
            order.push({ batch: b, when: ag.getAggregate('MAX', 'sys_created_on') });
            meta[b] = { total: parseInt(ag.getAggregate('COUNT'), 10) || 0, failed: 0, active: 0 };
        }
        // orderByAggregate è ascendente: i più recenti sono in coda.
        order.reverse();
        order = order.slice(0, 20);

        // Un solo passaggio aggregato per stato, ristretto ai batch mostrati.
        if (order.length) {
            var keys = [];
            for (var i = 0; i < order.length; i++) { keys.push(order[i].batch); }
            var st = new GlideAggregate('u_plugin_updater_install_log');
            st.addQuery('u_session_id', 'IN', keys.join(','));
            st.groupBy('u_session_id');
            st.groupBy('u_status');
            st.addAggregate('COUNT');
            st.query();
            while (st.next()) {
                var k = st.getValue('u_session_id'), s = st.getValue('u_status');
                var n = parseInt(st.getAggregate('COUNT'), 10) || 0;
                if (!meta[k]) { continue; }
                if (s === 'failed') { meta[k].failed += n; }
                else if (s !== 'complete' && s !== 'cancelled') { meta[k].active += n; }
            }
        }

        var out = [];
        for (var j = 0; j < order.length; j++) {
            var key = order[j].batch, m = meta[key] || { total: 0, failed: 0, active: 0 };
            out.push({
                batch:   key,
                started: this._fmtDateTime(order[j].when),
                total:   m.total,
                failed:  m.failed,
                active:  m.active
            });
        }
        return JSON.stringify({ batches: out });
    },

    // GlideAggregate restituisce le date in formato interno (UTC): la converto nel
    // fuso e formato dell'utente, come farebbe getDisplayValue su un GlideRecord.
    _fmtDateTime: function(raw) {
        if (!raw) { return ''; }
        try {
            var gdt = new GlideDateTime(raw);
            return gdt.getDisplayValue();
        } catch (e) { return '' + raw; }
    },

    // -----------------------------------------------------------------------
    // getHomeData — getInstanceInfo + getUpdatableApps in una sola chiamata.
    // Dimezza i round-trip al caricamento della Home e permette al client di
    // gestire un solo esito d'errore invece di due parziali.
    // -----------------------------------------------------------------------
    getHomeData: function() {
        if (!this._guard()) { return this._forbidden(); }
        var out = {};
        try { out.info = JSON.parse(this.getInstanceInfo()); }
        catch (e) { out.info = {}; out.infoError = '' + e; }
        try { out.appData = JSON.parse(this.getUpdatableApps()); }
        catch (e2) { out.appData = { apps: [], inFlight: [], appsUpToDate: 0 }; out.appsError = '' + e2; }
        return JSON.stringify(out);
    },

    // -----------------------------------------------------------------------
    // cancelRemaining — param: batch. Annulla le sole righe ancora in coda
    // ('queued'): le installazioni già avviate non sono interrompibili, quindi
    // le lascia proseguire. Restituisce quante righe sono state annullate.
    // -----------------------------------------------------------------------
    cancelRemaining: function() {
        if (!this._guard()) { return this._forbidden(); }
        var batch = ('' + (this.getParameter('sysparm_batch') || this.getParameter('batch') || '')).trim();
        if (!batch) { return JSON.stringify({ ok: false, error: 'batch required', cancelled: 0 }); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_session_id', batch);
        gr.addQuery('u_status', 'queued');
        gr.query();
        var n = 0;
        while (gr.next()) {
            gr.setValue('u_status', 'cancelled');
            gr.setValue('u_error_message', 'Cancelled by ' + gs.getUserName() + ' before the install started');
            gr.setValue('u_percent_complete', 100);
            gr.setValue('u_completed_at', new GlideDateTime());
            gr.update();
            n++;
        }
        gs.info('[PluginUpdater] cancelRemaining batch=' + batch + ' cancelled=' + n);
        return JSON.stringify({ ok: true, cancelled: n });
    },

    // getBatchStatus — param: batch. Returns rows + counts (installing/queued/complete/failed).
    getBatchStatus: function() {
        if (!this._guard()) { return this._forbidden(); }
        var batch = ('' + (this.getParameter('sysparm_batch') || this.getParameter('batch') || '')).trim();
        if (!batch) { return JSON.stringify({ error: 'batch required', rows: [], counts: {} }); }

        var counts = { total: 0, complete: 0, failed: 0, installing: 0, queued: 0, cancelled: 0 };
        var rows = [];
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_session_id', batch);
        gr.orderBy('u_app_name');
        gr.query();
        while (gr.next()) {
            var raw = gr.getValue('u_status') || 'queued';
            // Normalise to the buckets the UI shows.
            var st = raw;
            if (raw === 'in_progress') { st = 'installing'; } // legacy rows
            counts.total++;
            if (st === 'complete') { counts.complete++; }
            else if (st === 'failed') { counts.failed++; }
            else if (st === 'installing') { counts.installing++; }
            else if (st === 'cancelled') { counts.cancelled++; }
            else { counts.queued++; st = 'queued'; }
            rows.push({
                logSysId: gr.getUniqueValue(),
                name:     gr.getValue('u_app_name'),
                scope:    gr.getValue('u_app_scope'),
                current:  gr.getValue('u_previous_version'),
                latest:   gr.getValue('u_target_version'),
                status:   st,
                pct:      parseInt(gr.getValue('u_percent_complete'), 10) || 0,
                message:  gr.getValue('u_error_message') || '',
                startedAt: gr.getDisplayValue('u_started_at')
            });
        }
        var bStatus = 'running';
        if (counts.total > 0 && counts.installing === 0 && counts.queued === 0) {
            if (counts.failed > 0) { bStatus = (counts.complete > 0) ? 'partial' : 'failed'; }
            else if (counts.complete === 0 && counts.cancelled > 0) { bStatus = 'cancelled'; }
            else { bStatus = 'complete'; }
        }
        return JSON.stringify({ batch: batch, status: bStatus, counts: counts, rows: rows });
    },

    // attachWorker — UPDATE ONLY: record the worker id; status starts at 'queued'
    // (worker is pending until it actually starts; monitorBatches promotes it).
    attachWorker: function() {
        if (!this._guard()) { return this._forbidden(); }
        var logSysId = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        var pid      = this._sysId(this.getParameter('sysparm_progress_id') || this.getParameter('progress_id'));
        if (!logSysId) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        if (!gr.get(logSysId)) { return JSON.stringify({ ok: false, error: 'log row not found' }); }
        gr.setValue('u_progress_id', pid);
        gr.setValue('u_status', 'queued');
        gr.update();
        return JSON.stringify({ ok: true });
    },

    // failRow — UPDATE ONLY: mark a batch row failed.
    failRow: function() {
        if (!this._guard()) { return this._forbidden(); }
        var logSysId = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        var msg = ('' + (this.getParameter('sysparm_message') || this.getParameter('message') || 'Failed to launch')).substring(0, 1000);
        if (!logSysId) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        if (!gr.get(logSysId)) { return JSON.stringify({ ok: false, error: 'log row not found' }); }
        gr.setValue('u_status', 'failed');
        gr.setValue('u_error_message', msg);
        gr.setValue('u_percent_complete', 100);
        gr.setValue('u_completed_at', new GlideDateTime());
        gr.update();
        return JSON.stringify({ ok: true });
    },

    // monitorBatches — Scheduled Job (server-side, no params). Distinguishes
    // running (=installing) from pending (=queued), verifies version, finalises,
    // handles cancelled/failed, and times out workers that never materialise.
    //
    // v1.4.0 — la versione installata è l'arbitro finale dello stato: un worker
    // può riportare state='complete' con state_code='error' (installazione non
    // applicata). Prima del fix quelle righe venivano marcate 'complete', quindi
    // un batch fallito appariva riuscito.
    monitorBatches: function() {
        if (!this._guardServer('monitorBatches')) { return '0:0'; }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_status', 'IN', 'queued,installing,in_progress');
        gr.addNotNullQuery('u_progress_id');
        gr.setLimit(2000);
        gr.query();
        var checked = 0, finalized = 0, nowMs = new GlideDateTime().getNumericValue(), batchLast = {};
        var verifyCache = {};
        // Is the platform install queue still active? While any CICD install worker
        // is pending/running, the single-flight queue is draining — never time out
        // waiting rows (avoids false "did not start" on large/slow batches).
        var qa = new GlideAggregate('sys_progress_worker');
        qa.addQuery('name', 'CICDAppRepoService$CICDInstallWorker');
        qa.addQuery('state', 'IN', 'pending,running');
        qa.addAggregate('COUNT');
        qa.query();
        var queueActive = qa.next() ? ((parseInt(qa.getAggregate('COUNT'), 10) || 0) > 0) : false;
        while (gr.next()) {
            checked++;
            var w = this._findWorker(gr.getValue('u_progress_id'));
            if (!w) {
                // Worker not found. Under the single-flight CICD install queue the
                // worker is created only when this app's turn comes, so a missing
                // worker usually means "not started yet", not a failure.
                // 1) Source of truth: if the app already reached the target version,
                //    the install succeeded and the worker simply rotated away.
                var ver = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'), verifyCache);
                if (ver.matches) {
                    gr.setValue('u_status', 'complete');
                    gr.setValue('u_percent_complete', 100);
                    gr.setValue('u_completed_at', new GlideDateTime());
                    gr.update();
                    finalized++;
                    continue;
                }
                // 2) Not installed yet. While the install queue is still active
                //    (any CICD worker pending/running), keep waiting — never fail.
                if (queueActive) { continue; }
                // 3) Queue is idle: fail only if the batch has made no progress for
                //    >60 min (genuinely stalled / install never enqueued).
                var batch = gr.getValue('u_session_id');
                if (batchLast[batch] === undefined) { batchLast[batch] = this._batchLastActivityMs(batch); }
                var refMs = batchLast[batch] || new GlideDateTime(gr.getValue('u_started_at')).getNumericValue();
                if (refMs && (nowMs - refMs) > 3600000) {
                    gr.setValue('u_status', 'failed');
                    gr.setValue('u_error_message', 'Timed out: install did not start (install queue idle, no progress for 60 minutes)');
                    gr.setValue('u_percent_complete', 100);
                    gr.setValue('u_completed_at', new GlideDateTime());
                    gr.update();
                    finalized++;
                }
                continue;
            }
            var state = (w.state || '').toLowerCase();
            var code  = (w.code || '').toLowerCase();
            if (w.pct) { gr.setValue('u_percent_complete', w.pct); }

            if (state === 'complete' || state === 'success') {
                // La versione effettivamente installata decide: un worker "complete"
                // con state_code='error' — o che ha lasciato l'app alla versione
                // precedente — è un fallimento, non un successo.
                var v = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'), verifyCache);
                var codeFailed = (code === 'error' || code === 'failed' || code === 'cancelled');
                if (codeFailed || !v.matches) {
                    gr.setValue('u_status', 'failed');
                    gr.setValue('u_error_message', this._failMessage(w, v, gr.getValue('u_target_version')));
                } else {
                    gr.setValue('u_status', 'complete');
                    gr.setValue('u_error_message', '');
                }
                gr.setValue('u_percent_complete', 100);
                gr.setValue('u_completed_at', new GlideDateTime());
                finalized++;
            } else if (state === 'failed' || state === 'error' || state === 'cancelled') {
                gr.setValue('u_status', 'failed');
                gr.setValue('u_error_message', w.error || w.message || ('Worker ' + state));
                gr.setValue('u_percent_complete', 100);
                gr.setValue('u_completed_at', new GlideDateTime());
                finalized++;
            } else if (state === 'running') {
                gr.setValue('u_status', 'installing');
            } else {
                gr.setValue('u_status', 'queued'); // pending / unknown -> waiting in queue
            }
            gr.update();
        }
        gs.info('[PluginUpdater] monitorBatches checked=' + checked + ' finalized=' + finalized);
        return checked + ':' + finalized;
    },

    _findWorker: function(pid) {
        pid = this._sysId(pid);
        if (!pid) { return null; }
        var gr = new GlideRecord('sys_progress_worker');
        var found = gr.get(pid);
        if (!found) {
            gr = new GlideRecord('sys_progress_worker');
            gr.setWorkflow(false);
            gr.addQuery('sys_id', pid);
            gr.setLimit(1);
            gr.query();
            found = gr.next();
        }
        if (!found) { return null; }
        return {
            state:   gr.getValue('state'),
            // NB: il campo di esito su sys_progress_worker è 'state_code', non
            // 'completion_code' (che non esiste sulla tabella). Fino alla v1.3.7 si
            // leggeva il nome sbagliato, quindi il ramo di errore non scattava mai.
            code:    gr.getValue('state_code'),
            message: gr.getValue('message'),
            error:   gr.getValue('error_message'),
            pct:     parseInt(gr.getValue('percent_complete'), 10) || 0
        };
    },

    // _verify — confronta la versione installata con il target. `cache` è opzionale:
    // monitorBatches lo passa per non ripetere la stessa lettura su sys_store_app
    // a ogni giro del job (le righe di un batch puntano spesso alla stessa app).
    _verify: function(appSysId, target, cache) {
        appSysId = this._sysId(appSysId);
        if (!appSysId) { return { matches: false, current: '' }; }
        var cur;
        if (cache && cache.hasOwnProperty(appSysId)) {
            cur = cache[appSysId];
        } else {
            var gr = new GlideRecord('sys_store_app');
            cur = gr.get(appSysId) ? (gr.getValue('version') || '') : null;
            if (cache) { cache[appSysId] = cur; }
        }
        if (cur === null) { return { matches: false, current: '' }; }
        return { matches: (cur === target), current: cur };
    },

    // Messaggio d'errore leggibile: preferisce quello del worker, altrimenti spiega
    // il mismatch di versione (il caso "installazione non applicata").
    _failMessage: function(w, v, target) {
        var m = (w && (w.error || w.message)) || '';
        // "Executing queued operation" è il messaggio residuo del worker: non informa.
        if (m && m.toLowerCase().indexOf('executing queued operation') === -1) {
            return ('' + m).substring(0, 1000);
        }
        if (v && !v.matches) {
            return v.current
                ? ('Install did not apply: still at ' + v.current + ' (expected ' + target + ')')
                : 'Install did not apply: application record not found';
        }
        return 'Install failed';
    },

    // Most recent completion time (ms) across a batch — used to detect a stalled queue.
    _batchLastActivityMs: function(batch) {
        if (!batch) { return 0; }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_session_id', batch);
        gr.addNotNullQuery('u_completed_at');
        gr.orderByDesc('u_completed_at');
        gr.setLimit(1);
        gr.query();
        if (gr.next()) { return new GlideDateTime(gr.getValue('u_completed_at')).getNumericValue(); }
        return 0;
    },

    type: 'PluginUpdaterAjax'
});
