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
        return JSON.stringify(this._instanceInfo());
    },

    // Corpo interno: restituisce un oggetto (vedi O5).
    _instanceInfo: function() {
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

        return info;
    },

    // -----------------------------------------------------------------------
    // getUpdatableApps — { apps:[...], appsUpToDate, inFlight:[...] }
    // Count aligned with the native Application Manager.
    // -----------------------------------------------------------------------
    getUpdatableApps: function() {
        if (!this._guard()) { return this._forbidden(); }
        return JSON.stringify(this._updatableApps());
    },

    // Corpo interno: restituisce un oggetto (vedi O5).
    _updatableApps: function() {
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
        try { result.impact = this._updateImpact(null); }
        catch (eImpact) { result.impact = null; result.impactError = '' + eImpact; }

        return result;
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
    // _suiteImpact — ramo suite di getUpdateImpact, estratto in v1.6.3 (O1) per
    // poter essere calcolato prima di decidere se leggere sys_app_version.
    // sys_suite_config (compatible=true, versione piu' alta) + il suo m2m danno
    // il target esplicito per ogni app membro.
    _suiteImpact: function(index, selectedScopes) {
        var result = null, memberScopes = {};
        var sc = new GlideRecord('sys_suite_config');
        sc.addQuery('compatible', true);
        sc.orderByDesc('version');
        sc.setLimit(1);
        sc.query();
        if (sc.next()) {
            var suiteApps = [];
            var m2m = new GlideRecord('sys_suite_config_app_version_m2m');
            m2m.addQuery('suite_config', sc.getUniqueValue());
            m2m.setLimit(5000);
            m2m.query();
            while (m2m.next()) {
                var mScope  = m2m.getValue('app_scope') || '';
                var mTarget = m2m.getValue('app_version') || '';
                if (!mScope) { continue; }
                if (selectedScopes && !selectedScopes[mScope]) { continue; }
                var local = index[mScope];
                if (!local) { continue; }                              // non installata (§6.2)
                if (this._cmpVer(mTarget, local.current) <= 0) { continue; } // gia' a versione
                memberScopes[mScope] = true;
                suiteApps.push({
                    scope: mScope, name: local.name,
                    current: local.current, target: mTarget, hidden: local.hideOnUi
                });
            }
            if (suiteApps.length) {
                result = { name: sc.getValue('name') || 'Suite', version: sc.getValue('version') || '', apps: suiteApps };
            }
        }
        // §6.9 — nessuna suite compatible=true, o nessun membro con impatto:
        // non e' un errore, semplicemente non c'e' nulla da mostrare.
        return { result: result, memberScopes: memberScopes };
    },

    getUpdateImpact: function() {
        if (!this._guard()) { return this._forbidden(); }
        var scopesParam = ('' + (this.getParameter('sysparm_scopes') || this.getParameter('scopes') || '')).trim();
        return JSON.stringify(this._updateImpact(scopesParam));
    },

    // Corpo interno: restituisce un oggetto (vedi O5). scopesCsv = null|'' -> tutti
    // gli updatable; altrimenti solo i root nella selezione.
    _updateImpact: function(scopesCsv) {
        var scopesParam = ('' + (scopesCsv || '')).trim();
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

        // ---- Root da espandere: calcolati PRIMA di leggere sys_app_version ----
        // v1.6.3 (O1) — se non c'e' nessun root, non c'e' nulla da risolvere:
        // si esce subito. Fino alla v1.6.2 sys_app_version (ogni versione di ogni
        // app, tipicamente 10-50k righe) veniva caricata INTERAMENTE a ogni
        // chiamata, e getUpdatableApps la invoca sempre — anche con
        // "updates available = 0", lo stato normale, dove tutto quel lavoro
        // produceva un risultato vuoto.
        var roots = [];
        if (selectedScopes) {
            for (var rs0 in selectedScopes) { if (index[rs0]) { roots.push(rs0); } }
        } else {
            for (var allScope in index) {
                if (index[allScope].updateAvailable && !index[allScope].hideOnUi) { roots.push(allScope); }
            }
        }

        var suiteEarly = this._suiteImpact(index, selectedScopes);
        if (!roots.length) {
            // Nessun root: solo l'eventuale impatto di suite, niente ricorsione.
            return { suite: suiteEarly.result, dependenciesByRoot: null, dependencies: null };
        }

        // ---- Load sys_app_version into a "scope@version" -> deps index ----
        // Mirrors what the native DependencyProcessor reads per target version.
        // v1.6.3 (O1) — la lettura e' ristretta agli scope in gioco (i root piu'
        // le loro dipendenze, risolte per livelli) invece di scansionare tutta la
        // tabella. Il primo livello parte dai soli root.
        var versionIndex = {}; // "scope@version" -> [{scope, minVersion}]
        var loadedScopes = {};
        var self = this;
        function loadVersionsFor(scopeList) {
            var todo = [];
            for (var i = 0; i < scopeList.length; i++) {
                if (!loadedScopes[scopeList[i]]) { loadedScopes[scopeList[i]] = true; todo.push(scopeList[i]); }
            }
            if (!todo.length) { return []; }
            var discovered = {};
            var av = new GlideRecord('sys_app_version');
            av.addQuery('scope', 'IN', todo.join(','));
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
                for (var dq = 0; dq < deps.length; dq++) { discovered[deps[dq].scope] = true; }
            }
            var outList = [];
            for (var dk in discovered) { if (!loadedScopes[dk]) { outList.push(dk); } }
            return outList;
        }
        // Carico per livelli finche' emergono nuovi scope (profondita' misurata 2-3).
        var frontier = roots.slice(), depth = 0;
        while (frontier.length && depth < 12) { frontier = loadVersionsFor(frontier); depth++; }

        // ---- Dependency branch (DependencyProcessor-style, target-version recursion) ----
        // `roots`, `suiteEarly` e `versionIndex` sono gia' pronti (vedi O1 sopra).
        var suiteResult      = suiteEarly.result;
        var suiteMemberScopes = suiteEarly.memberScopes;

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

        return {
            suite: suiteResult,
            dependenciesByRoot: Object.keys(depByRoot).length ? depByRoot : null,
            dependencies: unionList.length ? unionList : null
        };
    },

    // =======================================================================
    // STORE SYNC (v1.6.3 — stato esplicito)
    //
    // Fino alla v1.6.2 la sync non aveva stato proprio: tutto era inferito da due
    // property di piattaforma (apps_sync_progress, apps_last_sync_time) piu'
    // euristiche lato client. Da qui i quattro problemi corretti in questa
    // versione:
    //
    //   S1  pct===0 e' ambiguo (idle oppure finita) e il client lo disambiguava
    //       confrontando STRINGHE di data (lastSync >= startedAt): con fusi o
    //       formati diversi il confronto era arbitrario.
    //   S2  se checkAvailableUpdates lanciava, l'eccezione veniva loggata e mai
    //       comunicata: il client pollava fino al timeout e poi mostrava "la sync
    //       continua sul server" — messaggio falso, la sync era morta.
    //   S3  il timeout client (5 min) era piu' corto della sync reale: ~112s
    //       misurati su 1.200 app, ma l'istanza ne ha 1.363 e cresce.
    //   S4  _syncRunning() legge apps_sync_progress, che resta 0 nella finestra
    //       fra creazione del job e sua prima fase: un secondo click in quella
    //       finestra avviava una SECONDA sync concorrente.
    //
    // La soluzione e' un unico stato serializzato in una property applicativa,
    // scritto da noi e quindi non ambiguo:
    //
    //   x_npu.sync_state = {"state":"running|done|error","startedAt":"...",
    //                       "finishedAt":"...","message":"...","by":"..."}
    //
    // state='running' e' il LOCK (S4): vale come tale finche' non scade
    // SYNC_LOCK_TTL_MS, cosi' un job morto senza scrivere l'esito non blocca la
    // sync per sempre. Il job scrive 'done' o 'error' al termine (S2), quindi il
    // client non deve piu' indovinare (S1) e puo' riagganciarsi a una sync in
    // corso invece di seguirla a vista (S3).
    // =======================================================================

    ROW_CAP:           500,   // O3: tetto alle righe restituite da getBatchStatus
    SYNC_JOB_NAME:     'Plugin Updater - Store Sync (once)',
    SYNC_STATE_PROP:   'x_npu.sync_state',
    SYNC_LOCK_TTL_MS:  1800000, // 30 min: oltre, un 'running' e' considerato morto

    _readSyncState: function() {
        var raw = gs.getProperty(this.SYNC_STATE_PROP, '');
        if (!raw) { return null; }
        try { return JSON.parse(raw); } catch (e) { return null; }
    },

    _writeSyncState: function(st) {
        try {
            gs.setProperty(this.SYNC_STATE_PROP, JSON.stringify(st),
                           'Now Plugin Updater — stato della sincronizzazione con lo Store');
            return true;
        } catch (e) {
            gs.error('[PluginUpdater] impossibile scrivere ' + this.SYNC_STATE_PROP + ': ' + e);
            return false;
        }
    },

    // Lock attivo? Solo uno stato 'running' NON scaduto conta (S4).
    _syncLocked: function() {
        var st = this._readSyncState();
        if (!st || st.state !== 'running' || !st.startedAt) { return false; }
        var started = new GlideDateTime(st.startedAt).getNumericValue();
        var age = new GlideDateTime().getNumericValue() - started;
        if (age > this.SYNC_LOCK_TTL_MS) {
            gs.warn('[PluginUpdater] lock di sync scaduto (' + Math.round(age / 60000) +
                    ' min): lo considero morto e ne consento una nuova');
            return false;
        }
        return true;
    },

    // -----------------------------------------------------------------------
    // syncStore — avvia la sincronizzazione con lo Store.
    //
    // NON usa gs.eventQueue('sn_appclient.check.for.update'): misurato su questa
    // istanza, quell'evento veniva processato con 9-13 ore di ritardo perche'
    // finisce in una coda condivisa con centinaia di eventi pendenti. Usa invece
    // uno Scheduled Job "Run Once", che lo scheduler prende in carico entro pochi
    // secondi. Non lo eseguiamo in linea perche' supererebbe il timeout della
    // transazione GlideAjax.
    // -----------------------------------------------------------------------
    syncStore: function() {
        if (!this._guard()) { return this._forbidden(); }

        var startedAt = new GlideDateTime();
        var prevSync  = gs.getProperty('sn_appclient.apps_last_sync_time', '');

        // S4 — lock esplicito: copre anche la finestra in cui il job e' creato
        // ma apps_sync_progress e' ancora 0.
        if (this._syncLocked() || this._syncRunning()) {
            var cur = this._readSyncState() || {};
            return JSON.stringify({
                queued: false, alreadyRunning: true,
                startedAt: cur.startedAt || ('' + startedAt),
                lastSync: prevSync
            });
        }

        // Prendo il lock PRIMA di creare il job: se due click arrivano insieme,
        // il secondo trova state='running'.
        this._writeSyncState({
            state: 'running', startedAt: '' + startedAt,
            finishedAt: '', message: '', by: gs.getUserName()
        });

        this._cleanupSyncJobs();

        // Lo script del job: scrive l'esito (S2) e si autocancella (B3).
        var prop = this.SYNC_STATE_PROP;
        var jobName = this.SYNC_JOB_NAME;
        var script = ''
            + "// Now Plugin Updater — one-shot Store sync (creato da syncStore, v1.6.3)\n"
            + "(function () {\n"
            + "    var started = '" + startedAt + "';\n"
            + "    function state(st, msg) {\n"
            + "        try {\n"
            + "            gs.setProperty('" + prop + "', JSON.stringify({\n"
            + "                state: st, startedAt: started,\n"
            + "                finishedAt: '' + new GlideDateTime(),\n"
            + "                message: msg || '', by: gs.getUserName()\n"
            + "            }));\n"
            + "        } catch (e) { gs.error('[PluginUpdater] sync state write failed: ' + e); }\n"
            + "    }\n"
            + "    try {\n"
            + "        gs.info('[PluginUpdater] Store sync starting');\n"
            + "        new sn_appclient.UpdateChecker().checkAvailableUpdates(false, false, { forceUpdate: true });\n"
            + "        gs.info('[PluginUpdater] Store sync finished');\n"
            + "        state('done', '');\n"
            + "    } catch (e) {\n"
            + "        gs.error('[PluginUpdater] Store sync failed: ' + e);\n"
            + "        state('error', '' + e);\n"
            + "    }\n"
            + "    // B3 — il job one-shot si rimuove da se': non resta schedulato\n"
            + "    // in attesa di un click successivo che lo ripulisca.\n"
            + "    try {\n"
            + "        var me = new GlideRecord('sysauto_script');\n"
            + "        if (me.get(gs.getProperty('__npu_sync_job_id', ''))) { me.deleteRecord(); }\n"
            + "    } catch (e2) { gs.warn('[PluginUpdater] self-cleanup del job di sync fallito: ' + e2); }\n"
            + "})();\n";

        var job = new GlideRecord('sysauto_script');
        job.initialize();
        job.setValue('name', jobName);
        job.setValue('script', script);
        job.setValue('active', true);
        job.setValue('run_type', 'once');
        job.setValue('run_start', startedAt);
        job.setValue('run_as', gs.getUserID());
        job.setValue('conditional', false);
        var jobId = job.insert();

        if (!jobId) {
            gs.error('[PluginUpdater] syncStore: impossibile creare il job one-shot di sync');
            // Rilascio il lock: nessuna sync e' partita.
            this._writeSyncState({
                state: 'error', startedAt: '' + startedAt,
                finishedAt: '' + new GlideDateTime(),
                message: 'Could not create the sync job', by: gs.getUserName()
            });
            return JSON.stringify({
                queued: false,
                error: 'Could not start the sync job. Check the "Scheduled Script Execution" table permissions.',
                startedAt: '' + startedAt, lastSync: prevSync
            });
        }

        // Il job ha bisogno del proprio sys_id per autocancellarsi.
        gs.setProperty('__npu_sync_job_id', jobId);

        gs.info('[PluginUpdater] syncStore: job one-shot ' + jobId + ' schedulato da ' + gs.getUserName());
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

    // v1.6.3 (B3/B4) — pulizia dei job one-shot di sync.
    //
    // B3: il job ora si CANCELLA DA SE' al termine (vedi lo script generato in
    // syncStore), quindi non serve piu' un click successivo per rimuoverlo.
    // Fino alla v1.6.2 il cleanup girava PRIMA di creare il job nuovo e filtrava
    // su sys_created_on < now-600s: il job appena creato non era mai ripulito dal
    // proprio click. Misurato sull'istanza: un job del 13 agosto ancora
    // active=true tre settimane dopo.
    //
    // B4: il filtro non e' piu' solo su sys_created_on (che cancellava anche job
    // creati >10 min prima ma non ancora eseguiti dallo scheduler, facendo
    // sparire la sync in silenzio). Ora si eliminano solo i job GIA' ESEGUITI
    // (run_start nel passato) e comunque piu' vecchi di un'ora: doppia
    // condizione, nessun job in attesa viene toccato.
    _cleanupSyncJobs: function() {
        var cutoff = new GlideDateTime();
        cutoff.addSeconds(-3600);
        var gr = new GlideRecord('sysauto_script');
        gr.addQuery('name', this.SYNC_JOB_NAME);
        gr.addQuery('sys_created_on', '<', cutoff);
        gr.addQuery('run_start', '<', new GlideDateTime()); // gia' scaduto = gia' eseguito
        gr.setLimit(50);
        gr.query();
        var n = 0;
        while (gr.next()) { gr.deleteRecord(); n++; }
        if (n) { gs.info('[PluginUpdater] cleaned up ' + n + ' stale one-shot sync job(s)'); }
        return n;
    },

    // -----------------------------------------------------------------------
    // getSyncProgress — avanzamento REALE della sincronizzazione con lo Store.
    //
    // v1.6.3 — restituisce un ESITO, non piu' un numero ambiguo (S1/S2). Il campo
    // `outcome` vale 'running' | 'done' | 'error' | 'idle' e viene letto dallo
    // stato che scriviamo noi, non inferito. Il client non deve piu' confrontare
    // stringhe di data per capire se la sync e' finita.
    //
    // apps_sync_progress resta la fonte della PERCENTUALE (la piattaforma la
    // aggiorna a ogni fase: 1 fixUpdateAvailableField, 3 fetchAppUpdates, 20-70
    // updateAppRecords, 85 refreshStoreResponseCache, 96 syncGoldenConfigs, poi
    // 0 = finita). La scala e' 0-100, verificato in corsa.
    // -----------------------------------------------------------------------
    getSyncProgress: function() {
        if (!this._guard()) { return this._forbidden(); }

        var pct = parseFloat(gs.getProperty('sn_appclient.apps_sync_progress', '0'));
        if (isNaN(pct)) { pct = 0; }
        pct = Math.round(pct);
        if (pct < 0)   { pct = 0; }
        if (pct > 100) { pct = 100; }

        var st = this._readSyncState();
        var outcome = 'idle', message = '', startedAt = '', finishedAt = '';
        if (st) {
            outcome    = st.state || 'idle';
            message    = st.message || '';
            startedAt  = st.startedAt || '';
            finishedAt = st.finishedAt || '';
            // Un 'running' scaduto non e' piu' credibile: il job e' morto senza
            // scrivere l'esito. Lo dichiaro fallito invece di far pollare a vuoto.
            if (outcome === 'running' && startedAt) {
                var age = new GlideDateTime().getNumericValue() - new GlideDateTime(startedAt).getNumericValue();
                if (age > this.SYNC_LOCK_TTL_MS) {
                    outcome = 'error';
                    message = 'The sync job stopped without reporting an outcome (timed out after ' +
                              Math.round(age / 60000) + ' minutes).';
                }
            }
        }

        // La piattaforma sta ancora lavorando? pct>0 e' un indizio positivo, ma
        // l'arbitro e' il nostro stato.
        var running = (outcome === 'running');

        return JSON.stringify({
            pct:        running ? pct : (outcome === 'done' ? 100 : pct),
            running:    running,
            outcome:    outcome,
            message:    message,
            startedAt:  startedAt,
            finishedAt: finishedAt,
            lastSync:   gs.getProperty('sn_appclient.apps_last_sync_time', '')
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
            // Snapshot of each dependency's pre-install version, taken from the
            // client's getUpdateImpact result at launch time — sys_execution_tracker
            // (§10.3) only carries the target version GlideAppLoader installs, never
            // the version it started from, so this is the only place that data is
            // available (sys_store_app.version is already the target once the
            // install has run, so it cannot be reconstructed after the fact).
            var depSnapJson = '';
            try { depSnapJson = JSON.stringify(a.depVersions || {}).substring(0, 4000); } catch (e2) { depSnapJson = ''; }
            gr.setValue('u_dependency_snapshot', depSnapJson);
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
        // v1.6.6 — ordinamento esplicito: la direzione di orderByAggregate non e'
        // affidabile (il selettore mostrava i batch dal piu' vecchio), e con piu' di
        // 20 batch lo slice avrebbe tenuto i 20 piu' vecchi. Si ordina per data
        // decrescente (formato interno 'yyyy-MM-dd HH:mm:ss', confrontabile come
        // stringa) PRIMA di tagliare: il primo elemento e' il piu' recente.
        order.sort(function(x, y) { return (x.when < y.when) ? 1 : ((x.when > y.when) ? -1 : 0); });
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
    //
    // v1.6.3 (O5) — usa i metodi interni _instanceInfo/_updatableApps che
    // restituiscono OGGETTI: prima si serializzava per poi deserializzare e
    // ri-serializzare subito dopo, tre volte per ogni caricamento della Home.
    // -----------------------------------------------------------------------
    getHomeData: function() {
        if (!this._guard()) { return this._forbidden(); }
        var out = {};
        try { out.info = this._instanceInfo(); }
        catch (e) { out.info = {}; out.infoError = '' + e; }
        try { out.appData = this._updatableApps(); }
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
        var n = 0, kept = 0, verifyCache = {};
        while (gr.next()) {
            // v1.6.6 — il log puo' essere in ritardo sulla piattaforma (monitorBatches
            // gira ogni minuto): una riga 'queued' puo' essere gia' in esecuzione o
            // gia' installata. La versione installata resta l'arbitro (§10.1), quindi
            // prima di annullare si controllano versione e tracker/worker.
            var pid = gr.getValue('u_progress_id');
            var w = pid ? this._findWorker(pid) : null;
            var ws = w ? ('' + w.state).toLowerCase() : '';
            var ver = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'), verifyCache);
            if (gr.getValue('u_target_version') && ver.matches) {
                gr.setValue('u_status', 'complete');
                gr.setValue('u_error_message', '');
                gr.setValue('u_percent_complete', 100);
                gr.setValue('u_completed_at', new GlideDateTime());
                gr.update();
                kept++;
                continue;
            }
            if (ws === 'running') {
                gr.setValue('u_status', 'installing');
                gr.update();
                kept++;
                continue;
            }
            gr.setValue('u_status', 'cancelled');
            gr.setValue('u_error_message', 'Cancelled by ' + gs.getUserName() + ' before the install started');
            gr.setValue('u_percent_complete', 100);
            gr.setValue('u_completed_at', new GlideDateTime());
            gr.update();
            n++;
        }
        gs.info('[PluginUpdater] cancelRemaining batch=' + batch + ' cancelled=' + n + ' alreadyStarted=' + kept);
        return JSON.stringify({ ok: true, cancelled: n, kept: kept });
    },

    // getBatchStatus — param: batch. Restituisce righe + conteggi.
    //
    // v1.6.3 — due cambi rispetto alla 1.6.2:
    //   O2: l'albero delle dipendenze e' risolto UNA VOLTA per tutto il batch
    //       (_dependencyTreeForBatch), non piu' con una BFS per riga.
    //   O3: i conteggi sono calcolati con GlideAggregate sull'INTERO batch, e le
    //       righe restituite sono limitate a ROW_CAP. Prima non c'era setLimit: un
    //       batch da 1000 app (il cap di createBatch) restituiva 1000 righe piu' i
    //       loro deps a ogni ciclo di polling, ogni 15s. RENDER_CAP lato client
    //       limitava solo il rendering, non il payload.
    getBatchStatus: function() {
        if (!this._guard()) { return this._forbidden(); }
        var batch = ('' + (this.getParameter('sysparm_batch') || this.getParameter('batch') || '')).trim();
        if (!batch) { return JSON.stringify({ error: 'batch required', rows: [], counts: {} }); }

        // v1.6.6 — "Refresh now": con reconcile=1 il log viene prima allineato a
        // tracker/worker e versione installata (stessa logica del job), cosi' la
        // risposta riflette lo stato reale e non quello dell'ultimo ciclo del job.
        var wantReconcile = ('' + (this.getParameter('sysparm_reconcile') || this.getParameter('reconcile') || '')) === '1';
        if (wantReconcile) {
            try { this._reconcile(batch); }
            catch (er) { gs.warn('[PluginUpdater] getBatchStatus reconcile failed: ' + er); }
        }

        // ---- Conteggi sull'intero batch (una query aggregata) ----
        var counts = { total: 0, complete: 0, failed: 0, installing: 0, queued: 0, cancelled: 0 };
        var ag = new GlideAggregate('u_plugin_updater_install_log');
        ag.addQuery('u_session_id', batch);
        ag.groupBy('u_status');
        ag.addAggregate('COUNT');
        ag.query();
        while (ag.next()) {
            var st0 = ag.getValue('u_status') || 'queued';
            var n0  = parseInt(ag.getAggregate('COUNT'), 10) || 0;
            if (st0 === 'in_progress') { st0 = 'installing'; }   // righe legacy
            if (!counts.hasOwnProperty(st0)) { st0 = 'queued'; }
            counts[st0] += n0;
            counts.total += n0;
        }

        // ---- Righe (limitate) ----
        var rows = [], progressIds = [];
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_session_id', batch);
        gr.orderBy('u_app_name');
        gr.setLimit(this.ROW_CAP);
        gr.query();
        while (gr.next()) {
            var raw = gr.getValue('u_status') || 'queued';
            var st = (raw === 'in_progress') ? 'installing' : raw;
            if (['complete','failed','installing','cancelled','queued'].indexOf(st) < 0) { st = 'queued'; }
            var pid = gr.getValue('u_progress_id');
            if (pid) { progressIds.push(pid); }
            rows.push({
                logSysId:   gr.getUniqueValue(),
                name:       gr.getValue('u_app_name'),
                scope:      gr.getValue('u_app_scope') || '',
                current:    gr.getValue('u_previous_version'),
                latest:     gr.getValue('u_target_version'),
                status:     st,
                pct:        parseInt(gr.getValue('u_percent_complete'), 10) || 0,
                message:    gr.getValue('u_error_message') || '',
                startedAt:  gr.getDisplayValue('u_started_at'),
                _pid:       pid,
                _snapshot:  gr.getValue('u_dependency_snapshot')
            });
        }

        // ---- Dipendenze: un albero per tutto il batch (O2) ----
        var tree = this._dependencyTreeForBatch(progressIds);
        var depScopeSet = {};
        for (var ri = 0; ri < rows.length; ri++) {
            rows[ri].deps = this._depRowsFor(tree, rows[ri]._pid, rows[ri].scope, rows[ri]._snapshot);
            delete rows[ri]._pid; delete rows[ri]._snapshot;
            for (var di = 0; di < rows[ri].deps.length; di++) { depScopeSet[rows[ri].deps[di].scope] = true; }
        }

        // Nomi leggibili per gli scope delle dipendenze, in UNA query (§6.7).
        var depScopeList = [];
        for (var ds in depScopeSet) { depScopeList.push(ds); }
        if (depScopeList.length) {
            var nameByScope = {};
            var sa = new GlideRecord('sys_store_app');
            sa.addQuery('scope', 'IN', depScopeList.join(','));
            sa.setLimit(5000);
            sa.query();
            while (sa.next()) { nameByScope[sa.getValue('scope')] = sa.getValue('name') || sa.getValue('scope'); }
            for (var rj = 0; rj < rows.length; rj++) {
                for (var dj = 0; dj < rows[rj].deps.length; dj++) {
                    var dep = rows[rj].deps[dj];
                    dep.name = nameByScope[dep.scope] || dep.scope;
                }
            }
        }

        var bStatus = 'running';
        if (counts.total > 0 && counts.installing === 0 && counts.queued === 0) {
            if (counts.failed > 0) { bStatus = (counts.complete > 0) ? 'partial' : 'failed'; }
            else if (counts.complete === 0 && counts.cancelled > 0) { bStatus = 'cancelled'; }
            else { bStatus = 'complete'; }
        }
        return JSON.stringify({
            batch:    batch,
            status:   bStatus,
            counts:   counts,
            rows:     rows,
            rowsShown: rows.length,
            truncated: (counts.total > rows.length)
        });
    },

    // _dependencyTreeForBatch — v1.6.3 (O2). Risolve in UNA PASSATA l'albero dei
    // tracker per TUTTE le righe del batch, e restituisce
    // { progressId -> { scope -> nodo } }.
    //
    // Fino alla v1.6.2 _dependencyRowsFromTracker era chiamata dentro il while su
    // ogni riga di getBatchStatus, e ciascuna chiamata faceva una BFS con una
    // GlideRecord per ogni nodo visitato (fino a 500). Un batch di 50 app con
    // alberi di profondita' 3 produceva centinaia di query per singolo polling —
    // e il Monitor polla ogni 15s. Ora si fa una query per LIVELLO dell'albero,
    // condivisa da tutte le righe: tipicamente 3-4 query in totale.
    //
    // sys_progress_worker e sys_execution_tracker condividono il sys_id del nodo
    // radice (misurato). Ogni app che GlideAppLoader installa sotto quella radice
    // — la richiesta e le dipendenze che ha dovuto aggiornare — ha un nodo
    // discendente "Installing application <scope>:<version>". Le dipendenze gia'
    // soddisfatte non producono nodi (§6.1): questo mostra cio' che e' realmente
    // avvenuto, non cio' che avevamo previsto con getUpdateImpact.
    _dependencyTreeForBatch: function(rootIds) {
        var byRoot = {};   // progressId -> { scope -> nodo }
        if (!rootIds || !rootIds.length) { return byRoot; }

        var owner = {};    // trackerId -> progressId radice di appartenenza
        var frontier = [];
        for (var i = 0; i < rootIds.length; i++) {
            var rid = this._sysId(rootIds[i]);
            if (!rid) { continue; }
            byRoot[rid] = {};
            owner[rid] = rid;
            frontier.push(rid);
        }
        if (!frontier.length) { return byRoot; }

        var re = /^Installing application ([A-Za-z0-9_.]+):(.+)$/;
        var stMap = { 0: 'queued', 1: 'installing', 2: 'complete', 3: 'failed', 4: 'cancelled' };
        var depth = 0;

        // Una query per livello: parent IN (tutti i nodi del livello precedente).
        while (frontier.length && depth < 8) {
            var gr = new GlideRecord('sys_execution_tracker');
            gr.addQuery('parent', 'IN', frontier.join(','));
            gr.setLimit(5000);
            gr.query();
            var next = [];
            while (gr.next()) {
                var childId  = gr.getUniqueValue();
                var parentId = gr.getValue('parent');
                var rootOf   = owner[parentId];
                if (!rootOf) { continue; }
                owner[childId] = rootOf;
                next.push(childId);

                var m = re.exec(gr.getValue('name') || '');
                if (!m) { continue; }
                var depScope = m[1];
                if (byRoot[rootOf][depScope]) { continue; }  // primo nodo vince
                byRoot[rootOf][depScope] = {
                    scope:   depScope,
                    version: m[2],
                    status:  stMap.hasOwnProperty(parseInt(gr.getValue('state'), 10))
                                ? stMap[parseInt(gr.getValue('state'), 10)] : 'queued',
                    pct:     parseInt(gr.getValue('percent_complete'), 10) || 0
                };
            }
            frontier = next;
            depth++;
        }
        return byRoot;
    },

    // _depRowsFor — proietta l'albero risolto sulla singola riga: esclude lo scope
    // dell'app richiesta (non e' una sua dipendenza) e applica lo snapshot delle
    // versioni di partenza.
    //
    // depSnapshotJson (v1.6.1): il nome del nodo tracker porta solo la versione
    // TARGET, mai quella di partenza — e quando questo codice gira,
    // sys_store_app.version e' gia' il target, quindi "current" non e'
    // ricostruibile a posteriori. createBatch ne salva uno snapshot pre-install in
    // u_dependency_snapshot; questa e' quella mappa, scope -> versione corrente.
    _depRowsFor: function(tree, progressId, ownScope, depSnapshotJson) {
        var pid = this._sysId(progressId);
        if (!pid || !tree[pid]) { return []; }
        var depCurrent = {};
        if (depSnapshotJson) {
            try { depCurrent = JSON.parse(depSnapshotJson) || {}; } catch (e) { depCurrent = {}; }
        }
        var out = [];
        var found = tree[pid];
        for (var scope in found) {
            if (scope === ownScope) { continue; }
            var n = found[scope];
            out.push({
                scope:   n.scope,
                current: depCurrent[scope] || '',
                version: n.version,
                status:  n.status,
                pct:     n.pct
            });
        }
        return out;
    },

    // attachWorker — UPDATE ONLY: registra il worker sulla riga di log.
    //
    // v1.6.3 (B1) — lo stato viene riportato a 'queued' SOLO se la riga e' ancora
    // in attesa. Fino alla v1.6.2 la scrittura era incondizionata: se il monitor
    // job (che gira ogni minuto) girava fra la POST CICD e questa chiamata, una
    // riga gia' 'complete' o 'failed' tornava 'queued', il batch non chiudeva mai
    // e la riga riappariva in coda dopo essere finita.
    attachWorker: function() {
        if (!this._guard()) { return this._forbidden(); }
        var logSysId = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        var pid      = this._sysId(this.getParameter('sysparm_progress_id') || this.getParameter('progress_id'));
        if (!logSysId) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var gr = new GlideRecord('u_plugin_updater_install_log');
        if (!gr.get(logSysId)) { return JSON.stringify({ ok: false, error: 'log row not found' }); }

        gr.setValue('u_progress_id', pid);
        var cur = gr.getValue('u_status') || 'queued';
        if (cur === 'queued' || cur === 'in_progress') {
            gr.setValue('u_status', 'queued');
        } else {
            gs.info('[PluginUpdater] attachWorker: riga ' + logSysId + ' gia\' in stato "' +
                    cur + '", stato preservato (worker registrato comunque)');
        }
        gr.update();
        return JSON.stringify({ ok: true, status: gr.getValue('u_status') });
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
        return this._reconcile('');
    },

    // _reconcile — corpo di monitorBatches. v1.6.6: `batchFilter` (opzionale) limita
    // la riconciliazione a un solo batch, cosi' "Refresh now" del Monitor puo'
    // allineare subito il log a tracker e versione installata senza aspettare il
    // ciclo di un minuto del job. Senza filtro e' identico al vecchio monitorBatches.
    // Non fa alcun controllo di ruolo: lo fanno i chiamanti (_guard / _guardServer).
    _reconcile: function(batchFilter) {
        // v1.6.3 (B2) — NON si filtra piu' su u_progress_id NOT NULL. Una riga
        // senza worker (tab chiuso durante il lancio, POST riuscita ma risposta
        // persa, failRow mai eseguita) non veniva guardata da nessun ciclo del
        // job: restava 'queued' per sempre, il batch restava 'running' a vita e
        // getActiveBatch continuava a restituirlo. Ora entra nel ciclo e viene
        // valutata come le altre: verifica di versione, poi timeout.
        var gr = new GlideRecord('u_plugin_updater_install_log');
        gr.addQuery('u_status', 'IN', 'queued,installing,in_progress');
        if (batchFilter) { gr.addQuery('u_session_id', batchFilter); }
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
            var pid = gr.getValue('u_progress_id');
            var w = pid ? this._findWorker(pid) : null;
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
                    gr.setValue('u_error_message', pid
                        ? 'Timed out: install did not start (install queue idle, no progress for 60 minutes)'
                        : 'Timed out: the install was never launched (no progress worker was ever attached to this row)');
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
                // v1.6.6 — anche qui la versione installata resta l'arbitro (§10.1):
                // se l'app ha comunque raggiunto il target, la riga e' 'complete'.
                var vf = this._verify(gr.getValue('u_store_app_id'), gr.getValue('u_target_version'), verifyCache);
                if (vf.matches) {
                    gr.setValue('u_status', 'complete');
                    gr.setValue('u_error_message', '');
                } else {
                    gr.setValue('u_status', 'failed');
                    gr.setValue('u_error_message', this._failMessage(w, vf, gr.getValue('u_target_version')));
                }
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
        // v1.6.6 — righe 'cancelled' di recente: l'annullamento tocca solo il log, non
        // la coda della piattaforma, quindi un'operazione gia' accodata puo' installarsi
        // comunque. Se la versione target risulta installata la riga e' 'complete'
        // (§10.1): la versione installata prevale sullo stato scritto da cancelRemaining.
        var cg = new GlideRecord('u_plugin_updater_install_log');
        cg.addQuery('u_status', 'cancelled');
        cg.addQuery('u_completed_at', '>=', gs.hoursAgo(6));
        if (batchFilter) { cg.addQuery('u_session_id', batchFilter); }
        cg.setLimit(200);
        cg.query();
        while (cg.next()) {
            var vc = this._verify(cg.getValue('u_store_app_id'), cg.getValue('u_target_version'), verifyCache);
            if (cg.getValue('u_target_version') && vc.matches) {
                cg.setValue('u_status', 'complete');
                cg.setValue('u_error_message', '');
                cg.update();
                finalized++;
            }
        }
        gs.info('[PluginUpdater] monitorBatches checked=' + checked + ' finalized=' + finalized);
        return checked + ':' + finalized;
    },

    // _findWorker — legge il worker CICD. v1.6.3 (B5): rimossa la seconda query
    // con setWorkflow(false), che duplicava la prima senza aggiungere nulla
    // (gr.get() non esegue business rule in lettura), e rimosso il campo `code`
    // (state_code), letto e mai usato: vedi il commento in monitorBatches sul
    // perche' state_code NON e' utilizzabile come criterio di esito.
    _findWorker: function(pid) {
        pid = this._sysId(pid);
        if (!pid) { return null; }
        var gr = new GlideRecord('sys_progress_worker');
        if (gr.get(pid)) {
            return {
                state:   gr.getValue('state'),
                message: gr.getValue('message'),
                error:   gr.getValue('error_message'),
                pct:     parseInt(gr.getValue('percent_complete'), 10) || 0,
                id:      pid,
                source:  'worker'
            };
        }
        // v1.6.6 — fallback su sys_execution_tracker. Quando l'install fallisce
        // prima di partire (es. "Unable to download app package") la piattaforma
        // crea solo il tracker e nessun sys_progress_worker: senza questo ramo la
        // riga restava 'queued' per 60 minuti e chiudeva con un timeout fuorviante.
        // Stati del tracker: 0 pending, 1 running, 2 successful, 3 failed, 4 cancelled.
        var tr = new GlideRecord('sys_execution_tracker');
        if (!tr.get(pid)) { return null; }
        var TRACKER_STATE = { '0': 'pending', '1': 'running', '2': 'complete', '3': 'failed', '4': 'cancelled' };
        return {
            state:   TRACKER_STATE[tr.getValue('state')] || '',
            message: tr.getValue('message'),
            error:   '',
            pct:     parseInt(tr.getValue('percent_complete'), 10) || 0,
            id:      pid,
            source:  'tracker'
        };
    },

    // _trackerFailure — v1.6.6. Il worker CICD chiude 'complete' con il solo
    // "Executing queued operation" anche quando la piattaforma ha abortito
    // l'installazione: il motivo vero sta sul tracker radice, che ha lo stesso
    // sys_id del worker (es. "Aborting installation of application: ...,
    // application depends on other applications which are not accessible at app
    // store: ..."). Si legge solo per le righe che stanno fallendo, e solo se il
    // tracker e' Failed (3) o Cancelled (4).
    _trackerFailure: function(pid) {
        pid = this._sysId(pid);
        if (!pid) { return ''; }
        var tr = new GlideRecord('sys_execution_tracker');
        if (!tr.get(pid)) { return ''; }
        var st = '' + tr.getValue('state');
        if (st !== '3' && st !== '4') { return ''; }
        return ('' + (tr.getValue('message') || '')).trim();
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
        var useless = !m || m.toLowerCase().indexOf('executing queued operation') !== -1;
        // v1.6.6 — in quel caso il motivo vero si cerca sul tracker (§19.13).
        if (useless && w && w.source === 'worker' && w.id) {
            m = this._trackerFailure(w.id);
        }
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
