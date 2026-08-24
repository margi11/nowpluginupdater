# Now Plugin Updater — Build Specification (Implementation-Ready)

**Application name:** Now Plugin Updater · **Author:** Gianmario Marongiu

**Target:** ServiceNow custom application, **global scope**
**Audience:** Claude Code, building directly on a ServiceNow instance via the ServiceNow MCP
**Delivery model:** **No-build UI Page** + single client-callable Script Include. No bundler, no Fluent SDK, no React toolchain.

> This spec supersedes the previous `SPECS.md`. The **domain logic** in that document was correct and is preserved here almost verbatim (filters, offering retry, version verification, progress polling, lessons learned). What changed is the **delivery architecture**, which was the actual cause of failure. Read §2 before building — it explains what to *not* repeat.
>
> **Sync status (v1.6.0 shipped).**
>
> - **§1–§18 describe the shipped application**, reconciled against `src/script_include/PluginUpdaterAjax.js` and `src/ui_page/pgi_plugin_updater.xhtml`, and **verified live on `democrmfalectriae152010`**: Scheduled Jobs (§10.2), install-log dictionary and ACLs (§9), filter behaviour (§8.1), dependency impact (§6), per-row dependency tracking from `sys_execution_tracker` (§10.3).
> - **v1.6 adds three admin-visibility fixes, all UI/data-shape only — no change to §6/§7/§8's core logic.** (1) The confirm dialog now names the *selected* apps in their own expandable list, not just a bare count (§14, §18.3.3). (2) The Monitor shows the dependency apps the platform actually installed alongside each row, read from `sys_execution_tracker` — an observed fact, not the §6 prediction (§10.3, §14). (3) Returning Home from the Monitor tab now force-refreshes the dashboard data (§14) so KPI counters never show a stale pre-batch state.
> - **v1.6 also closes a silent-truncation bug in the confirm dialog** (§18.3.3): both of its expandable lists rendered at most 150 rows with no indication a real total was higher — inconsistent with the `capNote()` pattern already used in Step 1/2. Fixed with the same "Showing N of M" wording.
> - **v1.6 documents, rather than resolves, a compatibility gap: the current dependency-impact mechanism (§6, `sys_app_version` + `sys_suite_config`) and the v1.6 tracker mechanism (§10.3, `sys_execution_tracker`) have only been verified on `democrmfalectriae152010` (Australia family). Neither has been verified on Zurich** — see §18.3.4. Do not represent this build as Zurich-compatible without that verification.
> - **§6 (dependency impact) is implemented as two certain branches — not suite + heuristic.** `getUpdateImpact` on `PluginUpdaterAjax` runs a **suite branch** (`sys_suite_config`) and a **dependency branch** that mirrors the platform's own DependencyProcessor (the logic behind the native Application Manager's Update button): for each app's *target* version, read `sys_app_version` (not `sys_store_app.dependencies` — see §6.1) and recurse only where installed < required, stopping at the first satisfied node. Both branches carry an explicit version constraint against the target, so **both render with identical certainty** — v1.5's `Will be updated` / `May also be updated` distinction is gone; there is no heuristic tier. Folded into `getUpdatableApps` (§6.7) and shown identically in **Step 1 and Step 2** (not Step 2 only, as in v1.5).
> - **v1.5's dependency-graph branch (BFS over `sys_store_app.dependencies`, "May also be updated") was removed and replaced, not just relabeled.** It walked the *installed* version's floor, not the target's, with no version check — measured live, that surfaced 19 unrelated Platform Analytics sub-components for "Content Understanding" (real `update_available=1` rows, reached only through a 40+-dependency hub app, with zero relevance to Content Understanding itself). The replacement dependency branch, measured on the same instance, correctly returns *zero* impact for Content Understanding (its 3 direct deps already satisfy its own target) and exactly 3 apps for Setup Hub (`Setup Hub Content → Common → Config`, terminating at Admin Center instead of continuing into unrelated apps).
> - **v1.5.2's shared dependency-branch summary panel was replaced by per-row expansion in v1.5.3** (§18.3.1) — a flat "N dependent apps" list gave no indication of *which* row caused *which* downstream app. Each table row that has dependency-branch impact now shows its own `N more ▾`, e.g. `Subscription Management v2` → `Licensing Engine`; `Setup Hub` → `Setup Hub Content/Common/Config`.
> - **v1.5.4: every row that is itself a suite member also gets its own per-row `N more ▾`**, expanding to the *other* members of the same suite (§18.3.2) — mirroring the native Application Manager, where clicking Update on **any** suite member opens the identical suite dialog. Before this, a suite-only row like `ServiceNow Otto AI Agents` (no dependency-branch impact of its own) showed no expansion at all, even though the native dialog for that exact app lists its 8 suite siblings — confirmed by comparing directly against the native dialog's own output for that app. **A first attempt at this fix shipped a real bug** (caught in the smoke test before this text was written, not after): it added the suite's other members to a row's expansion whenever the suite existed, without checking that *that specific row* was a member — every non-suite row (`Theme Builder`, `AI Experience Framework`, …) briefly showed a spurious `8 more`/`9 more`. Fixed by checking membership first (§18.3.2).
> - **§18.1 open questions — resolved, see §18.2. §18.3 records the v1.5.2 replacement decisions; §18.3.1 records the v1.5.3 UX correction; §18.3.2 records the v1.5.4 fix and the bug caught while shipping it.**
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

## 6. Dependency impact — what else gets updated (v1.5.2)

