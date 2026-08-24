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

        // v1.5 — fold the dependency impact (§6) into the same response: no
        // second round-trip, consistent with the getHomeData consolidation.
        try { result.impact = JSON.parse(this.getUpdateImpact()); }
        catch (eImpact) { result.impact = null; result.impactError = '' + eImpact; }

        return JSON.stringify(result);
    },

    // -----------------------------------------------------------------------
    // getUpdateImpact (v1.5, §6) — apps updated *in addition to* what the admin
    // selects, the same visibility the native App Manager gives in its "Review
    // Installation Details" dialog. Two independent, both-certain mechanisms:
    //
    //   suite branch      — sys_suite_config (compatible=true, highest version)
    //                       + sys_suite_config_app_version_m2m. Explicit
    //                       per-app target version.
    //   dependency branch — mirrors the platform's own DependencyProcessor
    //                       (the logic behind Application Manager's Update
    //                       button): for the app's TARGET version, read
    //                       sys_app_version (source_app_id/scope + version =
    //                       the target) and its `dependencies` glide_list.
    //                       For each dependency, if installed < required,
    //                       include it AND recurse into ITS target version's
    //                       own dependencies; if installed >= required, stop
    //                       — do not recurse into an already-satisfied node.
    //
    // v1.5.1 removed a third, heuristic branch that walked
    // sys_store_app.dependencies (the INSTALLED version's floor, not the
    // target's) breadth-first with no version check. Measured on this
    // instance: for "Content Understanding" that produced 19 unrelated
    // Platform Analytics sub-components (real update_available=1 rows, but
    // reached only because a hub dependency — Generative AI Controller —
    // declares 40+ sub-dependencies, none of which "Content Understanding"
    // has anything to do with). The two branches kept here both carry an
    // explicit version constraint against the TARGET, so both are shown with
    // the same certainty — there is no "may" here, matching the native
    // dialog, which badges every row identically.
    //
    // Verified live: "Content Understanding" 7.0.4→7.0.5 has zero dependency-
    // branch impact (its 3 direct deps are already at the versions its own
    // target requires) — the suite branch alone accounts for its 8 sibling
    // apps. "Setup Hub" 2.0.4→2.0.8 has zero suite impact but a 3-app
    // dependency-branch chain (Setup Hub Content → Common → Config),
    // terminating correctly at Admin Center (already satisfied) instead of
    // continuing into unrelated apps.
    //
    // Params: sysparm_scopes — optional CSV of selected scopes. Present ->
    // both branches are restricted to roots within that selection (confirm
    // dialog, deduplicated union). Omitted -> both branches run over every
    // updatable app (Step 1 / Step 2 initial render, folded into
    // getUpdatableApps, §6.7 — no query inside the recursion).
    // -----------------------------------------------------------------------
    getUpdateImpact: function() {
        if (!this._guard()) { return this._forbidden(); }

        var scopesParam = ('' + (this.getParameter('sysparm_scopes') || this.getParameter('scopes') || '')).trim();
        var selectedScopes = null;
        if (scopesParam) {
            selectedScopes = {};
            var parts = scopesParam.split(',');
            for (var p = 0; p < parts.length; p++) {
                var sc = parts[p].trim();
                if (sc) { selectedScopes[sc] = true; }
            }
        }

        // ---- Load sys_store_app ONCE into a scope-keyed index (§6.7) ----
        var index = {}; // scope -> { name, current, latest, hideOnUi, updateAvailable }
        var sa = new GlideRecord('sys_store_app');
        sa.setLimit(20000);
        sa.query();
        while (sa.next()) {
            var scope = sa.getValue('scope') || '';
            if (!scope) { continue; }
            index[scope] = {
                name:            sa.getValue('name') || scope,
                current:         sa.getValue('version') || '',
                latest:          sa.getValue('latest_version') || '',
                hideOnUi:        sa.getValue('hide_on_ui') === 'true' || sa.getValue('hide_on_ui') === '1',
                updateAvailable: sa.getValue('update_available') === 'true' || sa.getValue('update_available') === '1'
            };
        }

        // ---- Load sys_app_version ONCE into a "scope@version" -> deps index ----
        // Mirrors what the native DependencyProcessor reads per target version.
        var versionIndex = {}; // "scope@version" -> [{scope, minVersion}]
        var av = new GlideRecord('sys_app_version');
        av.setLimit(20000);
        av.query();
        while (av.next()) {
            var avScope = av.getValue('scope') || '';
            var avVersion = av.getValue('version') || '';
            if (!avScope || !avVersion) { continue; }
            var depsRaw = av.getValue('dependencies') || '';
            var deps = [];
            if (depsRaw) {
                var depEntries = depsRaw.split(',');
                for (var d = 0; d < depEntries.length; d++) {
                    var entry = depEntries[d];
                    var colon = entry.indexOf(':');
                    if (colon < 0) { continue; }
                    deps.push({ scope: entry.substring(0, colon), minVersion: entry.substring(colon + 1) });
                }
            }
            versionIndex[avScope + '@' + avVersion] = deps;
        }

        // ---- Suite branch ----
        var suiteResult = null;
        var suiteMemberScopes = {}; // dedup against the dependency branch (§18.1.1 style — same certainty, never duplicated)
        var sc = new GlideRecord('sys_suite_config');
        sc.addQuery('compatible', true);
        sc.orderByDesc('version');
        sc.setLimit(1);
        sc.query();
        if (sc.next()) {
            var suiteSysId = sc.getUniqueValue();
            var suiteApps = [];
            var m2m = new GlideRecord('sys_suite_config_app_version_m2m');
            m2m.addQuery('suite_config', suiteSysId);
            m2m.setLimit(5000);
            m2m.query();
            while (m2m.next()) {
                var mScope = m2m.getValue('app_scope') || '';
                var mTarget = m2m.getValue('app_version') || '';
                if (!mScope) { continue; }
                if (selectedScopes && !selectedScopes[mScope]) { continue; } // confirm dialog: restrict to the selection
                var local = index[mScope];
                if (!local) { continue; } // app absent -> not installed, will not be pulled in (§6.2)
                var cmp = this._cmpVer(mTarget, local.current);
                if (cmp <= 0) { continue; } // already at version or lower target -> no impact to show
                suiteMemberScopes[mScope] = true;
                suiteApps.push({
                    scope:  mScope,
                    name:   local.name,
                    current: local.current,
                    target:  mTarget,
                    hidden:  local.hideOnUi
                });
            }
            if (suiteApps.length) {
                suiteResult = { name: sc.getValue('name') || 'Suite', version: sc.getValue('version') || '', apps: suiteApps };
            }
        }
        // §6.9 — no compatible=true suite, or none of its members have impact: render nothing (no error).

        // ---- Dependency branch (DependencyProcessor-style, target-version recursion) ----
        var roots = [];
        if (selectedScopes) {
            for (var rs in selectedScopes) { if (index[rs]) { roots.push(rs); } }
        } else {
            for (var allScope in index) {
                if (index[allScope].updateAvailable && !index[allScope].hideOnUi) { roots.push(allScope); }
            }
        }

        var depByRoot = {};  // rootScope -> [impact node, ...] — per-row expansion (§14)
        var unionNodes = {}; // scope -> impact node, deduped across ALL roots (§6.4, confirm dialog)
        for (var r = 0; r < roots.length; r++) {
            var rootScope = roots[r];
            var rootEntry = index[rootScope];
            if (!rootEntry) { continue; }
            var visited = {};
            visited[rootScope] = true;
            // BFS from the root's OWN target version (its latest_version, i.e.
            // what this batch installs) down through each dependency's target.
            // No query here — `latest` already sits in the §6.7 in-memory index.
            var queue = [{ scope: rootScope, version: rootEntry.latest }];
            var rootDeps = [];

            while (queue.length) {
                var node = queue.shift();
                if (!node.version) { continue; }
                var deps = versionIndex[node.scope + '@' + node.version];
                if (!deps) { continue; } // no sys_app_version row for that exact target — nothing to resolve further

                for (var di = 0; di < deps.length; di++) {
                    var dep = deps[di];
                    var depScope = dep.scope;
                    if (!depScope) { continue; }
                    if (/^com\./.test(depScope)) { continue; } // platform plugin, not a Store app — not tracked here
                    if (visited[depScope]) { continue; } // cycle guard
                    visited[depScope] = true;

                    var depEntry = index[depScope];
                    if (!depEntry) { continue; } // dependency scope not installed — not impact

                    var cmpDep = this._cmpVer(dep.minVersion, depEntry.current);
                    if (cmpDep <= 0) { continue; } // already satisfies the target's requirement — stop, no recursion (mirrors the native processor)

                    if (!suiteMemberScopes[depScope]) {
                        var impactNode = {
                            scope:   depScope,
                            name:    depEntry.name,
                            current: depEntry.current,
                            target:  dep.minVersion,
                            hidden:  depEntry.hideOnUi
                        };
                        rootDeps.push(impactNode);
                        if (!unionNodes[depScope]) { unionNodes[depScope] = impactNode; }
                    }
                    queue.push({ scope: depScope, version: dep.minVersion }); // recurse into ITS target's own deps
                }
            }

            if (rootDeps.length) { depByRoot[rootScope] = rootDeps; }
        }

        // Exclude roots from the UNION only when the caller passed an explicit
        // selection (confirm dialog: "N MORE apps beyond what was picked"). The
        // per-row breakdown (depByRoot) is never filtered by root membership —
        // e.g. Setup Hub Content is both a root (it's independently updatable)
        // and Setup Hub's own dependency-branch impact; the per-row view answers
        // "what does THIS app pull in", so it must show that regardless.
        var unionList = [];
        if (selectedScopes) {
            var rootSet = {};
            for (var rr = 0; rr < roots.length; rr++) { rootSet[roots[rr]] = true; }
            for (var us in unionNodes) { if (!rootSet[us]) { unionList.push(unionNodes[us]); } }
        } else {
            for (var us2 in unionNodes) { unionList.push(unionNodes[us2]); }
        }

        var out = {
            suite: suiteResult,
            dependenciesByRoot: Object.keys(depByRoot).length ? depByRoot : null,
            dependencies: unionList.length ? unionList : null
        };
        return JSON.stringify(out);
    },

    // -----------------------------------------------------------------------
    // syncStore — trigger the platform Store update check (App Manager "Sync now").
    // Fires the same event the daily "Check Scoped App Updates" job uses; the
    // sn_appclient handler runs UpdateChecker.checkAvailableUpdates(forceUpdate).
    // Asynchronous: the client polls getInstanceInfo.lastStoreSync for completion.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // syncStore — avvia la sincronizzazione con lo Store.
    //
    // NON usa gs.eventQueue('sn_appclient.check.for.update'): misurato su questa
    // istanza, quell'evento viene processato con 9-13 ore di ritardo perché finisce
    // in una coda condivisa con centinaia di eventi pendenti (text_index e altri).
    // Nessun polling lato client può reggere quei tempi, e il pulsante sembrava
    // "bloccato".
    //
    // Usa invece uno Scheduled Job "Run Once", che lo scheduler prende in carico
    // entro pochi secondi indipendentemente dalla coda eventi. Il job chiama
    // UpdateChecker.checkAvailableUpdates() direttamente — misurato ~112s su 1.200
    // applicazioni. Non lo eseguiamo in linea perché supererebbe il timeout della
    // transazione GlideAjax.
    // -----------------------------------------------------------------------
    syncStore: function() {
        if (!this._guard()) { return this._forbidden(); }

        var startedAt = new GlideDateTime();
        var prevSync  = gs.getProperty('sn_appclient.apps_last_sync_time', '');

        // Se una sync è già in corso, non accodarne un'altra.
        if (this._syncRunning()) {
            return JSON.stringify({
                queued: false, alreadyRunning: true,
                startedAt: '' + startedAt, lastSync: prevSync
            });
        }

        var script = ''
            + "// Now Plugin Updater — one-shot Store sync (created by syncStore)\n"
            + "try {\n"
            + "    gs.info('[PluginUpdater] Store sync starting');\n"
            + "    new sn_appclient.UpdateChecker().checkAvailableUpdates(false, false, { forceUpdate: true });\n"
            + "    gs.info('[PluginUpdater] Store sync finished');\n"
            + "} catch (e) {\n"
            + "    gs.error('[PluginUpdater] Store sync failed: ' + e);\n"
            + "}\n";

        // I job "once" restano in tabella dopo l'esecuzione: rimuovo i precedenti
        // così non se ne accumula uno per ogni click sul pulsante.
        this._cleanupSyncJobs();

        var job = new GlideRecord('sysauto_script');
        job.initialize();
        job.setValue('name', 'Plugin Updater - Store Sync (once)');
        job.setValue('script', script);
        job.setValue('active', true);
        job.setValue('run_type', 'once');
        job.setValue('run_start', startedAt);
        job.setValue('run_as', gs.getUserID());
        job.setValue('conditional', false);
        var jobId = job.insert();

        if (!jobId) {
            gs.error('[PluginUpdater] syncStore: could not create the one-shot sync job');
            return JSON.stringify({
                queued: false, error: 'Could not start the sync job. Check the "Scheduled Script Execution" table permissions.',
                startedAt: '' + startedAt, lastSync: prevSync
            });
        }

        gs.info('[PluginUpdater] syncStore: one-shot job ' + jobId + ' scheduled by ' + gs.getUserName());
        return JSON.stringify({
            queued:    true,
            jobId:     jobId,
            startedAt: '' + startedAt,
            lastSync:  prevSync
        });
    },

    // Una sync è in corso? apps_sync_progress è > 0 solo durante l'elaborazione
    // (a fine corsa la piattaforma la riporta a 0).
    _syncRunning: function() {
        var raw = parseFloat(gs.getProperty('sn_appclient.apps_sync_progress', '0'));
        return !isNaN(raw) && raw > 0;
    },

    // Elimina i job one-shot di sync creati in precedenza (ne resta traccia in
    // sysauto_script anche dopo l'esecuzione). Ne tiene solo quelli creati negli
    // ultimi 10 minuti, che potrebbero essere ancora in attesa di partire.
    _cleanupSyncJobs: function() {
        var cutoff = new GlideDateTime();
        cutoff.addSeconds(-600);
        var gr = new GlideRecord('sysauto_script');
        gr.addQuery('name', 'Plugin Updater - Store Sync (once)');
        gr.addQuery('sys_created_on', '<', cutoff);
        gr.setLimit(50);
        gr.query();
        var n = 0;
        while (gr.next()) { gr.deleteRecord(); n++; }
        if (n) { gs.info('[PluginUpdater] cleaned up ' + n + ' old one-shot sync job(s)'); }
        return n;
    },

    // -----------------------------------------------------------------------
    // getSyncProgress — avanzamento reale della sincronizzazione con lo Store.
    //
    // La property sn_appclient.apps_sync_progress è aggiornata a ogni fase da
    // UpdateChecker._setAppsSyncProgress, che scrive `progress*100`: la scala è
    // quindi PERCENTUALE 0-100 (verificato in corsa: valore osservato "85.0"),
    // non una frazione 0-1. A fine sync la piattaforma la riporta a 0.
    //
    // Fasi osservate: 1 fixUpdateAvailableField, 3 fetchAppUpdates, 20-70
    // updateAppRecords (incrementale), 85 refreshStoreResponseCache,
    // 96 syncGoldenConfigs, poi 0 = finita.
    //
    // Restituisce { pct, running, lastSync }. pct 0 è ambiguo di per sé (idle
    // oppure finita): il client lo disambigua confrontando lastSync con lo
    // startedAt restituito da syncStore.
    // -----------------------------------------------------------------------
    getSyncProgress: function() {
        if (!this._guard()) { return this._forbidden(); }
        var pct = parseFloat(gs.getProperty('sn_appclient.apps_sync_progress', '0'));
        if (isNaN(pct)) { pct = 0; }
        pct = Math.round(pct);
        if (pct < 0)   { pct = 0; }
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
    // v1.4.0 — la versione installata è l'arbitro finale dello stato. Fino alla
    // v1.3.7 una riga veniva marcata 'complete' anche quando l'app era rimasta
    // alla versione precedente, quindi un update non applicato appariva riuscito.
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
            if (w.pct) { gr.setValue('u_percent_complete', w.pct); }

            if (state === 'complete' || state === 'success') {
                // La versione effettivamente installata è l'ARBITRO UNICO dell'esito.
                //
                // Attenzione: NON si può usare state_code come criterio di fallimento.
                // Misurato su questa istanza, il worker CICD chiude con
                // state='complete' + state_code='error' anche quando l'installazione
                // è andata a buon fine (723 righe su 725 con state_code='error'
                // avevano la versione target corretta). Usare state_code qui
                // significherebbe marcare come fallite centinaia di installazioni
                // riuscite: un falso negativo peggiore del falso positivo che
                // questo fix corregge.
                //
                // Il mismatch di versione, invece, è inequivocabile: se l'app non ha
                // raggiunto il target, l'update non è stato applicato.
                var v = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'), verifyCache);
                if (!v.matches) {
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

    // _cmpVer — confronto semantico di versione: -1, 0, 1.
    // Serve perché l'uguaglianza stretta non basta: se un batch successivo (o la
    // sync dello Store) ha portato l'app oltre il target di questo batch, quella
    // installazione è comunque riuscita. Solo una versione INFERIORE al target
    // indica che l'update non è stato applicato.
    _cmpVer: function(a, b) {
        var pa = ('' + (a || '')).split(/[.\-]/), pb = ('' + (b || '')).split(/[.\-]/);
        var n = Math.max(pa.length, pb.length);
        for (var i = 0; i < n; i++) {
            var x = parseInt(pa[i], 10); if (isNaN(x)) { x = 0; }
            var y = parseInt(pb[i], 10); if (isNaN(y)) { y = 0; }
            if (x !== y) { return (x > y) ? 1 : -1; }
        }
        return 0;
    },

    // _verify — confronta la versione installata con il target. `cache` è opzionale:
    // monitorBatches lo passa per non ripetere la stessa lettura su sys_store_app
    // a ogni giro del job (le righe di un batch puntano spesso alla stessa app).
    // matches = true quando la versione installata è >= target (vedi _cmpVer).
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
        // Nessun target dichiarato: non c'è nulla da verificare, non fallire.
        if (!target) { return { matches: true, current: cur }; }
        return { matches: (this._cmpVer(cur, target) >= 0), current: cur, exact: (cur === target) };
    },

    // Messaggio d'errore leggibile. Il fatto constatato (la versione non è cambiata)
    // viene prima, perché è l'unica informazione affidabile; l'eventuale errore del
    // worker viene accodato solo se aggiunge qualcosa di leggibile.
    _failMessage: function(w, v, target) {
        var base;
        if (v && !v.matches) {
            base = v.current
                ? ('Install did not apply: still at ' + v.current + ', below the target ' + target)
                : 'Install did not apply: application record not found';
        } else {
            base = 'Install failed';
        }
        var m = ('' + ((w && (w.error || w.message)) || '')).trim();
        // "Executing queued operation" è il messaggio residuo del worker: non informa.
        if (m && m.toLowerCase().indexOf('executing queued operation') === -1) {
            base += ' — ' + m;
        }
        return base.substring(0, 1000);
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
