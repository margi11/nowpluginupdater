function($scope, $timeout) {
  /* Now Plugin Updater — Service Portal widget controller. Author: Gianmario Marongiu */
  var c = this;

  c.view = 'home';
  c.loadingHome = true;
  c.loadingApps = false;
  c.loadingHistory = false;
  c.info = {};
  c.appData = { apps: [], inFlight: [], appsUpToDate: '—' };
  c.flatRows = [];
  c.categories = [];
  c.selected = {};
  c.filterText = '';
  c.filterCat = '';
  c.installRows = [];
  c.installDone = false;
  c.historyRows = [];
  c.histFilter = '';
  c.histStatus = '';
  c.globalError = '';
  c.sessionId = 'sess_' + (new Date().getTime());

  c.POLL_INTERVAL = 15000;
  c.POLL_TIMEOUT = 1800000;
  c.BATCH = 8;
  c._deadlines = {};

  // ---- helpers ----
  c.fmt = function(v) { return (v === null || v === undefined || v === '') ? '—' : v; };
  c.dv = function(f) { return (f && typeof f === 'object') ? (f.display_value || f.value || '') : (f || ''); };
  c.isWizard = function() { return ('' + c.view).indexOf('wizard') === 0; };
  c.showView = function(v) { c.view = v; };

  function apply(fn) { $timeout(fn); }

  function ajax(method, params, cb) {
    try {
      var ga = new GlideAjax('PluginUpdaterAjax');
      ga.addParam('sysparm_name', method);
      if (params) { for (var k in params) { ga.addParam(k, params[k]); } }
      ga.getXMLAnswer(function(ans) {
        apply(function() {
          if (ans === null || ans === '') { cb('Empty response from server', null); return; }
          try { cb(null, JSON.parse(ans)); } catch (e) { cb('Parse error: ' + e.message, null); }
        });
      });
    } catch (e) { apply(function() { cb('GlideAjax unavailable: ' + e.message, null); }); }
  }

  function normalize(d) {
    d = d || {};
    d.apps = d.apps || [];
    d.inFlight = d.inFlight || [];
    if (d.appsUpToDate === null || d.appsUpToDate === undefined) d.appsUpToDate = '—';
    return d;
  }

  function buildDerived() {
    var apps = c.appData.apps || [];
    // categories
    var cset = {}, cats = [];
    apps.forEach(function(a) { cset[a.category] = 1; });
    for (var k in cset) cats.push(k);
    cats.sort();
    c.categories = cats;
    // grouped flat rows
    var groups = {}, order = [];
    apps.forEach(function(a) { var cat = a.category || 'Other'; if (!groups[cat]) { groups[cat] = []; order.push(cat); } groups[cat].push(a); });
    order.sort();
    var flat = [];
    order.forEach(function(cat) {
      flat.push({ type: 'header', cat: cat, count: groups[cat].length });
      groups[cat].forEach(function(a) { flat.push({ type: 'app', app: a }); });
    });
    c.flatRows = flat;
  }

  // ---- HOME ----
  c.refresh = function() {
    c.globalError = '';
    c.loadingHome = true;
    var gotInfo = false, gotApps = false;
    function done() { if (gotInfo && gotApps) c.loadingHome = false; }
    ajax('getInstanceInfo', {}, function(e, d) { if (!e && d) c.info = d; else c.globalError = c.globalError || e; gotInfo = true; done(); });
    ajax('getUpdatableApps', {}, function(e, d) { if (!e && d) { c.appData = normalize(d); buildDerived(); } else c.globalError = c.globalError || e; gotApps = true; done(); });
  };

  // ---- WIZARD ----
  c.startWizard = function() {
    c.view = 'wizard1';
    c.loadingApps = true;
    ajax('getUpdatableApps', {}, function(e, d) {
      if (e) { c.globalError = e; }
      else { c.appData = normalize(d); buildDerived(); }
      c.loadingApps = false;
    });
  };

  c.openSelect = function() { c.view = 'wizard2'; };

  c.filteredApps = function() {
    var txt = (c.filterText || '').toLowerCase(), cat = c.filterCat;
    return (c.appData.apps || []).filter(function(a) {
      var mt = !txt || (a.name || '').toLowerCase().indexOf(txt) > -1 || (a.scope || '').toLowerCase().indexOf(txt) > -1;
      var mc = !cat || a.category === cat;
      return mt && mc;
    });
  };

  c.isInFlight = function(sysId) {
    return (c.appData.inFlight || []).some(function(w) { return (w.sys_id || w.sysId) === sysId; });
  };
  c.toggleApp = function(sysId) {
    if (c.isInFlight(sysId)) return;
    if (c.selected[sysId]) delete c.selected[sysId]; else c.selected[sysId] = true;
  };
  c.selectedIds = function() { var o = []; for (var k in c.selected) if (c.selected[k]) o.push(k); return o; };
  c.selectedCount = function() { return c.selectedIds().length; };
  c.selectAll = function() {
    c.filteredApps().forEach(function(a) { if (!c.isInFlight(a.sysId)) c.selected[a.sysId] = true; });
  };
  c.selectNone = function() { c.selected = {}; };

  // ---- INSTALL ----
  c.startInstalls = function() {
    var ids = c.selectedIds(), byId = {};
    (c.appData.apps || []).forEach(function(a) { byId[a.sysId] = a; });
    c.installRows = [];
    ids.forEach(function(id) {
      var a = byId[id]; if (!a) return;
      c.installRows.push({ sysId: a.sysId, name: a.name, scope: a.scope, current: a.current, latest: a.latest,
        category: a.category, status: 'pending', pct: 0, message: '', progressId: null, logSysId: null });
    });
    c.installDone = false;
    c.view = 'wizard3';
    c.installRows.forEach(function(row) {
      ajax('logInstall', { app_name: row.name, app_scope: row.scope, store_app_id: row.sysId,
        previous_version: row.current, target_version: row.latest, status: 'queued',
        session_id: c.sessionId, product_category: row.category },
        function(e, d) { if (!e && d && d.log_sys_id) row.logSysId = d.log_sys_id; });
    });
    runBatch();
  };

  function runBatch() {
    var running = c.installRows.filter(function(r) { return r.status === 'running'; }).length;
    var pending = c.installRows.filter(function(r) { return r.status === 'pending'; });
    var slots = c.BATCH - running;
    if (slots <= 0 || pending.length === 0) {
      c.installDone = c.installRows.length > 0 && c.installRows.every(function(r) { return r.status === 'success' || r.status === 'failed'; });
      return;
    }
    pending.slice(0, slots).forEach(function(row) { triggerInstall(row); });
  }

  function url(row) {
    return '/api/sn_cicd/app_repo/install?sys_id=' + encodeURIComponent(row.sysId) + '&version=' + encodeURIComponent(row.latest);
  }
  function headers() {
    return { 'X-UserToken': (window.g_ck || ''), 'Accept': 'application/json', 'Content-Type': 'application/json' };
  }

  function triggerInstall(row) {
    row.status = 'running'; row.pct = 0; row.message = 'Triggering install…';
    ajax('logInstall', { log_sys_id: row.logSysId || '', app_name: row.name, app_scope: row.scope, store_app_id: row.sysId,
      previous_version: row.current, target_version: row.latest, status: 'in_progress', session_id: c.sessionId, product_category: row.category },
      function(e, d) { if (!e && d && d.log_sys_id) row.logSysId = d.log_sys_id; });
    fetch(url(row), { method: 'POST', credentials: 'same-origin', headers: headers() })
      .then(function(resp) { return resp.json().then(function(b) { return { status: resp.status, body: b }; }); })
      .then(function(r) { apply(function() { handleResponse(row, r, false); }); })
      .catch(function(err) { apply(function() { row.status = 'failed'; row.message = 'Fetch error: ' + err.message; finalizeRow(row); }); });
  }

  function handleResponse(row, r, isRetry) {
    if (r.status === 200 || r.status === 201) {
      var pid = r.body && r.body.result && r.body.result.links && r.body.result.links.progress && r.body.result.links.progress.id;
      if (pid) { row.progressId = pid; row.message = isRetry ? 'Retry queued, polling…' : 'Install queued, polling…';
        c._deadlines[row.sysId] = (new Date().getTime()) + c.POLL_TIMEOUT; schedulePoll(row); }
      else { row.status = 'failed'; row.message = 'No progress ID returned'; finalizeRow(row); }
    } else if (r.status === 400 && !isRetry) {
      var msg = (r.body && r.body.result && r.body.result.error) || '';
      var m1 = msg.match(/\[([^\]]+)\]/), m2 = msg.match(/"offering"\s*:\s*"([^"]+)"/);
      var offering = (m1 && m1[1]) || (m2 && m2[1]) || null;
      if (offering && msg.toLowerCase().indexOf('offering') > -1) { row.message = 'Retrying with offering: ' + offering; retryWithOffering(row, offering); }
      else { row.status = 'failed'; row.message = msg || ('HTTP ' + r.status); finalizeRow(row); }
    } else {
      var em = (r.body && r.body.result && r.body.result.error) || ('HTTP ' + r.status);
      row.status = 'failed'; row.message = (isRetry ? 'Retry failed: ' : '') + em; finalizeRow(row);
    }
  }

  function retryWithOffering(row, offering) {
    fetch(url(row), { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify({ offering: offering }) })
      .then(function(resp) { return resp.json().then(function(b) { return { status: resp.status, body: b }; }); })
      .then(function(r) { apply(function() { handleResponse(row, r, true); }); })
      .catch(function(err) { apply(function() { row.status = 'failed'; row.message = 'Retry fetch error: ' + err.message; finalizeRow(row); }); });
  }

  function schedulePoll(row) { $timeout(function() { poll(row); }, c.POLL_INTERVAL); }

  function poll(row) {
    if (row.status === 'success' || row.status === 'failed') return;
    if ((new Date().getTime()) > (c._deadlines[row.sysId] || 0)) { row.status = 'failed'; row.message = 'Timeout after 30 minutes'; finalizeRow(row); return; }
    ajax('getProgress', { progress_id: row.progressId }, function(e, d) {
      if (e || (d && d.error && d.error === 'progress worker not found')) { row.message = 'Waiting for worker…'; schedulePoll(row); return; }
      if (d.error) { row.message = d.error; schedulePoll(row); return; }
      row.pct = d.percent_complete || row.pct;
      row.message = d.message || row.message;
      var state = (d.state || '').toLowerCase(), code = (d.completion_code || '').toLowerCase();
      if (state === 'complete' || state === 'success') {
        if (code === 'error' || code === 'failed') { row.status = 'failed'; row.pct = 100; row.message = d.error_message || d.message || 'Install failed'; finalizeRow(row); }
        else {
          ajax('verifyVersion', { store_app_sys_id: row.sysId, target_version: row.latest }, function(e2, v) {
            row.status = 'success'; row.pct = 100;
            if (!e2 && v && v.matches) row.message = 'Installed ' + row.latest + ' ✔';
            else row.message = 'Completed (version: ' + ((v && v.current) || '?') + ')';
            finalizeRow(row);
          });
        }
      } else if (state === 'failed' || state === 'error') { row.status = 'failed'; row.pct = 100; row.message = d.error_message || d.message || 'Worker reported failure'; finalizeRow(row); }
      else { schedulePoll(row); }
    });
  }

  function finalizeRow(row) {
    ajax('logInstall', { log_sys_id: row.logSysId || '', app_name: row.name, app_scope: row.scope, store_app_id: row.sysId,
      previous_version: row.current, target_version: row.latest,
      status: (row.status === 'success' ? 'complete' : 'failed'), progress_id: row.progressId || '',
      error_message: (row.status === 'failed' ? row.message : ''), percent_complete: row.pct,
      session_id: c.sessionId, product_category: row.category }, function() {});
    $timeout(runBatch, 500);
  }

  // ---- HISTORY ----
  c.openHistory = function() { c.view = 'history'; loadHistory(); };
  function loadHistory() {
    c.loadingHistory = true;
    var u = '/api/now/table/u_plugin_updater_install_log?sysparm_limit=200&sysparm_display_value=true'
      + '&sysparm_orderby=sys_created_on^DESC'
      + '&sysparm_fields=sys_id,u_app_name,u_app_scope,u_previous_version,u_target_version,u_status,u_started_at,u_completed_at,u_triggered_by,u_product_category,u_error_message';
    fetch(u, { credentials: 'same-origin', headers: { 'X-UserToken': (window.g_ck || ''), 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(d) { apply(function() { c.historyRows = (d.result || []); c.loadingHistory = false; }); })
      .catch(function() { apply(function() { c.historyRows = []; c.loadingHistory = false; }); });
  }
  c.filteredHistory = function() {
    var txt = (c.histFilter || '').toLowerCase(), st = c.histStatus;
    return (c.historyRows || []).filter(function(r) {
      var mt = !txt || c.dv(r.u_app_name).toLowerCase().indexOf(txt) > -1 || c.dv(r.u_app_scope).toLowerCase().indexOf(txt) > -1;
      var ms = !st || c.dv(r.u_status) === st;
      return mt && ms;
    });
  };

  // ---- init ----
  c.refresh();
}