**Requirement.** Before launching a batch, the admin must see the applications that will be updated *in addition to* the ones selected — the same visibility the native App Manager gives in its **Review Installation Details** dialog. Read-only: the batch still installs exactly what was selected; the platform pulls the rest in by itself.

Surfaced in **Wizard Step 1** (discover), **Step 2** (selection), and in the **confirm dialog** that precedes launch — all three read the same two branches described below.

### 6.1 Two version-constraint sources, and why only one of them is real per app

`sys_store_app.dependencies` (glide_list, `scope:min_version` entries) declares the floor required by the **currently installed** version, not by the target. Measured on `democrmfalectriae152010`: across the 20 updatable apps, walking this field with no version check surfaced impact that has nothing to do with the app being inspected — see §6.1.1. **Do not build the feature on this field's version constraint**, and do not BFS over it — it is structurally the wrong graph to walk.

The correct source for a **target-version** constraint is **`sys_app_version`**: one row per `(scope, version)`, where `version` is a version that has existed as a *target* (i.e. the version an install would move an app to), and its own `dependencies` glide_list declares what *that specific version* requires — not what the currently-installed version requires. This is the same table the native App Manager's `DependencyProcessor` reads when resolving what an Update click will pull in.

```
sys_app_version where scope='sn_docintel_gen_ai' and version='7.0.5'  (the target)
  dependencies: sn_docintel:8.0.9, sn_docintel_iframe:1.0.4, sn_generative_ai:14.2.2, com.glide.*:sys
```

Compare each declared `minVersion` against the dependency's *installed* version (`sys_store_app.version`): if installed ≥ required, the platform will not touch that app as part of this chain — **stop, do not recurse into it**. If installed < required, include it, and recurse into *its own* target version's `sys_app_version` row (its own `latest_version`) to keep resolving the chain.

#### 6.1.1 The v1.5 graph branch was wrong, not just approximate

The original v1.5 design BFS'd `sys_store_app.dependencies` (installed-version floor) breadth-first with no version check, labelling the result "May also be updated". Measured live: for "Content Understanding" (`sn_docintel_gen_ai`, 7.0.4→7.0.5) that produced **19 unrelated `sn-app-par-*` / Platform Analytics sub-components** — real `update_available=1` rows, reached only because one of Content Understanding's dependencies (`Generative AI Controller`, itself already at its required version and therefore a dead end under the §6.1 rule) declares **40+** of its own dependencies, one of which is Platform Analytics, which has its own long tail. None of that tail has anything to do with Content Understanding. This was not a labelling problem — the heuristic label was hiding a wrong result, not a fuzzy-but-useful one.

Rebuilt against `sys_app_version` (§6.1), the same app correctly resolves to **zero** dependency-branch impact: its three direct dependencies are already at the versions its own target requires, so the BFS terminates at depth 1 for all three. The suite branch (§6.2) is what actually explains its 8 sibling apps in the native dialog.

### 6.2 Two independent, both-certain branches

An app can fall under one, the other, both, or neither.

| | **Suite branch** | **Dependency branch** |
|---|---|---|
| Source | `sys_suite_config` + `sys_suite_config_app_version_m2m` | `sys_app_version`, recursive, per §6.1 |
| Semantics | atomic block — the whole suite moves together | parent → child edges resolved against each node's own target |
| Certainty | explicit target version per app | **also explicit** — every included node has a version constraint against the target that the installed version fails |
| UI label | `Will be updated` (uniform — no heuristic tier) | same |

**Suite branch** — this is the source behind the native dialog's suite block. Verified: `sn_nava_config → 16.0.5`, `sn_uxc_gen_ai 13.2.5 → 13.2.9`, `sn_docintel_gen_ai 7.0.4 → 7.0.5` (Content Understanding, a member despite not itself declaring any of its 8 siblings as a `sys_store_app.dependencies` entry — suite membership is a separate, orthogonal signal from the dependency graph), matching the App Manager screen field for field.

- Target suite = `sys_suite_config` where `compatible=true`, **highest `version`**.
- Members via `sys_suite_config_app_version_m2m` (`app_scope`, `app_version`).
- Per member: `app_version` > installed → *will update*; equal/lower → *already at version*; app absent → *not installed* (ignore, it will not be pulled in).
- **Never depend on the installed suite** (`installed=true`): not reliably populated. Deriving the target from the installed suite risks `null`. Mandatory guard, not defensive coding.

**Dependency branch** — covers what suites miss. `Subscription Management v2` and `Licensing Engine` are both outside the suite, both 6.4.5 → 6.4.7, with `sn_sub_man`'s target version declaring `sn_entitlement:6.4.7` in `sys_app_version`. A suite-only implementation shows "no impact" for that row and hides the Licensing Engine update.

- BFS from each root, resolving `sys_app_version[scope@targetVersion].dependencies`, recursing only past nodes where installed < required (§6.1).
- Keep a per-root `visited` set: **cycles are real**. Without the guard the traversal does not terminate.
- `com.*` entries are **platform plugins**, not Store apps — collected separately, never recursed into.
- No `lockstep` concept in v1.5.2 — both branches are equally certain, so there is nothing to flag as "likely" versus "will".

### 6.3 Recursion depth is not optional

Chains are deep and single-level resolution loses most of the impact. Verified live on `democrmfalectriae152010` (dependency branch, rooted at `Setup Hub`, target `2.0.8`):

