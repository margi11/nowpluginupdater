# Now Plugin Updater — Build Specification (Implementation-Ready)

**Application name:** Now Plugin Updater · **Author:** Gianmario Marongiu

**Target:** ServiceNow custom application, **global scope**
**Audience:** Claude Code, building directly on a ServiceNow instance via the ServiceNow MCP
**Delivery model:** **No-build UI Page** + single client-callable Script Include. No bundler, no Fluent SDK, no React toolchain.

> This spec supersedes the previous `SPECS.md`. The **domain logic** in that document was correct and is preserved here almost verbatim (filters, offering retry, version verification, progress polling, lessons learned). What changed is the **delivery architecture**, which was the actual cause of failure. Read §2 before building — it explains what to *not* repeat.
>
> **Sync status (v1.4.3 shipped + v1.5 design).**
>
> - **§1–§5, §7–§18 describe the shipped application**, reconciled against `src/script_include/PluginUpdaterAjax.js` and `src/ui_page/pgi_plugin_updater.xhtml`, and **verified live on `democrmfalectriae152010`**: Scheduled Jobs (§10.2), install-log dictionary and ACLs (§9), filter behaviour (§8.1).
> - **§6 is the v1.5 dependency-impact design — validated on two releases but NOT implemented.** No `getUpdateImpact` method exists yet; its signature in §6.10 is proposed, not built.
> - **Corrected against measured data, do not revert:** the seven extra "updatable" filters (§8.1) and the use of `state_code` as a failure signal (§10.1) were both prescriptions that live data falsified.
> - **Specified but never built:** category grouping (§13), and `u_product_category` (§9) is written by nothing.
> - **Migration:** the one-off `repair_install_log_140.js` is described in §9.1.

---

## 1. Goal

A single, clean admin screen to discover, select, and install available updates for **Store applications** on the instance, replacing the per-app dance in the native Application Manager. It must show instance version and counts, drive updates through a 3-step wizard with live progress, and keep an install history.

---

## 2. Why the previous architecture failed — hard constraints for this build

These are not preferences; they are the root causes of the prior non-working implementation. Do **not** reintroduce them.

1. **No React multi-file SPA, no bundler.** The prior `app.jsx / main.jsx / components/*.jsx` structure with ES `import`s requires a build step (Vite/esbuild) that a UI Page cannot perform at serve time. This produced blank pages / module errors. → Build the UI as a **single no-build UI Page**: structured vanilla JS in an IIFE. Nothing that needs transpilation or module resolution. (A no-build micro-lib as a UI Script was allowed here originally; the shipped app does not use one — §18 decision 3.)

2. **No Fluent / `*.now.ts` deploy.** The prior lessons-learned already note Fluent modules / `require()` "may not load on all instances." → All artifacts are created as **native instance records via the ServiceNow MCP** (UI Page, Script Include, table, ACLs, navigation module).

3. **No stored credentials, no Base64 "encryption".** Base64 is reversible; a Base64 `username:password` in a system property is plaintext admin credentials. The server-side `RESTMessageV2` loopback to the instance's own CICD API also breaks on self-call SSL / wrong `glide.servlet.uri` / password rotation. → **Trigger installs client-side using the logged-in user's session** (see §7). Remove the credentials-config UI entirely.

4. **One data path, not two.** The prior "GlideAjax primary + REST Table API fallback" doubles auth/ACL surface and creates inconsistent behavior. → **All reads go through one client-callable Script Include via GlideAjax.** No REST Table API fallback.

