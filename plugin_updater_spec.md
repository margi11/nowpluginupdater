# Now Plugin Updater — Build Specification (Implementation-Ready)

**Application name:** Now Plugin Updater · **Author:** Gianmario Marongiu

**Target:** ServiceNow custom application, **global scope**
**Audience:** Claude Code, building directly on a ServiceNow instance via the ServiceNow MCP
**Delivery model:** **No-build UI Page** + single client-callable Script Include. No bundler, no Fluent SDK, no React toolchain.

> This spec supersedes the previous `SPECS.md`. The **domain logic** in that document was correct and is preserved here almost verbatim (filters, offering retry, version verification, progress polling, category mapping, history, lessons learned). What changed is the **delivery architecture**, which was the actual cause of failure. Read §2 before building — it explains what to *not* repeat.

---

## 1. Goal

A single, clean admin screen to discover, select, and install available updates for **Store applications** on the instance, replacing the per-app dance in the native Application Manager. It must show instance version and counts, drive updates through a 3-step wizard with live progress, and keep an install history.

---

## 2. Why the previous architecture failed — hard constraints for this build

These are not preferences; they are the root causes of the prior non-working implementation. Do **not** reintroduce them.

1. **No React multi-file SPA, no bundler.** The prior `app.jsx / main.jsx / components/*.jsx` structure with ES `import`s requires a build step (Vite/esbuild) that a UI Page cannot perform at serve time. This produced blank pages / module errors. → Build the UI as a **single no-build UI Page**: structured vanilla JS in an IIFE, optionally a *single* no-build reactive micro-lib (Alpine.js or petite-vue) loaded as a **UI Script** (`sys_ui_script`) and referenced from the page. Nothing that needs transpilation or module resolution.

2. **No Fluent / `*.now.ts` deploy.** The prior lessons-learned already note Fluent modules / `require()` "may not load on all instances." → All artifacts are created as **native instance records via the ServiceNow MCP** (UI Page, Script Include, table, ACLs, navigation module).

3. **No stored credentials, no Base64 "encryption".** Base64 is reversible; a Base64 `username:password` in a system property is plaintext admin credentials. The server-side `RESTMessageV2` loopback to the instance's own CICD API also breaks on self-call SSL / wrong `glide.servlet.uri` / password rotation. → **Trigger installs client-side using the logged-in user's session** (see §6). Remove the credentials-config UI entirely.

4. **One data path, not two.** The prior "GlideAjax primary + REST Table API fallback" doubles auth/ACL surface and creates inconsistent behavior. → **All reads go through one client-callable Script Include via GlideAjax.** No REST Table API fallback.

