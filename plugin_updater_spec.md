# Now Plugin Updater — Technical & Functional Specification

**Application:** Now Plugin Updater · **Author:** Gianmario Marongiu
**Scope:** ServiceNow custom application, **global scope**
**Delivery model:** one **no-build UI Page** + one client-callable **Script Include** + one custom table + one Scheduled Job. No bundler, no Fluent SDK, no React, no UI Script, no external libraries.
**Audience:** developers (and Claude Code) maintaining the app on a ServiceNow instance via MCP.

> **Current state (2026-10-15).** Shipped release **v1.6.6** (`NowPluginUpdater166.xml`, 59 objects), **certified on the Brazil family** (`empgmarongiu1`, build `glide-brazil-08-25-2026__patch1-09-21-2026_10-05-2026_1244`, §18.5). It is composed of:
>
> - **UI Page** `pgi_plugin_updater` — client **v1.6.6** (`S.version='1.6.6'`). Identical to `src/ui_page/pgi_plugin_updater.xhtml` (99,994 chars, Guide corrected in the re-cut, §19.7).
> - **Script Include** `PluginUpdaterAjax` — server **v1.6.6**. Identical to `src/script_include/PluginUpdaterAjax.js` (73,544 chars). §19.1 is closed.
>
> Both were verified byte for byte against the records installed from the final `NowPluginUpdater166.xml` (367,720 bytes, remote set `0360940c…`, built on the published 1.6.5 lineage, §12.2; includes the tracker failure reason, §19.13) on 2026-10-15. On the **from-scratch** import of `empgmarongiu1` the preview gave 59 / inserted 59 / updated 0 / collisions 0 (§12.4). On the **upgrade from the published 1.6.5** on `democrmfalectriae163723` it gave 59 / updated 53 / inserted 6 / collisions 0. Both were committed. §19 lists the gaps that are still open. **Read §19 before changing anything.**
>
> Where this document says "server", it describes the **v1.6.6 Script Include**. The update set and `src/` now agree.

---

## 1. Goal

A single admin screen to **discover, select, and batch-install** available updates for **ServiceNow Store applications** on the instance. It replaces the one-app-at-a-time flow of the native Application Manager. It must:

