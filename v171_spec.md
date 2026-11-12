# Now Plugin Updater — v1.7.1 specification (bug-fix release)

**Status:** draft for implementation, 2026-11-12. **Baseline:** v1.7.0 as published (`NowPluginUpdater170.xml`, commit `b5ebf93`, tag `v170`).
**Audience:** whoever implements v1.7.1 (developer or Claude Code session). Read `CLAUDE.md` and `plugin_updater_spec.md` §2, §10, §12, §15, §19 first.

All line numbers refer to v1.7.0 (`b5ebf93`). Paths:
- `SI` = `src/script_include/PluginUpdaterAjax.js`
- `UI` = `src/ui_page/pgi_plugin_updater.xhtml`
- `REL` = `src/fix_scripts/release_orphan_install_lock.js`
- `RST` = `src/fix_scripts/reset_npu_instance.js`

**Verification column:**
- **Verified:** the code path was read and the defect confirmed in the 2026-11-12 review.
- **Reported:** found by a reviewer, plausible from the code, but the platform behaviour it depends on must be checked on an instance before the fix is written. Do this check first, and drop the item if it does not reproduce.

---

## 1. Goal and rules

v1.7.1 fixes the defects found in the full code review of v1.7.0. It adds no features. The rules that apply to every change:

- **Outcome rule (§10.1).** The installed version is the only arbiter of success. Never use `sys_progress_worker.state_code` as a failure criterion; there is no `completion_code`.
- **Fail closed.** For anything that deletes or changes platform records (release, reset), an unexpected state means "refuse and change nothing".
- **Platform constraints (§15).**
  - Rhino ES5. Glide values are Java strings: apply `'' +` before using JS string methods. An empty array is falsy: always test `.length`.
  - The `html` field is a Jelly fragment: no angle brackets anywhere inside `<style>`, including comments, and no `<` followed by a space in inline JS.
  - CSS lives under `#app` with the `.npu-` prefix, and never a `.modal` class.
  - Every dynamic string rendered as HTML goes through `esc()`.
- **No invented APIs.** Validate every platform API, table or field against the instance or the official documentation before using it.

---

## 2. Decisions (taken by the product owner, 2026-11-12)

| # | Decision | Chosen |
|---|---|---|
| D1 | Scope of v1.7.1 | **Everything: P1 + P2 + all P3 optimizations** (§3, §4, §5 and Appendix A, including N1–N3). N4 is investigated first; it becomes a fix only if confirmed. |
| D2 | Select header checkbox (F01) | **Tri-state:** checked / indeterminate / empty. |
| D3 | Confirm dialog lists (F02) | **25 rows per page, alphabetical by name, no page-size selector.** |
| D4 | *Cancel queued* for rows the platform has already queued (F09) | **Keep them `queued`** and tell the admin, for example "N were already queued on the platform and will still install". Only rows with no progress id or no tracker are cancelled. |
| D5 | Launching while another launch is running (F04) | **Block** the Wizard and *Install Updates* until the launch ends. |
| D6 | Session expired during a launch (F07) | **Stop the whole launch** and show "Session expired — sign in again and relaunch the remaining apps." (UI copy in English). Mark the rows that were not launched in **one** server call. |
| D7 | Store sync state captured in the admin's update set (F33, confirmed in A.2) | **To be evaluated at the start of the implementation.** Compare the candidate storages against the instance and the official documentation (one that is not update-set tracked, or a way to keep the writes out of the admin's update set). Record the choice and its evidence in spec §18.7 before writing the fix. |
| D8 | Version number | **1.7.1** |

---

## 3. P1 — must fix (correctness and safety)

### F01 · Select header checkbox never deselects · UI · Verified
- **Where:** `UI:1137`, handler `UI:1159-1168`.
- **Problem:** `#sel-allcheck` is re-rendered unchecked on every `renderSelect()`. The handler reads `this.checked`, so every click selects all again.
- **Fix:**
  - Compute the state from the selectable filtered apps, excluding in-flight apps: all selected → `checked`; some selected → `indeterminate` (D2); none selected → empty.
  - On click: if all are selected, deselect them; otherwise select all.
  - A single-row change (`toggleApp`) updates the header state without re-rendering the table.
- **Accept when:**
  - select all, then deselect all, works with the filter on and off and across pages;
  - a partial selection shows the indeterminate state;
  - in-flight apps are never selected (see F03).