5. **Instance version is not `glide.war`.** That property gives a raw build string, not "Australia Patch 2." → Use the version chain in §5.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  UI Page (no build):  pgi_plugin_updater.do                  │
│  Jelly shell + static HTML + design-token CSS                │
│  Vanilla JS (IIFE) [+ optional Alpine/petite-vue UI Script]  │
│  Views: Home · Wizard 1 · Wizard 2 · Wizard 3 · History ·    │
│         Guide   (client-side view switching, no router lib)  │
├─────────────────────────────────────────────────────────────┤
│  READS  → GlideAjax → Script Include (server)                │
│  INSTALL→ fetch() same-origin → /api/sn_cicd/app_repo/install │
│           (logged-in user session + X-UserToken, see §6)      │
├─────────────────────────────────────────────────────────────┤
│  Script Include (client_callable): PluginUpdaterAjax          │
│   extends AbstractAjaxProcessor   (NOT global.AbstractAjax…)   │
│   - getInstanceInfo   - getUpdatableApps                       │
│   - getProgress       - verifyVersion                          │
│   - logInstall (optional)                                      │
├─────────────────────────────────────────────────────────────┤
│  Custom table (optional, MVP-deferrable):                     │
│   u_plugin_updater_install_log                                │
└─────────────────────────────────────────────────────────────┘
```

**Components to create (all via MCP, all global scope):**

1. Application `Now Plugin Updater` (global), grouped in one update set / app for export.
2. UI Script (optional) hosting Alpine.js **or** petite-vue, if a reactive layer is desired. If omitted, vanilla JS only.
3. Script Include `PluginUpdaterAjax` (`client_callable = true`), extends `AbstractAjaxProcessor`.
4. UI Page `pgi_plugin_updater` (Jelly shell + HTML + CSS + JS).
5. Custom table `u_plugin_updater_install_log` + ACLs (optional for MVP — see §8).
6. Application menu + module linking to `pgi_plugin_updater.do`.
7. ACLs / role restriction to `admin`.

---

## 4. Script Include API (server)

`PluginUpdaterAjax extends AbstractAjaxProcessor`, `client_callable = true`, global scope.
**Constraint:** extend `AbstractAjaxProcessor` (not `global.AbstractAjaxProcessor`) — required for correct GlideAjax response handling in a global-scope app (carried over from prior lessons learned). All methods return JSON strings.

| Method | Returns |
|---|---|
| `getInstanceInfo` | `{ versionLabel, rawBuild, pluginCount }` — friendly version (§5), raw build string, active plugin count |
| `getUpdatableApps` | array of `{ sysId, name, scope, current, latest, category }` after applying the §7 filter rules; plus `appsUpToDate` count and the in-flight worker list |
| `getProgress` (params: `progress_id`) | `{ state, completion_code, message, error_message, percent_complete }` using the multi-strategy `sys_progress_worker` lookup (§9) |
| `verifyVersion` (params: `store_app_sys_id`, `target_version`) | `{ matches: bool, current: "x.y.z" }` — re-reads `sys_store_app.version` after install |
| `logInstall` (optional) | inserts/updates a row in the install-log table |

Reuse the proven GlideRecord/GlideAggregate logic from the original background script for counts and deltas. **No `RESTMessageV2` in the Script Include** — installs are triggered from the client (§6).

---

## 5. Data sources — precise reference

| Need | Table | Query / fields |
|---|---|---|
| Active plugin count | `v_plugin` | GROUP BY `state`; count `active` + `published` |
| Updatable store apps | `sys_store_app` | see §7 filter rules; fields `name`,`scope`,`version`,`latest_version`,`update_available`,`active`,`hide_on_ui`,`install_date`,`last_installed_from`,`static_content` |
| In-flight installs | `sys_progress_worker` | `name=CICDAppRepoService$CICDInstallWorker`, `state IN pending,running` |
| Install progress | `sys_progress_worker` | by sys_id; `state`,`completion_code`,`message`,`error_message`,`percent_complete` |
| Post-install verify | `sys_store_app` | re-read `version` for the app's sys_id |

**Instance version label (e.g. `Australia · Patch 2`)** — fallback chain; verify exact format on the target instance during build:

1. `gs.getProperty('glide.buildtag')` — parse release family + patch (e.g. `glide-australia-…__patchN`).
2. `gs.getProperty('glide.buildname')` — often the family name.
3. Fallback: `sys_upgrade_history.to_version` (raw build) if no friendly label can be derived.

Always display the best friendly label, with the raw build string as small secondary text so the value is never empty/meaningless.

**CICD install endpoint (called from client, §6):**
`POST /api/sn_cicd/app_repo/install?sys_id={store_app_sys_id}&version={latest_version}`
Success → `result.links.progress.id` is the `sys_progress_worker` sys_id to poll.
Offering retry → see §10.

---

## 6. Security & install trigger (mandatory)

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

**Validate this first during build** (§11 step 1): confirm the CICD App Repo Install API accepts session auth on the target instance. **Documented fallback only if it does not:** a **Basic Auth Credential + Connection alias** stored in the credential store (encrypted), retrieved server-side via `sn_ws.RESTMessageV2`. Never Base64 in a system property.

**Access control:** restrict the UI Page, module, and (if created) the log table to the `admin` role.

---

## 7. Filtering logic — which apps are "updatable"

Show an app only if **all** conditions hold (carried over from prior spec — this is the high-value part that makes the list correct):

| Filter | Reason |
|---|---|
| `update_available = true` | Flagged as having an update |
| `active = true` | App is active |
| `hide_on_ui = false` | Not a hidden dependency |
| `install_date != ''` | Was previously installed |
| `last_installed_from = 'store'` | Store app, not platform-bundled (platform-bundled cannot update via REST) |
| `static_content = false` | Not a UX web-component package (these accept installs but never bump version) |
| `name NOT LIKE @devsnc/` | UX Builder toolkit component — exclude |
| `name NOT LIKE @servicenow/` | ServiceNow internal component — exclude |
| `name NOT LIKE @now-par` | PAR visualization component — exclude |
| `version != latest_version` | Actually stale (guards against a stale `update_available` flag) |

---

## 8. Data model (optional for MVP)

The dashboard, wizard, and live progress do **not** require persistence — reads are live. The install-log table is a nice-to-have for history and can be deferred. If built, fix the prior type mistakes:

Table `u_plugin_updater_install_log`:

| Field | Type | Notes |
|---|---|---|
| `u_app_name` | String(255) | |
| `u_app_scope` | String(100) | |
| `u_store_app_id` | String(32) | sys_id from `sys_store_app` |
| `u_previous_version` | String(40) | |
| `u_target_version` | String(40) | |
| `u_status` | Choice | `queued`/`in_progress`/`complete`/`failed` |
| `u_started_at` | **glide_date_time** | not String |
| `u_completed_at` | **glide_date_time** | not String |
| `u_triggered_by` | **Reference → sys_user** | not String |
| `u_progress_id` | String(32) | `sys_progress_worker` sys_id |
| `u_error_message` | String(1000) | |
| `u_percent_complete` | Integer | not String |
| `u_session_id` | String(32) | groups one wizard batch |
| `u_product_category` | String(100) | from §12 mapping |

ACLs: CRUD restricted to `admin`.

---

## 9. Progress tracking (multi-strategy lookup)

`getProgress` reads `sys_progress_worker` resiliently (handles ACL/timing where a freshly-queued worker isn't yet materialized):

1. `gr.get(progressId)`.
2. else `addEncodedQuery('sys_id=' + progressId)` with `setWorkflow(false)`.
3. else query with `setQueryNoDomain(true)` if available.
4. all fail → return `{ error: 'progress worker not found' }`.

Client treats `"not found"` as **transient `running / queued`**, not an error.

Polling: every **15s**, **30-minute** timeout per app; stop polling apps in terminal state (`success`/`failed`). On `state=complete` + `completion_code=success`, call `verifyVersion` and mark `success` only if the version matches the target (else surface a warning).

---

## 10. Offering retry (client-side)

On the install `fetch`, if HTTP 400 with body containing `Offering plugin id must be specified`:

- Parse the first id inside `[...]` in `result.error` (e.g. `[com.sn_hs_csc]` → `com.sn_hs_csc`); fallback to the `"offering":"…"` hint in the example text.
- Retry the same endpoint with JSON body `{ "offering": "<id>" }`.
- If the retry also fails, mark the app `failed` with the parsed reason.

---

## 11. Build order for Claude Code

1. **Validate auth path.** Confirm `/api/sn_cicd/app_repo/install` accepts session auth (`credentials:'same-origin'` + `X-UserToken`) on the target instance. If yes, proceed credential-free; if no, switch to the credential-alias fallback (§6) — but only then.
2. **Confirm version label format.** Inspect `glide.buildtag` / `glide.buildname` and a `sys_upgrade_history` row; lock the §5 parsing to the observed format.
3. **Create the application** `Now Plugin Updater` (global) + update set.
4. **Create the Script Include** `PluginUpdaterAjax` with the §4 methods and §9 lookup.
5. **(Optional) Create the install-log table** + ACLs (§8) and `logInstall`.
6. **Create the UI Page** `pgi_plugin_updater`: Jelly shell + HTML + design-token CSS + vanilla-JS IIFE (optionally an Alpine/petite-vue UI Script). Implement Home, Wizard 1–3, History, Guide as client-side views.
7. **Wire reads** through GlideAjax; **wire installs** client-side (§6) with offering retry (§10) and batched concurrency cap (~8).
8. **Create application menu + module** → `pgi_plugin_updater.do`.
9. **Restrict** page/module/table to `admin`.
10. **Smoke test** against §13.
11. **Package** all artifacts in the app update set.

---

## 12. Product category mapping (by scope prefix)

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

## 13. UI / UX specification

Clean, modern, card-based, light neutral background, generous spacing, subtle shadows, rounded corners (8–12px), system font stack, clear type hierarchy. CSS via design tokens (CSS custom properties for color, spacing, radius, shadow). Client-side view switching — no router library.

**Views:**

- **Home (Dashboard).** Prominent **instance version** (`Australia · Patch 2`) with raw build as secondary text. KPI cards: `Active plugins`, `Up to date`, `Updates available`, `In progress`. Quick actions: *Start wizard*, *Refresh*, *View history*. (No credentials card — removed by design.)
- **Wizard Step 1 — Discover.** All updatable apps (per §7) **grouped by product category** (§12), each row showing name, scope, `current → latest`.
- **Wizard Step 2 — Select.** Multi-select with select-all, text filter, filter-by-category, live selected count. In-flight apps shown but disabled.
- **Wizard Step 3 — Install & progress.** Sequential/batched installs with a per-app live row: status pill (`pending` muted · `running` amber · `success` green · `failed` red), animated progress bar + percent, message/detail. In-flight workers from prior runs tagged and sorted first. Polling per §9; offering retry per §10; version verification before marking success.
- **History.** Install-log list (if §8 built), filterable by status, showing app, scope, versions, timestamps, triggered-by. If the log table is deferred, this view reads live in-flight + recent CICD workers instead.
- **Guide.** Short in-app usage notes.

Responsive: KPI cards wrap; wizard tables scroll horizontally on narrow viewports. Smooth, restrained transitions only.

---

## 14. Lessons learned — bake in as constraints

1. Script Include must extend `AbstractAjaxProcessor` (**not** `global.AbstractAjaxProcessor`) for correct GlideAjax responses in global scope.
2. The `/api/sn_appclient/v1/appmanager/product/install` **batch endpoint is unreliable** — use `/api/sn_cicd/app_repo/install` per app.
3. Fluent server modules / `require()` may not load on all instances — **build native records, not Fluent.**
4. `static_content=1` apps accept installs but never bump version — **filter them out** (§7).
5. `last_installed_from != 'store'` (platform-bundled) apps **cannot** update via REST — filter out (§7).
6. Base64 is not encryption — **no stored credentials** (§6).

---

## 15. Acceptance criteria

- Home shows the correct friendly **version label**, active plugin count, up-to-date count, updates-available count, and in-progress count — matching live instance data.
- Wizard Step 1 lists exactly the apps passing all §7 filters, grouped by category; no static-content / platform-bundled / `@devsnc|@servicenow|@now-par` entries appear.
- Selecting apps and starting updates triggers real CICD installs **with zero stored credentials** (new workers appear in `sys_progress_worker`).
- Offering-required 400 is handled by an automatic offering retry.
- Live progress reflects real worker state, survives the "worker not found" transient, and an app is marked `success` **only after `verifyVersion` confirms** the target version.
- History reflects installs (live or logged).
- The UI Page renders fully with **no build step** — no blank page, no module/import errors.
- All artifacts live in the `Now Plugin Updater` global-scope app and export cleanly.

---

## 16. Out of scope (future)

Dependency pre-resolution/ordering · maintenance-window scheduling · email notifications · auto-install policies · rollback · multi-instance management. Updating **platform plugins** (vs store apps) is also out of scope.

---

## 17. Decisions to confirm during build

1. Session-auth viability on `/api/sn_cicd/app_repo/install` (else credential-alias fallback) — §6, build step 1.
2. Exact friendly version-label format on the target instance — §5, build step 2.
3. Reactive layer: pure vanilla JS vs a single no-build micro-lib (Alpine/petite-vue) as a UI Script — §3.
4. Accent palette: ServiceNow brand (Infinite Blue `#032D42` + bright accent) vs neutral modern — §13.
5. Build the install-log table now or defer (History reads live in the interim) — §8.
