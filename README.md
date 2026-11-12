# Now Plugin Updater

A ServiceNow administration application that lets an administrator discover, select, and batch-install the available updates for Store applications on an instance — replacing the per-app flow in the native Application Manager.

**Version 1.7.1 · by Gianmario Marongiu · Global scope · no build, no external dependencies.**

## What it does

The native Application Manager updates one application at a time. Now Plugin Updater groups updates into a single, monitored workflow, suitable for large or unattended runs:

- **Batch install** — filter, select multiple applications, and launch the batch in one action.
- **Dependency impact** — see which other applications each choice brings with it, per row and in the confirmation dialog, and which ones were actually installed once the batch runs.
- **Server-side monitoring** — close the page after launch; a scheduled job tracks every install, verifies the installed version, and marks each Complete or Failed.
- **Verified outcomes** — a run counts as Complete only if the application actually reaches the target version.
- **Early failure detection** — an install that fails before it even starts (for example, the package cannot be downloaded) is shown as Failed with the platform's reason, not left Queued.
- **No stored credentials** — installs are triggered with the admin's own session; no passwords or tokens are stored.
- **Built on the platform** — a single UI Page using vanilla JavaScript (no React, no bundler, no external libraries).
- **Install queue health** — the Monitor shows whether the platform's own install queue is moving, and lets an admin release an operation that died and left its locks behind (1.7.0).

## What's new in 1.7.1

A bug-fix release from a full review of 1.7.0 plus live tests: no new features.

- **Select header checkbox** is tri-state (all, none, some) and the confirmation lists page through 25 applications at a time, alphabetically, so no row is capped away.
- **Applications already installing are not selectable again**, in this tab or in a second one, and **a second launch cannot start** while one is running. *Cancel queued* stops the browser and reports how many installs the platform had already queued (they stay *Queued* and will install).
- **An expired session stops the launch** with "Session expired — sign in again and relaunch the remaining apps." The rows not launched are marked in one call; the row already launched is never marked failed by mistake. The install POST is no longer retried blindly.
- **Guarded row updates.** A row that is already *Complete*, *Cancelled* or *Failed* is not overwritten by a late write, and *Failed* rows are re-verified against the installed version.
- **A Monitor and a Store sync that recover.** Every GlideAjax call has a 45 s watchdog: one failed poll no longer stops the Monitor or leaves the sync stuck. The sync ends on the server outcome, follows a sync started from the Application Manager, and no longer reads stale platform values (`sn_appclient.apps_last_sync_time`, `apps_sync_progress`).
- **The sync leaves your update set alone.** Its runtime state (`x_npu.sync_runtime_state`) is written with workflow off, so nothing is captured in your current update set, and the one-shot sync job is inserted active with its own sys_id, so it starts reliably.
- **Fail-closed maintenance.** Release of a stuck install re-checks that the install is still dead right before the first write and refuses if anything changed; the reset script guards empty lists.
- **Correct dependency impact** (the highest required version is kept) and a visible error when the impact lookup fails.
- **Smaller fixes:** numeric version sorting, the launch summary count, the Monitor keeps focus and scroll on refresh, keyboard access for the *Installing* card and the dialog, and the real tracker percentage when the worker has none.

**Certified on Brazil Patch 2** (`glide-brazil-08-25-2026__patch2-10-22-2026`): from-scratch install (59 / inserted 59 / collisions 0) and a 1.7.0 → 1.7.1 upgrade (59 / updated 53 / inserted 6 / collisions 0), both with 0 preview problems, and 12 functional tests driven in the browser (see `plugin_updater_spec.md` §18.7). **Also tested on Australia Patch 8** (upgrade 1.6.6 → 1.7.1, 0 preview problems, non-destructive functional tests and a batch of 5 apps). **Zurich is not tested yet.**

**Known notes:** on instances upgraded from earlier releases the old properties `x_npu.sync_state` and `__npu_sync_job_id` stay; 1.7.1 neither reads nor writes them. Two behaviours were observed but not investigated: the Monitor's *Checked* time is in the instance time zone while *STORE SYNCED* is in UTC, and the Home *Installing* card shows 0 while the batch rows are still queued.

## What's new in 1.7.0

A blocked platform install queue is detected and can be released from the Monitor, safely and only on request.