### F02 · Confirm dialog lists capped at 150 · UI · Verified
- **Where:** `selectedListHtml` `UI:1236-1250`; `confirmUnionHtml` `UI:1214-1223`.
- **Fix:**
  - Paginate both lists with the existing `paginate()` and new view keys (for example `cfsel`, `cfdep`): 25 rows per page, sorted alphabetically (D3).
  - Use a compact pager ("Showing 1–25 of 259", ‹ ›, page numbers with ellipsis). A page change re-renders only that list, not the whole dialog.
  - Both lists restart at page 1 every time the dialog opens.
  - Remove the "refine your selection" note.
- **Accept when:** a 259-app selection can be browsed to the last page in both lists; the "Show all / Hide" toggles keep working; the counts in the titles are unchanged.

### F03 · In-flight apps are selectable again · SI + UI · Verified
- **Where:** `SI:154-167` returns `inFlight[].sys_id` = the `sys_progress_worker` sys_id. `UI:1085-1088` keys `inFlightSet()` on it and compares it with `sys_store_app` ids, so nothing ever matches.
- **Effect:** apps already installing are neither disabled nor shown as installing. *Select All* includes them, and the "N already installing (not selectable)" hint is false.
- **Fix (server):**
  - Resolve each in-flight operation to its app id and return `inFlight[].appId`.
  - Preferred source: `u_plugin_updater_install_log` rows with status `queued` or `installing` and a `u_progress_id`, which give `u_store_app_id`.
  - Also cover installs started outside this app by reading the root `sys_execution_tracker` `detail_message` (`app=<sys_id>`), parsed as `_parseOpDetail` does.
- **Fix (client):** key `inFlightSet()` on `appId`.
- **Fix (`createBatch`):** refuse, or skip and report, an app that already has an active row (`queued` or `installing`) in any batch.
- **Accept when:** during a running batch, its apps are disabled in Select, excluded from Select All and the header checkbox, and shown as "installing".

### F04 · A second launch can start during a launch · UI · Verified
- **Where:** `startWizard` `UI:784`, `confirmInstalls` `UI:1252`, `startInstalls` `UI:1287-1336`.
- **Problem:** nothing checks `S.launching`. Two `pump()` loops share `S.launchTotal/Triggered/Failed/Errors`, collide on the CICD mutex, and the first loop's end block opens the second batch.
- **Fix:**
  - While `S.launching`, keep the Wizard tab and *Install Updates* disabled and return early from these functions (D5).
  - Keep the per-launch counters in a closure or launch object instead of shared `S.*` fields.
- **Accept when:** while a launch is running, the Wizard cannot start a new one, and the counters stay correct.

### F05 · *Cancel queued* during a launch does not stop the browser · UI + SI · Verified (client) / Reported (server path)
- **Where:** `pump()` `UI:1311-1335` never re-checks the row; `cancelQueued` `UI:1500`; server `attachWorker`.
- **Problem:** rows cancelled while the launch is still running are POSTed to CICD anyway, and later turn `complete`.
- **Fix:**
  - Before each POST, the server must confirm the row can still be launched. Add a claim step: `claimRow(log_sys_id)` atomically changes `queued` → `launching`, refuses otherwise, and the client skips refused rows.
  - Validate the new status value against the choice list (§19.4) and add it to the choice list in the update set. Alternatively, keep `queued` and check `u_error_message`/a flag: choose the variant that needs no schema change if possible.
  - `cancelRemaining` must not cancel `launching` rows.
- **Accept when:** cancelling at 10/50 stops the remaining 40 POSTs, and the counts in the cancel message match what was really stopped.

### F06 · Monitor polling stops for good after one failed poll; stale responses overwrite the view · UI · Verified
- **Where:** `pollMonitor` `UI:1483-1497`.
- **Problem (failed poll):** on `e` or `d.error`, `counts` is `{}`, so no timer is set. One empty GlideAjax answer freezes the Monitor.
- **Problem (stale responses):** responses for a previous batch (batch selector changed, or repeated *Refresh now*) render over the current one and cancel its timer.
- **Fix:**
  - Keep a request sequence number, and drop responses whose sequence or `d.batch` is not current.
  - On error, keep the previous active state, reschedule with backoff (15 s → 30 s → 60 s, capped), and show "Last refresh failed — retrying".
- **Accept when:** a simulated failed poll during a running batch recovers by itself, and switching batch quickly never shows the wrong batch.