- show instance identity (name, release, data center, DB, last upgrade, last Store sync) and app counters;
- drive updates through a 3-step wizard (Discover → Select → Launch), with the same **dependency impact** visibility the native *Review Installation Details* dialog offers;
- trigger installs **without stored credentials** (the admin's own session);
- keep monitoring **server-side**, so the page can be closed after launch;
- decide the outcome of each install **only from the installed version**;
- keep an **install history** (per-batch log table) browsable from the Monitor;
- trigger a **Store sync** ("Sync now" parity) with real progress.

Out of scope: platform plugins (`v_plugin` / `com.*`), rollback, scheduling, notifications, multi-instance (§17).

---

## 2. Hard architectural constraints (why the first build failed)

These are root causes of the prior, non-working implementation. Do not reintroduce them.

1. **No React multi-file SPA, no bundler.** A UI Page cannot run a build step at serve time. The UI is one Jelly fragment containing static HTML, `#app`-scoped CSS and a single vanilla-JS IIFE.
2. **No Fluent / `*.now.ts`.** Every artifact is a native instance record (created via MCP), packaged in a classic update set.
3. **No stored credentials, no Base64 "encryption", no server-side REST loopback.** Installs are triggered **client-side** with the logged-in admin's session (§7).
4. **One data path.** Every read and every log write goes through `PluginUpdaterAjax` via GlideAjax. There is no REST Table API fallback. (`sys_store_app` returns HTTP 403 to the Table API even for admins, so it is only readable server-side.)
5. **Instance version is not `glide.war`.** Use the parsing chain in §5.2.
6. **UI layer is vanilla JS only.** No Alpine, no petite-vue, no UI Script (decision §18.0-3).
7. **CSS under `#app`, prefix `.npu-`, never a `.modal` class** (Next Experience/Polaris defines `.modal{display:none}`). The single deliberate exception is `html,body{background:#f5f5f7}` (§14.9).
8. **Server code is ES5** (Rhino). Client code is ES5-style too (no build), using `fetch`/`Promise` natively.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ UI Page pgi_plugin_updater (Jelly fragment, no build)             │
│  <style> tokens + #app-scoped CSS                                 │
│  <div id="app"> nav · views · #modal-host                         │
│  <script> vanilla IIFE — state S, view switching, event delegation│
│  Views: home · wizard1 · wizard2 · wizard3 · monitor · guide      │
├──────────────────────────────────────────────────────────────────┤
│ READS/LOG WRITES → GlideAjax('PluginUpdaterAjax') → JSON strings  │
│ INSTALL          → fetch POST /api/sn_cicd/app_repo/install       │
│                    same-origin session + X-UserToken (g_ck)       │
├──────────────────────────────────────────────────────────────────┤
│ Script Include PluginUpdaterAjax (client_callable, global)        │
│  extends AbstractAjaxProcessor · every method admin-guarded       │
├──────────────────────────────────────────────────────────────────┤
│ Table u_plugin_updater_install_log  (one row per app per batch)   │
├──────────────────────────────────────────────────────────────────┤
│ Scheduled Job "Plugin Updater - Monitor Batches" (every 1 min)    │
│  → PluginUpdaterAjax.monitorBatches() finalizes rows server-side  │
│ Scheduled Job "Plugin Updater - Store Sync (once)" (on demand)    │
│  → sn_appclient.UpdateChecker.checkAvailableUpdates(...)          │
├──────────────────────────────────────────────────────────────────┤
│ Platform tables read: sys_store_app, sys_app_version,             │
│  sys_suite_config, sys_suite_config_app_version_m2m,              │
│  sys_progress_worker, sys_execution_tracker, sys_cluster_state,   │
│  sys_upgrade_history · properties glide.*, sn_appclient.*         │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 Component inventory (update set v1.6.6 — 59 objects)

The object list is unchanged from v1.6.5: v1.6.6 only changes the `script` of the Script Include and the `html` of the UI Page. On the from-scratch install of 2026-10-15 all 9 ACL-role rows resolved to `admin`, with no `snc_internal` fallback (§12.2, §19.6).

| # | Type | Record | Key attributes |
|---|---|---|---|
| 1 | UI Page | `pgi_plugin_updater` | category `general`, no client/processing script; everything is in `html` |
| 1 | Script Include | `PluginUpdaterAjax` (`global.PluginUpdaterAjax`) | `client_callable=true`, `active=true`, `sandbox_callable=false`, access `package_private` |
| 1 | Table | `u_plugin_updater_install_log` ("Plugin Updater Install Log") | not extendable, `access=public`, `ws_access=true` |
| 22 | Dictionary | 15 custom columns + collection + 6 `sys_*` | see §9 |
| 16 | Field Label (`sys_documentation`, en) | table + 15 columns | |
| 1 | Choice list | `u_status` | `queued`, `in_progress`, `complete`, `failed` — **see §19.4** |
| 5 | ACL | `u_plugin_updater_install_log` create/read/write/delete (type `record`); `pgi_plugin_updater` read (type `record`, **see §19.5**) | all `active`, `admin_overrides=true`, decision `allow` |
| 9 | ACL Role | `sys_security_acl_role` → role `admin` (`2831a114c611228501d4ea6c309d626d`) | 4 install-log ACLs are bound twice (harmless duplicates, §19.6) |
| 1 | Application Menu | `Now Plugin Updater` | `roles=admin`, order 100, device `browser` |
| 1 | Module | `Plugin Updater` | `roles=admin`, link type `DIRECT`, target `now/nav/ui/classic/params/target/pgi_plugin_updater.do` |
| 1 | Scheduled Script | `Plugin Updater - Monitor Batches` | `run_type=periodically`, period 1 min, `run_as` = `admin` user (`6816f79c…e441`), active |

Created **at runtime** (not in the update set):

- system property `x_npu.sync_state` (JSON Store-sync state, §11.2);
- system property `__npu_sync_job_id` (sys_id of the latest one-shot sync job);
- Scheduled Script `Plugin Updater - Store Sync (once)` (one per sync; deletes itself);
- the `sys_trigger` of `Plugin Updater - Monitor Batches` (created by the platform when the job is committed).

Created **by the platform** when the table is created, and deleted with it by cascade: `ua_table_licensing_config` for `u_plugin_updater_install_log`. On instances that received an early version, also `snc_internal` ACL-role rows from the platform fallback (§19.6). Neither is in the update set. The reset script (§12.4) removes their history.

### 3.2 Repository layout

| Path | Content | Status |
|---|---|---|
| `src/ui_page/pgi_plugin_updater.xhtml` | UI Page `html` field (Jelly) | = v1.6.6 (certified) |
| `src/script_include/PluginUpdaterAjax.js` | Script Include | = v1.6.6 (certified) |
| `src/fix_scripts/repair_install_log_140.js` | one-off history repair (§9.2) | current |
| `src/fix_scripts/reset_npu_instance.js` | full uninstall of the app and its history on the test instance (§12.4) | current |
| `NowPluginUpdater<ver>.xml` | exported update sets 1.3.7 → 1.6.6 | `166` is current |
| `index.html` | public landing page with the XML embedded as base64 download (Netlify) | v1.6.6 |
| `netlify.toml`, `netlify/functions/download-count.mjs`, `package.json` | Netlify site + download counter (Netlify Blobs; `GET` read, `POST` +1) | current |
| `Now-Plugin-Updater-Briefing.html` | original build briefing | historical |
| `README.md` | public README | **stale (says v1.4.2)**, §19.8 |
| `Update-Sets/README.md` | export/import notes | historical (v1.3.0) |

---

## 4. Script Include API — `PluginUpdaterAjax` (v1.6.6)

`Class.create()` + `Object.extendsObject(AbstractAjaxProcessor, {...})`. Use `AbstractAjaxProcessor`, **not** `global.AbstractAjaxProcessor`. Every public method returns a **JSON string**.

### 4.1 Conventions

- **Authorization:** every client-callable method starts with `_guard()` = `gs.hasRole('admin')`. It returns `{"error":"forbidden: admin role required"}` otherwise. `monitorBatches` uses `_guardServer(who)`, which also logs `gs.error` naming the "Run as" user, so a misconfigured job does not fail silently.
- **Input hygiene:** every `sys_id` coming from the client goes through `_sysId()` (trim + `/^[0-9a-f]{32}$/i`, else `''`). Strings written to the log are truncated to field length.
- **Parameters:** the client helper `ajax(method, params, cb)` sends each key as `sysparm_<key>`. The server reads both `sysparm_<key>` and `<key>`.
- **Internal object variants (v1.6.3, O5):** `_instanceInfo()`, `_updatableApps()` and `_updateImpact(scopesCsv)` return objects. The public methods only `JSON.stringify` them. This avoids stringify→parse→stringify inside `getHomeData`.
- **Logging:** `gs.info/warn/error` with the `[PluginUpdater]` prefix.

### 4.2 Read methods

| Method | Params | Returns |
|---|---|---|
| `getInstanceInfo` | — | `{ rawBuild, versionLabel, installsRunning, instanceName, dataCenter, dbType, lastUpgraded, lastStoreSync }` (§5.2) |
| `getUpdatableApps` | — | `{ appsUpToDate, inFlight:[{sys_id,state,message,percent_complete}], apps:[{sysId,name,scope,current,latest}], impact, impactError? }`. `impact` = `_updateImpact(null)` (§6). Apps are ordered by `name` |
| `getHomeData` | — | `{ info, appData, infoError?, appsError? }`: both of the above in **one** round-trip; each half fails independently |
| `getUpdateImpact` | `scopes` (CSV, optional) | `{ suite, dependenciesByRoot, dependencies }` (§6.10) |
| `getSyncProgress` | — | `{ pct, running, outcome, message, startedAt, finishedAt, lastSync }` (§11.3) |
| `getBatchStatus` | `batch`, `reconcile` (optional, `1`) | `{ batch, status, counts, rows, rowsShown, truncated }` (§10.4). **v1.6.6:** with `reconcile=1` it first runs `_reconcile(batch)` (§10.3) |
| `listBatches` | — | `{ batches:[{batch, started, total, failed, active}] }`: the current user's 20 most recent batches (§10.5) |
| `getMyLatestBatch` | — | `{ batch }`: the current user's most recent batch key, or `''` |
| `getActiveBatch` | — | `{ batch }`: the current user's most recent batch that still has a `queued/installing/in_progress` row |

### 4.3 Write / action methods

| Method | Params | Effect / returns |
|---|---|---|
| `createBatch` | `apps` = JSON `[{sysId,name,scope,current,latest,depVersions}]` | Inserts one `queued` row per app (cap **1000**). Returns `{ batch, total, rows:[{sysId, logSysId}] }` or `{error:'no apps'}` |
| `attachWorker` | `log_sys_id`, `progress_id` | Stores the worker id. Resets the status to `queued` **only if** the row is still `queued`/`in_progress` (v1.6.3, B1). Returns `{ ok, status }` |
| `failRow` | `log_sys_id`, `message` | Marks the row `failed`, 100 %, `u_completed_at=now`, message ≤ 1000 chars. Returns `{ ok }` |
| `cancelRemaining` | `batch` | For every `queued` row of the batch (**v1.6.6**): if a target version is set and is already installed → `complete`; else if the worker/tracker is `running` → `installing`; otherwise `cancelled` ("Cancelled by <user> before the install started"). Returns `{ ok, cancelled, kept }` (`kept` = rows found already started or installed). It only changes the log, not the platform queue (§19.12) |
| `syncStore` | — | Starts a Store sync through a one-shot Scheduled Job (§11). Returns `{ queued:true, jobId, startedAt, lastSync }`, `{ queued:false, alreadyRunning:true, startedAt, lastSync }` or `{ queued:false, error, … }` |

### 4.4 Server-only

| Method | Caller | Returns |
|---|---|---|
| `monitorBatches` | Scheduled Job, every minute | `"checked:finalized"`. **v1.6.6:** a thin wrapper, `_guardServer` then `_reconcile('')`. The algorithm is in §10.3 |

### 4.5 Private helpers

`_guard`, `_forbidden`, `_sysId`, `_guardServer`, `_instanceInfo`, `_updatableApps`, `_updateImpact`, `_suiteImpact` (suite branch, §6.2), `_readSyncState` / `_writeSyncState` / `_syncLocked` / `_syncRunning` / `_cleanupSyncJobs` (§11), `_fmtDateTime` (aggregate UTC → user display value), `_dependencyTreeForBatch` / `_depRowsFor` (§10.6), `_reconcile(batchFilter)` (v1.6.6, §10.3; no role check of its own, callers guard), `_findWorker` (`gr.get` on `sys_progress_worker`; **v1.6.6** falls back to `sys_execution_tracker` with the same sys_id; returns `{state,message,error,pct,id,source}`), `_trackerFailure(pid)` (v1.6.6: the root tracker's `message` when it is Failed/Cancelled, §19.13), `_cmpVer` (§10.2), `_verify` (installed vs target, per-run cache), `_failMessage`, `_batchLastActivityMs`.

Constants: `ROW_CAP=500`, `SYNC_JOB_NAME='Plugin Updater - Store Sync (once)'`, `SYNC_STATE_PROP='x_npu.sync_state'`, `SYNC_LOCK_TTL_MS=1800000` (30 min).

**There is no `RESTMessageV2` anywhere**, and no `getProgress`, `verifyVersion` or `logInstall` method.

---

## 5. Data sources

### 5.1 Tables and properties read

| Need | Source | Detail |
|---|---|---|
| Updatable apps | `sys_store_app` | `update_available=true ^ active=true ^ hide_on_ui=false`, ordered by `name` (§8) |
| Up-to-date count | `sys_store_app` (GlideAggregate) | `active=true ^ update_available=false ^ hide_on_ui=false` |
| In-flight installs | `sys_progress_worker` | `name=CICDAppRepoService$CICDInstallWorker ^ state IN pending,running` |
| "Installing" KPI | `sys_progress_worker` (GlideAggregate) | same name, `state=running`. **Instance-wide**, not limited to this app's batches |
| Install progress | `sys_progress_worker` by sys_id | `state`, `message`, `error_message`, `percent_complete`. There is **no `completion_code` field**, and `state_code` is not used (§10.2) |
| Post-install version | `sys_store_app.version` by sys_id | arbiter of outcome |
| Dependency impact | `sys_app_version`, `sys_suite_config`, `sys_suite_config_app_version_m2m` | §6 |
| Installed dependencies | `sys_execution_tracker` | §10.6 |
| Data center | `sys_cluster_state.system_id` (first by `system_id`) | host `appNNN.ams101.service-now.com:…` → 2nd DNS label upper-cased → `AMS101` |
| Last upgrade | `sys_upgrade_history` newest by `sys_created_on` | `completed` → `started` → `sys_created_on`, date part only |
| DB engine | `glide.db.rdbms` | `mysql`→`MySQL`, `postgres(ql)`→`PostgreSQL (RaptorDB)`, else capitalized |
| Instance name | `instance_name` | |
| Last Store sync | `sn_appclient.apps_last_sync_time` | |
| Store sync % | `sn_appclient.apps_sync_progress` | **0–100 scale** (observed "85.0"), reset to 0 at the end |

### 5.2 Release label

1. `family` = `glide.buildname` if set. Otherwise it comes from `glide.buildtag` `^glide-([a-z]+)-`, capitalized.
2. `patch` from `__patch(\d+)`, `hotfix` from `hotfix([0-9a-z]+)` (both on `glide.buildtag`).
3. Label = `Family · Patch N · Hot Fix M` (omit missing parts). If there is no family, use the raw buildtag. If there is no buildtag, use `sys_upgrade_history.to_version` or `Unknown`.
4. `rawBuild` = `glide.buildtag`. It is returned, but the current Home does not render it.

Home shows `instanceName` as the banner title (falling back to `versionLabel`) and `versionLabel` as the **Release** meta item.

### 5.3 CICD install endpoint (client-side, §7)

`POST /api/sn_cicd/app_repo/install?sys_id={sys_store_app sys_id}&version={latest_version}`
Success (200/201) → `result.links.progress.id` = `sys_progress_worker` sys_id. The API is **single-flight** (a "CICD Operation" mutex), so installs are enqueued one at a time (§7.3).

The v1.3.2 platform-plugin count from `v_plugin` was **removed**: it cost 10–40 s on a cold view, and it is not shown anywhere.

---

## 6. Dependency impact — what else gets updated

**Requirement.** Before launch, show the apps that will be updated *in addition to* the selected ones. This is the same information as the native *Review Installation Details* dialog. It is read-only: the batch installs exactly what was selected, and the platform pulls in the rest.

Surfaced in: Step 1 and Step 2 (per-row `N more ▾`, plus the suite panel, §14.3/§14.4) and the confirm dialog (deduplicated union, §14.5).

### 6.1 The correct constraint source is the *target* version

`sys_store_app.dependencies` declares the floor of the **installed** version. Walking it (the v1.5 design) surfaced unrelated apps. For example, for *Content Understanding* it returned 19 Platform Analytics components, reached only through a 40-dependency hub app. **Do not use it.**

The correct source is **`sys_app_version`**: one row per `(scope, version)`, whose `dependencies` glide_list (`scope:minVersion`, comma-separated) declares what *that* version requires. The native `DependencyProcessor` reads the same table. For each dependency, compare `minVersion` to the installed `sys_store_app.version`:

- installed ≥ required → the platform will not touch it. **Stop, do not recurse.**
- installed < required → it is impact. Recurse into its own `sys_app_version[scope@minVersion]`.

### 6.2 Two independent branches, same certainty

| | Suite branch (`_suiteImpact`) | Dependency branch |
|---|---|---|
| Source | `sys_suite_config` (`compatible=true`, **highest `version`**, limit 1) + `sys_suite_config_app_version_m2m` (`suite_config`, `app_scope`, `app_version`, limit 5000) | `sys_app_version`, BFS per root |
| Inclusion | member installed and `app_version` > installed | `minVersion` > installed |
| Certainty | explicit target | explicit target |

- The installed suite (`installed=true`) is **never** used: it is not reliably populated.
- Members that are not installed are ignored (the platform will not pull them in).
- `com.*` dependency entries are platform plugins: skipped, never recursed into.
- Each root keeps a `visited` set (cycles are real).
- **Suite wins the overlap:** a scope claimed by the suite branch never appears in the dependency branch.
- There is no heuristic tier. Every impact row reads the same (`current → target`).

### 6.3 Roots and root-exclusion

- **Without `scopes`** (Step 1/2, folded into `getUpdatableApps`): roots = every `updateAvailable && !hideOnUi` app. **No root-exclusion.** An app can be both a root and another root's impact (e.g. *Setup Hub* is updatable itself and is also impact of *ServiceNow Otto for Setup Core*). Excluding it would hide real impact; this was a v1.5.2 bug.
- **With `scopes`** (confirm dialog): roots = the selected scopes that are present in the index. The suite branch is also restricted to selected members. The union `dependencies` **excludes the roots** ("N *more* beyond what you picked"). `dependenciesByRoot` is never root-excluded.

### 6.4 Deduplication

The union counts each scope **once** across both branches and all roots. It is never a per-row sum.

### 6.5 Hidden apps

Impact nodes with `hide_on_ui=1` are **kept** in impact lists and badged `not selectable`. `hide_on_ui` only gates the selectable list.

### 6.6 Per-row expansion (client, `rowImpactList(scope)`)

A row's list = `dependenciesByRoot[scope]` **plus**, only when `scope` is itself one of `suite.apps`, all *other* suite members. This mirrors the native dialog, where any suite member lists its siblings. The membership check is mandatory: without it, every row inherits the suite list (a v1.5.4 bug caught in the smoke test).

### 6.7 Performance

- `sys_store_app` is loaded **once** into a scope index `{name,current,latest,hideOnUi,updateAvailable}` (limit 20000).
- **v1.6.3 (O1):** roots are computed first. **No roots → early return** (suite only, no `sys_app_version` read). This is the normal case when there are 0 updates.
- `sys_app_version` is read **level by level, restricted to relevant scopes** (`scope IN (roots)`, then `IN (newly discovered dependency scopes)`, up to 12 levels, limit 20000 per query) into a `"scope@version" → deps` index. It is no longer a full-table scan (≈5,200 rows measured).
- The BFS itself runs purely in memory.

### 6.8 Verified cases (`democrmfalectriae152010`, Australia family)

| Root | Suite | Dependency branch |
|---|---|---|
| Content Understanding `sn_docintel_gen_ai` 7.0.4→7.0.5 | 8 siblings (`Now assist` suite) | 0 (its 3 direct deps are already satisfied) |
| Setup Hub `sn_ia_base` 2.0.4→2.0.8 | not a member | 3: Setup Hub Content → Common → Config, stopping at Admin Center (6.2.1 satisfied) |
| Subscription Management v2 `sn_sub_man` | — | 1: Licensing Engine `sn_entitlement` 6.4.7 |
| ServiceNow Otto for Setup / Setup Core | member | 8 suite + 4 dependency = `12 more` |
| Theme Builder, etc. | — | none → no expansion |

### 6.9 Degradation

No `compatible=true` suite, or no member with impact → `suite:null`. No roots → `dependenciesByRoot:null, dependencies:null`. No `sys_app_version` row for a node's version → stop at that node. A dependency that is not installed → not impact. Empty impact → **render nothing** (no empty panel, no "0 more"). An exception in `_updateImpact` inside `getUpdatableApps` → `impact:null` + `impactError`, and the wizard still works.

### 6.10 `getUpdateImpact` response

```json
{
  "suite": { "name": "Now assist", "version": "29.5.20260820",
             "apps": [{ "scope":"…", "name":"…", "current":"…", "target":"…", "hidden":false }] },
  "dependenciesByRoot": { "sn_sub_man": [{ "scope":"sn_entitlement", "name":"Licensing Engine",
                                           "current":"6.4.5", "target":"6.4.7", "hidden":false }] },
  "dependencies": [ /* deduplicated union, root-excluded only when scopes given */ ]
}
```

Any key can be `null`. `sys_suite_config*` and `sys_app_version` are **not documented public API**. They are isolated in this one method so that a platform change is contained.

---

## 7. Install trigger & security

### 7.1 Session-based install (no credentials)

```js
fetch('/api/sn_cicd/app_repo/install?sys_id='+encodeURIComponent(sysId)+'&version='+encodeURIComponent(latest), {
  method:'POST', credentials:'same-origin',
  headers:{ 'X-UserToken': window.g_ck||'', 'Accept':'application/json', 'Content-Type':'application/json' }
  // body: JSON.stringify({offering:id}) only on the offering retry
});
```

`X-UserToken` satisfies CSRF. The acting admin already holds the CICD rights. Session auth was validated on the target instance, so the credential-alias fallback was never needed and is not implemented.

### 7.2 Response handling (`handleTrigger`)

| Case | Action |
|---|---|
| 200/201 with `result.links.progress.id` | `attachWorker(logSysId, pid)` → next app |
| 200/201 without a progress id | `failTrigger`: "The install was accepted but no progress ID was returned…" |
| 400 containing "offering" + an id in `[...]` or `"offering":"…"` | retry **once** with body `{offering:id}` |
| transient: HTTP 409/429/503, or a message containing `enqueue`/`mutex`/`in progress`/`try again`/`another`; or a `fetch` network error | `retryOrFail`: up to **8** retries, delay `2000 + attempt×800` ms, "Waiting for the CICD queue… (retry n/8)" |
| anything else | `failTrigger`: `HTTP <status> — <message>` |

The error message is read from `result.error`, else `error.message` / `error.detail`, else `HTTP <status>`. `failTrigger` records `{key,name,scope,target,message}` in `S.launchErrors` and calls `failRow`.

### 7.3 Sequential launch queue (`startInstalls`)

- Builds `apps[]` from the selection. Each item gets `depVersions = {scope: current}` from `rowImpactList(scope)`: the pre-install snapshot of predicted dependencies (§10.6).
- `createBatch` → maps `sysId → logSysId`.
- Pump with `POOL=1` (strictly sequential). Each step is wrapped in `once()` plus a **120 s watchdog** that advances the queue if a callback never returns ("An install took too long to launch — moving on to the next one.").
- When done: if nothing failed to launch → `openMonitor(batch)` automatically. Otherwise it stays on Step 3 with the "could not be started" table and its *Why failed* rows.

### 7.4 Access control

- Every Script Include method: `admin` (§4.1). This is the effective protection for all data and actions.
- Application Menu and Module: `roles=admin`.
- Install-log table: 4 CRUD ACLs → `admin` (bound through `sys_security_acl_role`, §19.6).
- UI Page: the `pgi_plugin_updater` read ACL has `type=record`. See §19.5 on whether it protects the page. A non-admin who opens the URL gets a page whose every call returns `forbidden`.
- XSS: every dynamic value rendered through `innerHTML` goes through `esc()` (`& < > "`).
- Batch keys (`u_session_id`) are passed to `addQuery(field, value)`, not to encoded queries. `sys_id`s are regex-validated.

---

## 8. Which apps are "updatable"

Exactly **three** conditions, mirroring the Application Manager:

| Filter | Reason |
|---|---|
| `update_available = true` | flagged as updatable by the Store sync |
| `active = true` | active app |
| `hide_on_ui = false` | not a hidden dependency (these appear only as impact, §6.5) |

### 8.1 Rejected filters (measured, do not add)

| Prior filter | Verdict |
|---|---|
| `static_content = false` | **Wrong.** 110 successful installs, 0 failures on `static_content=true` apps |
| `last_installed_from = 'store'` | **Too narrow.** `out_of_band` apps update normally |
| `install_date != ''`, `version != latest_version` | redundant |
| `name NOT LIKE @devsnc/ / @servicenow/ / @now-par` | inert or cosmetic |

Applying them would have hidden 40 % of the updatable apps. A few platform-bundled apps may end as *Failed*. That is accepted and visible, not filtered away.

---

## 9. Data model — `u_plugin_updater_install_log`

One row = one application in one batch.

| Field | Type (len) | Label | Written by | Meaning |
|---|---|---|---|---|
| `u_app_name` | string 255 | App Name | createBatch | display name |
| `u_app_scope` | string 100 | App Scope | createBatch | scope |
| `u_store_app_id` | string 32 | Store App ID | createBatch | `sys_store_app` sys_id (validated) |
| `u_previous_version` | string 40 | Previous Version | createBatch | version before install |
| `u_target_version` | string 40 | Target Version | createBatch | `latest_version` at launch |
| `u_status` | choice 40 | Status | all | `queued` · `installing` · `complete` · `failed` · `cancelled` (legacy read: `in_progress` → `installing`) — choice list gap §19.4 |
| `u_started_at` | glide_date_time | Started At | createBatch | batch creation time |
| `u_completed_at` | glide_date_time | Completed At | monitor/failRow/cancel | finalization time |
| `u_triggered_by` | reference → sys_user | Triggered By | createBatch | batch owner, filter for list/latest/active |
| `u_progress_id` | string 32 | Progress ID | attachWorker | `sys_progress_worker` = `sys_execution_tracker` root sys_id |
| `u_error_message` | string 1000 | Error Message | monitor/failRow/cancel | reason (also "Details" in the Monitor) |
| `u_percent_complete` | integer | Percent Complete | monitor | 0–100 |
| `u_session_id` | string 32 | Session ID | createBatch | **batch key** `b_<base36 ms>_<first 8 chars of user sys_id>` (~19 chars) |
| `u_product_category` | string 100 | Product Category | — | **unused**, category mapping never built (§13) |
| `u_dependency_snapshot` | string 4000 | Dependency Snapshot | createBatch | JSON `{scope: currentVersion}` of predicted dependencies, taken before launch |

20 physical fields (15 custom + `sys_*`). Instance data on 2026-09-29: 1,644 `complete`, 23 `failed`, no active rows.

### 9.1 Row lifecycle

```
createBatch ─► queued ──attachWorker (keeps status if already final)──► queued
   │                                     │ monitorBatches: worker running
   │                                     ▼
   │                                 installing
   │        worker complete/success      │      worker failed/error/cancelled
   │        + installed ≥ target ─► complete    ──────────────► failed
   │        + installed < target ─► failed
   │ failRow (launch failed) ─────────────────────────────────► failed
   │ cancelRemaining (only while queued) ─────────────────────► cancelled
   │ no worker + installed ≥ target ──────────────────────────► complete
   └ no worker + queue idle + batch inactive > 60 min ────────► failed (timed out)
```

### 9.2 Historical repair (upgrading from 1.3.x)

`src/fix_scripts/repair_install_log_140.js` (Scripts - Background, admin, `DRY_RUN=true` by default, `LIMIT=5000`) re-reads `complete` rows. It reclassifies a row as `failed` **only** when the installed version is semantically lower than the target, using the same `_failMessage` wording. Rows whose app no longer exists are left untouched. It documents the two rejected criteria: `state_code` (723/725 "error" rows had actually succeeded) and strict equality (503 of 507 "mismatches" were *above* target). Result on the reference instance: 4 real failures out of 1,072.

---

## 10. Batch monitoring

### 10.1 Two cooperating loops

- **Server (authoritative):** `monitorBatches` every minute. It reads workers, verifies versions and writes rows. This is what lets the admin close the page.
- **Client (display only):** the Monitor polls `getBatchStatus` every **15 s** while `counts.installing + counts.queued > 0`, then stops. The client never polls `sys_progress_worker` directly.

### 10.2 Outcome rule — the installed version is the only arbiter

- `sys_progress_worker` has **no `completion_code`** (reading it silently returned empty until v1.4.0, so failures looked Complete).
- `state_code` is **unusable**: the CICD worker ends `state=complete, state_code=error` even on success (723/725 measured).
- `_cmpVer(a,b)` splits on `.`/`-`, compares numerically (NaN → 0) and returns -1/0/1.
- `_verify(appId, target, cache)`: `matches = installed ≥ target` (a later batch or sync may legitimately exceed the target). If the app is not found → `matches:false`. If there is no target → `matches:true`.
- `_failMessage`: "Install did not apply: still at X, below the target Y" (or "application record not found"), plus ` — <worker error/message>` unless that message is the uninformative "Executing queued operation". Maximum 1000 chars.

### 10.3 `monitorBatches` algorithm

1. Guard `admin` (logs an error otherwise). Query rows with `u_status IN queued,installing,in_progress`, limit 2000. **v1.6.3 (B2):** rows with no `u_progress_id` are included too. Otherwise a row whose launch response was lost stayed `queued` forever.
2. `queueActive` = any `CICDInstallWorker` in `pending,running`.
3. Per row: `w = _findWorker(pid)`. **v1.6.6:** when `sys_progress_worker` has no record with that sys_id, `_findWorker` reads `sys_execution_tracker` with the same sys_id and maps its `state` (`sys_choice`: 0 Pending, 1 Running, 2 Successful, 3 Failed, 4 Cancelled) to `pending/running/complete/failed/cancelled`. An install that fails before it starts (observed on `sicuritaliafsmau`, 2026-10-14: "Unable to download app package" in ~6 s) creates **only** the tracker. Before v1.6.6, such a row stayed `queued` for 60 minutes and then closed with the misleading "Timed out: install did not start".
   - **No worker:** if installed ≥ target → `complete`. Else, if `queueActive` → keep waiting. Else, if the batch shows no activity for **> 60 min** (latest `u_completed_at` in the batch, else `u_started_at`) → `failed`: "Timed out: install did not start (install queue idle, no progress for 60 minutes)". If there is no pid at all, the message is "…the install was never launched (no progress worker was ever attached to this row)".
   - **Worker `complete`/`success`:** verify the version → `complete` (message cleared) or `failed` (`_failMessage`); 100 %; `u_completed_at`.
   - **Worker `failed`/`error`/`cancelled`:** **v1.6.6:** verify the version first (§10.2). If installed ≥ target → `complete`. Otherwise `failed` with `_failMessage` (the version fact plus the worker/tracker message). Up to v1.6.5 it was `failed` with the worker's `error_message`/`message`/"Worker <state>", without a version check.
   - **Worker `running`:** `installing`. **Otherwise** (`pending`/unknown): `queued`.
   - `u_percent_complete` follows the worker whenever the worker reports > 0.
4. **v1.6.6 — late installs of cancelled rows.** `cancelRemaining` changes only the log, so an operation already accepted by the platform queue can still install. Rows with `u_status=cancelled`, `u_completed_at` in the **last 6 hours** and a non-empty `u_target_version` are re-verified (limit 200). If installed ≥ target → `complete` (message cleared). Observed on Brazil: "Customer Service Case Action Status" was cancelled while its tracker was already Running. It installed anyway, and the row moved to `complete` on the first job cycle after the v1.6.6 deploy.
5. Log `monitorBatches checked=N finalized=M`.

**v1.6.6 — `_reconcile(batchFilter)`.** Steps 1–5 are the body of `_reconcile`. `monitorBatches` calls it with `''` (every batch). The Monitor's **Refresh now** calls it for one batch through `getBatchStatus` with `reconcile=1` (§10.4), so the log is aligned with tracker and installed version immediately instead of on the next one-minute cycle. The automatic 15 s poll does **not** reconcile: it only reads the log.

### 10.4 `getBatchStatus`

- **v1.6.6:** with `reconcile=1`, `_reconcile(batch)` runs first. A reconcile error is logged with `gs.warn` and the status is still returned.
- `counts` come from one GlideAggregate over the **whole batch** grouped by status (`in_progress` → `installing`, unknown → `queued`).
- `rows` are ordered by `u_app_name` and limited to **`ROW_CAP=500`** (v1.6.3, O3). Each row = `{logSysId,name,scope,current,latest,status,pct,message,startedAt(display),deps[]}`.
- `rowsShown`, `truncated = counts.total > rows.length`.
- Batch `status`: `running` while any row is installing/queued. Otherwise `partial` (some failed and some complete), `failed` (failed, none complete), `cancelled` (none complete, some cancelled), else `complete`.

### 10.5 `listBatches`

A GlideAggregate on the current user's rows, grouped by `u_session_id`, with `COUNT` + `MAX(sys_created_on)`. **v1.6.6:** the result is sorted explicitly by that date, **descending, before** `slice(0,20)`, so the most recent batch is first. The direction of `orderByAggregate` was not reliable: the selector showed the oldest batch first, and with more than 20 batches the slice kept the 20 oldest. Limits of the **Batch** dropdown: only the current user's batches (`u_triggered_by`), at most 20, no search and no paging. A second aggregate grouped by (batch, status) gives `failed` and `active` (= not complete/cancelled/failed). `started` = user-timezone display value. **Only the caller's own batches are listed**. Any admin can still open any batch via `getBatchStatus` if they know the key.

### 10.6 Observed dependency installs — `sys_execution_tracker`

The root `sys_execution_tracker` node has the **same sys_id** as the `sys_progress_worker` (verified). Every app that `GlideAppLoader` actually installs under that root gets a descendant node named `Installing application <scope>:<version>`. Dependencies that were already satisfied get no node. The tree is 2–3 levels deep (e.g. root → "Installing application package" → "Installing application …").

- **v1.6.3 (O2) `_dependencyTreeForBatch(progressIds)`:** resolves all rows' trees in **one query per level** (`parent IN (frontier)`, limit 5000, max depth 8). It tracks the owning root per node and matches `/^Installing application ([A-Za-z0-9_.]+):(.+)$/`. The first node per scope wins. State map: 0 queued, 1 installing, 2 complete, 3 failed, 4 cancelled.
- **`_depRowsFor(tree, pid, ownScope, snapshotJson)`:** excludes the row's own scope. It fills `current` from `u_dependency_snapshot`, because tracker names only carry the target, and `sys_store_app.version` is already the target after install. The result is `[{scope,current,version,status,pct}]`.
- Friendly names: **one** `sys_store_app` query (`scope IN …`) for all dependency scopes in the response.
- Degradation: no pid or no nodes → `deps:[]`. Pre-v1.6.1 rows have no snapshot, so the Monitor shows `→ target` only.

---

## 11. Store sync ("Sync with Store")

### 11.1 Mechanism

`gs.eventQueue('sn_appclient.check.for.update')` is **not used**: on the reference instance the event sat 9–13 h in a shared queue. Instead, `syncStore` inserts a **Run Once** `sysauto_script` (`run_start=now`, `run_as=current user`, `conditional=false`). The scheduler picks it up in seconds (up to minutes under load). The job calls:

```js
new sn_appclient.UpdateChecker().checkAvailableUpdates(false, false, { forceUpdate: true });
```

(~112 s measured over ~1,200 apps; too long for an inline GlideAjax transaction.)

### 11.2 Server state machine (v1.6.3, S1–S4)

`x_npu.sync_state` = `{"state":"running|done|error","startedAt","finishedAt","message","by"}`.

1. `syncStore`: if `_syncLocked()` (state `running` and younger than 30 min) or `_syncRunning()` (`apps_sync_progress > 0`) → `{alreadyRunning:true}`.
2. Otherwise it writes `running` **before** creating the job (the lock covers the window where the job exists but progress is still 0). Then it runs `_cleanupSyncJobs()` (deletes up to 50 old one-shot jobs: created > 1 h ago **and** `run_start` in the past), inserts the job and stores its id in `__npu_sync_job_id`.
3. If the job insert fails → it writes state `error` (releasing the lock) and returns an error.
4. The generated job script writes `done` or `error` (with the exception text), then **deletes its own `sysauto_script`** record (id taken from `__npu_sync_job_id`).
5. A `running` state older than 30 min is treated as dead: the lock is released, and `getSyncProgress` reports `outcome:'error'` ("The sync job stopped without reporting an outcome…").

### 11.3 `getSyncProgress`

`pct` = rounded `apps_sync_progress`, clamped to 0–100. The observed phases are 1 fixUpdateAvailableField, 3 fetchAppUpdates, 20–70 updateAppRecords, 85 refreshStoreResponseCache, 96 syncGoldenConfigs, then 0. `outcome` comes from `x_npu.sync_state` (`idle` if absent). `running = outcome==='running'`. When `outcome==='done'`, `pct` is reported as 100.

### 11.4 Client behaviour (deployed v1.6.5 page)

- The button is disabled with "Syncing…". It calls `syncStore`, then polls `getSyncProgress` (first poll after 3 s).
- `p.running` → progress bar "Updating the application catalog…", poll every 3 s.
- Otherwise: finished if `lastSync` changed from the value shown before the click, or `lastSync >= startedAt` (string comparison). Then "Finished" and a Home refresh after 700 ms.
- Otherwise it waits and shows the elapsed seconds ("Waiting for the sync job to start… (Ns)", with a warning after 90 s), polling every 6 s (3 s once running was seen). A poll error retries after 5 s.
- After **5 min** it stops following: "Still running after 5 minutes. The sync continues on the server…".
- **The v1.6.5 client ignores `outcome`, `message` and the re-attach on Home load that v1.6.4 had.** See §19.2.

---

## 12. Build & deployment procedure

### 12.1 Deploying changes to the instance

1. Edit the local sources. For the Script Include, first **re-sync `src/` from the instance** (§19.1).
2. Write the record server-side with `GlideRecord` (*Scripts - Background*). For large payloads (the UI Page is about 100 KB), verify **by exact length** against the record after writing. Dense base64 blobs corrupt: split them into separate patch writes.
   **Never write `sys_ui_page.html` through the REST Table API** (MCP `update_record`, or `PATCH /api/now/table/sys_ui_page`). The write returns 200, but the platform escapes the `<script>` tags into `&lt;script&gt;`, and the page silently stops running its JavaScript. Observed on `empgmarongiu1`, 2026-10-15: +12 chars, exactly the two tags. The same `html` written with `GlideRecord.setValue` was stored byte-identical. REST is fine for `description` and other plain fields.
3. The UI Page `html` field is a **Jelly fragment**, not a full document. No CDATA inside it. Avoid `<` followed by a space in inline JS (the Jelly parser may read it as a tag), so comparisons are written reversed (`30000 > age`).
4. Bump `S.version` in the page, plus the `description` of the UI Page and Script Include records.

### 12.2 Exporting the update set

- **Every** record must be a tracked `sys_update_xml` entry with `remote_update_set` set. Otherwise the import reports Total 0.
- Include `sys_app_application`, `sys_app_module`, `sys_db_object`, dictionary, `sys_documentation`, choice list, ACLs **and their `sys_security_acl_role` rows**. Missing ACL-role rows make the effective role depend on the target's platform fallback (observed `snc_internal`).
- `GlideUpdateManager2.saveRecord` does **not** rewrite an existing entry. Update the payload in place, or the export ships the old version.
- No `sys_attachment`-based content: attachment bytes do not travel in a plain XML export. This is why there is no brand icon (§18.3.5).
- Test the import on an instance **where the app does not exist**: a different instance, or the source instance after the reset of §12.4. Read `state=previewed`, `summary`, `inserted`, `collisions` from the `sys_remote_update_set` record. A from-scratch install was proven for v1.6.4 and for **v1.6.6** (§18.5).
- Refresh `index.html` (the embedded base64 XML, verified by exact length and round-trip, plus version strings).

**Native export, used for v1.6.6 (2026-10-15).** Never build the XML by hand: `payload_hash` is not the Java `hashCode` of the payload, and a hand-built set without `remote_update_set` imports as Total 0.

1. **Capture the changes.** Writes made with `execute_background_script` **are** captured, in the current update set of the admin session (here: **Default**). They are not "missing": look them up with `sys_update_xml` `name = <table>_<sys_id>`. Default also collects noise from the MCP tool (`mcp.bg_result.*` properties, see §19.12). Move only the app's entries by changing the `update_set` field of those `sys_update_xml` rows into a new local set (here "Now Plugin Updater v1.6.6 delta", 2 entries).
2. **Merge into a complete set.** Use *System Update Sets → Merge Completed Sets* (`merge_update_sets_complete.do`). The page has **no checkboxes**: it merges **every set the list filter shows**. Filter it to exactly the sets to merge (`sys_idIN…`) and confirm "merge these 2 update sets?". For each object the newest entry wins, decided by the record's *Updated* field. The merge **moves** the entries (it does not copy them), cannot be undone, and puts the source sets in state `ignore` with `merged_to` set. The superseded copies stay in the source set.
3. Close the merged set (`complete`) and use **Export to XML** from its Related Links. The file is named `sys_remote_update_set_<new sys_id>.xml`. In it, `remote_sys_id` is the local set's sys_id and every entry has `remote_update_set` set and `update_set` empty.
4. Check locally: number of entries, the `type` mix, and the `script`/`html` payload of the Script Include and UI Page against `src/` (length and SHA-256).

The MCP tools `preview_remote` and `commit_remote` are not usable for this (§19.12). Use the **Preview Update Set** and **Commit Update Set** buttons on the form.

**Lineage rule — build every release on top of the previous published one (since v1.6.6).** Each `sys_update_xml` carries an `update_guid` and an `update_guid_history` (`guid:payload_hash,…`). On import, the preview accepts a remote update without problems only if the target's **latest local customer update** for that object is in the remote entry's history. Otherwise it raises the error "**Found a local update that is newer than this one**", whatever the timestamps say.

- *Observed with the first v1.6.6 XML:* customers who installed the published 1.6.5 have the Script Include's 1.6.5 entry `3f53e670…` as their latest local update. The v1.6.6 Script Include had been written on an instance where the 1.6.5 commit had created **no new version** (same content as 1.6.4), so its history went straight to 1.6.4 (`32f7f153…`). Upgrading from 1.6.5 therefore gave an error on the Script Include. On `democrmfalectriae152010`, the development instance, there was also one on the UI Page, because of a local, never-exported edit in Default (`451e53f4…`).
- *Fix:* reset the build instance (§12.4) and install the **published** XML of the previous release from scratch. A clean insert creates the versions with the published guids. Then write the new code with `GlideRecord`, so that the new entries' history starts from those guids. Finally move the 2 entries to a delta set, merge with the local set created by the commit, and export.
- *Offline check before shipping:* for every entry of the previous published XML, its `update_guid` must be in the history (or be the guid) of the same entry in the new XML. Script: compare `NowPluginUpdater<prev>.xml` with `NowPluginUpdater<new>.xml`.
- *Refinement observed later the same day:* a matching **`payload_hash`** in the history is enough too. On `democrmfalectriae152010` the latest local entries came from the first 1.6.6 build: guids `8e4c4ffb…`/`87bc437f…`, hashes 717598062/1441050591. The tracker-fix XML has other guids for those steps but the same hashes (`0391a7ff…:717598062`, `9b91a7ff…:1441050591`), and the preview raised no problem. In practice the preview compares `guid:hash` pairs, and a match on either part counts.
- *Result for the final v1.6.6:* 59/59 entries of the published 1.6.5 are in the lineage, and 59/59 of the first final 1.6.6 build. Against 1.6.4, only the choice list differs, exactly as it already did in 1.6.5 (whose upgrade from 1.6.4 passed with 0 collisions).

### 12.3 Installing (end user)

System Update Sets → Retrieved Update Sets → **Import Update Set from XML** → Preview → Commit. Open **All → Now Plugin Updater → Plugin Updater** (`/now/nav/ui/classic/params/target/pgi_plugin_updater.do`). If the instance already had a `PluginUpdaterAjax` without this app's methods, delete it: it shadows the app's copy and Home returns "Empty response from server".

### 12.4 Resetting the test instance (uninstall and reinstall from scratch)

The app is in global scope, so the Application Manager has no *Uninstall*. Proving a from-scratch install used to need a new instance each time. `src/fix_scripts/reset_npu_instance.js` removes the app **and its history** from one dedicated test instance, so the same instance can be reused. First used on `empgmarongiu1` on 2026-10-15.

**Why the history must go too.** If `sys_update_version` or `sys_metadata_delete` rows with the same update names survive, the preview treats the incoming objects as "newer local deletion" instead of clean inserts. If the local update set the XML was exported from survives (same `remote_sys_id`), the import reads as a false success: the v1.6.5 lesson. `sys_metadata_delete` **is** used in global scope: every deletion of an app file leaves a row there, keyed by `sys_update_name`.

**What the script does** (ES5, Scripts - Background, scope `global`):

0. Runs only when `instance_name` equals `ALLOWED_INSTANCE` (`empgmarongiu1`).
1. Builds the inventory from the `sys_update_xml` names of **every** local and remote update set whose name starts with "Now Plugin Updater". No hand-kept list, so it covers every object ever shipped and keeps working for future versions. `sys_properties_*` entries are skipped (they are `mcp.bg_result.*` noise). On 2026-10-15: 12 local + 8 remote sets → **59 objects**, the same as the XML.
2. Runtime data: the job's `sys_trigger`, the properties `x_npu.sync_state` / `__npu_sync_job_id` (deleted **one by one**: `deleteMultiple` on `sys_properties` is refused with "Not allowing multiple record update to sys_property"), and the install-log rows.
3. App records, children first: ACL roles, ACLs, module, menu, UI Page, Script Include, job, labels, table last. Deleting the `sys_db_object` record **drops the table** (verified: `GlideRecord.isValid()` false afterwards) and takes the dictionary, labels and choices with it. Names are resolved as `<table>_<sys_id>`, otherwise through `sys_metadata.sys_update_name`. If any deletion fails (for example an ACL without `security_admin`), the script **stops before step 4**, keeping the update sets so a rerun can rebuild the inventory.
4. History: `sys_update_xml`, `sys_update_version` and `sys_metadata_delete` for those names, in every set including the DELETE entries just captured in Default. Then the NPU update sets, local and remote, with their entries. It also covers:
   - **cascade deletions** that are in no NPU set. These are recognised by their DELETE entry on an app target (`target_name` starting with the table name or `pgi_plugin_updater`). On 2026-10-15: 5 old `snc_internal` ACL-role rows and `ua_table_licensing_config`;
   - historical name variants (`sys_update_version` / `sys_metadata_delete` with `LIKE u_plugin_updater_install_log`, for example `sys_choice_u_plugin_updater_install_log_null` from v1.4.0).

**How to run it**

1. Export the release first (§12.2): the reset deletes the source update set.
2. Elevate the session to `security_admin`.
3. `MODE='dryrun'`: writes nothing and prints the inventory and the counts.
4. `MODE='execute'`: each line reports what was **actually** deleted (before − after) and flags `LEFT n` when something survived. "Record for rollback" stays on.
5. `MODE='verify'`, in a separate run: every count must be 0 and the table must be invalid.
6. Import, preview, commit the XML (§12.3), then smoke-test the page.

**Result on `empgmarongiu1` (2026-10-15).** The first `execute` removed 591 log rows, 36 app records (+ the table drop), 726+ `sys_update_xml`, 113+ `sys_update_version`, 52 `sys_metadata_delete`, 12 local and 8 remote sets in 36 s. `verify` then found the 2 properties and 1 name variant still there, plus 6 cascade deletions, which led to the one-by-one property delete, the cascade step and the `LEFT n` report. A second `execute` cleaned them, and `verify` returned all zeros. The import of `NowPluginUpdater166.xml` then gave **previewed, summary 59, inserted 58, updated 1, collisions 0**, with no preview problems. The one *update* is the `u_status` **Choice list**, even though no `sys_choice` row existed for the table. It was explained later the same day: a leftover `sys_choice_set` record from 2026-06-26 (see below). After the commit:
- the Script Include and UI Page were byte-identical to `src/`, with the same sys_ids;
- the 9 ACL-role rows were all `admin`;
- the job trigger was rescheduled and the table had its 22 dictionary entries;
- Home rendered real data with 0 console errors.

**`sys_choice_set` — the leftover that explained "updated 1".** The `u_status` choice list has a container record in `sys_choice_set` (`sys_update_name` `sys_choice_u_plugin_updater_install_log_u_status`, extends `sys_metadata`). It falls neither with the table nor with the `sys_choice` rows. On `empgmarongiu1` one was created on **2026-06-26** by the first install, and it survived every reset until it was found on 2026-10-15. Because it existed, every "clean" import reported the choice list as *updated* instead of *inserted*. The script now deletes it, plus the remaining `sys_update_xml` named like the table. After that, the import of the published 1.6.5 and of the final 1.6.6 both gave **inserted 59 / updated 0**.

**Second run (v1.6.6 re-cut, same day).** With the corrected script, one `dryrun` (59 objects, 3 local + 1 remote set) and **one** `execute` were enough. That run deleted 36 app records + table, 178 `sys_update_xml`, 129 `sys_update_version`, 58 `sys_metadata_delete` and 6 cascade names, with no `LEFT`. `verify` returned all zeros at the first attempt.

The script is destructive and irreversible. Never point it at an instance that is not a dedicated test instance.

---

## 13. Product category mapping — NOT IMPLEMENTED

Never built. Step 1 is a flat table and Step 2 filters by exact scope. `getUpdatableApps` returns no `category`, and `u_product_category` is written by nothing. Either implement a mapping by scope prefix (reference: `sn_csm`/`sn_customerservice` CSM, `sn_hr` HRSD, `sn_itsm` ITSM, `sn_itom`/`sn_em`/`sn_disco` ITOM, `sn_grc`/`sn_risk`/`sn_iam` IRM, `sn_sec`/`sn_si` SecOps, `sn_fsm` FSM, `sn_spm`/`sn_itbm`/`sn_project` SPM, `sn_cmdb` CMDB, `sn_flow`/`sn_creatorworkflow` App Engine, `sn_nowassist`/`sn_gen_ai`/`sn_va` Now Assist, else Other), or drop the column.

---

## 14. UI / UX specification (client v1.6.6)

### 14.1 Shell and style

- **Nav bar** (sticky, blurred translucent): the text "Now Plugin Updater" (no icon, §18.3.5); pill tabs **Home · Wizard · Monitor · Guide**; a **Refresh** ghost button on the right (reloads Home data).
- **Design tokens** on `#app`: `--bg #f5f5f7`, `--surface #fff`, `--surface-2 #fbfbfd`, `--border #e8e8ed`, `--border-2 #d2d2d7`, `--text #1d1d1f`, `--text-2 #6e6e73`, `--text-3 #a1a1a6`, `--accent #0071e3`, `--success #34c759`, `--warning #ff9f0a`, `--danger #ff3b30`. Radii 8/12/18/pill. Two shadow levels. System font stack (SF/Segoe/Helvetica). Max content width 1120 px.
- **Status pills** carry an icon as well as a colour (✓ complete, ✕ failed, ⟳ installing/running, • queued/pending, ⊘ cancelled, ! partial).
- Views switch through `.view.active` with a 0.25 s fade. No router. The Wizard tab is active for any `wizard*` view.
- All user-facing text is in **English**.

### 14.2 Home

- **Banner** (dark gradient): the instance name, plus a meta grid showing only the non-empty items: **Release**, **Data Center**, **Database**, **Signed in** (`g_user.getFullName()`), **Last Upgraded**, **Store Synced**.
- **KPIs:** **Apps** (= up to date + updates available, "managed (active & visible)"), **Up to Date**, **Updates Available** (warning colour when > 0), **Installing** (running CICD workers instance-wide). When Installing > 0 the card is clickable: `getActiveBatch` → Monitor.
- **Actions:** **Start Wizard** (disabled when there are 0 updates), **Refresh Data**, **Sync with Store** (§11.4), **Monitor installs** (current or latest batch).
- A sync status area, an error alert (`infoError`/`appsError`/transport error) and the footer "Now Plugin Updater v1.6.6 · by Gianmario Marongiu" (built from `S.version`).
- Loaded through **one** `getHomeData` call. The data is re-fetched on Home-tab entry the first time **and whenever the user comes from the Monitor** (so KPIs are never stale after a batch).

### 14.3 Wizard Step 1 — Discover (`wizard1`)

- Entering the wizard **always clears the selection** (`S.selected={}`). It reuses Home's app data if it is less than **30 s** old, otherwise calls `getUpdatableApps`.
- With 0 apps: "All store applications are up to date." and **← Home**.
- An info box "Found N application(s)…". **Next: Select →** and **Cancel** sit **above** the table.
- **The suite panel is hidden (v1.6.6).** `renderSuitePanel()` starts with `if(true) return ''`, so the banner "<suite> <version> — N apps will be updated together" (for example Now Assist) no longer appears in Step 1 or Step 2. This restores the v1.6.3 decision (§18.3.6) that v1.6.5 had undone. The code below the early return, and `wireSuitePanel`, are kept but unreachable. Suite impact is still visible through the per-row `N more` and the confirm dialog.
- A table with sortable columns **Application · Scope · Current → Latest** (click or Enter/Space, `aria-sort`, ▴/▾). The default order is by name. The sort is shared with Step 2 (`S.wizSort`).
- A per-row **`N more ▾`** (§6.6) toggles a detail row with `name [not selectable] current → target`. Its state (`S.treeOpenW1`) is kept per scope.
- A pager (§14.8, view `w1`).

### 14.4 Wizard Step 2 — Select (`wizard2`)

- A filter bar with a text filter on name/scope (debounced 150 ms), a **scope** dropdown ("All scopes (N)" + each distinct scope, keeping the chosen value across rebuilds), **Select All** and **Clear**.
- The top action bar: **Install N updates** (disabled at 0), **← Back**, **Cancel**, the badge "N selected" and the hint "N already installing (not selectable)".
- The per-row `N more` works as in Step 1 (its own state, `S.treeOpenSel`, reset on entry). The suite panel is hidden here too (§14.3).
- Columns: checkbox · Application · Scope · Current → Latest · Status. In-flight apps (`inFlight` sys_ids) have a disabled checkbox and an `installing` pill; the others show `pending`.
- The header checkbox and **Select All** act on **all apps matching the filter across all pages**, skipping in-flight ones. Selection is a `sysId` map that lives outside rendering, so it survives paging, sorting and filtering.
- Ticking a checkbox uses delegation on the `tbody` and **does not re-render** the table (it only updates the counter and button).
- The page resets to 1 on filter, scope, sort or page-size change and on entry. Empty result: "No applications match your filter."

### 14.5 Confirm dialog

Built by `confirmModal` in `#modal-host` (`.modal-back` + `.npu-modal`, `role=dialog`, `aria-modal`). Esc or a click on the backdrop cancels, and focus goes to the confirm button.

- **Title** "Install N updates?". **Body:** "You are about to update **N** applications on **<instance>**. Installs are queued one at a time and cannot be undone. You can close the page once launching finishes — the server keeps going."
- **Selected list:** "**N** selected applications will be installed. Show all ▾" (name, current → target).
- **Impact union:** a fresh `getUpdateImpact(scopes=selection)` call. Suite and dependency results are merged and deduplicated by scope, with selected scopes removed: "**N** more applications will be updated as a result. Show all ▾". It is omitted when empty or when the call fails.
- Both lists render at most **150** entries, with "Showing 150 of N — refine your selection to see the rest."
- Buttons: **Review selection** / **Install N** → `startInstalls` (§7.3).

### 14.6 Step 3 — Launch (`wizard3`)

- An info box about launching with the user's session, a progress card "Launching… k / N" (· "M failed to launch"), a progress bar and a transient message (retry or watchdog).
- If there are launch failures: a table "N applications could not be started" (Application · Scope · Status · **Why failed** expander with "Reason reported by the platform" and the target version). This table is not paginated.
- At the end: **Go to Monitor →** and **Home**, plus an automatic jump to the Monitor when nothing failed.

### 14.7 Monitor

- A permanent info box: "Installs run on the server. You can close this page…". A filter bar with:
  - a **Batch** selector (`listBatches`: "<started> · N apps · M failed | running"; the newest batch first, at most 20, only the user's own, §10.5);
  - **Refresh now**, which sends `reconcile:1` so the server aligns the log with tracker and installed version before answering (v1.6.6, §10.3). The 15 s auto-poll does not reconcile;
  - **Cancel queued**, visible only when queued > 0. It opens a danger confirm dialog with **Keep queued** as the cancel button, then calls `cancelRemaining`. The sr-announcement is "N queued installs cancelled", plus " · K had already started and will finish" when `kept` > 0 (v1.6.6).
- Opening it: with a batch key → load that batch. Otherwise `getMyLatestBatch`, or "No install batches yet. Launch updates from the Wizard."
- **End-of-batch summary** (when the status is not running): "All updates installed" (ok) / "Finished with failures" (warn) / "All updates failed" (bad) / "Batch cancelled", with counts and **Show only failures**.
- **KPI row = status filter** (v1.6.5): **Total · Installing · Queued · Complete · Failed**, counts from the server. A click (or Enter/Space, `role=button`, `aria-pressed`) filters to that status. Clicking again or clicking **Total** clears the filter. KPIs showing 0 are inert. The active card has `.kpi-active`. "filtered by X · show all" appears in the status line. "Show only failures" sets the same state (`S.monFilter`).
- Line: "Batch status: <pill>" · "Last refreshed <local time>".
- Table columns **Application · Scope · Version (current → target) · Status · Progress (% + bar) · Details**. Sortable by name/scope/latest/status/pct (`S.monSort`). **Details / Why failed** appears only if the row has a message and expands a full-width row ("Reason reported by the platform" / "Message", plus "Started …"). The expanded state is kept per `logSysId` across polls.
- **Dependency rows** under each parent: a `dependency` badge, name, scope, `current → version` (or `→ version`), status pill and progress. There is no Details for them. They **follow the parent** under filtering and paging and never count as page slots.
- A pager (view `mon`) labelled "Showing a–b of N applications · K dependency rows" (per page; the second clause is omitted when K is 0).
- A live region (`#mon-live`, `aria-live=polite`) announces progress and the final result.
- Polling: every 15 s while installing or queued > 0. The filter and page survive polls (page clamping).

### 14.8 Pagination (v1.6.5)

- One implementation for three views (`w1`, `sel`, `mon`) with **independent** `S.page[view]` and `S.pageSize[view]`. Sizes **25/50/100/150/200**, default **25**. The label is "Applications per page".
- `clampPage` pins the page into `[1,last]` on every render (lists shrink under filters and polls). `resetPage` runs on every reorder or shrink. `pageNumbers` shows all pages up to 7, otherwise first, last, a window of 3 and ellipses.
- The pager is built as an HTML string and wired with one delegated handler per pager, plus the size `<select>`. It is not rendered when the list is empty.

### 14.9 Page background

`html,body{background:#f5f5f7;margin:0}` is the only rule outside `#app`. It is a literal copy of `--bg` (the token is declared on `#app` and is invisible from `body`). `#app{min-height:100vh;border-radius:0}` removes the white band below short views. **If `--bg` changes, change the literal too.**

### 14.10 Guide

A static card in English: Overview · Home · Wizard Discover · Wizard Select · Confirm & Launch · Launch & Monitor · Notes · Access Control, plus a version footer (`S.version`). Revised in v1.6.6: it describes pagination, the per-row *N more* links (no suite banner) and what Cancel queued really does (§19.7).

### 14.11 Client state (`S`) and main functions

State: `info`, `appData`, `selected`, `version`, `page`, `pageSize`, `PAGE_SIZES`, `whyOpen`, `launchWhyOpen`, `monFilter`, `treeOpenW1`, `treeOpenSel`, `loadedHome`, `appsFetchedAt`, and at runtime `wizSort`, `monSort`, `currentBatch`, `monData`, `monTimer`, `syncing`, `launch*`. These are leftovers that nothing reads (§19.2): `installRows`, `historyRows`, `sessionId`, `pollTimers`, `pollDeadlines`, `POLL_INTERVAL`, `POLL_TIMEOUT`, `BATCH`.

Main functions: `ajax`, `showView`, `loadHome/renderHome/kpi`, `syncStore/renderSync/finishSync/keepGoingInBackground`, `startWizard/renderWizard1`, `openSelect/renderSelect/filteredApps/buildScopeFilter/toggleApp/selectedIds/updateSelCount`, `impactData/impactRowsHtml/renderSuitePanel/wireSuitePanel/rowImpactList/rowDepCount/rowDepTreeHtml`, `confirmInstalls/selectedListHtml/confirmUnionHtml/confirmModal`, `startInstalls/renderLaunch/triggerOne/fire/handleTrigger/retryOrFail/failTrigger`, `openMonitor/loadBatchList/startMonitorPolling/pollMonitor/renderMonitor/batchSummary/cancelQueued`, pagination helpers, `init`. Utilities: `esc`, `num`, `plural`, `once`, `debounce`, `statusPill`, `announce`.

---

## 15. Lessons learned — constraints to keep

1. Extend `AbstractAjaxProcessor`, not `global.AbstractAjaxProcessor`.
2. `/api/sn_appclient/v1/appmanager/product/install` (batch) is unreliable. Use `/api/sn_cicd/app_repo/install` per app.
3. No Fluent / `require()`. Build native records.
4. **Do not** filter on `static_content` or `last_installed_from` (§8.1). Earlier versions of this list said the opposite, and measurements proved that wrong.
5. Base64 is not encryption. Store no credentials.
6. The CICD install API is **single-flight**. Launch sequentially with retry and backoff.
7. `completion_code` does not exist and `state_code` lies. The installed version is the arbiter.
8. Never use a `.modal` CSS class. Scope everything under `#app`, with the `.npu-` prefix.
9. Do not use the `sn_appclient.check.for.update` event for the sync. Use a Run Once job.
10. A duplicate `PluginUpdaterAjax` shadows the app's own copy.
11. Reset the selection on wizard (re)entry.
12. A pagination label must name its unit ("applications", "dependency rows").
13. `sys_store_app` is 403 via REST. Verify server-side.
14. The update-set export must include `sys_security_acl_role` rows and in-place payload updates (§12.2).
15. **Always rebuild from the deployed version, not from a local copy that may be stale.** v1.6.5 lost v1.6.3/1.6.4 client work this way (§19.2).

---

## 16. Acceptance criteria

- Home shows the correct release label, data center, DB, last upgrade and last sync, plus the Apps / Up to Date / Updates Available / Installing KPIs matching live data (Apps = the sum of the next two).
- Step 1 lists exactly the apps passing the three §8 filters.
- Installs start with **zero stored credentials**. New `CICDInstallWorker` rows appear, and the offering-required 400 is retried automatically.
- Installs are launched sequentially. A busy queue is retried and a lost callback never stalls the queue.
- The page can be closed after launch: `monitorBatches` finalizes every row. A row is `complete` **only** if installed ≥ target. Rows without a worker are eventually finalized (complete by version, or timed out after 60 idle minutes).
- Dependency impact: per-row expansion (dependency branch + suite membership, with a membership check), a deduplicated root-excluded union in the confirm dialog, hidden apps kept and badged, empty impact renders nothing, and cycles terminate.
- The Monitor shows observed dependency installs (`sys_execution_tracker`) with `current → target` from the snapshot.
- Pagination works in the three views independently. Selection survives paging, select-all covers the whole filtered set, and the page is clamped when a list shrinks.
- The Monitor KPI filter follows §14.7. Dependency rows are never orphaned.
- The UI renders with no build step and no JS errors. There is no white band under short views.
- The update set imports with 0 preview problems on an instance where the app does not exist, and the ACLs resolve to `admin`. Proven for v1.6.6 on Brazil after the reset of §12.4.
- The update set **upgrades the previous published release with 0 preview problems**. Check the lineage offline (§12.2) and with a real import on an instance that has the previous published XML. Proven for 1.6.5 → 1.6.6 on `democrmfalectriae163723`.
- **Not claimed:** compatibility with the Zurich family (§19.10).

---

## 17. Out of scope

Dependency pre-resolution or ordering, maintenance-window scheduling, email notifications, auto-install policies, rollback, multi-instance management, platform plugin (`com.*`) updates, category grouping (§13), a separate History view (the Monitor's batch selector covers it), and editing or deleting log rows from the UI.

---

## 18. Decision record

### 18.0 Foundational (v1.x)

1. Session auth for CICD works (`same-origin` + `X-UserToken`). There is no credential fallback.
2. The version label is parsed from `glide.buildtag`/`glide.buildname` (§5.2).
3. The reactive layer is **pure vanilla JS** (no Alpine, no petite-vue, no UI Script).
4. The palette is neutral and Apple-inspired (§14.1), not the ServiceNow brand palette.
5. The install-log table is part of the MVP.

### 18.1 Dependency impact (v1.5 → v1.5.4)

1. **Suite wins** the overlap. A scope is shown once.
2. **Confirm dialog = count + Show all**, with a 150-entry cap and an explicit note.
3. **v1.5.2:** the second branch was rebuilt on `sys_app_version` (target-version constraints) instead of `sys_store_app.dependencies`. The heuristic "May also be updated" tier was dropped.
4. **Root-exclusion only with an explicit selection** (§6.3). Applying it unconditionally emptied every dependency result (a v1.5.2 bug).
5. **v1.5.3:** the shared dependency panel was replaced by a **per-row `N more ▾`**. A flat list could not tell which root caused which app. This introduced the `dependenciesByRoot` + `dependencies` shapes.
6. **v1.5.4:** suite members also get per-row expansion, **only after a membership check** (the first attempt gave every row a spurious `8 more`).

### 18.2 Confirm dialog (v1.6)

The selection is listed by name (`selectedListHtml`), separate from the impact union. Both lists carry a cap note beyond 150.

### 18.3 Monitor & packaging (v1.6 → v1.6.4)

1. **v1.6:** observed dependency rows come from `sys_execution_tracker` (a fact, not a prediction). Home refreshes when the user comes back from the Monitor.
2. **v1.6.1:** `u_dependency_snapshot` holds the pre-install version, which the tracker never carries.
3. **v1.6.1+:** the update set is a **complete from-scratch install**, not a diff.
4. **v1.6.2/v1.6.4:** menu, module, table, labels, choice list and **ACL-role** records are tracked, so the effective role no longer depends on target defaults.
5. **No brand icon.** An inline base64 `<img>` loaded but never painted (verified with Playwright/Chromium). A `sys_attachment` icon rendered, but its bytes cannot travel in a plain XML update set. Do not retry either approach.
6. **v1.6.3:** batch fixes B1–B5, optimizations O1–O5, and the explicit sync state S1–S4 (§4, §6.7, §10, §11). Per user feedback, the **suite banner was removed** from the wizard (`renderSuitePanel` returned `''`). The row-level `N more` and the confirm dialog carried the impact. The Monitor showed a notice when a batch exceeded `ROW_CAP`.

### 18.4 v1.6.5

1. **Uniform background** (§14.9): the one rule outside `#app`, deliberately.
2. **Pagination replaces the 150-row render cap** (§14.8). The old claim that paging breaks multi-select was false: selection is keyed by `sysId` outside rendering.
3. **Monitor KPIs are a hard status filter** (not a sort), per the user's decision. It absorbs `monOnlyFailed`.
4. **Pager label names its unit** (a regression caught by a colleague: "Showing 1–2 of 2" above 8 visible rows). Pagination stays on main rows so a dependency stays with its parent. Step 1/2 keep "of N applications".
5. **Verification:** 21 assertions on the pagination helpers, 7 on the label, and browser tests on `democrmfalectriae152010` (four real batches, a forced page size of 2). The import was tested on `democrmfalectriae163723` (59 objects, 0 collisions, as an update, not from scratch).

### 18.5 v1.6.6

1. **Failures before a worker exists are detected** (§10.3). Trigger: on `sicuritaliafsmau`, `sn_appclient.upload_base_url` / `sn_appauthor.upload_base_url` had been reset by `system` to `https://disabled.service-now.com`. Every Store install failed with "Unable to download app package" (syslog: "Blocked: credentials cannot be sent to a host other than the configured apprepo"). The Application Manager failed the same way, and clearing both properties fixed it. That is a platform issue, but the app hid it: rows looked `queued` for an hour.
2. **The failed/cancelled branch now applies the version rule** (§10.2), like the `complete` branch.
3. `src/script_include/PluginUpdaterAjax.js` was rebuilt from the deployed Script Include before patching. This closes §19.1.
4. **Suite banner hidden again** in Step 1 and Step 2 (§14.3). This settles the product question left open in §19.2/§19.3. The per-row `N more` links stay. The Guide was revised.
5. **`cancelRemaining` checks before cancelling** (§4.3): target version installed → `complete`; tracker Running → `installing`; otherwise `cancelled`. It returns `{ok, cancelled, kept}`, and the UI adds "N had already started and will finish". Trigger: on Brazil, "Customer Service Case Action Status" was marked `cancelled` by **Cancel queued** while its tracker was already Running, and it installed anyway.
6. **`_reconcile(batchFilter)`** (§10.3). `monitorBatches` became a wrapper. A new pass turns recent `cancelled` rows (6 h) back to `complete` when the target is installed, because cancelling touches only the log, not the platform queue.
7. **"Refresh now" reconciles** (`getBatchStatus` with `reconcile=1`). Before, it only re-read the log, which the job updates once a minute.
8. **`listBatches` sorts explicitly**, newest first, before taking 20 (§10.5).

**Certification on Brazil** — `empgmarongiu1`, build `glide-brazil-08-25-2026__patch1-09-21-2026_10-05-2026_1244`, 2026-10-14/15.

- **Path to the instance:** v1.6.5 was installed as an upgrade (remote set `0ce5e339…`, 59 entries, 0 collisions). v1.6.6 was then deployed by writing the two fields directly, verified byte for byte against `src/`.
- **Batch 1:** 5 apps (Application spoke selector, Beans.ai Spoke, Calendar component, Carousel component, Coaching) → 5 `complete`.
- **Batch 2:** 4 apps (Activity Timer Reporting, Assignment Workbench, Compatibility Management, Customer Service Case Action Status) → all installed. Home then showed Up to Date 183, Updates Available 343. The cancelled-but-installed row (point 5) moved to `complete` on the first job cycle after the v1.6.6 deploy, through the new pass of point 6.
- **Tested OK:**
  - Home and KPIs; Sync with Store (updates `apps_last_sync_time`);
  - Step 1 and 2: paging 25/50/100/150/200, text and scope filter, selection that persists;
  - the confirm dialog ("Show all", "Review selection");
  - the Monitor: Batch dropdown, KPI filters with toggle-off, reset with Total, a zero KPI not clickable, the Cancel queued dialog with "Keep queued";
  - Polaris / Next Experience rendering (`.playwright-mcp/brazil-monitor-queued.png`), with no console errors.
- **Install queue:** installs go through `AppOperationQueue` one at a time (a `sys_trigger` job). About 3 minutes passed before the first worker. That is normal on this instance.
- **Packaging:** native merge + export (§12.2), then reset (§12.4) and a **from-scratch import on the same instance**: previewed, summary 59, inserted 58, updated 1 (the choice list), collisions 0, committed. Code byte-identical to `src/`, ACLs all `admin`, Home rendered with 0 console errors.
- **Upgrade tests and lineage fix (same day).** These were run after the re-cut described in the next point.
  - *Australia, `democrmfalectriae152010`* (Patch 7, development instance, 1.6.5 deployed directly): preview 59 / updated 51 / inserted 6 / **2 errors** "Found a local update that is newer than this one" (Script Include, UI Page). Cause: the lineage (§12.2). The local records were verified identical to the shipped 1.6.5 page and the 1.6.4 Script Include, so both were resolved with *Accept remote update* and committed. Afterwards: code byte-identical to `src/`, 9 ACL-role rows on `admin`, 1,937 log rows intact, 0 console errors. This instance keeps that first build's lineage, which is irrelevant for customers.
  - *Rebuild on the published lineage* (§12.2): reset → published 1.6.5 installed from scratch (inserted 59 / updated 0) → v1.6.6 written with `GlideRecord` → merge → export. The result is the final `NowPluginUpdater166.xml`: 366,226 bytes, remote set `01f12733…`.
  - *Customer path, `democrmfalectriae163723`* (Australia Patch 6, 1.6.4 → published 1.6.5 committed): preview **59 / updated 53 / inserted 6 / collisions 0 / 0 problems**, committed. Afterwards: code identical, descriptions v1.6.6, 1,113 log rows intact, 0 console errors. ACL roles: 9 `admin` + 4 legacy `snc_internal` from early installs (§19.6); 1.6.6 neither adds nor removes them.
  - *Clean install of the final file, `empgmarongiu1`:* **inserted 59 / updated 0 / collisions 0**, committed, code identical, 9 `admin` roles, 0 console errors.
  - *Live batch on Australia (`152010`)* — Field Service Manager Mobile 1.1.0 → 1.2.1, with dependency Field Service Mobile 29.2.3 → 29.3.3: the platform aborted it ("application depends on other applications which are not accessible at app store: Field Service Mobile:29.3.3"). The app finalized the row correctly as `failed` by the version rule, but the message only says "still at 1.1.0, below the target 1.2.1": the platform's reason was in the tracker, which was not read (§19.13).
- **Tracker failure reason (same day, §19.13) — final build.** The Script Include was rebuilt on `empgmarongiu1` on top of the first final 1.6.6, with a 1-entry delta merged with the commit set and then exported. The final `NowPluginUpdater166.xml` is 367,720 bytes, remote set `0360940c…`, Script Include SHA-256 `655a8621…`; the UI Page is unchanged. Results:
  - offline lineage: 59/59 against the published 1.6.5 and 59/59 against the first final 1.6.6;
  - `democrmfalectriae163723`, 1.6.6 → 1.6.6: 0 problems, committed;
  - `empgmarongiu1`, real **1.6.5 → 1.6.6** path (reset, published 1.6.5 inserted 59/0, then the new XML): 59 / updated 53 / inserted 6 / 0 collisions / 0 problems, committed;
  - `empgmarongiu1`, clean install: inserted 59 / updated 0 / 0 collisions, committed. 9 `admin` roles, footer v1.6.6, 0 console errors;
  - `democrmfalectriae152010` (development, first build): 0 problems thanks to the hash match (§12.2), committed. The Field Service Manager Mobile batch was relaunched and the platform aborted it again for the same reason. Pressing **Refresh now** moved the row from `installing` to `failed` immediately, without waiting for the job (the first live test of §10.3's reconcile). Its *Why failed* reads: "Install did not apply: still at 1.1.0, below the target 1.2.1 — Aborting installation of application: Field Service Manager Mobile, application depends on other applications which are not accessible at app store: Field Service Mobile:29.3.3".
- **Re-cut (same day):** the Guide copy and the two record descriptions were corrected (§19.7), and v1.6.6 was rebuilt with the same flow. The REST write of `html` was corrupted by the platform and was rewritten with `GlideRecord` (§12.1). Then the delta set, a merge with the locally committed set, a new export (an intermediate `NowPluginUpdater166.xml`, 368,247 bytes, 59 entries, later superseded by the lineage rebuild above), and the reset, which cleaned everything in **one** `execute` pass. The re-import gave the same result: **previewed 59 / inserted 58 / updated 1 / collisions 0**, 0 preview problems, committed. Verified after the commit:
  - UI Page and Script Include SHA-256 equal to `src/`, descriptions "v1.6.6";
  - 9 ACL-role rows on `admin`;
  - the Guide shows the new text, with no trace of "first 150 rows", "suite banner" or "drops the applications";
  - the footer reads v1.6.6 and the console has 0 errors.
- **Not tested live:**
  - the new check inside `cancelRemaining` (clicking Cancel while an app has already started);
  - a failed download ("Unable to download app package", point 1). It was deliberately not reproduced: both `upload_base_url` properties are empty on `empgmarongiu1`.
- **Known limit:** **Cancel queued** does not remove the operation from the platform queue (§19.12). No unverified API was used to cancel the tracker.

---

## 19. Known gaps and discrepancies (as of 2026-10-15)

First found on 2026-09-29, while reconciling this spec against `src/`, the `NowPluginUpdater16x.xml` payloads and read-only queries on `democrmfalectriae152010`. Updated after the v1.6.6 certification on Brazil. Each item says whether it is closed or still open. They are listed so the next change starts from the facts.

### 19.1 `src/script_include/PluginUpdaterAjax.js` is stale — **closed in v1.6.6**

Before v1.6.6, the local file (55 KB) predated v1.6.3. v1.6.6 rebuilt it from the deployed Script Include. Since 2026-10-15, `src/` is byte-identical to the Script Include installed from `NowPluginUpdater166.xml` (73,544 chars).

### 19.2 The v1.6.5 UI Page regressed the v1.6.3/v1.6.4 client changes

The v1.6.5 page was built from the local `src/` page, which was still on the v1.6.1/1.6.2 client base, instead of from the deployed v1.6.4 page. A diff of the `164` and `165` payloads shows v1.6.5 **lost**:

- **Sync outcome handling (S1–S3):** `followSync`/`endSync`, reading `p.outcome` (`done`/`error`), the "The Store sync failed" alert with the server message, and re-attaching to a running sync on Home load. v1.6.5 is back to inferring completion by **string-comparing** `lastSync >= startedAt`, and to giving up after 5 minutes. A failed sync is now shown as "Still running…". The instance query `htmlLIKEp.outcome` returns 0.
- **The suite banner removal** (`renderSuitePanel` returned the panel again). **Closed in v1.6.6:** the banner is hidden again (§14.3, §18.5.4).
- **The `ROW_CAP` notice**: the page ignores `d.truncated`/`d.rowsShown`. A batch of more than 500 apps paginates only the first 500, with no indication.
- **O4 cleanup**: the unused state fields and the named poll constants (`MON_POLL_MS`, `SYNC_POLL_MS`) are back as literals.

The server still returns every field the old client expects, so nothing crashes. The loss is functional (the sync error path) and informational. **Still open in v1.6.6**, except the suite banner. The v1.6.6 client changed the Monitor and the suite panel but not the sync path.

### 19.3 Suite panel: shipped, but previously removed on purpose — **closed in v1.6.6**

v1.6.6 hides it again, as v1.6.3 had decided (§14.3).

### 19.4 Choice list is missing `installing` and `cancelled`

`u_status` choices on the instance and in the XML: `queued`, `in_progress`, `complete`, `failed`. The code writes `installing` and `cancelled` too. Those values are stored, but in list and form views they show as raw values and are not offered in the choice list. `in_progress` is legacy: it is read and normalized, never written.

### 19.5 The UI Page ACL has `type=record`

The `pgi_plugin_updater` read ACL is `type=record` (on the instance and in the XML). Protecting a UI Page normally needs an ACL of the UI Page type, so this ACL may not be enforced (**to verify** on the platform). The actual protection today is the admin guard on every server method plus the admin-only menu and module.

### 19.6 Duplicate ACL-role bindings

There are 9 `sys_security_acl_role` rows, all pointing to `admin`. The create, read, write and delete install-log ACLs are each bound twice (a leftover of the v1.6.4 role-binding fix; update sets are additive). This is harmless. Cleaning it up needs security_admin elevation. **Still in v1.6.6:** both rows of each pair are in the update set, so a from-scratch install creates both (verified 2026-10-15).

Instances that received an early version also carry `snc_internal` bindings created by the platform fallback, which no update set removes. On `empgmarongiu1` there were 5 (4 install-log + 1 UI Page). They were removed only as a cascade of the reset (§12.4).

### 19.7 Stale user-facing copy — **closed in v1.6.6 (re-cut)**

The first v1.6.6 export still shipped stale passages. They were fixed, v1.6.6 was re-cut with the same version (that export had never been published), and it was re-certified on 2026-10-15 (§18.5):

- **Step 3 (Select)** said "Very long lists render the first 150 rows for speed — use **show all**…". It now describes pagination (25–200 *applications per page*; selection kept across page, sort and filter; Select All covers the whole filter).
- **Step 3 (Select)** mentioned the hidden **suite banner**. Now only the per-row *N more* links are mentioned.
- **Launch & Monitor** said Cancel queued "drops the applications still waiting in the queue". It now says what happens: rows still waiting become *cancelled* after a check; started or installed apps are kept; the platform queue is not changed, so an app it had already accepted can still install and its row turns *Complete* (§19.12).
- The `description` of the UI Page and the Script Include records said "v1.6.4". Both now start with "Now Plugin Updater v1.6.6".

Still open: the Guide notes describe the 5-minute "stops following it" sync behaviour, which is correct for the current client but tied to the §19.2 regression.

### 19.8 README is out of date

`README.md` still says **v1.4.2**, references `NowPluginUpdater140.xml`, and describes the pre-1.5 feature set ("action bar pinned to the bottom", "first 150 rows").

### 19.9 `u_product_category` unused

This is §13: implement it or drop it.

### 19.10 Compatibility

| Family | Instance | What is verified |
|---|---|---|
| Australia | `democrmfalectriae152010` (Patch 7), `democrmfalectriae163723` (Patch 6) | dependency impact (`sys_app_version`, `sys_suite_config*`), tracker (`sys_execution_tracker`), v1.6.5 browser tests. **v1.6.6 upgrade**: 1.6.5 → 1.6.6 with 0 problems on `163723` (customer path); Home, Monitor (newest batch first) and one live batch on `152010` (§18.5) |
| **Brazil** (Patch 1) | `empgmarongiu1` | **v1.6.6 certified** (§18.5): two real batches (9 apps), Monitor, `sys_execution_tracker` read by `_findWorker`, Polaris rendering, from-scratch install (§12.4) |
| Zurich | — | **not verified** |

- These are internal, undocumented tables, so each new family must be re-checked.
- The from-scratch install is now proven for **v1.6.6** (2026-10-15). For v1.6.5 it is still an inference.
- On Brazil, the first worker appears about 3 minutes after launch (`AppOperationQueue` processes one operation at a time). That is not an app error.

### 19.11 Minor behaviours worth knowing

- The **Installing** KPI on Home counts every running CICD install worker on the instance, including ones not started by this app.
- `listBatches`, `getMyLatestBatch` and `getActiveBatch` only see the **current user's** batches.
- `createBatch` silently truncates the selection to 1000 apps.
- `__npu_sync_job_id` is a single global property. It is safe only because of the sync lock.
- `rawBuild` is returned but not displayed.

### 19.13 The failure reason from the tracker is not shown when a worker exists — **closed in v1.6.6**

When the CICD worker exists, it ends `state=complete` with the generic message "Executing queued operation", which `_failMessage` drops on purpose. The real reason is only on the root `sys_execution_tracker` (`state=3`, with the same sys_id as the worker). For example: "Aborting installation of application: …, application depends on other applications which are not accessible at app store: Field Service Mobile:29.3.3". `_findWorker` reads the tracker only when the worker is missing (§10.3), so the row says just "Install did not apply: still at X, below the target Y". Observed on `democrmfalectriae152010`, 2026-10-15.

**Fix (v1.6.6, same day):** `_findWorker` also returns `id` and `source`. When the worker's message is empty or "Executing queued operation", `_failMessage` calls `_trackerFailure(pid)` and appends the root tracker's `message` if the tracker is Failed (3) or Cancelled (4). The extra read happens only for rows being marked `failed`. This needed a new Script Include build. It was written on top of the already-shipped 1.6.6 build (history `421098c8…` → `0391a7ff…` → `3f53e670…`), so that instances with either the published 1.6.5 or the first final 1.6.6 upgrade cleanly (§12.2).

### 19.12 Cancel queued and tooling anomalies (v1.6.6)

**Cancel queued is a log operation.** `cancelRemaining` does not remove the operation from the platform queue. No verified API to cancel an `AppOperationQueue` operation or a `sys_execution_tracker` was found, and none was used. An app already queued can still install. v1.6.6 limits the damage: it checks the version and tracker before cancelling, and runs the 6 h re-verify pass in `_reconcile` (§10.3), so the row then turns `complete`.

**MCP tool anomalies** (`jarvis-servicenow`, observed on `empgmarongiu1`, 2026-10-14/15):

- `preview_remote` answers "initiated" but starts nothing. Use **Preview Update Set** on the form.
- `commit_remote` with `wait:true` reports "Update set committed", but the record stays `previewed`. Use **Commit Update Set** on the form.
- `execute_background_script` does not return `gs.info` output. Verify by re-reading records, or run the script in *Scripts - Background* through the browser, which shows the output. Each call also leaves an `mcp.bg_result.*` system property, captured in the current update set.
- Writes through `execute_background_script` **are** captured in the current update set of the session (Default). They are not lost (§12.2).
- `sys_store_app` returns 403 through MCP.
- `get_record`/`query_table` on large fields (`script`, `html`, `payload`) spill to a file. Analyse them with Python.
- Platform: `deleteMultiple` on `sys_properties` is refused ("Not allowing multiple record update to sys_property"). Delete properties one by one.
- Platform: a REST write of `sys_ui_page.html` escapes `<script>` into `&lt;script&gt;` and still returns 200. Write it with `GlideRecord` (§12.1).

---

## 20. Release history (summary)

| Version | Main changes |
|---|---|
| 1.3.0 | First working build: no-build UI Page, GlideAjax, session-based CICD install, install log, monitor job |
| 1.3.1–1.3.4 | Monitor false-failure fixes on large batches; never time out while the CICD queue is active |
| 1.3.2 | Home optimized; `v_plugin` count removed |
| 1.3.3 | Store sync added; updatable filter aligned with App Manager |
| 1.3.5–1.3.7 | UI polish; fire-and-forget sync; category feature removed |
| 1.4.0 | **Installed version as sole arbiter** (`completion_code` bug), semantic compare, launch watchdog, real sync progress, confirm dialog, scope filter, cancel queued, batch summary, a11y, `getHomeData`, aggregate `listBatches`; repair script |
| 1.4.1 | `.modal` → `.npu-modal` (invisible dialog) |
| 1.4.2 | Selection reset on wizard entry |
| 1.4.3 | Sync via Run Once job (event queue 9–13 h), elapsed wait time; landing page + download counter |
| 1.5–1.5.4 | Dependency impact: suite + `sys_app_version` branches, per-row expansion, suite-member expansion |
| 1.6 | Observed dependency rows (`sys_execution_tracker`), confirm dialog lists the selection, cap notes, Home refresh from Monitor |
| 1.6.1 | `u_dependency_snapshot`; complete from-scratch update set; brand icon removed |
| 1.6.2 | Menu, module, table and labels tracked in the update set |
| 1.6.3 | Server B1–B5 / O1–O5 / explicit sync state S1–S4; suite banner removed; `ROW_CAP` notice |
| 1.6.4 | ACL-role records for the install-log ACLs; ACL payload re-alignment |
| 1.6.5 | Uniform background, pagination, Monitor KPI filter, pager label fix. **Client regression of the 1.6.3/1.6.4 client changes (§19.2)** |
| 1.6.6 | Failures before a worker exists (tracker fallback), version rule on failed/cancelled, suite banner hidden, `cancelRemaining` checks first, `_reconcile` + Refresh now reconciles, `listBatches` newest first. **Certified on Brazil**; first native merge/export and from-scratch install after an instance reset (§12.4) |