5. **Instance version is not `glide.war`.** That property gives a raw build string, not "Australia Patch 2." → Use the version chain in §5.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  UI Page (no build):  pgi_plugin_updater.do                  │
│  Jelly shell + static HTML + design-token CSS                │
│  Vanilla JS (IIFE) — no reactive micro-lib, no UI Script      │
│  Views: Home · Wizard 1 (Discover) · Wizard 2 (Select) ·      │
│         Monitor · Guide  (no router lib)                      │
├─────────────────────────────────────────────────────────────┤
│  READS  → GlideAjax → Script Include (server)                │
│  INSTALL→ fetch() same-origin → /api/sn_cicd/app_repo/install │
│           (logged-in user session + X-UserToken, see §7)      │
├─────────────────────────────────────────────────────────────┤
│  Script Include (client_callable): PluginUpdaterAjax          │
│   extends AbstractAjaxProcessor   (NOT global.AbstractAjax…)   │
│   reads:   getInstanceInfo · getHomeData · getUpdatableApps    │
│            getUpdateImpact (§6) · getBatchStatus · listBatches │
│   batch:   createBatch · attachWorker · failRow                │
│            cancelRemaining · getActiveBatch                    │
│   store:   syncStore · getSyncProgress                         │
│   server:  monitorBatches  ← Scheduled Job, admin-guarded      │
├─────────────────────────────────────────────────────────────┤
│  Custom table (in MVP, not deferred):                         │
│   u_plugin_updater_install_log                                │
├─────────────────────────────────────────────────────────────┤
│  Scheduled Job: finalizes each install server-side, so the    │
│  can be closed after launch (outcome per §10.1)               │
└─────────────────────────────────────────────────────────────┘
```

**Components to create (all via MCP, all global scope):**

1. Application `Now Plugin Updater` (global), grouped in one update set / app for export.
2. ~~UI Script hosting Alpine.js or petite-vue~~ — **not created**: the shipped UI is vanilla JS only (§18 decision 3).
3. Script Include `PluginUpdaterAjax` (`client_callable = true`), extends `AbstractAjaxProcessor`.
4. UI Page `pgi_plugin_updater` (Jelly shell + HTML + CSS + JS).
5. Custom table `u_plugin_updater_install_log` + ACLs (**in MVP** — see §9).
6. Application menu + module linking to `pgi_plugin_updater.do`.
7. ACLs / role restriction to `admin`.

---

## 4. Script Include API (server)

`PluginUpdaterAjax extends AbstractAjaxProcessor`, `client_callable = true`, global scope.
**Constraint:** extend `AbstractAjaxProcessor` (not `global.AbstractAjaxProcessor`) — required for correct GlideAjax response handling in a global-scope app (carried over from prior lessons learned). All methods return JSON strings.

Every public method is `admin`-guarded (`gs.hasRole('admin')`) and every `sys_id` parameter is sanitised against `/^[0-9a-f]{32}$/i` before use.

**Reads**

| Method | Returns |
|---|---|
| `getInstanceInfo` | `{ versionLabel, rawBuild, instanceName, dataCenter, installsRunning, … }` — friendly version parsed per §5 |
| `getHomeData` | Home in **one** call (instance info + counters). Consolidated in v1.4.0 — do not split it back into two round-trips |
| `getUpdatableApps` | `{ apps: [{ sysId, name, scope, current, latest }], appsUpToDate, inFlight: [...] }` after the §8 filters. **No `category` field** — grouping by product category (§13) was not implemented |
| `getUpdateImpact` | dependency impact — see §6.10 |
| `getBatchStatus` | rows + progress for one batch |
| `listBatches` | batch list via **GlideAggregate**, not a row scan (v1.4.0) |
| `getActiveBatch` / `getMyLatestBatch` | resume the Monitor on (re)entry |
| `getSyncProgress` | live Store-sync progress from `sn_appclient.apps_sync_progress` |

**Writes / actions**

| Method | Purpose |
|---|---|
| `createBatch` | creates the batch and its `u_plugin_updater_install_log` rows |
| `attachWorker` | binds a `sys_progress_worker` sys_id to a row after launch |
| `failRow` | marks a row failed when the client-side launch itself fails |
| `cancelRemaining` | drops still-queued rows; running installs finish |
| `syncStore` | triggers the Store update check via a **Run Once Scheduled Job** — see §5 |

**Server-only (not client-callable)**

| Method | Purpose |
|---|---|
| `monitorBatches` | Scheduled Job entry point: polls workers, applies the §10.1 outcome rule, finalizes rows. Logs an explicit error if it runs without the `admin` role instead of failing silently |

Private helpers: `_findWorker` (multi-strategy lookup, §10), `_cmpVer` (semantic version compare), `_verify` (installed-version check, cached per run), `_failMessage`, `_batchLastActivityMs`.

There is **no** `getProgress`, `verifyVersion` or `logInstall` method: progress and verification live inside `getBatchStatus` / `monitorBatches`, and logging is done by `createBatch` + the Scheduled Job. **No `RESTMessageV2` in the Script Include** — installs are triggered from the client (§7).

---

## 5. Data sources — precise reference

| Need | Table | Query / fields |
|---|---|---|
| Active plugin count | `v_plugin` | GROUP BY `state`; count `active` + `published` |
| Updatable store apps | `sys_store_app` | see §8 filter rules; fields `name`,`scope`,`version`,`latest_version`,`update_available`,`active`,`hide_on_ui`,`install_date`,`last_installed_from`,`static_content` |
| In-flight installs | `sys_progress_worker` | `name=CICDAppRepoService$CICDInstallWorker`, `state IN pending,running` |
| Install progress | `sys_progress_worker` | by sys_id; `state`,`state_code`,`message`,`error_message`,`percent_complete` — **there is no `completion_code` field** (§10) |
| Post-install verify | `sys_store_app` | re-read `version` for the app's sys_id |
| Suite membership (§6) | `sys_suite_config` | target = `compatible=true`, highest `version`; **never rely on `installed=true`** — absent on Zurich |
| Suite app versions (§6) | `sys_suite_config_app_version_m2m` | `suite_config`, `app_scope`, `app_version` — the per-app target version behind the native *Review Installation Details* dialog |
| Dependency graph (§6) | `sys_store_app` | `dependencies` (glide_list, `scope:min_version`; `com.*:sys` = platform plugin), `update_available`, `hide_on_ui` |

> **`sys_store_app` returns HTTP 403 to the Table API** (API-level ACL) even for an admin with Basic Auth — verified on two instances. It is readable server-side, which is how the app reads it. Any verification or diagnostic script must run server-side (or through the app's own GlideAjax methods), not via REST.

**Instance version label (e.g. `Australia · Patch 2`)** — fallback chain; verify exact format on the target instance during build:

1. `gs.getProperty('glide.buildtag')` — parse release family + patch (e.g. `glide-australia-…__patchN`).
2. `gs.getProperty('glide.buildname')` — often the family name.
3. Fallback: `sys_upgrade_history.to_version` (raw build) if no friendly label can be derived.

Always display the best friendly label, with the raw build string as small secondary text so the value is never empty/meaningless.

**CICD install endpoint (called from client, §7):**
`POST /api/sn_cicd/app_repo/install?sys_id={store_app_sys_id}&version={latest_version}`
Success → `result.links.progress.id` is the `sys_progress_worker` sys_id to poll.
Offering retry → see §11.

---

## 6. Dependency impact — what else gets updated (v1.5)

**Requirement.** Before launching a batch, the admin must see the applications that will be updated *in addition to* the ones selected — the same visibility the native App Manager gives in its **Review Installation Details** dialog. Read-only: the batch still installs exactly what was selected; the platform pulls the rest in by itself.

Surfaced in **Wizard Step 2** (selection) and in the **confirm dialog** that precedes launch.

### 6.1 The field named `dependencies` is the wrong source

`sys_store_app.dependencies` (glide_list, `scope:min_version` entries) declares the floor required by the **currently installed** version, not by the target. Measured on `democrmfalectriae152010`: across all 20 updatable apps, **29 declared dependencies, 0 of which would change** — the feature would render "no dependencies" on every row.

`sn_aia` installed declares `sn_nowassist_admin:9.0.5` and has 10.2.3 → satisfied. It is the *target* 8.2.13 that may require ≥10.2.6, and that number is not in the local record — it comes from the Store payload at install time.

**Do not build the feature on version-constraint comparison.** It is structurally always satisfied.

### 6.2 Two independent mechanisms, both required

Neither one alone covers the app list. An app can fall under one, the other, or neither.

| | **Suite branch** | **Graph branch** |
|---|---|---|
| Source | `sys_suite_config` + `sys_suite_config_app_version_m2m` | `sys_store_app.dependencies` + `update_available` |
| Semantics | atomic block — the whole suite moves together | parent → child edges, resolved recursively |
| Certainty | explicit target version per app | **heuristic** (see §6.5) |
| UI label | `Will be updated` | `May also be updated` |

**Suite branch** — this is the source behind the native dialog. Verified: `sn_nava_config → 16.0.5`, `ITSM - Foundation 2.3.3 Installed`, `sn_uxc_gen_ai 13.2.5 → 13.2.9`, matching the App Manager screen field for field.

- Target suite = `sys_suite_config` where `compatible=true`, **highest `version`**.
- Members via `sys_suite_config_app_version_m2m` (`app_scope`, `app_version`).
- Per member: `app_version` > installed → *will update*; equal/lower → *already at version*; app absent → *not installed* (ignore, it will not be pulled in).
- **Never depend on the installed suite** (`installed=true`): on Zurich **no row has it**. Deriving the target from the installed suite yields `null` there. Mandatory guard, not defensive coding.

**Graph branch** — covers what suites miss. `Subscription Management v2` and `Licensing Engine` are both outside every suite, both 6.4.5 → 6.4.7, with a declared dependency between them. A suite-only implementation shows "no impact" for that row and hides the Licensing Engine update.

- BFS from each selected app over `dependencies`.
- Keep a `visited` set: **cycles are real** — 478 intercepted on Zurich. Without the guard the traversal does not terminate.
- Split entries: `com.*:sys` are **platform plugins**, not Store apps — list them separately as non-updatable leaves, never recurse into them.
- Include a node in the impact set when **`update_available=1`** — that, not the declared constraint, is the signal that its target moves.
- Flag `lockstep` when child and parent share both installed and latest version (e.g. both `6.4.5 → 6.4.7`): the strongest available signal that they move together.

### 6.3 Recursion depth is not optional

Chains are deep and single-level resolution loses most of the impact:

```
Setup Hub (sn_ia_base)          2.0.4 → 2.0.8
└── Setup Hub Content           4.0.4 → 4.0.8   ← updates
    └── Setup Hub Common        4.0.4 → 4.0.8   ← updates (lockstep)
        └── Setup Hub Config    4.0.5 → 4.0.8   ← updates
            └── Admin Center     6.2.1 (already at version)
                ├── Admin Experience Framework  5.3.0
                └── Configuration Hub           1.0.11