### F07 · Unsafe retry of the install POST; no fail-fast on expired session · UI · Verified
- **Where:** `fire`/`handleTrigger`/`retryOrFail` `UI:1400-1437`.
- **Problem (retries):** any rejected `fetch`, or a body that is not JSON, is retried as transient. A POST the server already accepted, whose response was lost, is retried 8 times, then marked `failed` while it installs (see F08).
- **Problem (session):** an HTML login page (expired session, SSO redirect) costs about 38 s of retries per app.
- **Fix:**
  - Check `resp.status` and the `content-type` before parsing.
  - A 401/403, a redirect, or an HTML body stops the whole launch (D6).
  - After a network error, do **not** blind-retry. First ask the server whether the row already has a worker or tracker (a lookup by app and time window, or `attachWorker` idempotence), then retry only if nothing was enqueued.
  - Keep the retries for explicit mutex or "in progress" answers.
- **Accept when:**
  - an expired session stops the launch with a clear message;
  - a lost response never produces a false `failed`;
  - mutex collisions are still retried.

### F08 · `failRow` overwrites any status, and `failed` is never re-verified · SI · Verified
- **Where:** `failRow` `SI:1192-1205`; the `_reconcile` query `SI:1232` scans only `queued,installing,in_progress`.
- **Fix:**
  - `failRow` writes only when the row is still `queued` (or `launching`, see F05); otherwise it returns `{ok:false, reason:'status changed'}`.
  - Add a re-verify pass for recent `failed` rows that have a target version, using the same rule as the cancelled pass. If the target version is installed, the row becomes `complete` (§10.1).
- **Accept when:** a row failed by the client, whose app then installs, ends `complete` within one job cycle.

### F09 · *Cancel queued* cancels rows already queued on the platform; the re-check misses them · SI · Verified
- **Where:** `cancelRemaining` `SI:908-950` only spares `running` workers. The cancelled pass `SI:1339-1353` covers 6 h and 200 rows, without `orderBy`.
- **Fix (D4a):**
  - Rows with a progress id whose worker or root tracker is pending or running stay `queued`. The response counts them as `alreadyQueued`, and the UI says "N were already queued on the platform and will still install".
  - Only rows with no progress id, or with no tracker, are cancelled.
  - For a worker that is already final but below the target version, apply the `_reconcile` outcome (`failed` with the failure message), not `cancelled` (reviewer item SI-B4).
  - Keep the cancelled re-verify pass as a safety net, but remove the 6 h limit for rows that have a progress id, and order it by `u_completed_at`.
- **Accept when:** cancelling a long batch after launching never leaves rows `cancelled` whose app later installs.

### F10 · Release apply phase does not re-check that the install is dead · SI + REL · Verified
- **Where:** `_releaseStuck` `SI:1971-1992`; `REL:268-283`.
- **Problem:**
  - Step 2 silently skips trackers that changed state.
  - Step 3 deletes by `lock_key` query instead of by the planned sys_ids, and it does so even when `failErr > 0`.
- **Fix (both files):**
  - Before any write, re-read every planned tracker. Abort with nothing changed if any tracker's `state` or `sys_updated_on` differs from the plan.
  - Abort before deleting if `failErr > 0`.
  - Delete only `plan.locks[*].sys_id`, after checking that each one's `sys_updated_on` is unchanged.
  - Keep the result message consistent when nothing was deleted.
- **Accept when:** with the simulation of §18.6 tests 2–4, touching one tracker between plan and apply makes the release refuse and change nothing. The normal release still works.

### F11 · Release padlock cap is not fail-closed · SI + REL · Verified
- **Where:** `_releasePlan` `SI:1890-1896` reads up to 100 padlocks without counting them, and the delete query is a separate unordered query. The same applies in `REL:156-160, 279-282`.
- **Fix:** count first with a `GlideAggregate`. If the count is ≥ `QH_LOCK_CAP`, refuse with "too many locks to verify". With F10, the delete uses the planned ids only.

### F12 · Reset script: empty `IN` lists are not guarded · RST · Verified (code) / Reported (platform behaviour)
- **Where:** `RST:101-107`, and the `nameIN` purges at `RST:236-239`.
- **Problem:** with no NPU update sets, or an empty `historyNames`, the encoded queries contain an empty `IN`. The platform may then drop the condition and delete unrelated update history.
- **Fix:**
  - Abort `execute` if both set lists are empty.
  - Build each `OR` branch only from a non-empty list.
  - Skip every `nameIN` purge when `historyNames` is empty.