```
Setup Hub (sn_ia_base)          2.0.4 → 2.0.8    ← itself a root elsewhere in the same list (§6.3.1)
└── Setup Hub Content           4.0.4 → 4.0.8    ← updates
    └── Setup Hub Common        4.0.4 → 4.0.8    ← updates
        └── Setup Hub Config    4.0.5 → 4.0.8    ← updates
            └── Admin Center     6.2.1 (already at 6.2.1 — STOP, no recursion)
```

`Setup Hub Config` sits at depth 3. Single-level would surface 1 of 3 impacts.

#### 6.3.1 A root can also be another root's impact — this is correct, not a bug

`Setup Hub` and `Licensing Engine` are each independently updatable (they're rows in Step 1's own list) **and** each is also the dependency-branch impact of a *different* root (`ServiceNow Otto for Setup Core` declares `sn_ia_base:2.0.8`; `Subscription Management v2` declares `sn_entitlement:6.4.7`). In the **unfiltered view** (Step 1/2, roots = every updatable app), do **not** exclude an app from the impact list just because it is itself a root elsewhere — that would hide real impact (§6.3.2 explains why the exclusion is right in a different context). In the **confirm dialog** (roots = only the admin's selection), exclude the selected roots from the result, since the dialog's framing is "N *more* apps beyond what you picked".

#### 6.3.2 The root-exclusion bug (found and fixed during the v1.5.2 build)

An early v1.5.2 draft applied the confirm-dialog exclusion rule (§6.3.1) unconditionally, including in the unfiltered view — where roots = all ~20 updatable apps. Since `Setup Hub Content/Common/Config` are themselves updatable (hence also roots), the filter silently discarded every dependency-branch result: `dependencyScopes` measured empty for every app, despite the underlying BFS logic being correct in isolation (confirmed by replaying the same traversal manually against live data). The fix: apply the root-exclusion filter **only** when the caller passed an explicit `sysparm_scopes` selection.

### 6.4 Deduplicate the union — never sum per row

Impact sets across both branches overlap. The batch-level figure the confirm dialog shows is the **union of the selected apps' impact (suite + dependency branch), deduplicated by scope, minus the apps already selected directly**.

Measured live: selecting all 20 updatable apps together on `democrmfalectriae152010` yields a union of exactly 20 apps beyond the selection (9 suite + the dependency-branch scopes not already suite members) — confirmed via the confirm dialog's "N more applications… Show all" list.

Suite membership takes priority when a scope appears in both branches: an app already accounted for by the suite branch is never duplicated into the dependency-branch result, so the union counts it once.

### 6.5 No heuristic tier — v1.5.2 correction

v1.5 shipped a `Will be updated` / `May also be updated` distinction, with the graph branch always the uncertain one. That distinction is now **gone**: both branches, as rebuilt in §6.1–§6.2, carry an explicit version constraint against the *target*, so both are shown with identical framing — matching the native dialog, which badges every row the same way regardless of which mechanism (suite or per-app dependency) produced it.

### 6.6 Hidden apps are still shown, never selectable

Impact nodes with `hide_on_ui=1` never appear in the wizard's selectable table, and are updated anyway. Show them in the impact panels, badged as not individually selectable. Never filter them out of the impact set: `hide_on_ui` gates the *selection list*, not the *impact list*.

### 6.7 Performance — compute once, not per root

- Load `sys_store_app` **once** into an in-memory scope-keyed index (installed version, latest/target version, `hide_on_ui`, `update_available`) — no GlideRecord query inside either branch's traversal.
- Load `sys_app_version` **once** into a `"scope@version" → dependencies` index (5.195 rows measured on `democrmfalectriae152010`) — the dependency branch looks up this index per BFS step, never queries.
- Load the target suite's members in **one** query.
- Fold the result into the existing `getUpdatableApps` response — no second round-trip (consistent with the `getHomeData` consolidation in v1.4.0).
- A root's own target version (needed to seed its BFS) is read from the already-loaded `sys_store_app` index's `latest_version` field — an earlier draft queried `sys_store_app` again per root inside the loop; fixed to read from the index instead.

### 6.8 Cross-instance validation

Verified live on `democrmfalectriae152010` (Australia · Patch 5): 20 updatable apps, one `Now assist` suite (highest version `29.5.20260820`) with 9-app impact, `sys_app_version` with 5.195 rows. Two independent chains confirmed by manual server-side replay before being trusted in the shipped code:

| Root | Suite impact | Dependency-branch impact |
|---|---|---|
| Content Understanding (`sn_docintel_gen_ai`) | 8 sibling apps (via suite membership) | **0** — all 3 direct deps already satisfy their required versions |
| Setup Hub (`sn_ia_base`) | 0 (not a suite member) | **3** — `Setup Hub Content → Common → Config`, terminating correctly at Admin Center |

`sys_store_app` returns HTTP 403 to the Table API (API-level ACL) — it is readable server-side, which is how the app reads it. Any verification script must run server-side (`servicenow_execute_background_script` or equivalent) or through the app's own GlideAjax methods, not via REST.

A single instance does not exercise every edge case (e.g. cycles, or an installed suite) — treat this instance's profile as a floor, not a ceiling, for what the feature must handle.

### 6.9 Degradation

- `sys_suite_config` empty or absent → suite branch yields nothing, dependency branch still runs. **Silence, not an error.**
- No suite with `compatible=true` → no target suite; suite branch off.
- Dependency scope not present in `sys_store_app` → not installed, not impact; do not recurse.
- No `sys_app_version` row for a node's exact target version → nothing further to resolve past that node; stop, do not error.
- Impact set empty → render nothing at all. No empty panel, no "0 dependencies" badge.

### 6.10 Server API — implemented

Extends the §4 table. **Built** on `PluginUpdaterAjax` and folded into `getUpdatableApps` (as `result.impact`) so Step 1 and Step 2's initial render cost no extra round-trip.

| Method | Returns |
|---|---|
| `getUpdateImpact` (param: `sysparm_scopes` — CSV of selected scopes, optional) | `{ suite: { name, version, apps: [{ scope, name, current, target, hidden }] } \| null, dependenciesByRoot: { [rootScope]: [{ scope, name, current, target, hidden }] } \| null, dependencies: [{ scope, name, current, target, hidden }] \| null }` |

Two dependency-branch shapes, for two different consumers (§18.3.1):

- **`dependenciesByRoot`** — per-root breakdown, keyed by the scope that *causes* the impact (e.g. `dependenciesByRoot['sn_sub_man'] = [{ scope: 'sn_entitlement', name: 'Licensing Engine', … }]`). Drives Step 1/2's per-row `N more ▾` expansion (§14). **Never** filtered by root-exclusion — a row's own breakdown must show everything it pulls in, even if some of those apps are also independently-updatable roots elsewhere in the same list (§6.3.1).
- **`dependencies`** — the deduplicated union across *all* roots (§6.4), used only by the confirm dialog. This one **is** subject to root-exclusion when `sysparm_scopes` is present (§6.3.2) — the dialog's framing is "N more beyond what you picked."

With no `scopes`, both branches run over every updatable app (Step 1 / Step 2 initial render). With `scopes`, both branches are restricted to roots within the selection; only `dependencies` (the union) has roots excluded from it — `dependenciesByRoot` still reports every root's own breakdown, since Step 1/2 read from it unconditionally regardless of any selection state.

Implementation notes (measured live on `democrmfalectriae152010`, §6.8):

- `sys_store_app` and `sys_app_version` are each loaded **once** into in-memory indexes (§6.7); both branches walk those indexes — no GlideRecord query inside either loop.
- Target suite = highest-`version` row with `compatible=true`; per-member impact requires `app_version` (m2m) to be semantically **greater** than the member's installed version (§6.2) — members already at version, or below the m2m's, are not shown.
- Dependency branch keeps a per-root `visited` set (cycle guard, §6.2); `com.*` dependency entries are skipped, never recursed into.
- **Overlap rule: suite wins.** A scope claimed by the suite branch is excluded from the dependency-branch result (both shapes) — never shown twice.
- Root-exclusion (§6.3.1, §6.3.2) applies only to the `dependencies` union, conditional on `sysparm_scopes` being present. `dependenciesByRoot` is never filtered by it.

Kept as **one** method. `sys_suite_config` and `sys_app_version` are not publicly documented API — they are data the platform itself uses, but an upgrade could change their shape. Isolating them in a single method keeps any breakage contained and easy to disable.

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

### 10.3 Dependency install tracking, per row (v1.6) — `sys_execution_tracker`

**Requirement.** The Monitor must show which dependency applications the platform actually installed alongside each selected app — not a pre-launch prediction (that's §6's `getUpdateImpact`), a fact observed after the fact.

**Mechanism.** `AppUpgrader.upgradeProcess()` — the same code path behind the native Application Manager's Update button — starts a `GlideScriptedHierarchicalWorker`; the returned `getProgressID()` is the `sys_progress_worker` sys_id the app already stores as `u_progress_id`. That worker's progress tree is written to **`sys_execution_tracker`**, a self-referencing table (`parent` → `sys_execution_tracker`) with `state` (0 Pending, 1 Running, 2 Successful, 3 Failed, 4 Cancelled) and `percent_complete`.

**Verified live on `democrmfalectriae152010` — the root node's sys_id is the SAME as the `sys_progress_worker`'s.** Confirmed for two independent workers (a `CICDAppRepoService$CICDInstallWorker` created by this app, and an unrelated `auto-upgrade-*` worker): `sys_execution_tracker.get(<the sys_progress_worker's own sys_id>)` returns a row directly — no join table, no lookup field needed.

Every application `GlideAppLoader` actually installs — the requested app **and** any dependency the platform pulled in because it wasn't already at the required version (§6.1's `_appAlreadyExist()` + `VersionComparator.isUpgrade()` check happens before this tree is built — a dependency already satisfied never gets a node here) — gets its own descendant node named exactly `Installing application <scope>:<version>`. Measured tree shape varies (2–3 levels: root → `"Installing application package"` → `"Installing application <scope>:<version>"`, or root → `"Plugins Loading"` → …), so the lookup walks the **whole subtree**, not just direct children.

