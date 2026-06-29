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
        utd.addQuery('install_date', '!=', '');
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
        gr.addQuery('install_date', '!=', '');
        gr.orderBy('name');
        gr.query();

        var apps = [];
        var categoryMap = {
            'sn_csm':'CSM','sn_customerservice':'CSM','sn_hr':'HRSD','sn_itsm':'ITSM','com_snc_itsm':'ITSM',
            'sn_itom':'ITOM','sn_em':'ITOM','sn_disco':'ITOM','sn_iam':'IRM','sn_risk':'IRM','sn_grc':'IRM',
            'sn_sec':'SecOps','sn_si':'SecOps','sn_fsm':'FSM','sn_field_service':'FSM','sn_spm':'SPM',
            'sn_itbm':'SPM','sn_project':'SPM','sn_cmdb':'CMDB','sn_creatorworkflow':'App Engine',
            'sn_flow':'App Engine','sn_nowassist':'Now Assist','sn_gen_ai':'Now Assist','sn_va':'Now Assist'
        };

        while (gr.next()) {
            var scope = gr.getValue('scope') || '';
            var cat = 'Other', keys = Object.keys(categoryMap);
            for (var k = 0; k < keys.length; k++) {
                if (scope.indexOf(keys[k]) === 0) { cat = categoryMap[keys[k]]; break; }
            }
            apps.push({
                sysId:    gr.getUniqueValue(),
                name:     gr.getValue('name') || '',
                scope:    scope,
                current:  gr.getValue('version') || '',
                latest:   gr.getValue('latest_version') || '',
                category: cat
            });
        }

        result.apps = apps;
        return JSON.stringify(result);
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

        var batchKey = 'batch_' + new GlideDateTime().getNumericValue() + '_' + gs.getUserID().substring(0, 8);
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
            gr.setValue('u_product_category', ('' + (a.category || '')).substring(0, 100));
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

    // listBatches — recent distinct batches for the current user (most recent 20)
    listBatches: function() {
        if (!this._guard()) { return this._forbidden(); }
        var seen = {}, out = [];
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_triggered_by', gs.getUserID());
        gr.addNotNullQuery('u_session_id');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(3000);
        gr.query();
        while (gr.next()) {
            var b = gr.getValue('u_session_id');
            if (seen[b]) { continue; }
            seen[b] = true;
            out.push({ batch: b, started: gr.getDisplayValue('u_started_at') || gr.getDisplayValue('sys_created_on') });
            if (out.length >= 20) { break; }
        }
        return JSON.stringify({ batches: out });
    },

    // getBatchStatus — param: batch. Returns rows + counts (installing/queued/complete/failed).
    getBatchStatus: function() {
        if (!this._guard()) { return this._forbidden(); }
        var batch = ('' + (this.getParameter('sysparm_batch') || this.getParameter('batch') || '')).trim();
        if (!batch) { return JSON.stringify({ error: 'batch required', rows: [], counts: {} }); }

        var counts = { total: 0, complete: 0, failed: 0, installing: 0, queued: 0 };
        var rows = [];
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_session_id', batch);
        gr.orderBy('u_app_name');
        gr.query();
        while (gr.next()) {
            var raw = gr.getValue('u_status') || 'queued';
            // Normalise to the two active buckets the UI shows.
            var st = raw;
            if (raw === 'in_progress') { st = 'installing'; } // legacy rows
            counts.total++;
            if (st === 'complete') { counts.complete++; }
            else if (st === 'failed') { counts.failed++; }
            else if (st === 'installing') { counts.installing++; }
            else { counts.queued++; st = 'queued'; }
            rows.push({
                logSysId: gr.getUniqueValue(),
                name:     gr.getValue('u_app_name'),
                scope:    gr.getValue('u_app_scope'),
                current:  gr.getValue('u_previous_version'),
                latest:   gr.getValue('u_target_version'),
                category: gr.getValue('u_product_category'),
                status:   st,
                pct:      parseInt(gr.getValue('u_percent_complete'), 10) || 0,
                message:  gr.getValue('u_error_message') || '',
                startedAt: gr.getDisplayValue('u_started_at')
            });
        }
        var bStatus = 'running';
        if (counts.total > 0 && counts.installing === 0 && counts.queued === 0) {
            bStatus = (counts.failed > 0) ? (counts.complete > 0 ? 'partial' : 'failed') : 'complete';
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
    monitorBatches: function() {
        if (!this._guard()) { return this._forbidden(); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_status', 'IN', 'queued,installing,in_progress');
        gr.addNotNullQuery('u_progress_id');
        gr.setLimit(2000);
        gr.query();
        var checked = 0, finalized = 0, nowMs = new GlideDateTime().getNumericValue(), batchLast = {};
        while (gr.next()) {
            checked++;
            var w = this._findWorker(gr.getValue('u_progress_id'));
            if (!w) {
                // Worker not found. Under the single-flight CICD install queue the
                // worker is created only when this app's turn comes, so a missing
                // worker usually means "not started yet", not a failure.
                // 1) Source of truth: if the app already reached the target version,
                //    the install succeeded and the worker simply rotated away.
                var ver = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'));
                if (ver.matches) {
                    gr.setValue('u_status', 'complete');
                    gr.setValue('u_percent_complete', 100);
                    gr.setValue('u_completed_at', new GlideDateTime());
                    gr.update();
                    finalized++;
                    continue;
                }
                // 2) Not installed yet: fail only if the whole batch has stalled
                //    (no install in it has completed for >60 min). While the queue
                //    keeps draining, waiting rows stay queued regardless of batch size.
                var batch = gr.getValue('u_session_id');
                if (batchLast[batch] === undefined) { batchLast[batch] = this._batchLastActivityMs(batch); }
                var refMs = batchLast[batch] || new GlideDateTime(gr.getValue('u_started_at')).getNumericValue();
                if (refMs && (nowMs - refMs) > 3600000) {
                    gr.setValue('u_status', 'failed');
                    gr.setValue('u_error_message', 'Timed out: install did not start (no queue progress for 60 minutes)');
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
                if (code === 'error' || code === 'failed' || code === 'cancelled') {
                    gr.setValue('u_status', 'failed');
                    gr.setValue('u_error_message', w.error || w.message || 'Install failed');
                } else {
                    var v = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'));
                    gr.setValue('u_status', 'complete');
                    if (!v.matches) { gr.setValue('u_error_message', 'Completed (version: ' + v.current + ')'); }
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
            code:    gr.getValue('completion_code'),
            message: gr.getValue('message'),
            error:   gr.getValue('error_message'),
            pct:     parseInt(gr.getValue('percent_complete'), 10) || 0
        };
    },

    _verify: function(appSysId, target) {
        appSysId = this._sysId(appSysId);
        var gr = new GlideRecord('sys_store_app');
        if (!appSysId || !gr.get(appSysId)) { return { matches: false, current: '' }; }
        var cur = gr.getValue('version') || '';
        return { matches: (cur === target), current: cur };
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