- **Accept when:** `execute` on an instance already reset deletes nothing and says so.

### F13 · Store sync client ignores the server outcome · UI · Verified
- **Where:** `UI:700-760`. The client uses the old `lastSync`/`startedAt` comparison and never reads `p.outcome`/`p.message`, which the server returns since v1.6.3.
- **Problem:** a failed sync polls for 5 minutes and then says "continues on the server". A sync that finishes without moving `apps_last_sync_time` never reaches "Finished".
- **Fix:**
  - End on `p.outcome==='done'`. On `'error'`, call `finishSync(esc(p.message))`.
  - Use `d.lastSync` from the `syncStore` answer as the baseline, not `S.info.lastStoreSync`.
- **Related, reported — check on an instance:** when the sync was started from the Application Manager, the server answers `alreadyRunning` with the previous `startedAt`. Set `running = outcome==='running' || _syncRunning()` and return `startedAt = now` when our lock is not held (`SI:551-557, 719`).

### F14 · Dependency impact misses or under-reports updates · SI · Verified
- **Where:** BFS `SI:405-440`.
- **Problem:** `visited[depScope]` is set **before** the version check. A dependency first reached through an edge that is already satisfied is never re-evaluated when a later edge needs a higher version. The union keeps the first target found (`if(!unionNodes[s])`), not the highest.
- **Fix:** track the highest required version per scope. Re-enqueue a scope when a higher `minVersion` appears, and keep the maximum target in `rootDeps` and `unionNodes`, compared with `_cmpVer`. Keep a cycle guard on (scope, version).
- **Accept when:** an offline unit case where root R needs `X:1.0` (satisfied) and `Y:2.0`, and Y needs `X:2.0`, lists X with target 2.0.

### F15 · `createBatch` insert failures and the 1000 cap lead to untracked installs · SI + UI · Verified
- **Where:** `SI:760-782` ignores the `gr.insert()` result. `UI:1310, 1323` launches every selected app, including apps without a `logSysId` (beyond the 1000 cap, §19.11).
- **Fix:**
  - Server: skip and report rows that fail to insert, and return `total` equal to the rows actually created. Derive name, scope, current and latest from the validated `sys_store_app` record, not from the client.
  - Client: launch only apps that have a `logSysId`, and show how many were not queued.
- **Accept when:** no install is ever launched without a log row.

### F16 · Unescaped server text in the launch message · UI · Verified
- **Where:** `renderLaunch(msg)` inserts `msg` raw (`UI:1347`). The error path passes `e` (`UI:1308`), which can contain the raw server answer.
- **Fix:** `esc()` the dynamic part, and show `d.error` when present.

### F17 · A failed impact lookup is shown as "no other apps" · SI + UI · Verified
- **Where:** `getUpdateImpact` `SI:281-285` has no try/catch, and the client `UI:1202` calls `cb('')` on error.
- **Fix:** the server wraps the call and returns `{error}`. The dialog then shows a visible warning ("The dependency impact could not be computed — other applications may be updated too") instead of nothing.

---

## 4. P2 — should fix

