# Now Plugin Updater — Update Set export

**Update Set:** `Now Plugin Updater` (v1.3.0) · state **complete**
**sys_id:** `73b52d50873103103ad5851d8bbb35c8`
**Instance:** democrmfalectriae152010

## Scaricare l'XML portabile (dal browser)

1. Apri il record dell'update set:
   ```
   https://democrmfalectriae152010.service-now.com/now/nav/ui/classic/params/target/sys_update_set.do%3Fsys_id%3D73b52d50873103103ad5851d8bbb35c8
   ```
   (oppure: **All → System Update Sets → Local Update Sets → Now Plugin Updater**)
2. Verifica che lo stato sia **Complete**.
3. In fondo al form, **Related Links → Export to XML** — il browser scarica `Now Plugin Updater.xml`.

Salva il file in questa cartella (`Update-Sets/Now Plugin Updater.xml`).

> Nota: l'endpoint diretto `export_update_set.do` **non è disponibile** su queste istanze — usa la Related Link **Export to XML** sul record dell'update set.

## Importare su un'altra istanza

1. **All → System Update Sets → Retrieved Update Sets → Import Update Set from XML** → carica il file.
2. Apri il record importato → **Preview Update Set**.
3. Risolvi eventuali preview problem → **Commit Update Set**.

## Cosa contiene
- UI Page `pgi_plugin_updater` (frammento Jelly + CSS scoped `#app` + JS vanilla, icona inline)
- Script Include `PluginUpdaterAjax` (client-callable, `AbstractAjaxProcessor`, role-guarded admin)
- Tabella `u_plugin_updater_install_log` (+ colonne, choice, label) e 4 ACL CRUD admin
- ACL di lettura sulla UI Page (admin)
- Application Menu `Now Plugin Updater` + Module `Plugin Updater` (apre via Next Experience nav)
- Scheduled Job `Plugin Updater - Monitor Batches` (monitoraggio server-side ogni 1 min)

> Scope: **global**. Nessuna credenziale salvata. Nessuna dipendenza esterna (UI vanilla JS no-build).