Live-verified case: a batch that requested only `Subscription Management v2` (`sn_sub_man`) produced a tree with exactly one dependency node — `Installing application sn_entitlement:6.4.7` (Licensing Engine) — matching §18.3.1's prediction from `getUpdateImpact`, but this time as an observed fact with real `state`/`percent_complete`, read after the install actually ran.

**Extraction (`_dependencyRowsFromTracker`, server-side):** BFS from the row's `u_progress_id`, matching each descendant's `name` against `/^Installing application ([A-Za-z0-9_.]+):(.+)$/`; skip the row's own scope (that's the requested app, not a dependency); dedupe by scope. Friendly names are resolved in **one** `sys_store_app` query per `getBatchStatus` call across all rows' dependency scopes combined (§6.7-style — no query per row). `guard < 500` node visits caps runaway traversal on a corrupted/cyclic tree, though none has been observed.

**Degradation:** no `u_progress_id` (row never got a worker attached) → empty dependency list, no error. No matching descendant nodes (dependency already satisfied, or the row's own install hasn't started writing tracker nodes yet) → empty list, not a placeholder.

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
8. **Wire dependency impact** (§6) — **done, rebuilt in v1.5.2, UX-corrected in v1.5.3 and v1.5.4.** `getUpdateImpact` runs a suite branch and a `sys_app_version`-based dependency branch (§6.1, §6.2), folded into the `getUpdatableApps` response. The suite panel renders identically in **Step 1 and Step 2** as one shared summary (v1.5 shipped it in Step 2 only). Per-row `N more ▾` expansion on each affected table row (§18.3.1) covers BOTH the dependency branch AND suite membership (§18.3.2) — a row that is itself a suite member expands to its siblings, mirroring the native App Manager where clicking Update on any suite member opens the identical suite dialog. The confirm dialog shows the deduplicated union across both branches (§18.2, §18.3). Smoke-tested live on `democrmfalectriae152010`: no installed suite (`installed=true` absent on every `sys_suite_config` row, confirming the §6.2 guard is load-bearing); `Content Understanding` and `ServiceNow Otto AI Agents` (both suite-only, no dependency-branch impact) each expand to their 8 suite siblings, matching the native dialog exactly; `Setup Hub`'s row expands to exactly `Setup Hub Content`, `Setup Hub Common`, `Setup Hub Config`; `Subscription Management v2`'s row expands to exactly `Licensing Engine`; rows with neither suite membership nor dependency-branch impact (e.g. `Theme Builder`) show no expansion. §18.3.2 documents a suite-membership false-positive bug caught in the smoke test and fixed before this was considered done.
8a. **Wire per-row dependency tracking (v1.6, §10.3)** — `_dependencyRowsFromTracker` walks `sys_execution_tracker` from each row's `u_progress_id`, folded into `getBatchStatus`'s `deps` array; rendered as indented dependency rows in the Monitor (§14). **Wire the confirm-dialog selected-apps list and both dialogs' 150-row cap-notes (§18.3.3).** **Wire Home's forced refresh on return from Monitor (§14).**
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
  **Dependency impact (§6) — implemented, shown here too (v1.5.4).** A **suite-only** shared panel renders above the table (`<suite name> <version> — N apps will be updated together`, expandable via `Show apps`/`Hide apps`) — the suite is a single atomic block with one target, so one summary badge reads unambiguously. There is **no shared panel for anything else** (§18.3.1): instead, every table row that has impact — from the dependency branch (§6.10's `dependenciesByRoot`), from suite membership, or both — gets its own `N more ▾` link next to the app name, opened via event delegation on the table body, expanding a detail row directly beneath it that lists exactly what *that row* causes. A suite-member row's expansion lists its suite siblings (mirroring the native App Manager, where clicking Update on **any** suite member opens the same suite dialog — §18.3.2), e.g. `ServiceNow Otto AI Agents` shows `8 more ▾` → its 8 `Now assist` siblings; a dependency-branch root's expansion lists what it pulls in, e.g. `Subscription Management v2` shows `1 more ▾` → `Licensing Engine`; a row that is both (e.g. `ServiceNow Otto for Setup Core`) shows the merged count (`12 more ▾` = 8 suite + 4 dependency-branch). Multiple rows can be expanded at once; state is tracked per view (`S.treeOpenW1` / `S.treeOpenSel`) and resets whenever the wizard is (re)entered. Every panel and every per-row detail use the identical `current → target` framing (§6.5: no heuristic tier). Hidden apps show a `not selectable` badge but are never filtered out.
- **Wizard Step 2 — Select.** Multi-select with select-all, debounced text filter, scope filter, live selected count. In-flight apps shown but disabled. Action bar **pinned to the bottom** so *Install* stays reachable on long lists; first 150 rows render with a *show all* escape, while *Select All* applies to everything matching the filter. Checkbox ticks use event delegation — no full-table re-render. Selection state resets whenever the wizard is (re)entered.
  **Dependency impact (§6)** — the same suite panel and the same per-row `N more ▾` expansion as Step 1, sharing the render/wire functions (`renderSuitePanel`/`wireSuitePanel`, `rowDepCount`/`rowDepTreeHtml`/`rowImpactList`), parameterised only by a DOM-id prefix so the two views' toggle state doesn't collide.
- **Confirm dialog.** Before launching, names the instance and the number of applications, then two separate expandable lists (v1.6 — §18.3.3):
  1. **Selected applications** — the apps the admin directly picked, by name and `current → target`, via `selectedListHtml()`. Before v1.6 this was a bare count ("N applications"); the admin had no way to see *which* apps without cancelling back into Step 2. Same `N selected applications will be installed` / `Show all ▾` mechanics as the list below, independent toggle state (`#confirm-selected-list` / `#confirm-selected-toggle`).
  2. **Dependency impact** — the **deduplicated** impact union (§6.4): suite branch + dependency branch merged by scope, minus the apps already selected directly, never a per-row sum — fetched from `getUpdateImpact` with the selected scopes at confirm time. A compact `N more applications will be updated as a result` line with a `Show all ▾` toggle (`#confirm-union-list` / `#confirm-union-toggle`).

  Both lists render at most 150 rows and, when the real count exceeds that, append a `Showing 150 of N — refine your selection to see the rest` note (`.cap-note-inline`) instead of silently dropping the remainder — the same wording Step 1/2's own `capNote()` uses. Before this fix (caught by asking what happens above ~50 selected apps with hundreds of dependencies) both lists capped at 150 with no indicator at all. CSS class **`.npu-modal`, never `.modal`**: the platform's Next Experience/Polaris `.modal{display:none}` rule would otherwise win and the dialog would stay invisible.
- **Monitor.** Per-app live rows: status pill (`queued` muted · `installing` amber · `complete` green · `failed` red), progress bar + percent, message/detail. **The page can be closed after launch** — a Scheduled Job (`monitorBatches`) finalizes every row server-side, outcome per §10.1. Batch selector showing app count and outcome; end-of-batch summary with a shortcut to list only failures; *Cancel queued* drops apps still waiting while running installs finish. Status icons alongside colour, `aria-sort` on sortable headers, keyboard sorting, live region announcing progress.
  **Dependency rows (v1.6 — §10.3).** Directly beneath a batch row, if the platform actually pulled in dependency apps to satisfy that install, each gets its own indented row: a `dependency` badge, the friendly name, `→ target version`, status pill, and progress bar/percent — read from `sys_execution_tracker` via `getBatchStatus`'s `deps` array, not predicted. No Details column (the tracker carries state/percent, not a human-readable error message). A row with no tracker-derived dependencies (already satisfied, or the tracker hasn't written nodes yet) shows nothing extra — no placeholder row.
  **Home auto-refresh on return (v1.6).** Clicking the Home tab while the Monitor view is active forces a data refresh (instance info, KPI counters) even if Home was already loaded earlier in the session — otherwise the KPI cards (e.g. `Updates available`) kept showing the pre-batch count until the admin clicked *Refresh* by hand.
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
- **Dependency impact (§6) — met, v1.5.4 mechanism.** Step 1 and Step 2 both show the suite panel (shared summary) and per-row `N more ▾` expansion covering both dependency-branch impact and suite membership (§18.3.1, §18.3.2); the confirm dialog shows the **deduplicated union**, never a per-row sum. Apps with `hide_on_ui=1` appear in the impact set (marked not selectable) and are never filtered out of it. Both suite-derived and dependency-derived rows read with **identical certainty framing** — no heuristic tier (§6.5), since the dependency branch is now built against `sys_app_version` target-version constraints (§6.1), not the installed-version floor. On an instance with no `compatible=true` suite, or with `sys_suite_config` empty, the suite panel renders **nothing** — no error, no empty panel (§6.9); the dependency branch is independent and still runs. BFS terminates on cyclic dependency graphs (§6.2) via a per-root `visited` set. Root-exclusion applies only to the confirm dialog's deduplicated union when an explicit selection is present, never to the per-row `dependenciesByRoot` breakdown in the unfiltered Step 1/2 view (§6.3.1, §6.3.2 — a real bug found and fixed during this build). A row's per-row expansion includes its suite siblings only when that row is itself confirmed a suite member — the initial v1.5.4 implementation skipped this check and gave every row a spurious expansion, caught immediately in the smoke test (§18.3.2). Verified live on `democrmfalectriae152010`: `Content Understanding` and `ServiceNow Otto AI Agents` each expand to their 8 suite siblings (0 of their own dependency-branch impact); `Setup Hub`'s row expands to exactly `Setup Hub Content`, `Setup Hub Common`, `Setup Hub Config`; `Subscription Management v2`'s row expands to exactly `Licensing Engine`; non-member, non-dependency rows (e.g. `Theme Builder`) show no expansion.
- The UI Page renders fully with **no build step** — no blank page, no module/import errors.
- All artifacts live in the `Now Plugin Updater` global-scope app and export cleanly.
- **Confirm dialog (v1.6) — met.** Shows the selected apps in their own expandable list (`selectedListHtml()`) separate from the deduplicated dependency-impact union, so the admin can see both which apps they picked and what else will be pulled in before committing. Both lists show a `Showing 150 of N` cap-note when the real count exceeds 150 rows, instead of silently truncating (§18.3.3).
- **Monitor dependency rows (v1.6) — met.** Each batch row that caused a dependency install (per §10.3's `sys_execution_tracker` extraction) shows that dependency as its own indented row with a `dependency` badge, name, target version, live status pill, and progress — an observed fact from the tracker, not the §6 prediction. Verified live: `Subscription Management v2`'s row showed a dependency row for `Licensing Engine` at `complete`/100%, matching the tracker extraction test.
- **Home auto-refresh (v1.6) — met.** Navigating to Home from an active Monitor view always triggers `refresh()`, even if Home data was already loaded earlier in the session.
- **Zurich compatibility — not claimed, gap documented (§18.3.4).** The v1.5.2+ dependency-impact mechanism and the v1.6 tracker mechanism have been verified only on `democrmfalectriae152010`. This is a documented gap, not an acceptance criterion met.

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

### 18.1 Opened for v1.5 (dependency impact), resolved in §18.2

1. **Suite-vs-graph overlap in the UI.** An app can be reached by both branches (§6.2). Decide whether the shared suite panel or the per-row tree owns such a row, so it is not counted twice in the displayed union.
2. **Confirm-dialog verbosity** when the union is large — Zurich yields a 200-app union (§6.8). Decide between a count with a *show all* escape and a scrollable list, consistent with the 150-row cap already used in Step 2.

### 18.2 Decisions — v1.5 dependency impact (resolved during the v1.5 build)

1. **Suite wins the overlap.** When a scope is a member of the target suite, it is excluded from every graph-branch tree and from the deduplicated union — it is shown once, in the suite panel, framed as `Will be updated` (the certain, explicit-target case). The graph branch (`May also be updated`, a heuristic per the original §6.5) never re-surfaces a suite-owned row. Reasoning: the suite branch has an explicit per-app target version; when both branches could claim a row, the more certain signal should own it, not the heuristic one. **Superseded in spirit by §18.3.1 — the overlap rule (suite wins) survives into v1.5.2 unchanged; what changed is that the non-suite branch is no longer heuristic either.**
2. **Confirm dialog: count + show all.** The dialog shows a compact `N more applications will be updated as a result` line by default; a `Show all` toggle expands a scrollable list on request. Chosen over an always-visible list so the dialog stays lightweight for the common case (a handful of apps) and only pays the rendering cost when the admin actually wants the detail — consistent with the 150-row cap already used in Step 2's own table. **Unchanged in v1.5.2.**

### 18.3 Decisions — v1.5.2 dependency-impact replacement (resolved during the v1.5.2 build)

The v1.5 graph branch was replaced, not tuned. Trigger: a real dependency chain (`Content Understanding`, §6.1.1) that the shipped v1.5 heuristic resolved to 19 apps with no relationship to the row inspected — surfaced by a side-by-side comparison against the native App Manager's own "Review Installation Details" dialog for the same app, which showed a completely different, much smaller set (the same 8 apps §6.2's suite branch already accounted for). That comparison is what triggered the replacement rather than a UI-only relabel.