```

`Setup Hub Config` sits at depth 3. Single-level would surface 1 of 3 impacts. On Zurich the **deepest chain is 11 levels**: `Service Observability` resolves 21 impacts, only 2 of which are direct.

### 6.4 Deduplicate the union — never sum per row

Impact trees overlap heavily. The batch-level figure is the **union of the selected apps' trees, minus the apps already selected directly**.

| | Zurich | `democrmfalectriae152010` |
|---|---|---|
| Sum of per-row impacts | 784 | — |
| Distinct union | **200** | — |
| Inflation avoided | **74%** | — |

Summing per row would announce 784 affected applications where 200 is the truth. All four Setup Hub apps are themselves in the updatable list, so their *additional* impact is **zero** — the opposite of what a per-row sum (3+2+1+0=6) suggests, and worth telling the admin explicitly.

The expandable row shows the tree **from that app's point of view**; the shared panel and the confirm dialog show the **deduplicated union**. Two different numbers, both correct — do not wire one to the other.

### 6.5 Honest labelling — the heuristic has a real limit

The platform does not expose the target version's dependencies locally; only the Store knows them at install time. A node with `update_available=1` *may* be left untouched if the parent's new version still accepts the installed child.

- **Suite branch → `Will be updated`.** The target version is explicit per app.
- **Graph branch → `May also be updated`**, with a `Likely` marker on `lockstep` pairs.

Do not promise `Will` for graph-derived rows. Include a tooltip explaining the count differs from the native dialog: the App Manager's `143 App updates required for compatibility` includes apps **already at the required version** (`ITSM - Foundation` appears there with status `Installed`), whereas this feature counts only what changes — 9 on that instance.

### 6.6 Hidden apps are the highest-value output

Impact nodes with `hide_on_ui=1` never appear in the wizard, cannot be selected, and are updated anyway — today entirely opaque. `Process Automation Designer 29.5.6 → 29.5.8` pulls in `Diagram Builder 30.0.0 → 30.1.0`, invisible. On Zurich **76 of 200 impacted apps are hidden** — over a third.

Show them, badged as not individually selectable. Never filter them out of the impact set: `hide_on_ui` gates the *selection list*, not the *impact list*.

### 6.7 Performance — compute once, not per row

On Zurich: **243 updatable apps, 142 with impact, BFS over thousands of nodes.** Per-row traversal inside a GlideAjax transaction risks the transaction timeout.

- Load `sys_store_app` **once** into an in-memory scope-keyed index (~2.000 rows), then traverse that index — no GlideRecord query inside the BFS.
- Load the target suite's members in **one** query.
- Fold the result into the existing `getUpdatableApps` response — no second round-trip (consistent with the `getHomeData` consolidation in v1.4.0).

### 6.8 Cross-release validation

Verified on two releases. All tables and fields exist on both; nothing depends on post-Zurich metadata.

| | Zurich · Patch 11 (`sicuritaliashowcase`) | `democrmfalectriae152010` |
|---|---|---|
| `sys_suite_config` | 30 versions | 20 versions |
| `..._app_version_m2m` | 5.926 rows | 7.614 rows |
| Installed suite | **none** | `29.2.20260604` |
| Updatable apps | 243 | 20 |
| Suite-branch impact | 14 | 9 |
| Graph-branch union | 200 | 5 |
| Cycles intercepted | 478 | 0 |
| Deepest chain | 11 | 5 |
| Hidden impact | 76 | 1 |

Note the zero-cycle / low-impact profile of the smaller instance: **a single instance is not enough to validate this feature.** The cycle guard, the dedup, and the missing-installed-suite case are all invisible there.

`sys_store_app` returns HTTP 403 to the Table API (API-level ACL) on both instances — it is readable server-side, which is how the app already reads it. Any verification script must run server-side or through the app's own GlideAjax methods.

### 6.9 Degradation

- `sys_suite_config` empty or absent → suite branch yields nothing, graph branch still runs. **Silence, not an error.**
- No suite with `compatible=true` → no target suite; suite branch off.
- Dependency scope not present in `sys_store_app` → not installed, not impact; do not recurse.
- Impact set empty → render nothing at all. No empty panel, no "0 dependencies" badge.

### 6.10 Server API

Extends the §4 table.

| Method | Returns |
|---|---|
| `getUpdateImpact` (params: `scopes` — CSV of selected scopes, optional) | `{ suite: { name, version, apps: [{ scope, name, current, target, hidden }] }, graph: [{ scope, name, current, latest, depth, via, lockstep, hidden }], plugins: [scope], union: { count, scopes: [] } }` — with no `scopes`, returns the full picture for all updatable apps (Step 2 initial render); with `scopes`, the deduplicated union for that selection (confirm dialog) |

Keep it as **one** method. `sys_suite_config` is not publicly documented API — it is the data the platform itself uses, but an upgrade could change its shape. Isolating it in a single method keeps any breakage contained and easy to disable.

---

## 7. Security & install trigger (mandatory)

**No stored credentials anywhere. Remove the credentials-config UI.**

Trigger each install **client-side with the logged-in admin's session**:

```js
fetch('/api/sn_cicd/app_repo/install?sys_id=' + sysId + '&version=' + encodeURIComponent(latest), {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'X-UserToken': window.g_ck, 'Accept': 'application/json', 'Content-Type': 'application/json' }
})
```

- `X-UserToken: window.g_ck` satisfies CSRF.
- The acting admin already holds the CICD roles; no service account, no Base64, no loopback.
- Server reads (`getInstanceInfo`, `getUpdatableApps`, `getProgress`, `verifyVersion`) run under the user's session via GlideAjax.

**Validate this first during build** (§12 step 1): confirm the CICD App Repo Install API accepts session auth on the target instance. **Documented fallback only if it does not:** a **Basic Auth Credential + Connection alias** stored in the credential store (encrypted), retrieved server-side via `sn_ws.RESTMessageV2`. Never Base64 in a system property.

**Access control:** restrict the UI Page, module, and (if created) the log table to the `admin` role.

---

## 8. Filtering logic — which apps are "updatable"

**Implemented filter — three conditions**, mirroring what the Application Manager itself lists:

| Filter | Reason |
|---|---|
| `update_available = true` | Flagged as having an update |
| `active = true` | App is active |
| `hide_on_ui = false` | Not a hidden dependency (§6.6 shows these as *impact*, never as selectable rows) |

### 8.1 The seven extra filters from the prior spec were wrong — measured, do not add them

The earlier spec prescribed seven more conditions. Applying them would remove **8 of the 20 updatable apps (40%)** on `democrmfalectriae152010`, including `Platform AI Agents and Skills` — the app in the native *Review Installation Details* dialog that motivated §6.

The load-bearing claim was that `static_content = true` apps *"accept installs but never bump version"*. **Falsified by the app's own install log:** of the last 400 `complete` rows, **110 are `static_content = true` apps, with 0 failures** — every one showing a real version bump (`Value Engine 6.0.8 → 6.0.10`, `Web Components Foundation 1.4.1 → 1.5.0`, `Webviews for mobile 36.2.0 → 36.2.8`). Excluding them would hide 30 currently-updatable apps for no reason.

| Prior filter | Verdict |
|---|---|
| `static_content = false` | **Wrong.** 110 successful installs, 0 failures, on `static_content = true` apps |
| `last_installed_from = 'store'` | **Too narrow.** 3 of the 20 read `out_of_band` and update normally; 676 rows instance-wide are non-`store` |
| `install_date != ''` | **Redundant.** 0 of the 20 have it empty |
| `version != latest_version` | **Redundant.** 0 of the 20 have them equal — `update_available` already covers it |
| `name NOT LIKE @devsnc/` / `@servicenow/` | **Inert.** 0 matches among updatable apps on either instance |
| `name NOT LIKE @now-par` | **1 match** (`@now-par-components/sn-par-visualization-controls-section`) out of 243 on Zurich — cosmetic at best |

The genuine caveat is the one already in the README: a few platform-bundled apps that cannot update via the Store API may end as *Failed*. That is **accepted and visible**, not filtered away — filtering on these flags removes far more working apps than broken ones.

---

## 9. Data model (in MVP)

The table is **required**, not deferred: `createBatch` writes the batch rows and the Scheduled Job (§10.1) finalizes them, which is what lets the admin close the page mid-batch. Field types matter — the prior build got these wrong:

Table `u_plugin_updater_install_log`:

| Field | Type | Notes |
|---|---|---|
| `u_app_name` | String(255) | |
| `u_app_scope` | String(100) | |
| `u_store_app_id` | String(32) | sys_id from `sys_store_app` |
| `u_previous_version` | String(40) | |
| `u_target_version` | String(40) | |
| `u_status` | Choice | code writes `queued` · `installing` · `complete` · `failed` · `cancelled`. **The choice list also still contains a legacy `in_progress`** entry that nothing writes — safe to delete |
| `u_started_at` | **glide_date_time** | not String |
| `u_completed_at` | **glide_date_time** | not String |
| `u_triggered_by` | **Reference → sys_user** | not String |
| `u_progress_id` | String(32) | `sys_progress_worker` sys_id |
| `u_error_message` | String(1000) | |
| `u_percent_complete` | Integer | not String |
| `u_session_id` | String(32) | groups one wizard batch |
| `u_product_category` | String(100) | from §13 mapping — **defined but unused** by the shipped code; keep or drop with §13 |

### 9.1 Historical repair (v1.3.x → v1.4.0)

`src/fix_scripts/repair_install_log_140.js` reclassifies log rows that claim `complete` for installs that never applied — the fallout of the `completion_code` bug (§10.1). Run **once** in Scripts - Background after upgrading from 1.3.x.

It is a **dry run by default** (`DRY_RUN = true`): it prints what it would change without writing. Review, then set `DRY_RUN = false` and re-run. Rows whose application is no longer present are left untouched. It reclassifies a row to `failed` **only when the installed version is semantically lower than the target** — the same rule as §10.1, and it independently documents the two rejected criteria on the same 725-row measurement.

ACLs: CRUD restricted to `admin`. **Verified on the instance:** four ACLs on the table (`create`, `read`, `write`, `delete`) plus one `read` ACL on `pgi_plugin_updater`, all `active=1` with `admin_overrides=1`. The table carries **20 fields** (14 custom + 6 `sys_*`), matching this list.

---

## 10. Progress tracking (multi-strategy lookup)

`getProgress` reads `sys_progress_worker` resiliently (handles ACL/timing where a freshly-queued worker isn't yet materialized):

1. `gr.get(progressId)`.
2. else `addEncodedQuery('sys_id=' + progressId)` with `setWorkflow(false)`.
3. else query with `setQueryNoDomain(true)` if available.
4. all fail → return `{ error: 'progress worker not found' }`.

Client treats `"not found"` as **transient `running / queued`**, not an error.

Polling: every **15s**, **30-minute** timeout per app; stop polling apps in terminal state (`complete`/`failed`).

### 10.1 The installed version is the only arbiter of outcome — measured

Two field-name traps on `sys_progress_worker`, both already paid for in v1.3.7 and v1.4.0. Do not re-derive them:

1. **`completion_code` does not exist on the table.** The real field is `state_code`. Reading the wrong name returns empty, so an error branch keyed on it never fires — this is exactly why failed installs were reported as Complete until v1.4.0.
2. **`state_code` is nevertheless unusable as a failure criterion.** Measured on the target instance: the CICD worker closes with `state='complete'` **and** `state_code='error'` even when the install succeeded — **723 of 725 rows** carrying `state_code='error'` had the correct target version installed. Keying failure on it would mark hundreds of successful installs as failed: a worse false negative than the false positive it appears to fix.

**Therefore:** on `state IN (complete, success)`, ignore `state_code` entirely and re-read the app's installed version. Outcome rule, with `_cmpVer` semantic comparison (not string equality):

- installed `>=` target → **complete** (a later batch or a Store sync may legitimately have pushed the app past this batch's target)
- installed `<` target → **failed** (the update did not apply)

On `state IN (failed, error, cancelled)` → **failed**, using the worker's own message. On `running` → *installing*; on `pending`/unknown → *queued*.

### 10.2 The two Scheduled Jobs (verified on the instance)

| Job | Type | Purpose |
|---|---|---|
| `Plugin Updater - Monitor Batches` | **periodically, every 1 minute**, `active=1` | calls `monitorBatches` — this is what lets the admin close the page after launch |
| `Plugin Updater - Store Sync (once)` | **run once**, created on demand by `syncStore` | calls `sn_appclient.UpdateChecker` directly (§15.10); cleaned up by `_cleanupSyncJobs` |

The monitor job runs as a **periodic** job, not on-demand: a batch left running with the browser closed is finalized within a minute of each worker completing.

---

## 11. Offering retry (client-side)

On the install `fetch`, if HTTP 400 with body containing `Offering plugin id must be specified`:

- Parse the first id inside `[...]` in `result.error` (e.g. `[com.sn_hs_csc]` → `com.sn_hs_csc`); fallback to the `"offering":"…"` hint in the example text.
- Retry the same endpoint with JSON body `{ "offering": "<id>" }`.
- If the retry also fails, mark the app `failed` with the parsed reason.

**Implemented** in the UI Page (`fire` / `handleTrigger`): the offering retry fires **once** with the parsed id, and is combined with backoff retries for transient enqueue/mutex collisions — the CICD install API being single-flight (§15.7).

---

## 12. Build order for Claude Code

1. **Validate auth path.** Confirm `/api/sn_cicd/app_repo/install` accepts session auth (`credentials:'same-origin'` + `X-UserToken`) on the target instance. If yes, proceed credential-free; if no, switch to the credential-alias fallback (§7) — but only then.
2. **Confirm version label format.** Inspect `glide.buildtag` / `glide.buildname` and a `sys_upgrade_history` row; lock the §5 parsing to the observed format.
3. **Create the application** `Now Plugin Updater` (global) + update set.
4. **Create the Script Include** `PluginUpdaterAjax` with the §4 methods and §10 lookup.
5. **(Optional) Create the install-log table** + ACLs (§9) and `logInstall`.
6. **Create the UI Page** `pgi_plugin_updater`: Jelly shell + HTML + design-token CSS + **vanilla-JS IIFE** (no Alpine, no petite-vue, no UI Script — see §18 decision 3). Implement Home, Wizard 1 (Discover), Wizard 2 (Select), Monitor, Guide as client-side views.
7. **Wire reads** through GlideAjax; **wire installs** client-side (§7) with offering retry (§11), enqueued **one app at a time** with retry on a busy queue — the CICD install API is single-flight (§15.7).
8. **Wire dependency impact** (§6): fold `getUpdateImpact` into the `getUpdatableApps` response, render the shared suite panel and the expandable per-row tree in Step 2, and the deduplicated union in the confirm dialog. Verify on an instance with **no installed suite** and on one with **deep dependency chains** — a single instance does not exercise the cycle guard or the dedup (§6.8).
9. **Create application menu + module** → `pgi_plugin_updater.do`. (On `democrmfalectriae152010` the UI Page exists with `category=general`; the module is reachable but was not found by a `name CONTAINS 'Plugin Updater'` query — confirm the menu record when packaging the update set.)
10. **Restrict** page/module/table to `admin`.
11. **Smoke test** against §16.
12. **Package** all artifacts in the app update set.

---

## 13. Product category mapping (by scope prefix) — NOT IMPLEMENTED

> **Status: not built.** The shipped UI groups nothing by category: Step 1 is a flat sortable table and Step 2 filters by **exact scope** (a dropdown built from the scopes actually present), which proved faster than typing a prefix. `getUpdatableApps` returns no `category` field and `u_product_category` is never written.
>
> Kept as reference in case categories are revisited. If they are not, drop this section together with the `u_product_category` column (§9).

| Prefix | Category |
|---|---|
| `sn_csm`, `sn_customerservice` | CSM |
| `sn_hr` | HRSD |
| `sn_itsm`, `com_snc_itsm` | ITSM |
| `sn_itom`, `sn_em`, `sn_disco` | ITOM |
| `sn_iam`, `sn_risk`, `sn_grc` | IRM |
| `sn_sec`, `sn_si` | SecOps |
| `sn_fsm`, `sn_field_service` | FSM |
| `sn_spm`, `sn_itbm`, `sn_project` | SPM |
| `sn_cmdb` | CMDB |
| `sn_creatorworkflow`, `sn_flow` | App Engine |
| `sn_nowassist`, `sn_gen_ai`, `sn_va` | Now Assist |
| (other) | Other |

---

## 14. UI / UX specification

Clean, modern, card-based, light neutral background, generous spacing, subtle shadows, rounded corners (8–12px), system font stack, clear type hierarchy. CSS via design tokens (CSS custom properties for color, spacing, radius, shadow). Client-side view switching — no router library.

**Views:**

- **Home (Dashboard).** Prominent **instance version** (`Australia · Patch 2`) with raw build as secondary text. KPI cards: `Active plugins`, `Up to date`, `Updates available`, `In progress`. Quick actions: *Start wizard*, *Refresh*, *View history*. (No credentials card — removed by design.)
- **Wizard Step 1 — Discover.** All updatable apps (per §8) in a **flat sortable table** — name, scope, `current → latest`. Not grouped by category (§13). The step indicator reads Discover · Select · Install, where *Install* is the launch that continues in the Monitor — there is no third wizard view.
- **Wizard Step 2 — Select.** Multi-select with select-all, debounced text filter, scope filter, live selected count. In-flight apps shown but disabled. Action bar **pinned to the bottom** so *Install* stays reachable on long lists; first 150 rows render with a *show all* escape, while *Select All* applies to everything matching the filter. Checkbox ticks use event delegation — no full-table re-render. Selection state resets whenever the wizard is (re)entered.
  **Dependency impact (§6):** a shared suite panel above the table (`Now Assist Suite <version> — N apps will be updated together`, expandable) plus a per-row expandable tree; suite rows badged `Will be updated`, graph rows `May also be updated` (`Likely` when lockstep); hidden apps shown but marked not individually selectable.
- **Confirm dialog.** Before launching, names the instance and the number of applications, plus the **deduplicated** impact union (§6.4) — never a per-row sum. CSS class **`.npu-modal`, never `.modal`**: the platform's Next Experience/Polaris `.modal{display:none}` rule would otherwise win and the dialog would stay invisible.
- **Monitor.** Per-app live rows: status pill (`queued` muted · `installing` amber · `complete` green · `failed` red), progress bar + percent, message/detail. **The page can be closed after launch** — a Scheduled Job (`monitorBatches`) finalizes every row server-side, outcome per §10.1. Batch selector showing app count and outcome; end-of-batch summary with a shortcut to list only failures; *Cancel queued* drops apps still waiting while running installs finish. Status icons alongside colour, `aria-sort` on sortable headers, keyboard sorting, live region announcing progress.
- **Guide.** Short in-app usage notes.

There is no separate History view: the Monitor's batch selector covers past runs from `u_plugin_updater_install_log`.

Responsive: KPI cards wrap; wizard tables scroll horizontally on narrow viewports. Smooth, restrained transitions only.

---

## 15. Lessons learned — bake in as constraints

1. Script Include must extend `AbstractAjaxProcessor` (**not** `global.AbstractAjaxProcessor`) for correct GlideAjax responses in global scope.
2. The `/api/sn_appclient/v1/appmanager/product/install` **batch endpoint is unreliable** — use `/api/sn_cicd/app_repo/install` per app.
3. Fluent server modules / `require()` may not load on all instances — **build native records, not Fluent.**
4. `static_content=1` apps accept installs but never bump version — **filter them out** (§8).
5. `last_installed_from != 'store'` (platform-bundled) apps **cannot** update via REST — filter out (§8).
6. Base64 is not encryption — **no stored credentials** (§7).
7. **The CICD install API is single-flight.** A batch must be enqueued one app at a time, with retry on a busy queue — not fired in parallel. (The earlier "batched concurrency cap (~8)" idea was wrong and is gone from §12.)
8. **`completion_code` does not exist** on `sys_progress_worker`, and `state_code` is not a usable failure signal — the installed version is the only arbiter (§10.1).
9. **Never name a CSS class `.modal`** in a UI Page: the Next Experience/Polaris `.modal{display:none}` rule wins and the dialog silently never appears. Use a prefixed class (`.npu-modal`). Scope **all** CSS under `#app`.
10. **Do not use `gs.eventQueue('sn_appclient.check.for.update')` for the Store sync.** Measured on the target instance, that event sat in a shared queue for 9–13 hours. Use a **Run Once Scheduled Job** calling `UpdateChecker.checkAvailableUpdates()` (~112s over 1.200 apps) — picked up within seconds. Too slow to run inline inside a GlideAjax transaction.
11. **A duplicate `PluginUpdaterAjax` Script Include shadows the app's own** and makes Home return an empty response. If one pre-exists on the instance, delete the copy without the app's methods.
12. **Reset client selection state when the wizard is (re)entered** — stale `selected` entries otherwise show "N selected" with every checkbox visibly unticked (fixed in v1.4.2).