When an install dies half-way, it can leave its resource locks behind (`sys_padlock` rows owned by its tracker). Every install queued after it — from the Application Manager, CICD or this app — then waits, retried about once a second, for hours or days. Observed on Brazil: installs stuck *Queued* for about three days.

- **Platform install queue card** at the top of the Monitor: *Healthy*, *Busy* (an install is running), *Blocked* or *Unavailable*. When blocked it says since when, by which application and version, on which node, and how many operations are waiting.
- **Warning on Home** when the queue is blocked, with a link to the Monitor.
- **Release blocked operation…** — offered only when the server confirms the operation can be released: its whole tracker tree has made no progress for longer than the threshold (6 hours by default, optional system property `x_npu.stuck_op_hours`) and its locks are as old. The confirmation lists what will change and requires you to confirm that you checked *Active Transactions*.
- **The server decides and repeats every check** at release time. It saves a JSON backup of the records it changes as an attachment on the operation's tracker, marks the stuck operation's Running/Pending trackers as *Failed*, deletes **only** that operation's locks and writes an audit line to the system log. Calling it again is harmless.
- **Never automatic, and nothing else is touched:** no job, no release without a click and a confirmation; queued operations, other locks, other trackers and running transactions are left as they are.
- **Background-script alternative:** `src/fix_scripts/release_orphan_install_lock.js` does the same from *Scripts - Background* (dry run by default), even if the app is not installed or the page does not open.

**Known limits:** the page cannot tell whether the install's thread is still alive (the platform does not expose it to server scripts), so checking *Active Transactions* stays with the admin. A lock whose operation is no longer *Running* (for example already *Failed*), or whose tracker no longer exists, is shown but not released from the page. The backup attachment lives on the tracker, so it is removed when the platform cleans up old trackers (30 days on the Brazil instance tested); download it if you need to keep it. On a release that does not expose the expected tables or fields, the card shows *Unavailable* and nothing can be released.

## What's new in 1.6.6

A Monitor you can trust while a batch is still running: failures surface right away, cancelling no longer contradicts the platform, and one click brings the view up to date.

- **Early failures show up as failures.** When an install fails before a worker exists, the Monitor reads the platform's installation tracker (`sys_execution_tracker`) and marks the row Failed with the platform's own reason (e.g. "application depends on other applications which are not accessible at app store"), instead of leaving it Queued for an hour.
- **The installed version has the last word.** Failed and cancelled rows are re-checked against the version actually installed, just like successful ones. If an application you cancelled was already accepted by the platform and installs anyway, its row turns Complete.
- **Cancel queued checks first.** Before cancelling a row, the app checks whether that application is already installing or already installed. Those rows are kept, and the confirmation tells you how many had already started and will finish.
- **Refresh now means now.** It asks the server to reconcile the batch against the platform before answering, without waiting for the next background cycle.
- **Newest batch first.** The Monitor's batch selector always lists the most recent batches first.
- **A quieter wizard.** The suite banner above the Discover and Select lists is gone; the per-row *N more* links and the confirmation dialog still show exactly which other applications each choice brings with it. The in-app Guide copy was corrected.
- **Certified on the Brazil release** (alongside Australia), including a from-scratch install and a clean 1.6.5 → 1.6.6 upgrade with 0 preview problems.

**Known limit:** *Cancel queued* updates the install log only; it does not remove an operation from the platform's own install queue.

## Previous releases (1.5 → 1.6.5)

**1.6.5 — Pagination and Monitor filters**
- **Pagination** in Step 1, Step 2 and the Monitor (25/50/100/150/200 rows, default 25), replacing the old 150-row cap. Selection persists across pages, and *Select All* still applies to everything matching the filter.
- **Monitor KPI cards are a status filter** — click Failed, Complete, etc. to filter, click again (or Total) to reset.
- The pager label names its unit ("Showing 1-2 of 2 applications · 6 dependency rows").
- Uniform page background.

**1.6.2 → 1.6.4 — Packaging and install reliability**
- The update set is a **complete from-scratch install**: menu, module, table, fields, labels, choice list, ACLs and **ACL-role bindings** are all tracked, so the effective role no longer depends on the target instance's defaults.
- Batch and launch fixes, faster dependency/impact queries, and an explicit Store-sync state.

