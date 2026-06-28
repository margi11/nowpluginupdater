# Now Plugin Updater

A ServiceNow administration application that lets an administrator discover, select, and batch-install the available updates for Store applications on an instance — replacing the per-app flow in the native Application Manager.

**Version 1.3.0 · by Gianmario Marongiu · Global scope · no build, no external dependencies.**

## What it does

The native Application Manager updates one application at a time. Now Plugin Updater groups updates into a single, monitored workflow, suitable for large or unattended runs:

- **Batch install** — filter, select multiple applications, and launch the batch in one action.
- **Server-side monitoring** — close the page after launch; a scheduled job tracks every install, verifies the installed version, and marks each Complete or Failed.
- **No stored credentials** — installs are triggered with the admin's own session; no passwords or tokens are stored.
- **Built on the platform** — a single UI Page using vanilla JavaScript (no React, no bundler, no external libraries).

## Get started

### 1. Download
Download the update set — a single portable XML file (`NowPluginUpdater v13.xml`) containing the full app (UI Page, server logic, table, ACLs, scheduled job).

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
| `NowPluginUpdater v13.xml` | Exported update set (v1.3.0) — portable install file |
| `Now-Plugin-Updater-Landing.html` | Self-contained distribution page (screens, download, install/use guide) |
| `Now-Plugin-Updater-Briefing.html` | Build briefing |
| `Update-Sets/README.md` | Update-set export/import notes |
| `plugin_updater_spec.md` | Full application specification |

## Notes

- The UI Page is a classic UI Page rendered as a Jelly body fragment (no full HTML document), with all CSS scoped under `#app` to stay isolated from the Next Experience shell.
- Installs use the platform CICD App Repo install API, which is single-flight, so a batch is enqueued one application at a time with automatic retry on a busy queue.