---

## 16. Acceptance criteria

- Home shows the correct friendly **version label**, active plugin count, up-to-date count, updates-available count, and in-progress count — matching live instance data.
- Wizard Step 1 lists exactly the apps passing the **three** §8 filters — mirroring the Application Manager. `static_content` and `last_installed_from` are **not** used as exclusions (§8.1): a platform-bundled app that ends *Failed* is accepted and visible, not filtered away.
- Selecting apps and starting updates triggers real CICD installs **with zero stored credentials** (new workers appear in `sys_progress_worker`).
- Offering-required 400 is handled by an automatic offering retry.
- Live progress reflects real worker state and survives the "worker not found" transient.
- Monitor reflects installs from `u_plugin_updater_install_log`, and **finishes them with the page closed** — the Scheduled Job finalizes every row server-side.
- An app is marked `complete` **only when the installed version reaches the target** (§10.1); `state_code` is never used as the failure criterion.
- **Dependency impact (§6):** Step 2 shows the suite panel and per-row trees; the confirm dialog shows the **deduplicated union**, never a per-row sum. Apps with `hide_on_ui=1` appear in the impact set (marked not selectable) and are never filtered out of it. Suite-derived rows read `Will be updated`; graph-derived rows read `May also be updated`. On an instance with no `compatible=true` suite, or with `sys_suite_config` empty, the feature renders **nothing** — no error, no empty panel (§6.9). BFS terminates on cyclic dependency graphs (§6.2) and `getUpdatableApps` stays within the transaction limit on an instance with 240+ updatable apps (§6.7).
- The UI Page renders fully with **no build step** — no blank page, no module/import errors.
- All artifacts live in the `Now Plugin Updater` global-scope app and export cleanly.