**1.6 – 1.6.1 — Observed dependencies**
- The Monitor shows the dependency applications **actually installed** per row, with `current → target` versions.
- The confirmation dialog lists the selected applications separately from the dependency impact.

**1.5 – 1.5.4 — Dependency impact**
- Per-row *N more* expansion showing which applications an update pulls in, including suite members, following the native Application Manager's behaviour.

**1.4.3 — Store sync**
- Sync runs through a one-shot scheduled job (the platform event queue can take 9–13 hours) and shows elapsed wait time.

**1.4.0 – 1.4.2**
- **Installed version is the sole arbiter** of success (failed installs are no longer reported as Complete), launch watchdog, real Store-sync progress, confirmation dialog, scope filter, *Cancel queued*, end-of-batch summary, accessibility improvements.
- Fixed an invisible confirmation dialog (`.modal` collided with Next Experience) and a stale selection when re-entering the wizard.

The full history is in [`plugin_updater_spec.md`](plugin_updater_spec.md) §20.

## Get started

### 1. Download
Download the update set — a single portable XML file (`NowPluginUpdater171.xml`) containing the full app (UI Page, server logic, table, ACLs, module, scheduled job).

A self-contained landing page, [`index.html`](index.html), embeds the same XML and offers it as a download, with screenshots and these instructions. Open it in a browser (desktop or mobile), or visit the published Netlify site.

### 2. Install
Import and commit the update set on your instance:

1. Open **All → System Update Sets → Retrieved Update Sets**.
2. Click **Import Update Set from XML**, choose the downloaded `NowPluginUpdater171.xml`, and upload.
3. Open the retrieved record and click **Preview Update Set**; resolve any preview problems.
4. Click **Commit Update Set**.

### 3. Use
The commit creates a **Now Plugin Updater** application menu and a **Plugin Updater** module.

1. In the navigator, open **All → Now Plugin Updater → Plugin Updater** (or go to `/now/nav/ui/classic/params/target/pgi_plugin_updater.do`).
2. On **Home**, review the instance and the Apps indicators, then click **Start Wizard**.
3. **Discover** the applications with updates, **Select** the ones to update, review the **Confirm** dialog, and click **Install**.
4. Switch to **Monitor** to watch progress. The page can be closed; the server finishes and tracks each install.

## Requirements

- The **admin** role.
- **Global** scope.

Because the application list mirrors the Application Manager, a few platform-bundled apps that cannot be updated via the Store API may end as *Failed* — this is expected.

## Compatibility

| Family | Status |
|--------|--------|
| Australia (Patch 6, Patch 7) | Verified up to 1.6.6 — dependency impact, tracker, batches, upgrade path |
| Brazil (Patch 1) | **v1.6.6 certified** — real batches, Monitor, Polaris rendering, from-scratch install |
| Brazil (Patch 2) | **v1.7.1 certified** (from scratch, 1.7.0 → 1.7.1 upgrade on two instances, 12 browser tests); **v1.7.0 certified** — from-scratch install and a clean 1.6.6 → 1.7.0 upgrade on two instances, with 0 preview problems; install queue health tested on a development instance: detection, simulated blocked queue with a real install waiting, release from the Monitor and from the background script |
| Australia (Patch 8) | **v1.7.1 verified** — upgrade 1.6.6 → 1.7.1 with 0 preview problems, select/dialog/Monitor/sync tests and a batch of 5 apps (all *Complete*); install/release simulation tests not repeated |
| Zurich | Not verified |

The app reads internal platform tables (`sys_app_version`, `sys_suite_config*`, `sys_execution_tracker`; since 1.7.0 also `sys_padlock` and `sys_nowmq_message`), so each new release family should be re-checked.

## Repository layout