1. **Rebuild the second branch against `sys_app_version` (target-version dependencies), not `sys_store_app.dependencies` (installed-version floor).** §6.1 explains why the old source was structurally wrong, not merely imprecise. This is the same table/logic the platform's own `DependencyProcessor` reads for the Application Manager's Update button.
2. **Drop the heuristic tier entirely.** Both branches now carry an explicit target-version constraint, so both render identically (`Will be updated` framing, no `May also be updated`, no `lockstep`/`Likely` marker) — §6.5.
3. **Surface the impact panels in Step 1, not just Step 2.** The suite panel renders identically in both wizard steps, sharing the same render/wire functions parameterised by a DOM-id prefix.
4. **Root-exclusion is conditional on an explicit selection (§6.3.1, §6.3.2).** The unfiltered view (Step 1/2) must NOT exclude an app from the impact panels just because it is itself a root elsewhere in the same updatable-apps list — doing so was a real bug found during this build (Setup Hub's own 3-app chain was being filtered to zero because Setup Hub Content/Common/Config are themselves independently-updatable roots). The confirm dialog (an explicit selection) is the only context where root-exclusion is correct, because there the framing is "N more beyond what you picked."
5. **A root that is also another root's dependency is shown as both, without deduplication penalty.** Verified live: `Setup Hub` is independently updatable *and* is `ServiceNow Otto for Setup Core`'s dependency-branch impact; `Licensing Engine` is independently updatable *and* is `Subscription Management v2`'s. Decided to show this plainly (§18.3.1) rather than hide the cross-reference — the information ("updating A will also touch B, which happens to be updatable on its own too") is accurate and useful even though it reads as redundant next to B's own row in the table.

### 18.3.1 v1.5.3 correction — per-row dependency expansion replaces the shared dependency panel

v1.5.2 (this section's original text) shipped the dependency branch as **one shared summary panel** — "N dependent apps will be updated together" — next to the suite panel, listing the deduplicated union across every root with no indication of *which* row caused *which* downstream app. User feedback on that exact screen: it read as ambiguous — seeing `Setup Hub`, `Setup Hub Content`, `Setup Hub Common`, `Setup Hub Config`, and `Licensing Engine` in one flat list gives no way to tell that `Setup Hub` is the one causing the first three, and `Subscription Management v2` (not shown in the panel at all — it's the *root*, not the *impact*) is the one causing the fifth.

**Fix:** drop the shared dependency panel. Instead, every table row that has dependency-branch impact gets its own `N more ▾` link (identical styling and mechanics to the suite panel's toggle) that expands a detail row directly beneath it, scoped to exactly that root's own impact — `Subscription Management v2` shows `1 more ▾` and expanding it reveals `Licensing Engine`; `Setup Hub` shows `3 more ▾` and expanding it reveals `Setup Hub Content`, `Setup Hub Common`, `Setup Hub Config`. **The suite panel stays a shared summary** (unchanged from v1.5.2) — a suite is a single atomic block with one target version, so one badge unambiguously describes it; the dependency branch has no such collective noun (20 different roots, 20 different reasons), so per-row is the only framing that doesn't require the admin to reverse-engineer the relationship.

This required a backend shape change: `getUpdateImpact` now returns **both** `dependenciesByRoot` (keyed by root scope, feeds the per-row expansion, never subject to root-exclusion) and `dependencies` (the flat deduplicated union, feeds the confirm dialog only, root-excluded when a selection is present) — see §6.10. The confirm dialog's framing ("N more applications will be updated as a result") is unaffected; only the wizard steps' presentation changed.

### 18.3.2 v1.5.4 correction — suite-member rows also get per-row expansion

§18.3.1's per-row expansion only read `dependenciesByRoot` — populated exclusively by the dependency branch (§6.2). A row whose *only* impact source is suite membership (it declares no `sys_app_version` dependencies of its own, but is listed in `sys_suite_config_app_version_m2m`) got **no expansion at all**, even though every other suite member's row correctly showed one via the shared panel's presence.

Concrete case that surfaced this: `ServiceNow Otto AI Agents` (`sn_aia`) is a `Now assist` suite member with zero dependency-branch impact of its own. In the native Application Manager, clicking Update on `ServiceNow Otto AI Agents` opens the *same* "Review Installation Details" dialog every other suite member opens — listing its 8 suite siblings. The shipped UI's suite panel already listed those 8 apps (shared, top-of-page), but `sn_aia`'s own *row* showed no `N more ▾` — nothing tied the panel to that specific row, so the two looked unconnected even though they describe the same fact.

**Fix:** `rowImpactList(scope)` (client-side) now merges two sources per row: `dependenciesByRoot[scope]` (unchanged) **and**, if `scope` is itself a suite member, every *other* suite member (`imp.suite.apps` minus itself). A row that is both a dependency-branch root and a suite member (none observed on this instance, but structurally possible) shows the union of both, deduplication not required since the two sources are already disjoint by construction (§6.10's suite-wins overlap rule keeps suite scopes out of `dependenciesByRoot`).

**A bug shipped with the first version of this fix, caught in the smoke test before merging further:** the initial implementation added "every other suite member" to a row's list whenever a suite existed, without first checking whether *that row's own scope* was among the suite's members. Since the filter was `suiteApps[i].scope !== scope` (excluding only the row itself) rather than "is `scope` in `suiteApps` at all", every row — suite member or not — passed the filter and inherited the full suite list. The smoke test caught this immediately: non-suite rows like `Theme Builder`, `AI Experience Framework`, `AI Service Graph Connector for Databricks`, `ISA Equipment Model`, `Licensing Engine`, `Process Automation Designer`, and `Setup Hub Config` all showed spurious `8 more ▾`/`9 more ▾`/`10 more ▾` links with no basis in the data. Fixed by adding an explicit membership check before merging: only add the suite's other members if the row's own scope first matches one of `imp.suite.apps`.

Verified live on `democrmfalectriae152010` after the fix: all 9 suite-member rows (`AI Admin Hub`, `Content Understanding`, `Platform AI Agents and Skills`, `ServiceNow Otto AI Agents`, `ServiceNow Otto for Setup`, `ServiceNow Otto for Setup Core`, `ServiceNow Otto for Virtual Agent`, `ServiceNow Otto for Virtual Agent Configurations`, `ServiceNow Otto in Document Management`) show `8 more ▾` (or `12 more ▾` for the two that also have dependency-branch impact — `ServiceNow Otto for Setup` and `ServiceNow Otto for Setup Core`, each 8 suite + 4 dependency-branch apps merged); every non-member, non-dependency row shows no expansion at all; `ServiceNow Otto AI Agents` expanded matches the native dialog's 8-app list exactly.

### 18.3.3 v1.6 fix — confirm dialog: name the selection, and never silently truncate past 150

Two separate gaps in the confirm dialog, both surfaced by direct questions rather than a smoke-test failure.

**Gap 1 — the dialog never named the selection.** Before v1.6 the confirm dialog said only `You are about to update N applications`, with the dependency-impact union shown as its own expandable list. The admin had no equivalent list for what they had *actually clicked* — only a number. To see the names they had to cancel back into Step 2. **Fix:** `selectedListHtml()` builds a second expandable list, styled and mechanically identical to the dependency-impact one (`N selected applications will be installed` + `Show all ▾`), populated directly from `selectedIds()` and the already-loaded `S.appData.apps` — no extra round-trip. It renders above the dependency-impact list so the dialog reads top-to-bottom as "what you picked" then "what else follows."

**Gap 2 — both lists silently truncated past 150 rows.** Asked directly: *what does the confirm dialog do if the admin selects more than 50 apps that relate to hundreds of dependencies?* Grepping the code found `Math.min(list.length, 150)` in both `confirmUnionHtml()` and (the then-new) `selectedListHtml()`, with no indicator when the true count exceeded 150 — the row simply stopped, with no `capNote()`-style message. This is inconsistent with Step 1/2, which have shown a `Showing N of M · show all` note since before v1.6 whenever a list is capped. On this instance (~20 updatable apps) the case can't be triggered live, but the code path is real and the inconsistency was real. **Fix:** both lists now append `<div class="cap-note-inline">Showing 150 of N — refine your selection to see the rest.</div>` when the underlying array's length exceeds 150, matching the existing cap-note wording style. New CSS rule `.cap-note-inline` (muted, centered, top border) visually separates it from the row list above it.

### 18.3.4 Compatibility gap — Zurich not verified, documented rather than claimed

Asked directly: *is this version of Now Plugin Updater compatible with the Zurich release of ServiceNow?* Checked rather than assumed.

The **original** dependency-impact design (the one superseded in §18.3, before the `sys_app_version` rebuild) had been validated on a Zurich instance per the original §6.8. That code path **no longer exists** — §6.1–§6.10 describe a different mechanism (`sys_app_version` target-version constraints, `sys_suite_config` suite branch), built and verified only against `democrmfalectriae152010`, which runs the Australia release family. The v1.6 tracker mechanism (§10.3, `sys_execution_tracker`) is newer still and has never run against anything but that same instance.

**Decision (explicit, not a default): document the gap rather than claim compatibility.** Neither the current `sys_app_version`/`sys_suite_config` dependency-impact mechanism nor the `sys_execution_tracker` tracking mechanism has been verified on Zurich. Nothing in the tables or APIs involved (`sys_app_version`, `sys_suite_config`, `sys_suite_config_app_version_m2m`, `sys_execution_tracker`) is documented public API — they are internal platform tables the app reads because they're what `AppUpgrader`/`DependencyProcessor` itself reads, and their presence, shape, or population behaviour could differ across release families in ways that have not been checked. Do not represent this build as Zurich-verified in any customer-facing material until that verification is actually run.