| ID | Area | Where | Problem | Fix | Verification |
|---|---|---|---|---|---|
| F18 | UI | `UI:678, 1865` | The nav *Refresh* on the Select step replaces `S.appData` but does not redraw Select. `S.selected` keeps ids that are gone, so the count says 5 while 4 are launched. | After the load, drop the selected ids that are not in `apps`, and redraw the active wizard view. | Verified |
| F19 | UI | `UI:1252-1258` | *Install* can be clicked twice, and the selection can change while `getUpdateImpact` loads. The dialog says 3 while confirm launches 5. | Disable *Install* with a spinner until the dialog opens, and snapshot the ids used by `startInstalls`. | Verified |
| F20 | UI | `UI:1318-1323` | The 120 s watchdog counts a stuck launch as triggered while its retry chain keeps running. `fetch` has no timeout. | Use `AbortController` on `fetch`; the watchdog aborts the chain and records a launch failure. | Verified |
| F21 | UI | — | No warning when the tab is closed during a launch, so the rows stay queued until the 60-min timeout. | Set `window.onbeforeunload` while launching. | Verified |
| F22 | UI | `UI:1695-1782` | `getBatchStatus` truncation (`truncated`, `rowsShown`, 500 rows) is ignored, so the KPIs and the filtered table disagree with no notice. | Show "Showing first N of M rows"; optionally filter on the server. | Verified |
| F23 | UI | `UI:1634-1659, 1878, 1885` | During `releaseStuckOperation`, *Check again* or *Refresh now* re-renders the card from the old `S.queue` and re-enables *Release*, so a second release is possible. A stale `getQueueHealth` answer can bring back "blocked". | Add an `S.releasing` flag (button disabled, dialog blocked) and a sequence number on `getQueueHealth`. | Verified |
| F24 | SI | `SI:1286-1332` | No upper bound for rows whose worker or tracker never becomes final. After a queue release the worker may stay `running`, so the row stays `installing` forever. | When the worker is not final, also read the root tracker. If the tracker is Failed or Cancelled, or there has been no progress for more than N h, finalize by the version rule. | Reported — check the worker state after a release |
| F25 | SI | `SI:1247-1334` | The job and *Refresh now* can reverse each other's writes for one cycle. | Re-read `u_status` before writing, and skip rows already final. | Verified |
| F26 | SI | `SI:1234, 1343` | `setLimit(2000)` and `setLimit(200)` without `orderBy` can starve rows. | `orderBy('sys_updated_on')`. | Verified |
| F27 | SI | `SI:1257-1264` | The no-worker branch marks a row `complete` when the target version is empty. | Require `u_target_version`. | Verified |
| F28 | UI | `UI:817-826` | Version columns sort as strings (10.0.1 before 9.2.0). | Compare numerically per dot-separated segment (reuse the `_cmpVer` logic on the client). | Verified |
| F29 | SI + REL | `SI:1642-1659`, `REL:88-101` | Tracker state values read from `sys_choice` are not validated: no `inactive=false`, no order, no check that the values are distinct. | Filter `inactive=false` and order by `sequence`. If the five values are not distinct, or `failed` equals `running`/`pending`, use the defaults or refuse. | Reported |
| F30 | SI | `SI:303-316` | The impact index loads every `sys_store_app` row (inactive ones included) and keeps the last row per scope. | Add `active=true`, or prefer the active row per scope. | Reported — check for inactive rows and duplicate scopes |
| F31 | SI | `SI:247-251` | `sys_suite_config` `orderByDesc('version')` may sort as a string, and `setLimit(1)` across all suites considers one suite family only. | Pick the max with `_cmpVer` in memory, grouped by suite name. | Reported — check the field type |
| F32 | UI | `UI:642, 651, 697`; `startWizard` | *Refresh Data* during a sync re-enables a *Sync* button that does nothing. A new wizard run keeps the old filter and scope. | Render the button disabled ("Syncing…") while `S.syncing`; reset the filter and scope in `startWizard`. | Verified |
| F33 | SI | `SI:510, 602-611, 629` | The sync writes `sys_properties` and inserts a `sysauto_script` in the admin's session. These may be captured in the admin's current update set. | D7: verify on an instance (`sys_update_xml` after one sync). If confirmed, choose an untracked storage validated against the documentation. | Reported |
| F34 | SI | `SI:551-565, 598, 629` | Sync lock race: two clicks can create two jobs. The jobs share the single `__npu_sync_job_id`, so a late job can delete the new job's record. | Embed the job's own id in its script (insert, then update the script with the id). | Verified (edge case) |

---

## 5. P3 — optimizations (all included in v1.7.1, D1)