| Path | Description |
|------|-------------|
| `src/ui_page/pgi_plugin_updater.xhtml` | UI Page — Jelly body fragment, CSS scoped under `#app`, vanilla-JS IIFE (Home, Wizard, Monitor, Guide) |
| `src/script_include/PluginUpdaterAjax.js` | Client-callable GlideAjax (`AbstractAjaxProcessor`), admin role-guarded, `sys_id`-sanitized |
| `src/fix_scripts/repair_install_log_140.js` | One-off background script — reclassifies historical rows wrongly marked Complete (dry-run by default) |
| `src/fix_scripts/reset_npu_instance.js` | Test-instance reset — removes the app completely so a from-scratch install can be re-tested |
| `src/fix_scripts/release_orphan_install_lock.js` | Background-script alternative to *Release blocked operation…* (1.7.0) — dry run by default |
| `NowPluginUpdater171.xml` | Exported update set (v1.7.1) — portable install file, 59 objects |
| `v171_spec.md` | Specification of the 1.7.1 bug-fix release (review findings and test plan) |
| `Old Releases/NowPluginUpdater1xx.xml` | Earlier releases (1.3.7–1.7.0), kept for reference and for lineage checks |
| `index.html` | Self-contained distribution page (screens, download, install/use guide) — published to Netlify |
| `Now-Plugin-Updater-Briefing.html` | Build briefing |
| `Update-Sets/README.md` | Update-set export/import notes |
| `plugin_updater_spec.md` | Full application specification |

## Upgrading

**From 1.5.x, 1.6.x or 1.7.0:** import, preview and commit `NowPluginUpdater171.xml` as for a new install. Upgrading from the published 1.7.0 (and 1.6.6) previews with 0 problems.

**From 1.3.x:** after committing the update set, run `src/fix_scripts/repair_install_log_140.js` once in **Scripts - Background**. Because of a bug fixed in 1.4.0, existing rows may claim *Complete* for installs that never applied; the script reclassifies them against the version actually installed.

It runs as a **dry run by default** — it prints what it would change without writing. Review the output, then set `DRY_RUN = false` and run it again to apply. Rows whose application is no longer present are left untouched.

## Troubleshooting

**"Empty response from server" on Home (empty header, all counters 0):** the instance has a *duplicate* `PluginUpdaterAjax` Script Include shadowing the app's one — this happens when a `PluginUpdaterAjax` already existed before importing the update set. Delete the copy that does **not** contain the app's methods (`getInstanceInfo`, `monitorBatches`, `syncStore`); keep the one from this update set, then reload the page.

**Every install fails with "Unable to download app package":** a platform issue, not an app error — the Application Manager fails the same way. Check that the system properties `sn_appclient.upload_base_url` and `sn_appauthor.upload_base_url` are not set to `https://disabled.service-now.com`; clearing them fixes it. Since 1.6.6 the Monitor shows this as Failed with the reason instead of leaving the rows Queued.

**The first install starts a few minutes after launch:** installs go through the platform's `AppOperationQueue` one operation at a time, so about 3 minutes can pass before the first worker appears. This is normal.

**Installs stay Queued for hours** (in this app, the Application Manager and CICD alike): an earlier install may have died and left its resource locks behind. Since 1.7.0 the Monitor's *Platform install queue* card shows *Blocked* and Home shows a warning.
1. Open *System Diagnostics → Active Transactions* (`v_cluster_transaction_list.do`) and check that no transaction of the blocked install is still running on the node the card names.
2. In the Monitor, click **Release blocked operation…**, confirm the Active Transactions check, and click **Release**. Queued installs should start within a minute or two; the blocked install itself did not complete and must be run again.
3. If the page cannot be opened, use `src/fix_scripts/release_orphan_install_lock.js` in *Scripts - Background* instead: run it as a dry run first, read its output, then apply it.
4. If the card shows the lock with a reason instead of a release button — the operation that holds it is no longer *Running* (for example *Failed*) or its tracker no longer exists — neither the page nor the script releases it, because the checks that make the release safe do not apply. The script's dry run prints the operation's tracker sys_id and its `lock_key` (`r*<sys_id>`); after the same *Active Transactions* check, delete only the `sys_padlock` rows with that exact `lock_key`.

The backup of the changed records is a `npu_release_backup_<timestamp>.json` attachment on the operation's tracker (*Install from the App Repository* in `sys_execution_tracker`).

## Notes

- The UI Page is a classic UI Page rendered as a Jelly body fragment (no full HTML document), with all CSS scoped under `#app` to stay isolated from the Next Experience shell.
- Installs use the platform CICD App Repo install API, which is single-flight, so a batch is enqueued one application at a time with automatic retry on a busy queue.
