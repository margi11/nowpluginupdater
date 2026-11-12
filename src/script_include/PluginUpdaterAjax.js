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

        // In-flight apps — used by the wizard to disable apps already being installed.
        // v1.7.1 (F03): ogni voce porta appId (sys_id di sys_store_app).
        result.inFlight = this._inFlightApps();

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

    // Stati "attivi" di una riga di log: la riga non e' ancora finale.
    ACTIVE_STATUSES: 'queued,installing,in_progress',

    // _inFlightApps — v1.7.1 (F03). Fino alla v1.7.0 inFlight conteneva i sys_id
    // dei sys_progress_worker, che il client confrontava con i sys_id di
    // sys_store_app: non coincidevano mai, quindi le app in installazione restavano
    // selezionabili. Ora ogni voce e' risolta all'app:
    //   1) righe di log attive (queued/installing) di QUALSIASI batch: coprono
    //      anche i primi minuti dopo il lancio, quando il worker non esiste ancora
    //      (misurato su Brazil: inFlight vuoto subito dopo il lancio). Le righe senza
    //      progress id sono incluse di proposito: createBatch rifiuta comunque
    //      un'app con una riga attiva, quindi mostrarla selezionabile sarebbe falso;
    //   2) worker CICD pending/running e operazioni di install radice
    //      (sys_execution_tracker, type sys.applifecycle.operation) pending/running:
    //      coprono le installazioni avviate fuori da questa app, risolte con
    //      detail_message "app=<sys_id>" (stesso parsing di _parseOpDetail).
    // Restituisce [{ appId, state, source }], senza duplicati per appId.
    _inFlightApps: function() {
        var out = [], seen = {};
        function add(appId, state, source) {
            if (!appId || seen.hasOwnProperty(appId)) { return; }
            seen[appId] = true;
            out.push({ appId: appId, state: state, source: source });
        }

        var lg = new GlideRecord('u_plugin_updater_install_log');
        lg.addQuery('u_status', 'IN', this.ACTIVE_STATUSES);
        lg.addNotNullQuery('u_store_app_id');
        lg.setLimit(2000);
        lg.query();
        while (lg.next()) {
            var st = '' + lg.getValue('u_status');
            add(this._sysId(lg.getValue('u_store_app_id')), (st === 'queued') ? 'queued' : 'installing', 'log');
        }

        var rootIds = [];
        var wGr = new GlideRecord('sys_progress_worker');
        wGr.addQuery('name', 'CICDAppRepoService$CICDInstallWorker');
        wGr.addQuery('state', 'IN', 'pending,running');
        wGr.setLimit(200);
        wGr.query();
        while (wGr.next()) { rootIds.push('' + wGr.getUniqueValue()); }

        var tr = new GlideRecord('sys_execution_tracker');
        if (tr.isValid() && tr.isValidField('detail_message') && tr.isValidField('type')) {
            var ts = this._trackerStates();
            var q = 'sys_idIN' + (rootIds.length ? rootIds.join(',') : '-') +
                    '^NQparentISEMPTY^type=' + this.QH_SUBJECT + '^stateIN' + ts.v.pending + ',' + ts.v.running;
            tr.addEncodedQuery(q);
            tr.setLimit(400);
            tr.query();
            while (tr.next()) {
                var d = this._parseOpDetail(tr.getValue('detail_message'));
                var s = '' + tr.getValue('state');
                add(d.appId, (s === ts.v.running) ? 'installing' : 'queued', 'platform');
            }
        }
        return out;
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
        // v1.7.1 (F31) — sys_suite_config.version e' una STRINGA (verificato su
        // Brazil Patch 2): orderByDesc('version') ordina come testo e 30.10
        // finirebbe sotto 30.9. Inoltre setLimit(1) su tutte le suite considerava
        // una sola famiglia. Ora si legge ogni config compatibile, si sceglie in
        // memoria la versione piu' alta con _cmpVer PER NOME di suite, e si
        // uniscono i membri di tutte le famiglie.
        var bestByName = {}, names = [];
        var sc = new GlideRecord('sys_suite_config');
        sc.addQuery('compatible', true);
        sc.setLimit(1000);
        sc.query();
        while (sc.next()) {
            var sName = ('' + (sc.getValue('name') || 'Suite')).trim();
            var sVer  = ('' + (sc.getValue('version') || '')).trim();
            if (!bestByName.hasOwnProperty(sName)) { names.push(sName); }
            else if (this._cmpVer(sVer, bestByName[sName].version) <= 0) { continue; }
            bestByName[sName] = { id: '' + sc.getUniqueValue(), name: sName, version: sVer };
        }
        var suiteApps = [], byScope = {}, usedNames = [], usedVersion = '';
        for (var sn = 0; sn < names.length; sn++) {
            var cfg = bestByName[names[sn]], cfgHasApps = false;
            var m2m = new GlideRecord('sys_suite_config_app_version_m2m');
            m2m.addQuery('suite_config', cfg.id);
            m2m.setLimit(5000);
            m2m.query();
            while (m2m.next()) {
                var mScope  = ('' + (m2m.getValue('app_scope') || '')).trim();
                var mTarget = ('' + (m2m.getValue('app_version') || '')).trim();
                if (!mScope) { continue; }
                if (selectedScopes && !selectedScopes.hasOwnProperty(mScope)) { continue; }
                if (!index.hasOwnProperty(mScope)) { continue; }
                var local = index[mScope];                              // non installata (§6.2)
                if (this._cmpVer(mTarget, local.current) <= 0) { continue; } // gia' a versione
                memberScopes[mScope] = true;
                cfgHasApps = true;
                if (byScope.hasOwnProperty(mScope)) {
                    // Scope in due famiglie: resta il target piu' alto.
                    if (this._cmpVer(mTarget, byScope[mScope].target) > 0) { byScope[mScope].target = mTarget; }
                    continue;
                }
                byScope[mScope] = {
                    scope: mScope, name: local.name,
                    current: local.current, target: mTarget, hidden: local.hideOnUi
                };
                suiteApps.push(byScope[mScope]);
            }
            if (cfgHasApps) { usedNames.push(cfg.name); usedVersion = cfg.version; }
        }
        if (suiteApps.length) {
            // Forma invariata ({ name, version, apps }): con una sola famiglia (il caso
            // di oggi) name e version sono quelli della config scelta.
            result = { name: usedNames.join(', '), version: (usedNames.length === 1) ? usedVersion : '', apps: suiteApps };
        }
        // §6.9 — nessuna suite compatible=true, o nessun membro con impatto:
        // non e' un errore, semplicemente non c'e' nulla da mostrare.
        return { result: result, memberScopes: memberScopes };
    },

    getUpdateImpact: function() {
        if (!this._guard()) { return this._forbidden(); }
        var scopesParam = ('' + (this.getParameter('sysparm_scopes') || this.getParameter('scopes') || '')).trim();
        // v1.7.1 (F17) — un'eccezione qui produceva una risposta vuota, che il
        // dialog di conferma mostrava come "nessun'altra app": un falso negativo.
        // Ora l'errore torna esplicito e il client lo mostra come avviso.
        try { return JSON.stringify(this._updateImpact(scopesParam)); }
        catch (e) {
            gs.warn('[PluginUpdater] getUpdateImpact failed: ' + e);
            return JSON.stringify({ error: 'The dependency impact could not be computed: ' + e });
        }
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
            var scope = ('' + (sa.getValue('scope') || '')).trim();
            if (!scope) { continue; }
            // v1.7.1 (F30) — con piu' righe per lo stesso scope vince quella attiva:
            // fino alla v1.7.0 vinceva l'ultima letta, anche se inattiva. Le righe
            // inattive restano nell'indice solo se lo scope non ne ha una attiva.
            var saActive = ('' + sa.getValue('active')) === 'true' || ('' + sa.getValue('active')) === '1';
            if (index.hasOwnProperty(scope) && index[scope].active && !saActive) { continue; }
            index[scope] = {
                active:          saActive,
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
            for (var rs0 in selectedScopes) { if (selectedScopes.hasOwnProperty(rs0) && index.hasOwnProperty(rs0)) { roots.push(rs0); } }
        } else {
            for (var allScope in index) {
                // Stesso insieme di _updatableApps: attive, con update, visibili (F30).
                if (index.hasOwnProperty(allScope) && index[allScope].active && index[allScope].updateAvailable && !index[allScope].hideOnUi) { roots.push(allScope); }
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
                if (!loadedScopes.hasOwnProperty(scopeList[i])) { loadedScopes[scopeList[i]] = true; todo.push(scopeList[i]); }
            }
            if (!todo.length) { return []; }
            var discovered = {};
            var av = new GlideRecord('sys_app_version');
            av.addQuery('scope', 'IN', todo.join(','));
            av.setLimit(20000);
            av.query();
            while (av.next()) {
                // v1.7.1 (O7) — '' + : valori Glide come stringhe JS; trim di scope,
                // versione e di ogni voce "scope:minVersion" della glide_list.
                var avScope = ('' + (av.getValue('scope') || '')).trim();
                var avVersion = ('' + (av.getValue('version') || '')).trim();
                if (!avScope || !avVersion) { continue; }
                var depsRaw = '' + (av.getValue('dependencies') || '');
                var deps = [];
                if (depsRaw) {
                    var depEntries = depsRaw.split(',');
                    for (var d = 0; d < depEntries.length; d++) {
                        var entry = depEntries[d];
                        var colon = entry.indexOf(':');
                        if (colon < 0) { continue; }
                        var depS = entry.substring(0, colon).trim(), depV = entry.substring(colon + 1).trim();
                        if (!depS) { continue; }
                        deps.push({ scope: depS, minVersion: depV });
                    }
                }
                versionIndex[avScope + '@' + avVersion] = deps;
                for (var dq = 0; dq < deps.length; dq++) { discovered[deps[dq].scope] = true; }
            }
            var outList = [];
            for (var dk in discovered) {
                if (discovered.hasOwnProperty(dk) && !loadedScopes.hasOwnProperty(dk)) { outList.push(dk); }
            }
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
            // v1.7.1 (F14) — fino alla v1.7.0 lo scope veniva marcato "visitato"
            // PRIMA del controllo di versione: una dipendenza raggiunta prima da un
            // arco gia' soddisfatto (X:1.0) non veniva piu' rivalutata quando un arco
            // successivo chiedeva una versione piu' alta (Y:2.0 -> X:2.0). Ora si
            // tiene la versione richiesta PIU' ALTA per scope: uno scope viene
            // rimesso in coda quando compare un minVersion maggiore, e il guard
            // anti-ciclo e' sulla coppia (scope, versione), non sul solo scope.
            var required = {};   // scope -> versione richiesta piu' alta finora
            var seenPair = {};   // "scope@versione" gia' accodato (guard anti-ciclo)
            seenPair[rootScope + '@' + rootEntry.latest] = true;
            // BFS from the root's OWN target version (its latest_version, i.e.
            // what this batch installs) down through each dependency's target.
            // No query here — `latest` already sits in the §6.7 in-memory index.
            var queue = [{ scope: rootScope, version: rootEntry.latest }];
            var rootNodes = {}, rootOrder = [];

            while (queue.length) {
                var node = queue.shift();
                if (!node.version) { continue; }
                var vKey = node.scope + '@' + node.version;
                if (!versionIndex.hasOwnProperty(vKey)) { continue; } // no sys_app_version row for that exact target — nothing to resolve further
                var deps = versionIndex[vKey];

                for (var di = 0; di < deps.length; di++) {
                    var dep = deps[di];
                    var depScope = dep.scope;
                    if (!depScope || depScope === rootScope) { continue; }
                    if (/^com\./.test(depScope)) { continue; } // platform plugin, not a Store app — not tracked here

                    if (!index.hasOwnProperty(depScope)) { continue; } // dependency scope not installed — not impact
                    var depEntry = index[depScope];

                    var cmpDep = this._cmpVer(dep.minVersion, depEntry.current);
                    if (cmpDep <= 0) { continue; } // already satisfies the target's requirement — stop, no recursion (mirrors the native processor)

                    // Gia' richiesto a una versione uguale o superiore: niente di nuovo.
                    if (required.hasOwnProperty(depScope) && this._cmpVer(dep.minVersion, required[depScope]) <= 0) { continue; }
                    required[depScope] = dep.minVersion;

                    if (!suiteMemberScopes[depScope]) {
                        var impactNode = {
                            scope:   depScope,
                            name:    depEntry.name,
                            current: depEntry.current,
                            target:  dep.minVersion,
                            hidden:  depEntry.hideOnUi
                        };
                        if (!rootNodes.hasOwnProperty(depScope)) { rootOrder.push(depScope); }
                        rootNodes[depScope] = impactNode;   // il target piu' alto vince
                        if (!unionNodes.hasOwnProperty(depScope) ||
                            this._cmpVer(impactNode.target, unionNodes[depScope].target) > 0) {
                            unionNodes[depScope] = impactNode;
                        }
                    }
                    var pKey = depScope + '@' + dep.minVersion;
                    if (!seenPair.hasOwnProperty(pKey)) {
                        seenPair[pKey] = true;
                        queue.push({ scope: depScope, version: dep.minVersion }); // recurse into ITS target's own deps
                    }
                }
            }

            var rootDeps = [];
            for (var ro = 0; ro < rootOrder.length; ro++) { rootDeps.push(rootNodes[rootOrder[ro]]); }
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
            for (var us in unionNodes) { if (unionNodes.hasOwnProperty(us) && !rootSet.hasOwnProperty(us)) { unionList.push(unionNodes[us]); } }
        } else {
            for (var us2 in unionNodes) { if (unionNodes.hasOwnProperty(us2)) { unionList.push(unionNodes[us2]); } }
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
    // scritto da noi e quindi non ambiguo (v1.7.1: x_npu.sync_runtime_state,
    // privata — vedi SYNC_STATE_PROP):
    //
    //   x_npu.sync_runtime_state = {"state":"running|done|error","startedAt":"...",
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
    // v1.7.1 (F33, decisione D7 — spec §18.7). Fino alla v1.7.0 lo stato stava in
    // x_npu.sync_state, scritta con gs.setProperty, e il job leggeva il proprio
    // sys_id da __npu_sync_job_id: entrambe le property finivano nell'update set
    // corrente dell'admin (misurato su Brazil Patch 2, 2026-11-12), quindi un admin
    // al lavoro nel proprio update set le avrebbe spedite con le sue modifiche.
    // Ora lo stato sta in una property NUOVA, creata con is_private=true ("exclude
    // this property from being imported via update sets", documentazione
    // ufficiale) e scritta/letta con GlideRecord. Evidenza sull'istanza: le
    // property private sn_appclient.apps_last_sync_time e apps_sync_progress,
    // riscritte dalla piattaforma a ogni sync, non hanno alcuna voce
    // sys_update_xml per quelle scritture. ignore_cache=true: la scrittura non
    // svuota la cache delle property del cluster (lo stato si legge sempre con
    // GlideRecord). La vecchia x_npu.sync_state non viene piu' scritta ne' letta,
    // e __npu_sync_job_id non serve piu' (F34: l'id del job e' nel suo script).
    SYNC_STATE_PROP:   'x_npu.sync_runtime_state',
    SYNC_LOCK_TTL_MS:  1800000, // 30 min: oltre, un 'running' e' considerato morto

    _readSyncState: function() {
        var p = new GlideRecord('sys_properties');
        if (!p.get('name', this.SYNC_STATE_PROP)) { return null; }
        var raw = '' + (p.getValue('value') || '');
        if (!raw) { return null; }
        try { return JSON.parse(raw); } catch (e) { return null; }
    },

    _writeSyncState: function(st) {
        try {
            var p = new GlideRecord('sys_properties');
            var exists = p.get('name', this.SYNC_STATE_PROP);
            if (!exists) {
                p.initialize();
                p.setValue('name', this.SYNC_STATE_PROP);
                p.setValue('type', 'string');
                p.setValue('description', 'Now Plugin Updater - Store sync state (runtime, private: not captured in update sets)');
            }
            p.setValue('is_private', true);
            p.setValue('ignore_cache', true);
            p.setValue('value', JSON.stringify(st));
            return !!(exists ? p.update() : p.insert());
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
        var locked = this._syncLocked();
        if (locked || this._syncRunning()) {
            var cur = this._readSyncState() || {};
            // v1.7.1 (F13) — sync avviata fuori da questa app (Application Manager):
            // il nostro lock non e' preso, quindi il suo startedAt e' quello di una
            // sync precedente. external:true dice al client di seguire la
            // percentuale della piattaforma invece del nostro esito.
            return JSON.stringify({
                queued: false, alreadyRunning: true, external: !locked,
                startedAt: locked ? (cur.startedAt || ('' + startedAt)) : ('' + startedAt),
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

        // v1.7.1 (F34) — il job viene creato INATTIVO con un segnaposto, poi lo
        // script riceve il PROPRIO sys_id e il job viene attivato. Fino alla v1.7.0
        // tutti i job condividevano __npu_sync_job_id: un job tardivo poteva
        // cancellare il record del job nuovo. Il job scrive l'esito solo se lo stato
        // e' ancora quello della SUA sync (stesso startedAt): un job scaduto non
        // sovrascrive la sync successiva.
        var job = new GlideRecord('sysauto_script');
        job.initialize();
        job.setValue('name', this.SYNC_JOB_NAME);
        job.setValue('script', '// Now Plugin Updater - one-shot Store sync (being created)');
        job.setValue('active', false);
        job.setValue('run_type', 'once');
        job.setValue('run_start', startedAt);
        job.setValue('run_as', gs.getUserID());
        job.setValue('conditional', false);
        var jobId = this._sysId(job.insert());

        if (jobId) {
            job.setValue('script', this._syncJobScript('' + startedAt, jobId));
            job.setValue('active', true);
            if (!job.update()) {
                gs.error('[PluginUpdater] syncStore: impossibile attivare il job ' + jobId);
                job.deleteRecord();
                jobId = '';
            }
        }

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

        gs.info('[PluginUpdater] syncStore: job one-shot ' + jobId + ' schedulato da ' + gs.getUserName());
        return JSON.stringify({
            queued:    true,
            jobId:     jobId,
            startedAt: '' + startedAt,
            lastSync:  prevSync
        });
    },

    // Script del job one-shot (v1.7.1). Scrive l'esito nella property privata con
    // GlideRecord (D7) solo se lo stato e' ancora quello della propria sync, e si
    // autocancella con il proprio sys_id incorporato (F34).
    _syncJobScript: function(startedAt, jobId) {
        var prop = this.SYNC_STATE_PROP;
        return ''
            + "// Now Plugin Updater - one-shot Store sync (creato da syncStore, v1.7.1)\n"
            + "(function () {\n"
            + "    var started = '" + startedAt + "', jobId = '" + jobId + "';\n"
            + "    function state(st, msg) {\n"
            + "        try {\n"
            + "            var p = new GlideRecord('sys_properties');\n"
            + "            if (!p.get('name', '" + prop + "')) { gs.warn('[PluginUpdater] sync state property missing'); return; }\n"
            + "            var cur = {};\n"
            + "            try { cur = JSON.parse('' + (p.getValue('value') || '{}')) || {}; } catch (eP) { cur = {}; }\n"
            + "            if (cur.startedAt !== started) { gs.warn('[PluginUpdater] sync job ' + jobId + ': state belongs to another sync, not overwritten'); return; }\n"
            + "            p.setValue('is_private', true);\n"
            + "            p.setValue('ignore_cache', true);\n"
            + "            p.setValue('value', JSON.stringify({\n"
            + "                state: st, startedAt: started,\n"
            + "                finishedAt: '' + new GlideDateTime(),\n"
            + "                message: msg || '', by: '' + gs.getUserName()\n"
            + "            }));\n"
            + "            p.update();\n"
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
            + "    // B3 — il job one-shot si rimuove da se'.\n"
            + "    try {\n"
            + "        var me = new GlideRecord('sysauto_script');\n"
            + "        if (me.get(jobId)) { me.deleteRecord(); }\n"
            + "    } catch (e2) { gs.warn('[PluginUpdater] self-cleanup del job di sync fallito: ' + e2); }\n"
            + "})();\n";
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

        // La piattaforma sta ancora lavorando? L'arbitro e' il nostro stato, ma
        // v1.7.1 (F13): una sync avviata dall'Application Manager non scrive il
        // nostro stato. Se la piattaforma e' in corsa (apps_sync_progress > 0) e il
        // nostro stato non e' 'running', la sync e' esterna: outcome 'running',
        // external true, e il client chiude quando la percentuale torna a 0.
        var external = false;
        if (outcome !== 'running' && this._syncRunning()) { outcome = 'running'; external = true; message = ''; }
        var running = (outcome === 'running');

        return JSON.stringify({
            pct:        running ? pct : (outcome === 'done' ? 100 : pct),
            running:    running,
            external:   external,
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
        if (!apps || !apps.length) { return JSON.stringify({ error: 'no apps', batch: '', rows: [], skipped: [] }); }

        // v1.7.1 (F15) — le app oltre il tetto non vengono piu' troncate in silenzio:
        // sono riportate in `skipped` e il client non le lancia. Prima il client
        // lanciava comunque ogni app selezionata, anche senza riga di log.
        var CAP = 1000, skipped = [];
        for (var c = CAP; c < apps.length; c++) {
            skipped.push({ sysId: this._sysId((apps[c] || {}).sysId), name: '' + ((apps[c] || {}).name || ''), reason: 'over the ' + CAP + '-application limit of one batch' });
        }
        if (apps.length > CAP) { apps = apps.slice(0, CAP); }

        // v1.7.1 (F15) — nome, scope, versione corrente e target vengono dal record
        // sys_store_app validato, non dal client. Una sola query per tutte le app.
        var ids = [];
        for (var k = 0; k < apps.length; k++) { var vid = this._sysId((apps[k] || {}).sysId); if (vid) { ids.push(vid); } }
        var store = {};
        if (ids.length) {
            var sa = new GlideRecord('sys_store_app');
            sa.addQuery('sys_id', 'IN', ids.join(','));
            sa.setLimit(CAP);
            sa.query();
            while (sa.next()) {
                store['' + sa.getUniqueValue()] = {
                    name:    '' + (sa.getValue('name') || ''),
                    scope:   '' + (sa.getValue('scope') || ''),
                    current: '' + (sa.getValue('version') || ''),
                    latest:  '' + (sa.getValue('latest_version') || ''),
                    ok:      ('' + sa.getValue('active')) === '1' || ('' + sa.getValue('active')) === 'true'
                };
            }
        }
        // v1.7.1 (F03) — un'app con una riga attiva (queued/installing) in un
        // QUALSIASI batch non viene accodata due volte.
        var busy = {};
        if (ids.length) {
            var bz = new GlideRecord('u_plugin_updater_install_log');
            bz.addQuery('u_store_app_id', 'IN', ids.join(','));
            bz.addQuery('u_status', 'IN', this.ACTIVE_STATUSES);
            bz.setLimit(CAP);
            bz.query();
            while (bz.next()) { busy['' + bz.getValue('u_store_app_id')] = true; }
        }

        // u_session_id è un campo da 32 char: la chiave va tenuta corta con margine.
        // Timestamp in base36 (~8 char per i prossimi secoli) + 8 char di user id
        // => 'b_' + 8 + '_' + 8 = 19 char, contro i 28 della v1.3.7.
        // Number(...) forza il long Java di getNumericValue() a un numero JS prima
        // di toString(36) — su Rhino il metodo nativo del long non è affidabile.
        var batchKey = 'b_' + Number(new GlideDateTime().getNumericValue()).toString(36) +
                       '_' + ('' + gs.getUserID()).substring(0, 8);
        var now = new GlideDateTime();
        var rows = [], queuedIds = {};
        for (var i = 0; i < apps.length; i++) {
            var a = apps[i] || {};
            var sid = this._sysId(a.sysId), rec = sid ? store[sid] : null;
            var label = rec ? rec.name : ('' + (a.name || '')).substring(0, 255);
            var why = '';
            if (!rec) { why = 'application record not found'; }
            else if (!rec.ok) { why = 'application is not active'; }
            else if (!rec.latest || this._cmpVer(rec.latest, rec.current) <= 0) { why = 'no update available any more'; }
            else if (busy.hasOwnProperty(sid) || queuedIds.hasOwnProperty(sid)) { why = 'already queued or installing'; }
            if (why) { skipped.push({ sysId: sid, name: label, reason: why }); continue; }
            var gr = new GlideRecord('u_plugin_updater_install_log');
            gr.initialize();
            gr.setValue('u_app_name',         rec.name.substring(0, 255));
            gr.setValue('u_app_scope',        rec.scope.substring(0, 100));
            gr.setValue('u_store_app_id',     sid);
            gr.setValue('u_previous_version', rec.current.substring(0, 40));
            gr.setValue('u_target_version',   rec.latest.substring(0, 40));
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
            var logId = gr.insert();
            if (!this._sysId(logId)) {
                gs.error('[PluginUpdater] createBatch: insert failed for app ' + sid + ' in batch ' + batchKey);
                skipped.push({ sysId: sid, name: label, reason: 'the install log row could not be created' });
                continue;
            }
            queuedIds[sid] = true;
            // target: il client lancia la versione validata qui, non la sua copia.
            rows.push({ sysId: sid, logSysId: '' + logId, target: rec.latest });
        }
        if (skipped.length) {
            gs.info('[PluginUpdater] createBatch batch=' + batchKey + ' queued=' + rows.length + ' skipped=' + skipped.length);
        }
        if (!rows.length) {
            return JSON.stringify({ error: 'None of the selected applications could be queued.', batch: '', total: 0, rows: [], skipped: skipped });
        }
        return JSON.stringify({ batch: batchKey, total: rows.length, rows: rows, skipped: skipped });
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
        // v1.7.0 — stato della coda di installazione in versione leggera
        // ({ status, waiting }): con la coda sana costa una query su sys_padlock e
        // una GlideAggregate su sys_nowmq_message. Fallisce in modo indipendente.
        try { out.queueHealth = this._queueHealth(false); }
        catch (e3) { out.queueHealth = { status: 'unavailable', waiting: 0 }; out.queueHealthError = '' + e3; }
        return JSON.stringify(out);
    },

    // -----------------------------------------------------------------------
    // cancelRemaining — param: batch. Annulla le righe ancora in attesa che la
    // piattaforma NON ha ancora preso in carico.
    //
    // v1.7.1 (F09, decisione D4) — l'annullamento tocca solo il log: non esiste
    // un'API verificata per togliere un'operazione dalla coda della piattaforma
    // (§19.12). Quindi:
    //   - riga con progress id il cui worker o tracker radice e' pending/running:
    //     resta 'queued' (o diventa 'installing') e viene contata in
    //     alreadyQueued / alreadyStarted — si installera' comunque;
    //   - worker gia' finale: esito con la stessa regola di _reconcile (versione
    //     installata come arbitro), non 'cancelled';
    //   - riga in lancio dal browser (claim recente, F05): non si tocca
    //     (launching), il browser la salta da solo se non l'ha ancora inviata;
    //   - solo le righe senza progress id, o senza worker ne' tracker, diventano
    //     'cancelled'. La scrittura e' condizionata (_casRow): se nel frattempo la
    //     riga e' cambiata, non viene sovrascritta.
    // -----------------------------------------------------------------------
    cancelRemaining: function() {
        if (!this._guard()) { return this._forbidden(); }
        var batch = ('' + (this.getParameter('sysparm_batch') || this.getParameter('batch') || '')).trim();
        if (!batch) { return JSON.stringify({ ok: false, error: 'batch required', cancelled: 0 }); }
        var rows = this._activeRows(batch, 'queued');
        var ops = this._loadOps(this._pidsOf(rows));
        var verifyCache = this._loadVersions(this._appIdsOf(rows));
        var res = { ok: true, cancelled: 0, alreadyQueued: 0, alreadyStarted: 0, installed: 0, failed: 0, launching: 0, changed: 0 };
        var nowMs = new GlideDateTime().getNumericValue(), who = '' + gs.getUserName();
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.pid && this._claimFresh(r.msg, nowMs)) { res.launching++; continue; }
            var v = this._verify(r.appId, r.target, verifyCache);
            if (r.target && v.matches) {
                if (this._casRow(r, { u_status: 'complete', u_error_message: '', u_percent_complete: 100, u_completed_at: new GlideDateTime() })) { res.installed++; }
                else { res.changed++; }
                continue;
            }
            var op = r.pid ? this._opState(r.pid, ops) : null;
            if (op && op.active) {
                // Gia' presa in carico dalla piattaforma: non annullabile.
                if (op.state === 'running') {
                    this._casRow(r, { u_status: 'installing' });
                    res.alreadyStarted++;
                } else {
                    res.alreadyQueued++;
                }
                continue;
            }
            if (op && op.final) {
                // Worker/tracker gia' chiuso sotto il target: stesso esito di _reconcile (SI-B4).
                if (this._casRow(r, { u_status: 'failed', u_error_message: this._failMessage(op, v, r.target),
                                      u_percent_complete: 100, u_completed_at: new GlideDateTime() })) { res.failed++; }
                else { res.changed++; }
                continue;
            }
            if (this._casRow(r, { u_status: 'cancelled', u_error_message: 'Cancelled by ' + who + ' before the install started',
                                  u_percent_complete: 100, u_completed_at: new GlideDateTime() })) { res.cancelled++; }
            else { res.changed++; }
        }
        res.kept = res.alreadyStarted + res.installed;   // campo della v1.7.0, per compatibilita'
        gs.info('[PluginUpdater] cancelRemaining batch=' + batch + ' cancelled=' + res.cancelled + ' alreadyQueued=' + res.alreadyQueued +
                ' alreadyStarted=' + res.alreadyStarted + ' installed=' + res.installed + ' failed=' + res.failed +
                ' launching=' + res.launching + ' changed=' + res.changed);
        return JSON.stringify(res);
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
                // v1.7.1 (F05) — il claim di lancio e' un marcatore interno: in UI
                // diventa una frase leggibile.
                message:    this._isClaim(gr.getValue('u_error_message')) ? 'Being launched from the browser.' : ('' + (gr.getValue('u_error_message') || '')),
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

    // =======================================================================
    // v1.7.1 — stato delle righe di log: lettura, scrittura condizionata, claim
    // =======================================================================
    LOG_TABLE:       'u_plugin_updater_install_log',
    // F05 — claim di lancio. Variante senza modifiche allo schema (decisione v1.7.1,
    // spec §18.7): la riga resta 'queued' e u_error_message porta questo prefisso
    // con l'ora UTC del claim. Un claim piu' vecchio di CLAIM_TTL_MS e' considerato
    // abbandonato (tab chiuso durante il lancio): il watchdog del client chiude
    // ogni lancio entro 120 s.
    CLAIM_PREFIX:    'Launching: claimed by the browser at ',
    CLAIM_TTL_MS:    600000,
    // F24 — oltre questa inattivita' di worker, tracker radice e albero, una riga
    // non finale viene chiusa con la regola della versione.
    ROW_STALE_HOURS: 24,

    // Istantanea di una riga (stringhe JS). E' la base delle scritture condizionate.
    _snap: function(gr) {
        return {
            id:      '' + gr.getUniqueValue(),
            status:  '' + (gr.getValue('u_status') || 'queued'),
            msg:     '' + (gr.getValue('u_error_message') || ''),
            pid:     this._sysId(gr.getValue('u_progress_id')),
            appId:   this._sysId(gr.getValue('u_store_app_id')),
            target:  '' + (gr.getValue('u_target_version') || ''),
            batch:   '' + (gr.getValue('u_session_id') || ''),
            started: '' + (gr.getValue('u_started_at') || ''),
            pct:     parseInt(gr.getValue('u_percent_complete'), 10) || 0
        };
    },
    _rowSnap: function(logSysId) {
        var gr = new GlideRecord(this.LOG_TABLE);
        return (logSysId && gr.get(logSysId)) ? this._snap(gr) : null;
    },
    // Righe di un batch (o di tutti, batch='') negli stati indicati. F26: ordinate
    // per sys_updated_on, cosi' il setLimit non affama sempre le stesse righe.
    _activeRows: function(batch, statusCsv, limit) {
        var out = [], gr = new GlideRecord(this.LOG_TABLE);
        gr.addQuery('u_status', 'IN', statusCsv || this.ACTIVE_STATUSES);
        if (batch) { gr.addQuery('u_session_id', batch); }
        gr.orderBy('sys_updated_on');
        gr.setLimit(limit || 2000);
        gr.query();
        while (gr.next()) { out.push(this._snap(gr)); }
        return out;
    },
    _pidsOf: function(rows) { var o = []; for (var i = 0; i < rows.length; i++) { if (rows[i].pid) { o.push(rows[i].pid); } } return o; },
    _appIdsOf: function(rows) { var o = []; for (var i = 0; i < rows.length; i++) { if (rows[i].appId) { o.push(rows[i].appId); } } return o; },

    // Scrittura condizionata (F05, F08, F25): aggiorna la riga SOLO se stato e
    // messaggio sono ancora quelli letti nell'istantanea. updateMultiple esegue un
    // unico UPDATE con quella condizione, quindi due scrittori concorrenti (job,
    // Refresh now, Cancel queued, browser) non si sovrascrivono a vicenda.
    // Restituisce true se la riga riletta porta i valori scritti.
    _casRow: function(r, set) {
        var g = new GlideRecord(this.LOG_TABLE);
        g.addQuery('sys_id', r.id);
        g.addQuery('u_status', r.status);
        if (r.msg) { g.addQuery('u_error_message', r.msg); } else { g.addNullQuery('u_error_message'); }
        for (var k in set) { if (set.hasOwnProperty(k)) { g.setValue(k, set[k]); } }
        g.updateMultiple();
        var after = this._rowSnap(r.id);
        if (!after) { return false; }
        var wantStatus = set.hasOwnProperty('u_status') ? '' + set.u_status : r.status;
        if (after.status !== wantStatus) { return false; }
        if (set.hasOwnProperty('u_error_message') && after.msg !== ('' + set.u_error_message).substring(0, 1000)) { return false; }
        if (set.hasOwnProperty('u_progress_id') && after.pid !== this._sysId(set.u_progress_id)) { return false; }
        return true;
    },
    // La scrittura cambierebbe qualcosa? (O1: niente update a vuoto ogni minuto)
    _differs: function(r, set) {
        for (var k in set) {
            if (!set.hasOwnProperty(k)) { continue; }
            if (k === 'u_status') { if (r.status !== '' + set[k]) { return true; } }
            else if (k === 'u_percent_complete') { if (r.pct !== (parseInt(set[k], 10) || 0)) { return true; } }
            else if (k === 'u_error_message') { if (r.msg !== '' + set[k]) { return true; } }
            else { return true; }
        }
        return false;
    },

    _isClaim: function(msg) { return ('' + (msg || '')).indexOf(this.CLAIM_PREFIX) === 0; },
    _claimTimeMs: function(msg) {
        if (!this._isClaim(msg)) { return 0; }
        var m = ('' + msg).substring(this.CLAIM_PREFIX.length).match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        return m ? new GlideDateTime(m[1]).getNumericValue() : 0;
    },
    _claimFresh: function(msg, nowMs) {
        var t = this._claimTimeMs(msg);
        return !!t && (nowMs - t) < this.CLAIM_TTL_MS;
    },

    // -----------------------------------------------------------------------
    // claimRow — param: log_sys_id. v1.7.1 (F05). Il browser lo chiama subito
    // prima di ogni POST CICD: porta la riga da "in attesa" a "in lancio" in modo
    // atomico e rifiuta se la riga non e' piu' lanciabile (annullata da Cancel
    // queued, gia' lanciata, gia' finale). Il client salta le righe rifiutate.
    // -----------------------------------------------------------------------
    claimRow: function() {
        if (!this._guard()) { return this._forbidden(); }
        var id = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        if (!id) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var r = this._rowSnap(id);
        if (!r) { return JSON.stringify({ ok: false, error: 'log row not found' }); }
        if (r.status !== 'queued') { return JSON.stringify({ ok: false, reason: 'status changed', status: r.status }); }
        if (r.pid) { return JSON.stringify({ ok: false, reason: 'already launched', status: r.status }); }
        if (this._isClaim(r.msg)) { return JSON.stringify({ ok: false, reason: 'already claimed', status: r.status }); }
        var marker = this.CLAIM_PREFIX + new GlideDateTime().getValue() + ' UTC';
        if (!this._casRow(r, { u_error_message: marker })) {
            var now = this._rowSnap(id);
            return JSON.stringify({ ok: false, reason: 'status changed', status: now ? now.status : '' });
        }
        return JSON.stringify({ ok: true });
    },

    // -----------------------------------------------------------------------
    // findLaunch — param: log_sys_id. v1.7.1 (F07). Dopo un errore di rete sulla
    // POST il browser non sa se la piattaforma ha accodato l'install (risposta
    // persa). Prima di riprovare chiede qui: se la riga ha gia' un progress id, o
    // se esiste un'operazione di install radice per la stessa app creata dopo il
    // claim (sys_execution_tracker, type sys.applifecycle.operation, creata alla
    // POST — verificato su Brazil Patch 2), la registra sulla riga e risponde
    // found:true, e il browser NON ripete la POST.
    // -----------------------------------------------------------------------
    findLaunch: function() {
        if (!this._guard()) { return this._forbidden(); }
        var id = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        if (!id) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var r = this._rowSnap(id);
        if (!r) { return JSON.stringify({ ok: false, error: 'log row not found' }); }
        if (r.pid) { return JSON.stringify({ ok: true, found: true, progressId: r.pid, status: r.status }); }
        if (!r.appId) { return JSON.stringify({ ok: true, found: false }); }
        var tr = new GlideRecord('sys_execution_tracker');
        if (!tr.isValid() || !tr.isValidField('detail_message') || !tr.isValidField('type')) {
            return JSON.stringify({ ok: true, found: false, unknown: true });
        }
        var fromMs = this._claimTimeMs(r.msg) || new GlideDateTime(r.started).getNumericValue();
        var from = new GlideDateTime();
        from.setNumericValue(fromMs - 120000);   // margine per orologi di nodi diversi
        tr.addNullQuery('parent');
        tr.addQuery('type', this.QH_SUBJECT);
        tr.addQuery('detail_message', 'CONTAINS', 'app=' + r.appId);
        tr.addQuery('sys_created_on', '>=', from);
        tr.orderByDesc('sys_created_on');
        tr.setLimit(1);
        tr.query();
        if (!tr.next()) { return JSON.stringify({ ok: true, found: false }); }
        var pid = '' + tr.getUniqueValue();
        if (r.status === 'queued') {
            this._casRow(r, { u_progress_id: pid, u_error_message: this._isClaim(r.msg) ? '' : r.msg });
        }
        gs.info('[PluginUpdater] findLaunch: row ' + id + ' matched operation ' + pid + ' (response lost in the browser)');
        return JSON.stringify({ ok: true, found: true, progressId: pid });
    },

    // attachWorker — UPDATE ONLY: registra il worker sulla riga di log.
    //
    // v1.6.3 (B1) — lo stato viene riportato a 'queued' SOLO se la riga e' ancora
    // in attesa. Fino alla v1.6.2 la scrittura era incondizionata: se il monitor
    // job (che gira ogni minuto) girava fra la POST CICD e questa chiamata, una
    // riga gia' 'complete' o 'failed' tornava 'queued', il batch non chiudeva mai
    // e la riga riappariva in coda dopo essere finita.
    // v1.7.1 — toglie anche il claim di lancio (F05): la riga ora ha un worker.
    attachWorker: function() {
        if (!this._guard()) { return this._forbidden(); }
        var logSysId = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        var pid      = this._sysId(this.getParameter('sysparm_progress_id') || this.getParameter('progress_id'));
        if (!logSysId) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var gr = new GlideRecord(this.LOG_TABLE);
        if (!gr.get(logSysId)) { return JSON.stringify({ ok: false, error: 'log row not found' }); }

        gr.setValue('u_progress_id', pid);
        var cur = '' + (gr.getValue('u_status') || 'queued');
        if (cur === 'queued' || cur === 'in_progress') {
            gr.setValue('u_status', 'queued');
            if (this._isClaim(gr.getValue('u_error_message'))) { gr.setValue('u_error_message', ''); }
        } else {
            gs.info('[PluginUpdater] attachWorker: riga ' + logSysId + ' gia\' in stato "' +
                    cur + '", stato preservato (worker registrato comunque)');
        }
        gr.update();
        return JSON.stringify({ ok: true, status: '' + gr.getValue('u_status') });
    },

    // failRow — UPDATE ONLY: segna 'failed' una riga il cui lancio e' fallito.
    // v1.7.1 (F08) — scrive SOLO se la riga e' ancora 'queued' (anche con il claim
    // di lancio). Fino alla v1.7.0 sovrascriveva qualsiasi stato, anche 'complete'.
    failRow: function() {
        if (!this._guard()) { return this._forbidden(); }
        var logSysId = this._sysId(this.getParameter('sysparm_log_sys_id') || this.getParameter('log_sys_id'));
        var msg = ('' + (this.getParameter('sysparm_message') || this.getParameter('message') || 'Failed to launch')).substring(0, 1000);
        if (!logSysId) { return JSON.stringify({ ok: false, error: 'valid log_sys_id required' }); }
        var r = this._rowSnap(logSysId);
        if (!r) { return JSON.stringify({ ok: false, error: 'log row not found' }); }
        if (r.status !== 'queued') { return JSON.stringify({ ok: false, reason: 'status changed', status: r.status }); }
        var ok = this._casRow(r, { u_status: 'failed', u_error_message: msg, u_percent_complete: 100, u_completed_at: new GlideDateTime() });
        return JSON.stringify(ok ? { ok: true } : { ok: false, reason: 'status changed' });
    },

    // failRows — params: log_sys_ids (CSV), message. v1.7.1 (D6). Sessione scaduta
    // durante il lancio: il browser si ferma e segna in UNA chiamata le righe non
    // lanciate. Tocca solo righe 'queued' senza progress id.
    failRows: function() {
        if (!this._guard()) { return this._forbidden(); }
        var raw = ('' + (this.getParameter('sysparm_log_sys_ids') || this.getParameter('log_sys_ids') || '')).split(',');
        var msg = ('' + (this.getParameter('sysparm_message') || this.getParameter('message') || 'Not launched')).substring(0, 1000);
        var ids = [];
        for (var i = 0; i < raw.length && ids.length < 1000; i++) { var v = this._sysId(raw[i]); if (v) { ids.push(v); } }
        if (!ids.length) { return JSON.stringify({ ok: true, failed: 0, skipped: 0 }); }
        var gr = new GlideRecord(this.LOG_TABLE);
        gr.addQuery('sys_id', 'IN', ids.join(','));
        gr.setLimit(1000);
        gr.query();
        var rows = [];
        while (gr.next()) { rows.push(this._snap(gr)); }
        var failed = 0, skipped = ids.length - rows.length;
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            if (r.status !== 'queued' || r.pid) { skipped++; continue; }
            if (this._casRow(r, { u_status: 'failed', u_error_message: msg, u_percent_complete: 100, u_completed_at: new GlideDateTime() })) { failed++; }
            else { skipped++; }
        }
        gs.info('[PluginUpdater] failRows by=' + gs.getUserName() + ' failed=' + failed + ' skipped=' + skipped);
        return JSON.stringify({ ok: true, failed: failed, skipped: skipped });
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
    //
    // v1.7.1:
    //   O1  worker, tracker e versioni sono letti con query "sys_id IN" per tutto
    //       il giro (prima: due get() per riga), e una riga viene scritta solo se
    //       qualcosa cambia (prima: update() di ogni riga ogni minuto);
    //   F25 ogni scrittura e' condizionata allo stato letto (_casRow): job e
    //       Refresh now non si annullano piu' a vicenda per un ciclo;
    //   F26 righe ordinate per sys_updated_on;
    //   F27 senza worker, 'complete' richiede una versione target;
    //   F24 worker non finale ma tracker radice Failed/Cancelled, o nessun
    //       progresso per ROW_STALE_HOURS: esito con la regola della versione;
    //   N2  percentuale dal tracker radice quando quella del worker e' vuota;
    //   F08 nuovo passaggio di riverifica delle righe 'failed' recenti;
    //   F09 il passaggio sulle 'cancelled' copre senza limite di eta' le righe
    //       con progress id, ordinate per u_completed_at.
    _reconcile: function(batchFilter) {
        // v1.6.3 (B2) — NON si filtra piu' su u_progress_id NOT NULL. Una riga
        // senza worker (tab chiuso durante il lancio, POST riuscita ma risposta
        // persa, failRow mai eseguita) non veniva guardata da nessun ciclo del
        // job: restava 'queued' per sempre, il batch restava 'running' a vita e
        // getActiveBatch continuava a restituirlo. Ora entra nel ciclo e viene
        // valutata come le altre: verifica di versione, poi timeout.
        var rows = this._activeRows(batchFilter, this.ACTIVE_STATUSES, 2000);
        var ops = this._loadOps(this._pidsOf(rows));
        var verifyCache = this._loadVersions(this._appIdsOf(rows));
        var checked = 0, finalized = 0, nowMs = new GlideDateTime().getNumericValue(), batchLast = {};
        // Is the platform install queue still active? While any CICD install worker
        // is pending/running, the single-flight queue is draining — never time out
        // waiting rows (avoids false "did not start" on large/slow batches).
        var qa = new GlideAggregate('sys_progress_worker');
        qa.addQuery('name', 'CICDAppRepoService$CICDInstallWorker');
        qa.addQuery('state', 'IN', 'pending,running');
        qa.addAggregate('COUNT');
        qa.query();
        var queueActive = qa.next() ? ((parseInt(qa.getAggregate('COUNT'), 10) || 0) > 0) : false;

        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], set = null, isFinal = false;
            checked++;
            var op = r.pid ? this._opState(r.pid, ops) : null;
            if (!op) {
                // Worker not found. Under the single-flight CICD install queue the
                // worker is created only when this app's turn comes, so a missing
                // worker usually means "not started yet", not a failure.
                // 1) Source of truth: if the app already reached the target version,
                //    the install succeeded and the worker simply rotated away.
                //    F27: serve un target dichiarato.
                var ver = this._verify(r.appId, r.target, verifyCache);
                if (r.target && ver.matches) {
                    set = { u_status: 'complete', u_error_message: '', u_percent_complete: 100, u_completed_at: new GlideDateTime() };
                    isFinal = true;
                } else if (queueActive) {
                    // 2) Not installed yet. While the install queue is still active
                    //    (any CICD worker pending/running), keep waiting — never fail.
                    set = null;
                } else if (!r.pid && this._claimFresh(r.msg, nowMs)) {
                    // Il browser sta lanciando questa riga adesso (F05).
                    set = null;
                } else {
                    // 3) Queue is idle: fail only if the batch has made no progress for
                    //    >60 min (genuinely stalled / install never enqueued).
                    if (!batchLast.hasOwnProperty(r.batch)) { batchLast[r.batch] = this._batchLastActivityMs(r.batch); }
                    var refMs = batchLast[r.batch] || new GlideDateTime(r.started).getNumericValue();
                    if (refMs && (nowMs - refMs) > 3600000) {
                        set = { u_status: 'failed', u_percent_complete: 100, u_completed_at: new GlideDateTime(),
                                u_error_message: r.pid
                                    ? 'Timed out: install did not start (install queue idle, no progress for 60 minutes)'
                                    : 'Timed out: the install was never launched (no progress worker was ever attached to this row)' };
                        isFinal = true;
                    }
                }
            } else if (op.final) {
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
                // raggiunto il target, l'update non è stato applicato. Vale anche per
                // worker/tracker failed, error o cancelled (v1.6.6).
                var v = this._verify(r.appId, r.target, verifyCache);
                set = v.matches
                    ? { u_status: 'complete', u_error_message: '' }
                    : { u_status: 'failed', u_error_message: this._failMessage(op, v, r.target) };
                set.u_percent_complete = 100;
                set.u_completed_at = new GlideDateTime();
                isFinal = true;
            } else {
                // pending / running / sconosciuto
                var staleMs = this.ROW_STALE_HOURS * 3600000;
                // Solo 'running': un'operazione 'pending' puo' attendere a lungo in una
                // coda lenta o bloccata (quel caso lo segnala la scheda della coda).
                if (op.state === 'running' && op.updatedMs && (nowMs - op.updatedMs) > staleMs) {
                    // F24 — nessun progresso su worker e tracker radice: guardo l'intero
                    // albero (i figli si aggiornano anche quando la radice no).
                    var tree = this._opTree(r.pid);
                    var lastMs = (tree && tree.lastUpdated) ? new GlideDateTime(tree.lastUpdated).getNumericValue() : op.updatedMs;
                    if ((nowMs - lastMs) > staleMs) {
                        var vs = this._verify(r.appId, r.target, verifyCache);
                        set = (r.target && vs.matches)
                            ? { u_status: 'complete', u_error_message: '' }
                            : { u_status: 'failed', u_error_message: ('No progress for ' + this.ROW_STALE_HOURS + ' h on the platform install (' +
                                op.state + '): ' + this._failMessage(op, vs, r.target)).substring(0, 1000) };
                        set.u_percent_complete = 100;
                        set.u_completed_at = new GlideDateTime();
                        isFinal = true;
                    }
                }
                if (!set) {
                    set = { u_status: (op.state === 'running') ? 'installing' : 'queued' };
                    if (op.pct) { set.u_percent_complete = op.pct; }
                }
            }
            if (set && this._differs(r, set) && this._casRow(r, set) && isFinal) { finalized++; }
        }

        finalized += this._reverifyPass('cancelled', batchFilter, verifyCache);
        finalized += this._reverifyPass('failed', batchFilter, verifyCache);
        gs.info('[PluginUpdater] monitorBatches checked=' + checked + ' finalized=' + finalized);
        return checked + ':' + finalized;
    },

    // Riverifica delle righe finali che la versione installata puo' smentire (§10.1).
    //   cancelled (v1.6.6, F09) — l'annullamento tocca solo il log: un'operazione
    //       gia' accodata puo' installarsi comunque. Righe chiuse nelle ultime 6 h,
    //       piu' TUTTE quelle con progress id (nessun limite di eta').
    //   failed (v1.7.1, F08) — una riga segnata 'failed' dal browser (lancio
    //       dato per fallito, risposta persa) la cui app poi si installa. Righe
    //       chiuse nelle ultime 6 h, con una versione target.
    // Se la versione target risulta installata la riga diventa 'complete'.
    _reverifyPass: function(status, batchFilter, verifyCache) {
        var rows = [], seen = {}, self = this;
        function collect(withPid) {
            var g = new GlideRecord(self.LOG_TABLE);
            g.addQuery('u_status', status);
            g.addNotNullQuery('u_target_version');
            if (withPid) { g.addNotNullQuery('u_progress_id'); }
            else { g.addQuery('u_completed_at', '>=', gs.hoursAgo(6)); }
            if (batchFilter) { g.addQuery('u_session_id', batchFilter); }
            g.orderByDesc('u_completed_at');
            g.setLimit(200);
            g.query();
            while (g.next()) {
                var s = self._snap(g);
                if (!seen.hasOwnProperty(s.id)) { seen[s.id] = true; rows.push(s); }
            }
        }
        collect(false);
        if (status === 'cancelled') { collect(true); }
        var missing = [];
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].appId && !verifyCache.hasOwnProperty(rows[i].appId)) { missing.push(rows[i].appId); }
        }
        var more = this._loadVersions(missing);
        for (var m in more) { if (more.hasOwnProperty(m)) { verifyCache[m] = more[m]; } }
        var n = 0;
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            var v = this._verify(r.appId, r.target, verifyCache);
            if (r.target && v.matches && this._casRow(r, { u_status: 'complete', u_error_message: '' })) { n++; }
        }
        return n;
    },

    // Worker CICD e tracker radice per un insieme di progress id, in query
    // "sys_id IN" a blocchi (O1). sys_progress_worker e sys_execution_tracker
    // condividono il sys_id del nodo radice (misurato).
    _loadOps: function(pids) {
        var res = { w: {}, t: {} };
        var uniq = [], seen = {};
        for (var i = 0; i < pids.length; i++) {
            var p = this._sysId(pids[i]);
            if (p && !seen.hasOwnProperty(p)) { seen[p] = true; uniq.push(p); }
        }
        for (var c = 0; c < uniq.length; c += 400) {
            var chunk = uniq.slice(c, c + 400).join(',');
            var w = new GlideRecord('sys_progress_worker');
            w.addQuery('sys_id', 'IN', chunk);
            w.query();
            while (w.next()) {
                res.w['' + w.getUniqueValue()] = {
                    state:   '' + (w.getValue('state') || ''),
                    message: '' + (w.getValue('message') || ''),
                    error:   '' + (w.getValue('error_message') || ''),
                    pct:     parseInt(w.getValue('percent_complete'), 10) || 0,
                    updated: '' + (w.getValue('sys_updated_on') || '')
                };
            }
            var t = new GlideRecord('sys_execution_tracker');
            t.addQuery('sys_id', 'IN', chunk);
            t.query();
            while (t.next()) {
                res.t['' + t.getUniqueValue()] = {
                    state:   '' + (t.getValue('state') || ''),
                    message: '' + (t.getValue('message') || ''),
                    pct:     parseInt(t.getValue('percent_complete'), 10) || 0,
                    updated: '' + (t.getValue('sys_updated_on') || '')
                };
            }
        }
        return res;
    },

    // Stato combinato worker + tracker radice di un'operazione, o null se
    // nessuno dei due esiste. state: pending|running|complete|success|failed|
    // error|cancelled. active/final ne derivano.
    //   v1.6.6 — senza worker vale il tracker (install fallita prima di partire).
    //   v1.7.1 (F24) — worker ancora pending/running ma tracker radice Failed o
    //   Cancelled (es. dopo uno sblocco della coda): vale il tracker.
    //   v1.7.1 — worker gia' finale ma tracker radice ancora pending/running:
    //   l'installazione sta ancora lavorando, quindi 'running'.
    //   v1.7.1 (N2) — percentuale del tracker quando quella del worker manca.
    _opState: function(pid, ops) {
        var w = ops.w.hasOwnProperty(pid) ? ops.w[pid] : null;
        var t = ops.t.hasOwnProperty(pid) ? ops.t[pid] : null;
        if (!w && !t) { return null; }
        var names = this._trackerStates().name;
        var tName = t ? (names[t.state] || '') : '';
        if (tName === 'successful') { tName = 'complete'; }
        var tFinal = (tName === 'complete' || tName === 'failed' || tName === 'cancelled');
        var tActive = (tName === 'pending' || tName === 'running');
        var state;
        if (w) {
            state = w.state.toLowerCase();
            var wActive = (state === 'pending' || state === 'running');
            if (wActive && (tName === 'failed' || tName === 'cancelled')) { state = tName; }
            else if (!wActive && tActive) { state = 'running'; }
        } else {
            state = tName;
        }
        var updated = '';
        if (w && w.updated > updated) { updated = w.updated; }
        if (t && t.updated > updated) { updated = t.updated; }
        return {
            id:          pid,
            source:      w ? 'worker' : 'tracker',
            state:       state,
            active:      (state === 'pending' || state === 'running'),
            final:       (state === 'complete' || state === 'success' || state === 'failed' || state === 'error' || state === 'cancelled'),
            message:     w ? w.message : (t ? t.message : ''),
            error:       w ? w.error : '',
            pct:         (w && w.pct) ? w.pct : (t ? t.pct : 0),
            trackerFail: (t && tFinal && tName !== 'complete') ? t.message.trim() : '',
            updatedMs:   updated ? new GlideDateTime(updated).getNumericValue() : 0
        };
    },

    // Versione installata per un insieme di sys_store_app (O1): appId -> versione,
    // o null se il record non esiste. E' la cache usata da _verify.
    _loadVersions: function(appIds) {
        var cache = {}, uniq = [];
        for (var i = 0; i < appIds.length; i++) {
            var a = this._sysId(appIds[i]);
            if (a && !cache.hasOwnProperty(a)) { cache[a] = null; uniq.push(a); }
        }
        for (var c = 0; c < uniq.length; c += 400) {
            var g = new GlideRecord('sys_store_app');
            g.addQuery('sys_id', 'IN', uniq.slice(c, c + 400).join(','));
            g.query();
            while (g.next()) { cache['' + g.getUniqueValue()] = '' + (g.getValue('version') || ''); }
        }
        return cache;
    },

    // _findWorker — stato di un singolo worker/tracker (stessa logica di _opState).
    // v1.6.3 (B5): niente state_code — vedi il commento in _reconcile sul perche'
    // state_code NON e' utilizzabile come criterio di esito.
    _findWorker: function(pid) {
        pid = this._sysId(pid);
        if (!pid) { return null; }
        return this._opState(pid, this._loadOps([pid]));
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
        var st = this._trackerStates(), s = '' + tr.getValue('state');
        if (s !== st.v.failed && s !== st.v.cancelled) { return ''; }
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
            // v1.7.1 (O1) — _opState porta gia' il messaggio del tracker radice.
            m = w.hasOwnProperty('trackerFail') ? w.trackerFail : this._trackerFailure(w.id);
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

    // =======================================================================
    // v1.7.0 — Salute della coda di installazione della piattaforma (§4.6)
    //
    // PERCHE'
    // La piattaforma esegue le operazioni di installazione (CICD, App Repository)
    // da una coda NowMQ (subject sys.applifecycle.operation), una alla volta. Ogni
    // operazione chiede dei lock di risorsa su sys_padlock, con
    // lock_key = 'r*' + <sys_id del tracker radice>. Se il thread di
    // un'installazione muore a meta', i suoi padlock restano: ogni operazione in
    // coda viene ritentata circa una volta al secondo senza ottenerli mai, e
    // tutte le installazioni restano Queued. Osservato su Brazil: circa 3 giorni,
    // fino allo sblocco manuale (tracker dell'albero a Failed, cancellazione dei
    // soli padlock con quella lock_key; la coda e' ripartita entro un minuto).
    //
    // COSA FA
    //   getQueueHealth()         sola lettura: stato della coda e proprietari dei lock
    //   releaseStuckOperation()  solo su richiesta esplicita dell'admin: ripete TUTTE
    //                            le verifiche, salva un backup, porta a Failed i
    //                            tracker Running/Pending dell'albero e cancella SOLO i
    //                            padlock con lock_key 'r*<radice>'
    //
    // COSA NON FA, MAI
    //   - niente di automatico: nessun job chiama questi metodi;
    //   - non tocca i messaggi NowMQ, i latch e gli altri padlock con lock_key
    //     vuota o diversa, i tracker fuori dall'albero, i trigger;
    //   - non termina transazioni e non riavvia nodi.
    //
    // LIMITI
    //   - da script server non si puo' sapere se il thread e' vivo
    //     (v_cluster_transaction restituisce 0 righe): per questo la conferma
    //     "nessuna transazione attiva" e' un parametro OBBLIGATORIO dell'API,
    //     che l'admin attesta dopo aver controllato Active Transactions;
    //   - tabelle e campi sono interni e non documentati: se mancano, lo stato e'
    //     'unavailable' e lo sblocco rifiuta.
    // =======================================================================

    QH_SUBJECT:       'sys.applifecycle.operation',
    QH_HOURS_PROP:    'x_npu.stuck_op_hours', // opzionale, non nell'update set (§18.6)
    QH_HOURS_DEFAULT: 6,
    QH_HOURS_MIN:     1,     // valori piu' bassi nella proprieta' vengono alzati a 1
    QH_TREE_DEPTH:    8,
    QH_TREE_CAP:      500,   // oltre, l'albero non e' verificabile: niente sblocco
    QH_LOCK_CAP:      100,
    QH_OWNER_CAP:     10,
    QH_BACKUP_PREFIX: 'npu_release_backup_',
    QH_SCHEMA: {
        sys_padlock:           ['resource_type', 'resource_id', 'lock_key'],
        sys_execution_tracker: ['state', 'parent', 'node', 'type', 'message', 'detail_message', 'percent_complete'],
        sys_nowmq_message:     ['subject', 'state', 'attempt_count', 'sequence', 'queue_expiration', 'last_attempted', 'body']
    },

    // -----------------------------------------------------------------------
    // getQueueHealth — sola lettura. Restituisce:
    // { status: healthy|busy|blocked|unavailable, waiting, thresholdHours,
    //   checkedAt, releasable, queue:{byState,maxAttempts,oldest}, owners:[...],
    //   ownersTruncated, reason? }
    //   healthy     nessun padlock 'r*' (le operazioni in coda vengono servite)
    //   busy        padlock 'r*' di un albero aggiornato entro la soglia
    //   blocked     padlock 'r*' di un albero fermo oltre la soglia, anche senza
    //               messaggi in attesa: il lock blocchera' la prossima install
    //   unavailable tabelle o campi attesi assenti (altra release), o eccezione
    // releasable dice solo se lo sblocco puo' essere proposto: il server rifa'
    // comunque tutte le verifiche in releaseStuckOperation.
    // -----------------------------------------------------------------------
    getQueueHealth: function() {
        if (!this._guard()) { return this._forbidden(); }
        try { return JSON.stringify(this._queueHealth(true)); }
        catch (e) {
            gs.warn('[PluginUpdater] getQueueHealth failed: ' + e);
            return JSON.stringify({ status: 'unavailable', reason: 'error', error: '' + e, waiting: 0, owners: [], releasable: false });
        }
    },

    // -----------------------------------------------------------------------
    // releaseStuckOperation — params: tracker_id, confirm_no_active_tx ('true').
    // Equivalente server dello sblocco manuale: verifiche, backup, tracker a
    // Failed, cancellazione dei soli padlock 'r*<tracker_id>'. Idempotente: se
    // l'operazione non possiede piu' lock risponde { ok:true, released:false }.
    // -----------------------------------------------------------------------
    releaseStuckOperation: function() {
        if (!this._guard()) { return this._forbidden(); }
        var id = this._sysId(this.getParameter('sysparm_tracker_id') || this.getParameter('tracker_id'));
        var ack = ('' + (this.getParameter('sysparm_confirm_no_active_tx') || this.getParameter('confirm_no_active_tx') || '')).trim();
        if (!id) { return JSON.stringify({ ok: false, released: false, error: 'tracker_id required' }); }
        if (ack !== 'true') {
            return JSON.stringify({ ok: false, released: false,
                error: 'Confirmation required: check Active Transactions first and confirm that no transaction of this install is still running.' });
        }
        try { return JSON.stringify(this._releaseStuck(id)); }
        catch (e) {
            gs.error('[PluginUpdater] releaseStuckOperation tracker=' + id + ' by=' + gs.getUserName() + ' failed: ' + e);
            return JSON.stringify({ ok: false, released: false, error: '' + e });
        }
    },

    // Corpo di getQueueHealth (detail=true) e della versione leggera usata da
    // getHomeData (detail=false: solo { status, waiting }).
    _queueHealth: function(detail) {
        var hours = this._stuckHours();
        var res = { status: 'healthy', waiting: 0 };
        var miss = this._qhSchemaMissing();
        if (miss.length) {
            res.status = 'unavailable';
            if (detail) {
                res.reason = 'This release does not expose the expected install-queue tables or fields (missing: ' + miss.join(', ') + ').';
                res.thresholdHours = hours; res.owners = []; res.releasable = false;
            }
            return res;
        }
        var q = this._qhMessages(detail);
        res.waiting = q.waiting;
        var owners = this._qhLockOwners(detail, hours);
        var stale = false, releasable = false;
        for (var i = 0; i < owners.list.length; i++) {
            if (owners.list[i].stale) { stale = true; }
            if (owners.list[i].releasable) { releasable = true; }
        }
        if (owners.list.length) { res.status = stale ? 'blocked' : 'busy'; }
        if (detail) {
            res.thresholdHours = hours;
            res.checkedAt = '' + new GlideDateTime().getDisplayValue();
            res.queue = q;
            res.owners = owners.list;
            res.ownersTruncated = owners.truncated;
            res.releasable = releasable;
        }
        return res;
    },

    // Tabelle e campi attesi (verificati su Brazil). Restituisce cio' che manca.
    _qhSchemaMissing: function() {
        var miss = [];
        for (var t in this.QH_SCHEMA) {
            if (!this.QH_SCHEMA.hasOwnProperty(t)) { continue; }
            var gr = new GlideRecord(t);
            if (!gr.isValid()) { miss.push(t); continue; }
            var f = this.QH_SCHEMA[t];
            for (var i = 0; i < f.length; i++) {
                if (!gr.isValidField(f[i])) { miss.push(t + '.' + f[i]); }
            }
        }
        return miss;
    },

    // Soglia in ore oltre la quale un albero senza aggiornamenti e' "fermo".
    // La proprieta' e' opzionale: non e' nell'update set, perche' ogni release e'
    // un set completo e la riporterebbe al default a ogni upgrade.
    _stuckHours: function() {
        var h = parseFloat(gs.getProperty(this.QH_HOURS_PROP, '' + this.QH_HOURS_DEFAULT));
        if (isNaN(h)) { h = this.QH_HOURS_DEFAULT; }
        return (this.QH_HOURS_MIN > h) ? this.QH_HOURS_MIN : h;
    },

    // Valori di sys_execution_tracker.state letti da sys_choice (lingua en),
    // come lo sblocco manuale; i default sono quelli osservati su Brazil.
    _trackerStates: function() {
        if (this._qhStates) { return this._qhStates; }
        var v = { pending: '0', running: '1', successful: '2', failed: '3', cancelled: '4' };
        var c = new GlideRecord('sys_choice');
        c.addQuery('name', 'sys_execution_tracker');
        c.addQuery('element', 'state');
        c.addQuery('language', 'en');
        c.setLimit(20);
        c.query();
        while (c.next()) {
            var k = ('' + c.getValue('label')).toLowerCase();
            if (v.hasOwnProperty(k)) { v[k] = '' + c.getValue('value'); }
        }
        var name = {};
        for (var n in v) { if (v.hasOwnProperty(n)) { name[v[n]] = n; } }
        this._qhStates = { v: v, name: name };
        return this._qhStates;
    },
    // Etichetta leggibile di uno stato del tracker ("Failed"), per i messaggi.
    _stateLabel: function(value, st) {
        var n = st.name['' + value];
        return n ? (n.charAt(0).toUpperCase() + n.substring(1)) : ('state ' + value);
    },

    // Ore trascorse da un datetime interno (UTC); -1 se vuoto. Non arrotondato:
    // i confronti con la soglia usano il valore esatto, la UI quello arrotondato.
    _ageHours: function(utc) {
        if (!utc) { return -1; }
        return (new GlideDateTime().getNumericValue() - new GlideDateTime('' + utc).getNumericValue()) / 3600000;
    },
    _round1: function(h) { return Math.round(h * 10) / 10; },
    // Durata leggibile per i messaggi: minuti sotto l'ora, ore con un decimale sopra.
    _fmtHours: function(h) { return (1 > h) ? (Math.max(0, Math.round(h * 60)) + ' min') : (this._round1(h) + ' h'); },

    // Copia di un record in un oggetto (solo campi valorizzati): forma del backup.
    _recordToObj: function(gr) {
        var o = { _table: '' + gr.getTableName() }, els = gr.getElements(), n = els.size ? els.size() : els.length;
        for (var i = 0; i < n; i++) {
            var el = els.get ? els.get(i) : els[i], name = '' + el.getName(), val = gr.getValue(name);
            if (val !== null && val !== '') { o[name] = '' + val; }
        }
        return o;
    },

    // detail_message del tracker radice, es.
    // "operation=app_install, app=<sys_id sys_store_app>, version=1.2.3, baseVersion=null, ..."
    _parseOpDetail: function(dm) {
        dm = '' + (dm || '');
        function pick(k) {
            var m = dm.match(new RegExp('(?:^|,)\\s*' + k + '=([^,]*)'));
            var s = m ? ('' + m[1]).trim() : '';
            return s === 'null' ? '' : s;
        }
        var app = pick('app');
        return { operation: pick('operation'), appId: /^[0-9a-f]{32}$/i.test(app) ? app : '', version: pick('version') };
    },

    // Albero dei tracker sotto una radice, un livello per query (come
    // _dependencyTreeForBatch). truncated=true se supera QH_TREE_CAP o
    // QH_TREE_DEPTH: in quel caso l'albero non e' verificabile per intero.
    _opTree: function(rootId) {
        var root = new GlideRecord('sys_execution_tracker');
        if (!root.get(rootId)) { return null; }
        var nodes = [{ sysId: rootId, state: '' + root.getValue('state'), updated: '' + root.getValue('sys_updated_on') }];
        var seen = {}, frontier = [rootId], truncated = false;
        seen[rootId] = true;
        for (var depth = 0; depth < this.QH_TREE_DEPTH && frontier.length && !truncated; depth++) {
            var gr = new GlideRecord('sys_execution_tracker');
            gr.addQuery('parent', 'IN', frontier.join(','));
            gr.setLimit(this.QH_TREE_CAP + 1);
            gr.query();
            var next = [];
            while (gr.next()) {
                var id = gr.getUniqueValue();
                if (seen[id]) { continue; }
                if (nodes.length >= this.QH_TREE_CAP) { truncated = true; break; }
                seen[id] = true;
                nodes.push({ sysId: id, state: '' + gr.getValue('state'), updated: '' + gr.getValue('sys_updated_on') });
                next.push(id);
            }
            frontier = next;
        }
        if (!truncated && frontier.length) {
            // profondita' esaurita: se c'e' ancora un livello sotto, non lo conosciamo
            var more = new GlideRecord('sys_execution_tracker');
            more.addQuery('parent', 'IN', frontier.join(','));
            more.setLimit(1);
            more.query();
            truncated = more.hasNext();
        }
        var last = '';
        for (var i = 0; i < nodes.length; i++) { if (nodes[i].updated > last) { last = nodes[i].updated; } }
        return { root: root, nodes: nodes, lastUpdated: last, truncated: truncated };
    },

    // Messaggi della coda NowMQ delle operazioni. waiting = non DELIVERED.
    _qhMessages: function(detail) {
        var out = { waiting: 0 };
        var ga = new GlideAggregate('sys_nowmq_message');
        ga.addQuery('subject', this.QH_SUBJECT);
        ga.addAggregate('COUNT');
        if (detail) { ga.addAggregate('MAX', 'attempt_count'); }
        ga.groupBy('state');
        ga.query();
        var byState = {}, maxAtt = 0;
        while (ga.next()) {
            var st = '' + ga.getValue('state'), n = parseInt(ga.getAggregate('COUNT'), 10) || 0;
            byState[st] = n;
            if (st === 'DELIVERED') { continue; }
            out.waiting += n;
            if (detail) {
                var a = parseInt(ga.getAggregate('MAX', 'attempt_count'), 10) || 0;
                if (a > maxAtt) { maxAtt = a; }
            }
        }
        if (!detail) { return out; }
        out.byState = byState;
        out.maxAttempts = maxAtt;
        out.oldest = null;
        if (out.waiting > 0) {
            var h = new GlideRecord('sys_nowmq_message');
            h.addQuery('subject', this.QH_SUBJECT);
            h.addQuery('state', '!=', 'DELIVERED');
            h.orderBy('sequence');
            h.setLimit(1);
            h.query();
            if (h.next()) {
                var body = '' + (h.getValue('body') || '');
                out.oldest = {
                    since:         this._fmtDateTime(h.getValue('sys_created_on')),
                    attempts:      parseInt(h.getValue('attempt_count'), 10) || 0,
                    lastAttempted: this._fmtDateTime(h.getValue('last_attempted')),
                    expires:       this._fmtDateTime(h.getValue('queue_expiration')),
                    trackerId:     (body.match(/"sys_execution_tracker_id"\s*:\s*"([0-9a-f]{32})"/) || [])[1] || ''
                };
            }
        }
        return out;
    },

    // Padlock di operazione (lock_key 'r*'), raggruppati per proprietario.
    // I padlock con lock_key vuota o diversa (latch di cluster, sys_repo_config,
    // ...) non vengono nemmeno letti.
    _qhLockOwners: function(detail, hours) {
        var st = this._trackerStates();
        var p = new GlideRecord('sys_padlock');
        p.addQuery('lock_key', 'STARTSWITH', 'r*');
        p.orderBy('sys_created_on');
        p.setLimit(this.QH_LOCK_CAP);
        p.query();
        var byKey = {}, keys = [];
        while (p.next()) {
            var k = '' + p.getValue('lock_key');
            // hasOwnProperty, non !byKey[k]: nel Rhino dello scope global un array
            // vuoto e' falsy (verificato su Brazil), quindi mai testare un array.
            if (!byKey.hasOwnProperty(k)) { byKey[k] = []; keys.push(k); }
            byKey[k].push({
                sysId:    p.getUniqueValue(),
                type:     '' + (p.getValue('resource_type') || ''),
                resource: '' + (p.getValue('resource_id') || ''),
                created:  '' + (p.getValue('sys_created_on') || ''),
                updated:  '' + (p.getValue('sys_updated_on') || '')
            });
        }
        var list = [];
        for (var i = 0; i < keys.length && this.QH_OWNER_CAP > list.length; i++) {
            list.push(this._qhLockOwner(keys[i].substring(2), byKey[keys[i]], detail, hours, st));
        }
        return { list: list, truncated: keys.length > list.length };
    },

    // Un proprietario di lock. stale = albero E lock fermi oltre la soglia.
    // releasable = stale + radice Running di un'operazione di install + albero
    // verificabile per intero. Altrimenti reason spiega perche' non si propone.
    _qhLockOwner: function(rawId, locks, detail, hours, st) {
        var o = { trackerId: rawId, lockCount: locks.length, state: 'missing', stale: false, releasable: false, reason: '' };
        var newestLock = '', oldestLock = '';
        for (var j = 0; j < locks.length; j++) {
            var t = (locks[j].updated > locks[j].created) ? locks[j].updated : locks[j].created;
            if (t > newestLock) { newestLock = t; }
            if (!oldestLock || oldestLock > locks[j].created) { oldestLock = locks[j].created; }
        }
        var lockAge = this._ageHours(newestLock);
        var id = this._sysId(rawId);
        var tree = id ? this._opTree(id) : null;
        if (!tree) {
            o.stale = lockAge >= hours;
            o.reason = id ? 'The operation that holds the lock no longer exists. Release it manually (see the README).'
                          : 'Unrecognised lock owner.';
        } else {
            var root = tree.root, rs = '' + root.getValue('state'), idle = this._ageHours(tree.lastUpdated);
            o.state = st.name[rs] || ('state ' + rs);
            o.idleHours = this._round1(idle);
            o.treeSize = tree.nodes.length;
            o.toFail = 0;
            for (var n = 0; n < tree.nodes.length; n++) {
                if (tree.nodes[n].state === st.v.running || tree.nodes[n].state === st.v.pending) { o.toFail++; }
            }
            o.stale = (idle >= hours) && (lockAge >= hours);
            if (!o.stale) {
                o.reason = '';
            } else if (rs !== st.v.running) {
                o.reason = 'The operation that holds the lock is ' + this._stateLabel(rs, st) +
                           ', not running. Release it manually (see the README).';
            } else if (('' + (root.getValue('parent') || '')).length) {
                o.reason = 'The lock owner is not the root of an operation.';
            } else if ('' + root.getValue('type') !== this.QH_SUBJECT) {
                o.reason = 'The lock owner is not an application install operation.';
            } else if (tree.truncated) {
                o.reason = 'The operation is too large to verify (more than ' + this.QH_TREE_CAP + ' trackers).';
            } else {
                o.releasable = true;
            }
            if (detail) {
                var d = this._parseOpDetail(root.getValue('detail_message'));
                o.lastUpdated = this._fmtDateTime(tree.lastUpdated);
                o.node = '' + (root.getValue('node') || '');
                o.percent = parseInt(root.getValue('percent_complete'), 10) || 0;
                o.operation = d.operation;
                o.appId = d.appId;
                o.version = d.version;
                o.app = '';
                if (d.appId) {
                    var a = new GlideRecord('sys_store_app');
                    if (a.get(d.appId)) { o.app = '' + (a.getValue('name') || ''); o.scope = '' + (a.getValue('scope') || ''); }
                }
                o.message = ('' + (root.getValue('message') || '')).substring(0, 300);
            }
        }
        if (detail) {
            o.lockedSince = this._fmtDateTime(oldestLock);
            o.lockAgeHours = this._round1(lockAge);
            o.locks = [];
            for (var q = 0; q < locks.length; q++) { o.locks.push({ type: locks[q].type, resource: locks[q].resource }); }
        }
        return o;
    },

    // Verifiche dello sblocco, in sola lettura. Usato da _releaseStuck e
    // richiamabile da script per una prova a secco. Restituisce:
    //   { ok:true, nothing:true, message }   nessun lock: niente da fare
    //   { ok:false, error }                  una verifica non e' passata
    //   { ok:true, rootId, key, hours, toFail[], locks[], lastUpdated, detail }
    _releasePlan: function(id) {
        var NOTHING = ' Nothing was changed.';
        var miss = this._qhSchemaMissing();
        if (miss.length) { return { ok: false, error: 'Not available on this release (missing: ' + miss.join(', ') + ').' + NOTHING }; }
        var hours = this._stuckHours(), st = this._trackerStates(), key = 'r*' + id;
        var locks = [];
        var p = new GlideRecord('sys_padlock');
        p.addQuery('lock_key', key);
        p.setLimit(this.QH_LOCK_CAP);
        p.query();
        while (p.next()) { locks.push(this._recordToObj(p)); }
        if (!locks.length) { return { ok: true, nothing: true, message: 'Nothing to release: this operation holds no resource lock.' }; }

        var tree = this._opTree(id);
        if (!tree) { return { ok: false, error: 'The operation tracker was not found.' + NOTHING }; }
        var root = tree.root, rs = '' + root.getValue('state');
        if (('' + (root.getValue('parent') || '')).length) { return { ok: false, error: 'The tracker is not the root of the operation.' + NOTHING }; }
        if ('' + root.getValue('type') !== this.QH_SUBJECT) { return { ok: false, error: 'The tracker is not an application install operation.' + NOTHING }; }
        if (rs !== st.v.running) { return { ok: false, error: 'The operation is not running (state: ' + this._stateLabel(rs, st) + ').' + NOTHING }; }
        if (tree.truncated) { return { ok: false, error: 'The operation is too large to verify (more than ' + this.QH_TREE_CAP + ' trackers).' + NOTHING }; }
        var toFail = [];
        for (var i = 0; i < tree.nodes.length; i++) {
            var age = this._ageHours(tree.nodes[i].updated);
            if (hours > age) {
                return { ok: false, error: 'A tracker of this operation was updated ' + this._fmtHours(age) + ' ago (threshold ' +
                         hours + ' h): the install may still be alive.' + NOTHING };
            }
            if (tree.nodes[i].state === st.v.running || tree.nodes[i].state === st.v.pending) { toFail.push(tree.nodes[i].sysId); }
        }
        for (var j = 0; j < locks.length; j++) {
            var lu = locks[j].sys_updated_on || '', lc = locks[j].sys_created_on || '';
            var lAge = this._ageHours(lu > lc ? lu : lc);
            if (hours > lAge) {
                return { ok: false, error: 'A lock of this operation is only ' + this._fmtHours(lAge) + ' old (threshold ' + hours + ' h).' + NOTHING };
            }
        }
        return { ok: true, rootId: id, key: key, hours: hours, toFail: toFail, locks: locks, treeSize: tree.nodes.length,
                 lastUpdated: tree.lastUpdated, detail: this._parseOpDetail(root.getValue('detail_message')) };
    },

    // Sblocco vero e proprio: verifiche (_releasePlan), backup, tracker a
    // Failed, cancellazione dei padlock con la lock_key esatta, verifica finale.
    // Senza backup salvato non si modifica nulla.
    _releaseStuck: function(id) {
        // '' + : le API Glide restituiscono stringhe Java. Su una stringa Java,
        // replace() con una regex e' ambiguo e lancia un InternalError (CP4).
        var user = '' + gs.getUserName();
        var plan = this._releasePlan(id);
        if (plan.ok && plan.nothing) {
            gs.info('[PluginUpdater] releaseStuckOperation tracker=' + id + ' by=' + user + ': nothing to release');
            return { ok: true, released: false, message: plan.message };
        }
        if (!plan.ok) {
            gs.warn('[PluginUpdater] releaseStuckOperation tracker=' + id + ' by=' + user + ' refused: ' + plan.error);
            return { ok: false, released: false, error: plan.error };
        }
        var st = this._trackerStates(), now = '' + new GlideDateTime().getValue();

        // 1. Backup: solo i record che verranno modificati o cancellati.
        var trackers = [];
        for (var i = 0; i < plan.toFail.length; i++) {
            var t = new GlideRecord('sys_execution_tracker');
            if (t.get(plan.toFail[i])) { trackers.push(this._recordToObj(t)); }
        }
        var backup = {
            _note: 'Now Plugin Updater - backup taken before releaseStuckOperation. trackers_to_fail are shown with their state ' +
                   'before the change; padlocks_to_delete are the deleted sys_padlock records.',
            taken_utc: now, by: user, threshold_hours: plan.hours, root: id, lock_key: plan.key,
            trackers_to_fail: trackers, padlocks_to_delete: plan.locks
        };
        var fileName = this.QH_BACKUP_PREFIX + now.replace(/[^0-9]/g, '') + '.json';
        var attId = '';
        try {
            var rootGr = new GlideRecord('sys_execution_tracker');
            if (rootGr.get(id)) { attId = '' + (new GlideSysAttachment().write(rootGr, fileName, 'application/json', JSON.stringify(backup)) || ''); }
        } catch (eB) {
            gs.error('[PluginUpdater] releaseStuckOperation tracker=' + id + ' backup error: ' + eB);
        }
        if (!this._sysId(attId)) {
            gs.error('[PluginUpdater] releaseStuckOperation tracker=' + id + ' by=' + user + ': backup not saved, nothing changed');
            return { ok: false, released: false, error: 'The backup could not be saved, so nothing was changed.' };
        }

        // 2. Tracker Running/Pending dell'albero -> Failed, con un messaggio esplicativo.
        var note = ('Marked Failed by Now Plugin Updater (' + user + ', ' + now + ' UTC): no progress since ' + plan.lastUpdated +
                    ' UTC and its resource locks were blocking the install queue. Backup: ' + fileName + ' on this tracker.').substring(0, 4000);
        var failed = 0, failErr = 0;
        for (var k = 0; k < plan.toFail.length; k++) {
            var u = new GlideRecord('sys_execution_tracker');
            if (!u.get(plan.toFail[k])) { failErr++; continue; }
            var s = '' + u.getValue('state');
            if (s !== st.v.running && s !== st.v.pending) { continue; } // cambiato nel frattempo: non lo tocco
            u.setValue('state', st.v.failed);
            u.setValue('message', note);
            if (u.update()) { failed++; } else { failErr++; }
        }

        // 3. Solo i padlock con la lock_key esatta (alcuni possono essere gia'
        //    stati rilasciati dalla piattaforma al passo 2).
        var del = 0, delErr = 0;
        var p = new GlideRecord('sys_padlock');
        p.addQuery('lock_key', plan.key);
        p.setLimit(this.QH_LOCK_CAP);
        p.query();
        while (p.next()) {
            p.setWorkflow(false);
            if (p.deleteRecord()) { del++; } else { delErr++; }
        }

        // 4. Verifica finale.
        var ga = new GlideAggregate('sys_padlock');
        ga.addQuery('lock_key', plan.key);
        ga.addAggregate('COUNT');
        ga.query();
        var left = ga.next() ? (parseInt(ga.getAggregate('COUNT'), 10) || 0) : 0;

        gs.info('[PluginUpdater] releaseStuckOperation tracker=' + id + ' by=' + user + ' app=' + plan.detail.appId +
                ' version=' + plan.detail.version + ' idleSince=' + plan.lastUpdated + 'Z trackersFailed=' + failed + '/' +
                plan.toFail.length + ' locksDeleted=' + del + '/' + plan.locks.length + ' locksLeft=' + left +
                ' backup=sys_attachment:' + attId);
        return {
            ok: left === 0 && failErr === 0 && delErr === 0, released: true,
            trackersFailed: failed, trackersExpected: plan.toFail.length, trackerErrors: failErr,
            locksDeleted: del, locksExpected: plan.locks.length, locksLeft: left, lockErrors: delErr,
            backupId: attId, backupFile: fileName,
            message: left === 0 ? 'The blocked operation was released. Queued installs should start within a minute or two.'
                                : (left + ' lock(s) could not be released. Check the system log for [PluginUpdater].')
        };
    },

    type: 'PluginUpdaterAjax'
});
