# CLAUDE.md — Project Instructions

## Context
Pre-sales Solution Consultant ServiceNow, mercato italiano. Applicazione custom **Now Plugin Updater** costruita su istanza ServiceNow demo connessa via MCP a Claude Code.
- **App name:** Now Plugin Updater
- **Autore:** Gianmario Marongiu

## Target instance
- **democrmfalectriae152010** (`https://democrmfalectriae152010.service-now.com`)
- Tutti i comandi MCP devono specificare `instance: "democrmfalectriae152010"`.

## Language
- Conversazione con l'utente e commenti di codice: **italiano**.
- **Contenuti user-facing dell'applicazione (UI, label, messaggi, guida in-app, KB): inglese.** Questa è un'applicazione, non una demo localizzata.
- Identificatori tecnici (tabelle, campi, script include, variabili): **inglese**, snake_case lato server, camelCase lato client.

## Platform conventions
- **Scope di sviluppo: Global.**
- Preferire componenti out-of-the-box prima di custom.
- Ogni claim tecnico va validato contro la piattaforma o la documentazione ufficiale. Niente API, plugin, flag, tabelle o ruoli inventati.
- **No React, no bundler, no Fluent SDK** — UI Page no-build (vedi spec §2).
- **UI Layer: vanilla JS puro** in un IIFE, con event delegation. **Niente Alpine.js, niente petite-vue, nessuna UI Script**: la spec le ammetteva come opzione (§2), ma l'app in produzione non le usa. Non introdurle.
- **Stile UI:** Apple-inspired — pulito, elegante, moderno. Neutri chiari, tipografia fine, ombre sottili, bordi arrotondati.
- **Tabella install-log:** inclusa nel MVP (non differita).
- **CSS della UI Page:** tutto sotto `#app`. **Mai una classe `.modal`** — collide con la regola `.modal{display:none}` di Next Experience/Polaris e il dialog resta invisibile senza errori. Usare il prefisso `.npu-`.
- **Esito di un'installazione:** l'unico arbitro è la versione effettivamente installata. Su `sys_progress_worker` **non esiste `completion_code`**, e `state_code` non è utilizzabile come criterio di fallimento (chiude a `error` anche su installazioni riuscite). Vedi spec §10.1.

## MCP & tooling
- L'istanza demo è raggiungibile via MCP server già configurato in Claude Code.
- Prima di proporre modifiche, leggere lo stato attuale dell'istanza tramite MCP.
- Operazioni distruttive (delete record, drop table, disattivazione plugin) richiedono conferma esplicita.

## Code style
- Server-side: ES5 per Business Rule, Script Include, Client Script (vincolo Rhino).
- Client-side moderno (ES2015+) consentito solo nei contesti che lo supportano.
- GlideRecord: sempre `setLimit()` quando ha senso, mai query senza filtro su tabelle grandi.
- Logging: `gs.info()` / `gs.warn()` / `gs.error()`. Mai `gs.print()` se non in script monouso.

## Deliverable-specific briefs
- `plugin_updater_spec.md` — specifica completa dell'applicazione Plugin Updater

## Out of bounds
- Niente loghi, font proprietari o testi protetti di clienti reali.
- Dati anagrafici: solo fittizi.

## Before instance changes
- **Sempre mostrare un piano prima di eseguire task multi-step**, elencando i record e i file che verranno creati o modificati.
- **Chiedere conferma esplicita prima di pushare modifiche sull'istanza ServiceNow** via MCP.

## File system
- **Mai creare file fuori da questa cartella di progetto.**
- Tutto il lavoro vive in questa cartella.

## Git workflow
Progetto tracciato su GitHub (`margi11/nowpluginupdater`), branch `main`.

- Commit message format: `<imperative summary, max 60 chars>` con body opzionale che elenca i record creati/modificati.
- Non committare file che contengano credenziali o segreti.

## Git safety
- Prima di qualsiasi **operazione git distruttiva** (`reset --hard`, `push --force`, `branch -D`, `rebase`, riscrittura history), **sempre creare un safety commit** (`git commit -am "safety: pre-<operazione>"`) e **attendere approvazione esplicita** prima di procedere.
- Preferire operazioni additive (`commit`, `merge --no-ff`, `cherry-pick`) quando possibile.