---

## 17. Out of scope (future)

Dependency pre-resolution/ordering · maintenance-window scheduling · email notifications · auto-install policies · rollback · multi-instance management. Updating **platform plugins** (vs store apps) is also out of scope.

---

## 18. Decisions — resolved during the v1.x build

All five open questions were settled by the shipped implementation. Recorded here so they are not reopened.

1. **Session auth — confirmed working.** `/api/sn_cicd/app_repo/install` accepts `credentials:'same-origin'` + `X-UserToken: window.g_ck`. The credential-alias fallback (§7) was **never needed** and no credentials are stored anywhere.
2. **Version label — parsed from `glide.buildtag`.** Family from `^glide-([a-z]+)-`, patch from `__patch(\d+)`, hotfix likewise; rendered as `Zurich · Patch 11`, with the raw build string as secondary text. Verified on two releases (§6.8).
3. **Reactive layer — pure vanilla JS.** No Alpine, no petite-vue, no UI Script. This supersedes the "Alpine.js as UI Script" note in the project brief: the shipped UI Page uses a plain IIFE with event delegation.
4. **Palette — neutral Apple-inspired**, as CSS custom properties: `--bg:#f5f5f7`, `--surface:#ffffff`, `--border:#e8e8ed`, `--text:#1d1d1f`, `--accent:#0071e3`, `--success:#34c759`, `--warning:#ff9f0a`. Not the ServiceNow brand palette.
5. **Install-log table — built, in MVP.** `u_plugin_updater_install_log` is not deferred; the Monitor and the Scheduled Job both depend on it.

### 18.1 Still open for v1.5 (dependency impact)

1. **Suite-vs-graph overlap in the UI.** An app can be reached by both branches (§6.2). Decide whether the shared suite panel or the per-row tree owns such a row, so it is not counted twice in the displayed union.
2. **Confirm-dialog verbosity** when the union is large — Zurich yields a 200-app union (§6.8). Decide between a count with a *show all* escape and a scrollable list, consistent with the 150-row cap already used in Step 2.