| ID | Where | Item |
|---|---|---|
| O1 | `SI:1247-1334, 1363-1393` | `_reconcile` does N+1 `get()`s on `sys_progress_worker`/`sys_execution_tracker` and `update()`s every row each minute. Batch them into `sys_id IN` queries and update only `if (gr.changes())`. **Cheap. Recommended in v1.7.1:** it lowers the risk of hitting the transaction quota on *Refresh now*. |
| O2 | `SI:1080-1130` | `_dependencyTreeForBatch` rebuilds the tree on every 15 s poll, finished rows included, and silently cuts at 5000 nodes. Skip final rows, flag the truncation, and optionally save the deps on the row when it is finalized. |
| O3 | `SI:895-899, 1596-1598, 1740-1745, 1808` | The light queue-health check on Home walks the tracker tree of every lock owner, even when the locks are young. Skip the walk when the newest lock is younger than the threshold. The light message count should use `state!=DELIVERED` without `groupBy`. **Cheap.** |
| O4 | `UI:1783, 1832-1833` | The Monitor rebuilds the whole table every 15 s, losing focus and scroll position, and `announce()` repeats unchanged text. Render only when the data changed, delegate the handlers on `#mon-body`, and announce only when the counts change. **Cheap. Recommended in v1.7.1** (accessibility). |
| O5 | `UI:525-558, 636, 655, 827-944` | Accessibility: restore focus after the re-renders caused by sort, pager and "N more"; trap Tab inside the dialog and return focus to the opener; make the *Installing* KPI card keyboard-operable (`role="button"`, `tabindex`, Enter/Space). |
| O6 | `SI:122-123` | `lastUpgraded` uses `getDisplayValue().split(' ')[0]`, which breaks with date formats that contain spaces. Use `getLocalDate()`/`getDate().getDisplayValue()`. |
| O7 | `SI:296-371` | Impact maps: use `hasOwnProperty`, and `.trim()` the dependency scope and `minVersion`. |
| O8 | `SI:1790, 1810` | Set `ownersTruncated` also when the padlock row count equals `QH_LOCK_CAP`. |
| O9 | `src/fix_scripts/repair_install_log_140.js` | Treat an empty installed version as unverifiable instead of `failed`. |

---

## 6. Explicitly out of scope

- The known gaps in spec §19.4, §19.5, §19.6, §19.9 and §19.14 (thread liveness cannot be checked server-side).
- New features: automatic release, a cancel API for platform queue operations (none is verified, §19.12), product categories.

---

## 7. Build and release (spec §12, lineage on v1.7.0)

1. **Branch:** `release/1.7.1` from `main`. Commit each fix separately (message format from `CLAUDE.md`).
2. **Version:** `S.version='1.7.1'` (`UI:465`). Update the descriptions of both records to "v1.7.1 — …".
3. **Offline checks before any deploy:**
   - `node --check` on the Script Include and on `REL`/`RST`;
   - no angle brackets inside `<style>`, no `'< '` in the inline JS;
   - every new `innerHTML` interpolation goes through `esc()`;
   - offline unit cases for F14 (BFS) and F28 (version sort), run with node on the extracted functions.
4. **Build instance `empgmarongiu1`** (Brazil Patch 2):
   - reset (`dryrun` → `execute` → `verify`, with F12 already applied) and elevate to `security_admin`;
   - import the **published** `NowPluginUpdater170.xml` from scratch (expect 59 inserted, 0 collisions), then commit;
   - write the two records from `src/` with `GlideRecord.setValue`, and verify length + SHA-256;
   - if F05 adds a choice value, it must be captured too (Choice list entry in the set);
   - move the entries from *Default* to "Now Plugin Updater v1.7.1 delta", merge with the commit set, and **Export to XML** → `NowPluginUpdater171.xml`.
5. **Offline lineage check:**
   - every `update_guid` of `NowPluginUpdater170.xml` is in the history of the same entry;
   - the changed payloads are identical to `src/`;
   - the entry count is 59, or 59 + new objects, explained.
