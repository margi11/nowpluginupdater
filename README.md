# Now Plugin Updater

A ServiceNow administration application that lets an administrator discover, select, and batch-install the available updates for Store applications on an instance — replacing the per-app flow in the native Application Manager.

**Version 1.4.2 · by Gianmario Marongiu · Global scope · no build, no external dependencies.**

## What it does

The native Application Manager updates one application at a time. Now Plugin Updater groups updates into a single, monitored workflow, suitable for large or unattended runs:

- **Batch install** — filter, select multiple applications, and launch the batch in one action.
- **Server-side monitoring** — close the page after launch; a scheduled job tracks every install, verifies the installed version, and marks each Complete or Failed.
- **Verified outcomes** — a run counts as Complete only if the application actually reaches the target version.
- **No stored credentials** — installs are triggered with the admin's own session; no passwords or tokens are stored.
- **Built on the platform** — a single UI Page using vanilla JavaScript (no React, no bundler, no external libraries).

## What's new in 1.4.2

**Fix**
- **Stale selection after returning to the wizard.** `S.selected` (the Wizard Step 2 checkbox state) was never cleared when leaving the wizard — via the Home nav tab, Cancel, or after a batch finished. Re-entering the wizard could show "N selected" and an active "Install N updates" button with every checkbox visibly unticked, because the selection referred to rows from the previous visit. Selection is now reset whenever the wizard is (re)started.

## What's new in 1.4.1

**Fix**
- **Install confirmation popup was invisible.** Its `.modal` class collided with the platform's own Next Experience/Polaris `.modal{display:none}` rule; since the app's CSS never set `display`, the platform rule won and the dialog stayed hidden (the click still registered, so nothing visibly happened). Renamed to `.npu-modal`.

## What's new in 1.4.0

**Correctness**
- **Failed installs are no longer reported as Complete.** The monitor read `completion_code` on `sys_progress_worker` — a field that does not exist on that table (the real one is `state_code`), so the error branch never ran. The installed version is now the final arbiter: if it does not match the target, the row is Failed.
- Launch queue no longer stalls silently when a callback is lost — each step advances once, with a per-app watchdog.
- Monitor polling no longer freezes near the end of a batch (it checked a counter the server never returned).
- The monitor Scheduled Job logs an explicit error if it runs without the admin role, instead of stopping silently.

**Store sync**
- **Real progress instead of a blind wait.** Reads the platform's own `sn_appclient.apps_sync_progress`, updated at every phase by `UpdateChecker`, and shows a live progress bar. The button is disabled while a sync is running.

**Wizard UX (long lists)**
- **Action bar pinned to the bottom** in both wizard steps — no more scrolling hundreds of rows to reach *Next* or *Install*.
- Selection count and the number of already-installing apps stay visible while selecting; the install button names what it will do (`Install 47 updates`).
- **Confirmation dialog** before launching, naming the instance and the number of applications.
- **Scope filter** and debounced text filter; the first 150 rows render for speed, with *show all* — *Select All* still applies to everything matching the filter.
- Ticking a checkbox no longer re-renders the whole table (event delegation), so long lists stay responsive.

**Monitor**
- **End-of-batch summary** with a shortcut to list only the failures.
- **Cancel queued** drops applications still waiting; running installs finish.
- Batch selector shows app count and outcome, not just a timestamp.
- Status icons alongside colours, `aria-sort` on sortable headers, keyboard sorting, and a live region announcing progress.

**Performance**
- Home loads through a single call (`getHomeData`) instead of two.
- `listBatches` uses aggregates instead of scanning up to 3000 rows.
- Version verification is cached per monitor run.

## Get started

### 1. Download
Download the update set — a single portable XML file (`NowPluginUpdater140.xml`) containing the full app (UI Page, server logic, table, ACLs, scheduled job).

A self-contained landing page, [`Now-Plugin-Updater-Landing.html`](Now-Plugin-Updater-Landing.html), embeds the same XML and offers it as a download, with screenshots and these instructions. Open it in a browser (desktop or mobile).

### 2. Install
Import and commit the update set on your instance:

1. Open **All → System Update Sets → Retrieved Update Sets**.
2. Click **Import Update Set from XML**, choose the downloaded `Now Plugin Updater.xml`, and upload.
3. Open the retrieved record and click **Preview Update Set**; resolve any preview problems.
4. Click **Commit Update Set**.

### 3. Use
The commit creates a **Now Plugin Updater** application menu and a **Plugin Updater** module.

1. In the navigator, open **All → Now Plugin Updater → Plugin Updater** (or go to `/now/nav/ui/classic/params/target/pgi_plugin_updater.do`).
2. On **Home**, review the instance and the Apps indicators, then click **Start Wizard**.
3. **Discover** the applications with updates, **Select** the ones to update, and click **Install**.
4. Switch to **Monitor** to watch progress. The page can be closed; the server finishes and tracks each install.

## Requirements

- The **admin** role.
- **Global** scope.

Because the application list mirrors the Application Manager, a few platform-bundled apps that cannot be updated via the Store API may end as *Failed* — this is expected.

## Repository layout

| Path | Description |
|------|-------------|
| `src/ui_page/pgi_plugin_updater.xhtml` | UI Page — Jelly body fragment, CSS scoped under `#app`, vanilla-JS IIFE (Home, Wizard, Monitor, Guide) |
| `src/script_include/PluginUpdaterAjax.js` | Client-callable GlideAjax (`AbstractAjaxProcessor`), admin role-guarded, `sys_id`-sanitized |
| `src/fix_scripts/repair_install_log_140.js` | One-off background script — reclassifies historical rows wrongly marked Complete (dry-run by default) |
| `NowPluginUpdater140.xml` | Exported update set (v1.4.0) — portable install file |
| `Now-Plugin-Updater-Landing.html` | Self-contained distribution page (screens, download, install/use guide) |
| `Now-Plugin-Updater-Briefing.html` | Build briefing |
| `Update-Sets/README.md` | Update-set export/import notes |
| `plugin_updater_spec.md` | Full application specification |

## Upgrading from 1.3.x

After committing the update set, run `src/fix_scripts/repair_install_log_140.js` once in **Scripts - Background**. Because of the bug fixed in 1.4.0, existing rows may claim *Complete* for installs that never applied; the script reclassifies them against the version actually installed.

It runs as a **dry run by default** — it prints what it would change without writing. Review the output, then set `DRY_RUN = false` and run it again to apply. Rows whose application is no longer present are left untouched.

## Troubleshooting

**"Empty response from server" on Home (empty header, all counters 0):** the instance has a *duplicate* `PluginUpdaterAjax` Script Include shadowing the app's one — this happens when a `PluginUpdaterAjax` already existed before importing the update set. Delete the copy that does **not** contain the app's methods (`getInstanceInfo`, `monitorBatches`, `syncStore`); keep the one from this update set, then reload the page.

## Notes

- The UI Page is a classic UI Page rendered as a Jelly body fragment (no full HTML document), with all CSS scoped under `#app` to stay isolated from the Next Experience shell.
- Installs use the platform CICD App Repo install API, which is single-flight, so a batch is enqueued one application at a time with automatic retry on a busy queue.