6. **Install tests:**
   - from scratch on `empgmarongiu1` (after a reset);
   - upgrade 1.7.0 → 1.7.1 on `gmbrazil` (Brazil Patch 2, has 1.7.0);
   - **Australia, after the implementation** (the user's decision, 2026-11-12): upgrade on `democrmfalectriae163723` and on `sicuritaliafsmau`. Neither is tested yet for 1.7.x. Both need a browser login for the UI steps.
     - `sicuritaliafsmau` resets `upload_base_url` to `disabled.service-now.com`, so Store downloads fail there ("Unable to download app package"). Use it for the install, preview and UI tests, not for app updates, unless the property is fixed first.
   - Expected in each case: 0 collisions, 0 preview problems.
7. **Functional tests:** §8.
8. **Publish:**
   - `index.html` (embedded XML with an exact round-trip, versions, What's new);
   - README and `plugin_updater_spec.md` (§18.7 decision record, §19 items closed, §20);
   - merge to `main`, push, tag `v171`;
   - check that Netlify shows "Release 1.7.1".

---

## 8. Functional test plan (per instance, Wizard driven like an admin)

| # | Test | Expected |
|---|---|---|
| T1 | Header checkbox: select all, deselect all, partial selection, with filter and across pages | F01 behaviour; counts correct |
| T2 | Confirm dialog with more than 150 apps: page through both lists, then **Review selection** (no launch) | F02; all rows reachable |
| T3 | Batch of 3 small patch apps without dependencies (as in the v1.7.0 tests) | 3/3 Complete; installed versions = target |
| T4 | During T3: open Select in a second tab | the T3 apps are disabled and shown "installing" (F03); the Wizard is blocked in the launching tab (F04) |
| T5 | Batch of 5, *Cancel queued* at 1/5 launched | no further POSTs; the message counts are correct (F05, F09) |
| T6 | Simulated failed poll (devtools offline for 20 s) during a batch | the Monitor recovers by itself (F06) |
| T7 | Expired session before a launch (log out in another tab) | the launch stops with the session message; no false `failed` (F07) |
| T8 | Store sync: normal, and started while an App Manager sync runs | correct end state and message (F13) |
| T9 | Release simulation (§18.6 tests 2–4) plus a tracker touched between plan and apply | release refused, nothing changed (F10); normal release OK |
| T10 | Reset `execute` run twice | the second run deletes nothing (F12) |
| T11 | Console | 0 errors on Home, Wizard, Monitor and Guide |

---

## 9. Documentation to update with the release

- **`plugin_updater_spec.md`:**
  - current-state block;
  - §4 API changes (`inFlight[].appId`, `claimRow` if added, the `cancelRemaining` response with `alreadyQueued`, `failRow` refusal);
  - §10 outcome rules for failed and cancelled re-verification;
  - §14 confirm dialog paging and header checkbox;
  - §18.7 decision record (D1–D8 as decided) with verification results;
  - §19 updates;
  - §20 row.
- **README:** What's new in 1.7.1, the compatibility table (Australia result), repository layout.
- **`index.html`:** What's new, versions, embedded XML.

---

## Appendix A — Live tests on `empgmarongiu1`, 2026-11-12

These tests ran on `empgmarongiu1` (Brazil Patch 2, v1.7.0 installed, 339 selectable updates), with Playwright driving the page as an admin and with read-only server checks. `gmbrazil` was not tested in this round, because its browser session had expired. Australia is deferred until after the implementation (§7.6). The axe accessibility scan was not run: loading an external script into the instance page was not allowed, so only the manual checks below were done.

### A.1 New findings

| ID | Priority | Where | Finding | Fix | Evidence |
|---|---|---|---|---|---|
| N1 | **P1** | `UI:562-572` `ajax()` | `ajax()` has no timeout and no error path. When `xmlhttp.do` fails (a 502 was observed), `getXMLAnswer` never calls back, so every polling chain stops silently. **This is the root cause behind F06 and F13.** | Wrap every call with a watchdog: after 45 s, call `cb('timeout')` once (use `once()`). Callers treat it like any other error: the Monitor reschedules with backoff (F06), the Store sync keeps polling or shows an error (F13), the queue card shows *Unavailable*, retry. | **Reproduced live.** The Store sync UI stayed on "Updating the application catalog…" with the button disabled, while the server reported `outcome:'done'` at 13:14:42. The console showed `502 Bad Gateway @ /xmlhttp.do`. |
| N2 | P2 | `SI` `_findWorker` / `getBatchStatus` rows | The Monitor row shows **0 %** while the platform tracker is at **99 %**. The worker's `percent_complete` is null on Brazil, and the tracker's value is not used. | Use the root tracker's `percent_complete` when the worker's is null. | **Reproduced live:** `sn_ai_list_exp` row at 0 %, tracker at 99 %. |
| N3 | P3 | `UI` Monitor and queue card | One screen shows two time zones. "Checked 2026-11-12 02:41:17" is the instance user's time zone (server display value). "Last refreshed 12/11/2026, 11:41:17" is the browser's local time. | Format both the same way: use the server display values everywhere, or label the time zone. | Seen on the Monitor of both instances. |
| N4 | Investigate | `SI` `_updateImpact`; confirm dialog | An app that the impact reports as having **no dependencies** (`sn_ai_list_exp`, List AI Experience, member of the *Now assist* suite) took **45 padlocks** (every scope of the suite, plus `**resource**`, `schema` and `sys_script_fix`), and kept the queue busy for more than 20 minutes. Locks are not updates, so this is not yet a defect. | After the install finishes, compare the versions of the suite scopes with the pre-install list. If other suite apps changed version, the impact under-reports (extend F14). Either way, the confirm dialog could say "This application belongs to the *Now assist* suite; installing it locks the whole suite and can take a long time". | Live. Install launched 13:21; still running at 13:41 (root tracker 99 %, tree updating, queue `busy`). |

### A.2 Review findings checked live

| ID | Result |
|---|---|
| F01 | **Reproduced.** Two clicks on the header checkbox: "339 selected" both times, and the header is unchecked both times. |
| F02 | **Reproduced.** The dialog for 339 apps lists 150 rows ("Showing 150 of 339"). The union list had 85 rows. *Review selection* closed the dialog without launching. |
| F03 | **Reproduced.** A few seconds after launching 2 apps, both were still selectable in Select as *Pending*, and the "already installing" hint was empty. The server's `inFlight` came back empty right after the launch, and held 1 entry only later, once the worker existed. So F03's fix must also use the log rows (`queued`/`installing` with a progress id), not only `sys_progress_worker`. |
| F04 | **Reproduced.** The Wizard tab stays enabled during a launch and opens Discover/Select. |
| F06 | **Reproduced.** One injected 502 on a `getBatchStatus` poll: "Last refreshed" froze at 14:20:26 for more than 60 s while the batch was running (root cause N1). |
| F13 | The normal sync path works on the server (`done` in about 3 min). The UI got stuck because of N1. The `alreadyRunning` case (started from the Application Manager) was not tested. |
| F28 | **Reproduced.** Sorting by version gives 1.0.1, 1.0.10, 1.0.12, 1.0.2, … |
| F33 | **Confirmed. Raise it to P1.** One Store sync wrote `sys_properties` `__npu_sync_job_id` (13:12:05) and `x_npu.sync_state` (13:14:46) into the session's current update set (*Default*). An admin working in their own update set would ship these rows. The one-shot `sysauto_script` deleted itself and left no update-set entry. D7 (storage choice) still applies. |
| O5 | **Reproduced.** After clicking a sort header, focus falls back to `<body>`. The only control without keyboard access is the *Installing* KPI card (`#kpi-inprogress`). All inputs and selects have a label. |

### A.3 Reported items resolved by read-only checks

| ID | Result on Brazil Patch 2 | New priority |
|---|---|---|
| F12 | An empty `IN` matches **no** rows (`nameIN` → 0; `update_setIN^NQremote_update_setIN` → 0, out of 1,962 `sys_update_xml`). An unbounded delete does not happen on this release. | P3: keep the guards as cheap defence. |
| F29 | The `sys_execution_tracker.state` choices are clean: 0 Pending, 1 Running, 2 Successful, 3 Failed, 4 Cancelled, none inactive and no duplicates. | P3, defensive. |
| F30 | 1,092 `sys_store_app` rows; 1 inactive with no update available; no duplicate scopes. | P3 |
| F31 | `sys_suite_config.version` is a **string**. There are 44 rows, all of one suite ("Now assist"), and the string order happens to be right today (`30.2.20261105` first). It will break with versions like 30.10 against 30.9. | P3, cheap fix with `_cmpVer` |
| F24 | Could not be tested: no stuck worker or tracker exists on the instance. Keep it as Reported. | P2, unchanged |

### A.4 Performance and layout (measured)

- **Server calls:** `getHomeData` about 0.75 s (189 KB), `getUpdatableApps` about 0.75 s (189 KB), `getUpdateImpact` 0.6–0.75 s (142 KB), the others under 0.25 s. **No server-side action needed.**
- **Client:**
  - Home visible in 1.95 s when warm. The 7.3 s seen once was a cold platform load, not the app.
  - Select renders 339 apps in 0.3 s; the filter responds in 0.2 s; the confirm dialog opens in 0.8 s.
  - **No client-side action needed** beyond O4.
- **390 px width:** no horizontal page scroll; tables scroll inside `.tbl-wrap` as intended. Minor: the KPI cards stack one per row, which makes the Monitor long on phones (optional: a two-column KPI grid below 600 px).

### A.5 Changes to the plan

- **P1** gains **N1** and **F33**.
- **F12** moves to P3.
- **N2** joins P2.
- **N3** joins P3.
- **N4** is an investigation, to close before the implementation starts or at the start of it.
- Test T6 (§8) must inject the failure as in this appendix: a Playwright `route` returning 502 for one `getBatchStatus` call. Add **T12:** inject a 502 on `getSyncProgress` and check that the sync UI recovers or shows an error.
