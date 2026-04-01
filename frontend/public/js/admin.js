/**
 * admin.js
 *
 * Admin dashboard frontend — only loaded and rendered for users
 * whose email is in the ADMIN_EMAILS environment variable.
 *
 * Sections:
 *   Overview  — platform KPIs, health status, failed job count
 *   Users     — searchable paginated user list + user detail panel
 *   Queues    — links to BullMQ Board + live queue depth summary
 *
 * Calls the same /admin/* API endpoints defined in routes/admin.js.
 * All requests use apiFetch() which handles the Authorization header.
 */

// ----------------------------------------------------------------
// renderAdminDashboard — entry point called by app.js renderView()
// ----------------------------------------------------------------
// Open BullMQ Board in a new tab with proper auth cookie
async function openBullBoard(e) {
  e.preventDefault();
  try {
    // Call the session endpoint with our JWT — it sets a cookie and returns a redirect
    await fetch('/admin/queues-session', {
      headers: { 'Authorization': 'Bearer ' + App.token },
      redirect: 'manual' // Don't follow the redirect — we want to open it ourselves
    });
    // The endpoint returns a 302 redirect to /admin/queues.
    // Since we used redirect:'manual', we get an opaque redirect response.
    // Just open the board URL directly — the cookie is now set.
    window.open('/admin/queues', '_blank');
  } catch (err) {
    console.error('[Admin] Failed to open BullMQ Board:', err);
    showAlert('admin-alerts', 'Failed to open BullMQ Board: ' + err.message, 'error');
  }
}

function renderAdminDashboard(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">🛠️ Admin Dashboard</div>
      <div class="page-subtitle">Platform management — visible to admins only</div>
    </div>

    <!-- Tab bar -->
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="overview"  onclick="switchAdminTab('overview')">Overview</button>
      <button class="admin-tab"        data-tab="users"     onclick="switchAdminTab('users')">Users</button>
      <button class="admin-tab"        data-tab="queues"    onclick="switchAdminTab('queues')">Queues</button>
      <button class="admin-tab"        data-tab="messages"  onclick="switchAdminTab('messages')">
        Messages
        <span id="admin-msg-unread-badge" style="display:none;font-size:11px;background:#dc2626;color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;vertical-align:middle;"></span>
      </button>
      <button class="admin-tab"        data-tab="limits"    onclick="switchAdminTab('limits')">Limits</button>
      <button class="admin-tab"        data-tab="revenue"   onclick="switchAdminTab('revenue')">Revenue</button>
      <button class="admin-tab"        data-tab="email"     onclick="switchAdminTab('email')">Email</button>
      <button class="admin-tab"        data-tab="plans"     onclick="switchAdminTab('plans')">Plans</button>
      <button class="admin-tab"        data-tab="avatars"   onclick="switchAdminTab('avatars')">Avatars</button>
      <button class="admin-tab"        data-tab="watchdog"  onclick="switchAdminTab('watchdog')">
        Watchdog
        <span id="admin-watchdog-badge" style="display:none;font-size:11px;background:#dc2626;color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;vertical-align:middle;"></span>
      </button>
      <button class="admin-tab"        data-tab="issues"    onclick="switchAdminTab('issues')">
        Issues
        <span id="admin-issues-badge" style="display:none;font-size:11px;background:#dc2626;color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;vertical-align:middle;"></span>
      </button>
      <button class="admin-tab"        data-tab="diagnostics" onclick="switchAdminTab('diagnostics')">
        Diagnostics
        <span id="admin-diag-badge" style="display:none;font-size:11px;background:#dc2626;color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;vertical-align:middle;"></span>
      </button>
    </div>

    <!-- Tab panels -->
    <div id="admin-tab-overview"  class="admin-panel"></div>
    <div id="admin-tab-users"     class="admin-panel hidden"></div>
    <div id="admin-tab-queues"    class="admin-panel hidden"></div>
    <div id="admin-tab-messages"  class="admin-panel hidden"></div>
    <div id="admin-tab-limits"    class="admin-panel hidden"></div>
    <div id="admin-tab-revenue"   class="admin-panel hidden"></div>
    <div id="admin-tab-email"     class="admin-panel hidden"></div>
    <div id="admin-tab-plans"     class="admin-panel hidden"></div>
    <div id="admin-tab-avatars"    class="admin-panel hidden"></div>
    <div id="admin-tab-watchdog"   class="admin-panel hidden"></div>
    <div id="admin-tab-issues"    class="admin-panel hidden"></div>
    <div id="admin-tab-diagnostics" class="admin-panel hidden"></div>
  `;

  injectAdminStyles();

  // Load the default tab
  loadAdminOverview();
}

// ----------------------------------------------------------------
// switchAdminTab — shows one panel, hides the rest
// ----------------------------------------------------------------
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.admin-panel').forEach(panel => {
    panel.classList.toggle('hidden', !panel.id.endsWith(tab));
  });

  // Always reload users tab so new registrations appear immediately.
  // Other tabs are lazy-loaded once and cached (data doesn't change as often).
  const panel = document.getElementById(`admin-tab-${tab}`);
  if (!panel) return;

  if (tab === 'users') { loadAdminUsers(); return; }

  if (panel.dataset.loaded) return;

  if (tab === 'overview')  loadAdminOverview();
  if (tab === 'queues')    loadAdminQueues();
  if (tab === 'messages')  loadAdminMessages();
  if (tab === 'limits')    loadAdminLimits();
  if (tab === 'revenue')   loadAdminRevenue();
  if (tab === 'email')     loadAdminEmail();
  if (tab === 'plans')     loadAdminPlans();
  if (tab === 'avatars')      loadAdminAvatars();
  if (tab === 'watchdog')     loadAdminWatchdog();
  if (tab === 'issues')       loadAdminIssues();
  if (tab === 'diagnostics')  loadAdminDiagnostics();
}

// ================================================================
// OVERVIEW TAB
// ================================================================

async function loadAdminOverview() {
  const panel = document.getElementById('admin-tab-overview');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;

  try {
    const [stats, health, watchdog] = await Promise.all([
      apiFetch('/admin/stats'),
      apiFetch('/admin/health'),
      apiFetch('/admin/watchdog').catch(() => null)
    ]);

    panel.innerHTML = buildOverviewHtml(stats, health, watchdog)
      + `<div style="margin-top:20px;"><button class="btn btn-sm" onclick="panel=document.getElementById('admin-tab-overview');if(panel)panel.dataset.loaded='';loadAdminOverview();">🔄 Refresh Overview</button></div>`;

    // Update the Issues tab badge with open ticket count
    const issuesBadge = document.getElementById('admin-issues-badge');
    if (issuesBadge && stats.open_tickets > 0) {
      issuesBadge.textContent = stats.open_tickets;
      issuesBadge.style.display = 'inline';
    } else if (issuesBadge) {
      issuesBadge.style.display = 'none';
    }

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load overview: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function buildOverviewHtml(stats, health, watchdog) {
  const isCritical  = health.status === 'critical';
  const isOk        = health.status === 'ok';
  const statusColor = isOk ? '#16a34a' : isCritical ? '#7f1d1d' : '#dc2626';
  const statusBg    = isOk ? '#f0fdf4' : isCritical ? '#fef2f2' : '#fff7ed';
  const statusLabel = isOk
    ? '✅ All systems operational'
    : isCritical
    ? '🚨 CRITICAL — platform is down'
    : '⚠️ Degraded — features broken, action needed';

  // Color-code a status string based on its content
  function statusCell(val) {
    if (!val) return '<span style="color:#6b7280;">—</span>';
    const s = String(val).toLowerCase();
    const ok   = s.startsWith('ok') || s.startsWith('key present');
    const warn = s.startsWith('not configured') || s.startsWith('missing') || s.startsWith('warning');
    const color = ok ? '#16a34a' : warn ? '#d97706' : '#dc2626';
    const icon  = ok ? '✅' : warn ? '⚠️' : '❌';
    return `<span style="color:${color};">${icon} ${escapeAdminHtml(val)}</span>`;
  }

  // Queue rows — includes Workers column to catch silent worker death
  const queueRows = Object.entries(health.queues || {}).map(([name, q]) => {
    if (q.error) {
      return `<tr><td><code>${name}</code></td><td colspan="5" style="color:#dc2626;">${escapeAdminHtml(q.error)}</td></tr>`;
    }
    const failedStyle = q.failed  > 0 ? 'color:#dc2626;font-weight:700;' : '';
    const workerStyle = q.workers < 1 ? 'color:#dc2626;font-weight:700;' : 'color:#16a34a;';
    const workerLabel = q.workers < 1 ? '❌ 0 — DEAD' : `✅ ${q.workers}`;
    return `<tr>
      <td><code>${name}</code></td>
      <td>${q.waiting}</td>
      <td>${q.active}</td>
      <td>${q.delayed}</td>
      <td style="${failedStyle}">${q.failed}</td>
      <td style="${workerStyle}">${workerLabel}</td>
    </tr>`;
  }).join('');

  // External API rows
  const apiRows = Object.entries(health.external_apis || {}).map(([name, status]) =>
    `<tr><td><code>${escapeAdminHtml(name)}</code></td><td>${statusCell(status)}</td></tr>`
  ).join('');

  // Env var rows
  const envRows = (health.env_vars?.summary || []).map(e => {
    const isSet      = e.status === 'set';
    const levelBadge = e.level === 'critical'
      ? '<span style="font-size:10px;color:#7f1d1d;background:#fee2e2;padding:1px 5px;border-radius:3px;">CRITICAL</span>'
      : e.level === 'important'
      ? '<span style="font-size:10px;color:#92400e;background:#fef3c7;padding:1px 5px;border-radius:3px;">IMPORTANT</span>'
      : '<span style="font-size:10px;color:#6b7280;background:#f3f4f6;padding:1px 5px;border-radius:3px;">optional</span>';
    return `<tr>
      <td><code>${escapeAdminHtml(e.key)}</code></td>
      <td style="color:#374151;">${escapeAdminHtml(e.label)}</td>
      <td>${levelBadge}</td>
      <td>${isSet ? '<span style="color:#16a34a;">✅ set</span>' : '<span style="color:#dc2626;font-weight:700;">❌ MISSING</span>'}</td>
    </tr>`;
  }).join('');

  // Watchdog confidence mini-gauge for overview
  const wdConf = watchdog?.confidence ?? null;
  const wdPaused = watchdog?.pause_state?.paused || false;
  const wdColor = wdConf === null ? '#94a3b8'
                : wdConf >= 80 ? '#16a34a'
                : wdConf >= 50 ? '#f59e0b'
                : '#dc2626';

  let pauseBannerHtml = '';
  if (wdPaused) {
    const reason = escapeAdminHtml(watchdog?.pause_state?.reason || 'Unknown');
    pauseBannerHtml = `
      <div class="wd-pause-banner">
        <div>🛑 SYSTEM PAUSED — ${reason}</div>
        <button class="btn btn-sm" style="background:#16a34a;color:#fff;border:none;"
          onclick="resumeSystem()">▶ Resume System</button>
      </div>`;
  }

  return `
    ${pauseBannerHtml}
    <!-- Health banner -->
    <div class="admin-health-banner" style="border-color:${statusColor};background:${statusBg};">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        ${wdConf !== null ? `
          <div style="display:flex;align-items:center;gap:8px;padding-right:16px;border-right:1px solid #e2e8f0;">
            <div style="font-size:28px;font-weight:800;color:${wdColor};line-height:1;">${wdConf}</div>
            <div style="font-size:11px;color:${wdColor};font-weight:600;line-height:1.2;">HEALTH<br>SCORE</div>
          </div>` : ''}
        <span style="color:${statusColor};font-weight:700;font-size:15px;">${statusLabel}</span>
      </div>
      <span class="admin-health-sub">
        Redis: <strong>${escapeAdminHtml(health.redis)}</strong> &nbsp;·&nbsp;
        DB: <strong>${escapeAdminHtml(health.database)}</strong> &nbsp;·&nbsp;
        Storage: <strong>${escapeAdminHtml(health.storage)}</strong>
      </span>
      ${health.workers?.warning
        ? `<div style="color:#dc2626;margin-top:6px;font-size:13px;">⚠️ ${escapeAdminHtml(health.workers.warning)}</div>`
        : ''}
    </div>

    <!-- KPI cards — row 1: activity -->
    <div class="admin-section-title" style="margin-top:20px;">Activity</div>
    <div class="admin-kpi-grid">
      ${adminKpi('🟢 DAU',              stats.dau,               '', 'Users who generated a brief today',         'dau')}
      ${adminKpi('📅 MAU',              stats.mau,               '', 'Users who generated a brief in last 30 days','mau')}
      ${adminKpi('📝 Briefs (7d)',       stats.briefs_7d,         '', 'Briefs submitted in the last 7 days',      'briefs_7d')}
      ${adminKpi('✅ Posts Published',   stats.total_posts,       '', 'All-time published posts',                 'posts_published')}
      ${adminKpi('📈 Posts (7d)',        stats.recent_posts_7d,   '', 'Posts published in the last 7 days',       'posts_7d')}
    </div>

    <!-- KPI cards — row 2: users & health -->
    <div class="admin-section-title" style="margin-top:20px;">Users &amp; Health</div>
    <div class="admin-kpi-grid">
      ${adminKpi('👤 Total Users',       stats.total_users,       '', 'Registered user profiles',    'total_users')}
      ${adminKpi('🆕 New Today',         stats.new_users_today,   '', 'New signups since midnight UTC','new_today')}
      ${adminKpi('🆕 New (7d)',          stats.new_users_7d,      '', 'New signups in the last 7 days','new_7d')}
      ${adminKpi('📊 Metric Records',    stats.total_metrics,     '', 'Total post_metrics rows')}
      ${adminKpi('❌ Failed Jobs',       stats.total_failed_jobs, stats.total_failed_jobs > 0 ? 'kpi-alert' : '', 'Failed BullMQ jobs — needs attention')}
    </div>

    <!-- Queues + workers table -->
    <div class="admin-section-title" style="margin-top:28px;">Queues &amp; Workers</div>
    <p style="font-size:12px;color:#6b7280;margin:0 0 8px;">
      Workers = active BullMQ worker processes listening on that queue.
      If any queue shows 0 workers, those jobs will queue up and never run.
    </p>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th><th>Workers</th></tr>
        </thead>
        <tbody>${queueRows}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;">
      <a href="#" onclick="openBullBoard(event)" class="btn btn-sm">
        🔍 Open BullMQ Board (full job inspector) ↗
      </a>
    </div>

    <!-- External API keys -->
    <div class="admin-section-title" style="margin-top:28px;">External API Keys</div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Service</th><th>Status</th></tr></thead>
        <tbody>${apiRows || '<tr><td colspan="2" style="color:#6b7280;">No data</td></tr>'}</tbody>
      </table>
    </div>

    <!-- RLS Security Check -->
    ${buildRlsSectionHtml(health.rls_issues)}

    <!-- Environment variable audit -->
    <div class="admin-section-title" style="margin-top:28px;">
      Environment Variables
      ${(health.env_vars?.missing_count || 0) > 0
        ? `<span style="margin-left:8px;font-size:12px;color:#dc2626;">${health.env_vars.missing_count} missing</span>`
        : '<span style="margin-left:8px;font-size:12px;color:#16a34a;">all set</span>'}
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Variable</th><th>Purpose</th><th>Level</th><th>Status</th></tr></thead>
        <tbody>${envRows || '<tr><td colspan="4" style="color:#6b7280;">No data</td></tr>'}</tbody>
      </table>
    </div>`;
}

// ----------------------------------------------------------------
// RLS Security Check — shows tables with RLS enabled but no policy.
// These tables silently reject all writes, causing data loss.
// ----------------------------------------------------------------
function buildRlsSectionHtml(rlsIssues) {
  // null = RPC not installed yet
  if (rlsIssues === null) {
    return `
      <div class="admin-section-title" style="margin-top:28px;">
        RLS Security
        <span style="margin-left:8px;font-size:12px;color:#d97706;">⚠️ check not available</span>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:4px 0 0;">
        The <code>check_rls_policies()</code> function hasn't been created yet.
        Run <code>migration_rls_health_check.sql</code> in Supabase SQL Editor to enable this check.
      </p>`;
  }

  // No issues — all good
  if (!rlsIssues || rlsIssues.length === 0) {
    return `
      <div class="admin-section-title" style="margin-top:28px;">
        RLS Security
        <span style="margin-left:8px;font-size:12px;color:#16a34a;">✅ all tables have policies</span>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:4px 0 0;">
        Every table with Row Level Security enabled has at least one policy. No action needed.
      </p>`;
  }

  // Issues found — show table with fix buttons
  const rows = rlsIssues.map(table => `
    <tr id="rls-row-${escapeAdminHtml(table)}">
      <td><code>${escapeAdminHtml(table)}</code></td>
      <td style="color:#dc2626;font-weight:700;">❌ RLS ON — no policy</td>
      <td>All writes silently rejected (data loss)</td>
      <td>
        <button class="btn btn-sm" style="background:#dc2626;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;"
                onclick="fixRlsTable('${escapeAdminHtml(table)}')">
          🔧 Fix Now
        </button>
      </td>
    </tr>`).join('');

  return `
    <div class="admin-section-title" style="margin-top:28px;">
      RLS Security
      <span style="margin-left:8px;font-size:12px;color:#dc2626;font-weight:700;">🚨 ${rlsIssues.length} table(s) at risk</span>
    </div>
    <p style="font-size:13px;color:#dc2626;margin:4px 0 8px;">
      These tables have Row Level Security enabled but <strong>no policy</strong>.
      All inserts and updates are silently rejected — even from the service role.
      Click "Fix Now" to create a standard <code>user_id = auth.uid()</code> policy.
    </p>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Table</th><th>Status</th><th>Impact</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Fix a table's missing RLS policy from the admin dashboard.
// Calls POST /admin/rls-fix with the table name.
// If auto-fix isn't available (no exec_sql RPC), shows the SQL to run manually.
async function fixRlsTable(tableName) {
  if (!confirm(`Create an RLS policy for "${tableName}"?\n\nThis will add: user_id = auth.uid() for all operations.`)) return;

  const row = document.getElementById(`rls-row-${tableName}`);
  const btn = row?.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fixing…'; }

  try {
    const result = await apiFetch('/admin/rls-fix', {
      method: 'POST',
      body: JSON.stringify({ table: tableName })
    });

    if (result.fixed) {
      // Auto-fix worked — update the row to show success
      if (row) {
        row.innerHTML = `
          <td><code>${escapeAdminHtml(tableName)}</code></td>
          <td style="color:#16a34a;font-weight:700;">✅ Policy created</td>
          <td>${escapeAdminHtml(result.policy)}</td>
          <td>Fixed!</td>`;
      }
    } else {
      // Auto-fix not available — show the SQL to run manually
      alert(
        `Auto-fix not available.\n\n` +
        `Copy and run this SQL in Supabase SQL Editor:\n\n` +
        result.sql
      );
      if (btn) { btn.disabled = false; btn.textContent = '🔧 Fix Now'; }
    }
  } catch (err) {
    alert(`Fix failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🔧 Fix Now'; }
  }
}

function adminKpi(label, value, extraClass, tooltip, drilldownType) {
  const tip = tooltip ? ` title="${escapeAdminHtml(tooltip)}"` : '';
  const click = drilldownType
    ? ` onclick="openKpiDrilldown('${drilldownType}')" style="cursor:pointer;"`
    : '';
  return `
    <div class="admin-kpi ${extraClass}"${tip}${click}>
      <div class="admin-kpi-value">${value ?? '—'}</div>
      <div class="admin-kpi-label">${label}</div>
    </div>`;
}

// ================================================================
// KPI DRILL-DOWN OVERLAY
// ================================================================

// Opens a full-screen overlay showing the detailed list behind a KPI card.
// Users can select rows and create an email group from the selection.
async function openKpiDrilldown(type) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'admin-drilldown-overlay';
  overlay.innerHTML = `
    <div class="admin-drilldown-panel">
      <div class="admin-drilldown-header">
        <span>Loading…</span>
        <button class="admin-drilldown-close" onclick="closeDrilldown()">&times;</button>
      </div>
      <div class="admin-drilldown-body">
        <div class="admin-loading"><div class="spinner spinner-sm"></div> Fetching data…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Close when clicking the dark backdrop (not the panel itself)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDrilldown();
  });

  try {
    const data = await apiFetch(`/admin/drilldown/${type}`);
    const header = overlay.querySelector('.admin-drilldown-header span');
    header.textContent = `${data.label} (${data.count})`;

    const body = overlay.querySelector('.admin-drilldown-body');

    if (data.count === 0) {
      body.innerHTML = '<p style="color:#6b7280;text-align:center;padding:40px 0;">No results.</p>';
      return;
    }

    // Build rows based on mode
    let rowsHtml = '';
    if (data.mode === 'users') {
      rowsHtml = data.items.map(u => `
        <div class="admin-drilldown-row">
          <input type="checkbox" class="drilldown-cb" data-user-id="${u.user_id}" />
          <label>
            <strong>${escapeAdminHtml(u.email || '—')}</strong>
            <span style="color:#6b7280;margin-left:8px;">${escapeAdminHtml(u.brand_name || '')}${u.industry ? ' · ' + escapeAdminHtml(u.industry) : ''}</span>
          </label>
          <span style="color:#9ca3af;font-size:11px;white-space:nowrap;">${u.created_at ? new Date(u.created_at).toLocaleDateString() : ''}</span>
        </div>`).join('');
    } else {
      // Content mode — show content info + user
      rowsHtml = data.items.map(item => {
        const contentLabel = item.topic || item.hook || '—';
        const dateStr = item.published_at || item.created_at;
        return `
          <div class="admin-drilldown-row">
            <input type="checkbox" class="drilldown-cb" data-user-id="${item.user_id}" />
            <label style="flex:1;">
              <span style="display:block;font-weight:600;font-size:13px;">${escapeAdminHtml(item.email || '—')}</span>
              <span style="color:#6b7280;font-size:12px;">${escapeAdminHtml(contentLabel)}${item.platform ? ' · ' + escapeAdminHtml(item.platform) : ''}${item.brand_name && item.brand_name !== '—' ? ' · ' + escapeAdminHtml(item.brand_name) : ''}</span>
            </label>
            <span style="color:#9ca3af;font-size:11px;white-space:nowrap;">${dateStr ? new Date(dateStr).toLocaleDateString() : ''}</span>
          </div>`;
      }).join('');
    }

    body.innerHTML = `
      <div class="admin-drilldown-select-all">
        <label><input type="checkbox" id="drilldown-select-all" onchange="toggleDrilldownSelectAll(this)" /> Select All</label>
        <span id="drilldown-selected-count" style="margin-left:12px;font-size:12px;color:#6b7280;">0 selected</span>
      </div>
      ${rowsHtml}`;

    // Add change listeners to individual checkboxes
    body.querySelectorAll('.drilldown-cb').forEach(cb => {
      cb.addEventListener('change', updateDrilldownSelectionCount);
    });

    // Add footer with Create Group button
    const panel = overlay.querySelector('.admin-drilldown-panel');
    const footer = document.createElement('div');
    footer.className = 'admin-drilldown-footer';
    footer.innerHTML = `
      <button class="btn btn-sm" id="drilldown-create-group-btn" style="background:#2563eb;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;"
              onclick="createGroupFromDrilldown('${escapeAdminHtml(type)}')">
        Create Group
      </button>
      <span id="drilldown-group-status" style="font-size:13px;color:#6b7280;"></span>
      <button class="btn btn-sm" style="margin-left:auto;" onclick="closeDrilldown()">Close</button>`;
    panel.appendChild(footer);

  } catch (err) {
    const body = overlay.querySelector('.admin-drilldown-body');
    body.innerHTML = `<div class="admin-error">Failed to load: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// Close the drill-down overlay
function closeDrilldown() {
  const overlay = document.querySelector('.admin-drilldown-overlay');
  if (overlay) overlay.remove();
}

// Select All / Deselect All toggle
function toggleDrilldownSelectAll(masterCb) {
  const checkboxes = document.querySelectorAll('.drilldown-cb');
  checkboxes.forEach(cb => { cb.checked = masterCb.checked; });
  updateDrilldownSelectionCount();
}

// Update the "X selected" count in the overlay header
function updateDrilldownSelectionCount() {
  const all     = document.querySelectorAll('.drilldown-cb');
  const checked = document.querySelectorAll('.drilldown-cb:checked');
  const countEl = document.getElementById('drilldown-selected-count');
  if (countEl) countEl.textContent = `${checked.length} selected`;

  // Keep "Select All" checkbox in sync
  const selectAll = document.getElementById('drilldown-select-all');
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length;
}

// Create an email group from the selected drill-down rows.
// Collects unique user_ids from checked rows and calls the existing
// POST /email/groups endpoint to create a manual group.
async function createGroupFromDrilldown(type) {
  const checked = document.querySelectorAll('.drilldown-cb:checked');
  if (checked.length === 0) {
    alert('Select at least one row first.');
    return;
  }

  // Collect unique user IDs (content mode may have duplicates)
  const userIds = [...new Set([...checked].map(cb => cb.dataset.userId))];

  const groupName = prompt(`Name this group (${userIds.length} user${userIds.length !== 1 ? 's' : ''}):`);
  if (!groupName || !groupName.trim()) return;

  const btn    = document.getElementById('drilldown-create-group-btn');
  const status = document.getElementById('drilldown-group-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  try {
    const today = new Date().toISOString().split('T')[0];
    await apiFetch('/email/groups', {
      method: 'POST',
      body: JSON.stringify({
        name: groupName.trim(),
        description: `Created from ${type} drill-down on ${today}`,
        group_type: 'manual',
        manual_user_ids: userIds
      })
    });

    if (status) {
      status.style.color = '#16a34a';
      status.textContent = `Group "${groupName.trim()}" created with ${userIds.length} user${userIds.length !== 1 ? 's' : ''}!`;
    }
    if (btn) { btn.textContent = 'Created!'; }

  } catch (err) {
    if (status) {
      status.style.color = '#dc2626';
      status.textContent = `Error: ${err.message}`;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Create Group'; }
  }
}

// ================================================================
// USERS TAB
// ================================================================

let _adminUserPage    = 1;
let _adminUserSearch  = '';
let _adminUserTotal   = 0;

async function loadAdminUsers(page = 1, search = '') {
  const panel = document.getElementById('admin-tab-users');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  _adminUserPage   = page;
  _adminUserSearch = search;

  // Keep the search bar if it exists; otherwise build the full layout
  const existing = panel.querySelector('.admin-users-list');
  if (!existing) {
    panel.innerHTML = `
      <div class="admin-users-top">
        <input
          id="admin-user-search"
          class="admin-search"
          type="text"
          placeholder="Search by email or brand name…"
          value="${escapeAdminHtml(search)}"
          oninput="adminUserSearchDebounce(this.value)"
        />
        <span id="admin-user-count" class="admin-muted"></span>
      </div>
      <div class="admin-users-list" id="admin-users-list"></div>
      <div class="admin-pagination" id="admin-pagination"></div>
      <div class="admin-user-detail hidden" id="admin-user-detail"></div>
    `;
  }

  const listEl = document.getElementById('admin-users-list');
  if (listEl) listEl.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;

  try {
    const params = new URLSearchParams({ page, limit: 50 });
    if (search) params.set('q', search);

    const data = await apiFetch(`/admin/users?${params}`);
    _adminUserTotal = data.total;

    const countEl = document.getElementById('admin-user-count');
    if (countEl) countEl.textContent = `${data.total} user${data.total !== 1 ? 's' : ''}`;

    if (listEl) listEl.innerHTML = buildUsersTableHtml(data.users);

    buildPagination(data.page, data.pages);

  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="admin-error">Failed to load users: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function buildUsersTableHtml(users) {
  if (!users.length) return '<div class="admin-muted" style="padding:20px;">No users found.</div>';

  const tierColors = { enterprise: '#6366f1', professional: '#0ea5e9', starter: '#16a34a', free_trial: '#64748b', suspended: '#dc2626' };
  const rows = users.map(u => {
    const tierColor = tierColors[u.subscription_tier] || '#64748b';
    return `
    <tr class="admin-user-row" onclick="loadAdminUserDetail('${u.user_id}')">
      <td>${escapeAdminHtml(u.email)}</td>
      <td>${escapeAdminHtml(u.brand_name || '—')}</td>
      <td><span style="color:${tierColor};font-weight:600;font-size:12px;">${escapeAdminHtml(u.subscription_tier || 'free_trial')}</span></td>
      <td>${escapeAdminHtml(u.industry || '—')}</td>
      <td>${u.onboarding_complete ? '✅' : '⏳'}</td>
      <td class="admin-muted">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');

  return `
    <table class="admin-table admin-users-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Brand</th>
          <th>Tier</th>
          <th>Industry</th>
          <th>Onboarded</th>
          <th>Joined</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildPagination(currentPage, totalPages) {
  const el = document.getElementById('admin-pagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }

  const prev = currentPage > 1
    ? `<button class="btn btn-sm" onclick="loadAdminUsers(${currentPage - 1}, '${_adminUserSearch}')">← Prev</button>`
    : '';
  const next = currentPage < totalPages
    ? `<button class="btn btn-sm" onclick="loadAdminUsers(${currentPage + 1}, '${_adminUserSearch}')">Next →</button>`
    : '';

  el.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-top:12px;">
    ${prev}
    <span class="admin-muted">Page ${currentPage} of ${totalPages}</span>
    ${next}
  </div>`;
}

// Debounce helper for search input
let _adminSearchTimer = null;
function adminUserSearchDebounce(value) {
  clearTimeout(_adminSearchTimer);
  _adminSearchTimer = setTimeout(() => loadAdminUsers(1, value), 400);
}

// ----------------------------------------------------------------
// loadAdminUserDetail — loads and shows a single user's detail panel
// ----------------------------------------------------------------
async function loadAdminUserDetail(userId) {
  const detailEl = document.getElementById('admin-user-detail');
  if (!detailEl) return;

  detailEl.classList.remove('hidden');
  detailEl.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading user…</div>`;
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const data = await apiFetch(`/admin/users/${userId}`);
    detailEl.innerHTML = buildUserDetailHtml(data);
  } catch (err) {
    detailEl.innerHTML = `<div class="admin-error">Failed to load user: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function buildUserDetailHtml(data) {
  const p = data.profile;
  const postSummaryHtml = Object.entries(data.post_summary || {})
    .map(([status, count]) => `<span class="admin-badge">${status}: ${count}</span>`)
    .join(' ') || '—';

  const recentPostsHtml = (data.recent_posts || []).map(post => `
    <tr>
      <td>${escapeAdminHtml(post.platform)}</td>
      <td>${escapeAdminHtml(post.status)}</td>
      <td class="admin-muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${escapeAdminHtml(post.hook || '—')}
      </td>
      <td class="admin-muted">${post.published_at ? new Date(post.published_at).toLocaleDateString() : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="admin-muted">No posts yet</td></tr>';

  return `
    <div class="admin-user-detail-card">
      <div class="admin-user-detail-header">
        <div>
          <div class="admin-user-detail-email">${escapeAdminHtml(p.email)}</div>
          <div class="admin-muted">${escapeAdminHtml(p.brand_name || 'No brand name')} · ${escapeAdminHtml(p.industry || 'No industry')}</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="document.getElementById('admin-user-detail').classList.add('hidden')">✕ Close</button>
      </div>

      <div class="admin-detail-grid">
        <div><strong>User ID</strong><br/><code class="admin-muted">${p.user_id}</code></div>
        <div><strong>Current Tier</strong><br/><span style="font-weight:700;color:${p.subscription_tier === 'enterprise' ? '#6366f1' : p.subscription_tier === 'professional' ? '#0ea5e9' : p.subscription_tier === 'starter' ? '#16a34a' : '#64748b'};">${escapeAdminHtml(p.subscription_tier || 'free_trial')}</span></div>
        <div><strong>Region</strong><br/>${escapeAdminHtml(p.geo_region || '—')}</div>
        <div><strong>Business type</strong><br/>${escapeAdminHtml(p.business_type || '—')}</div>
        <div><strong>Joined</strong><br/>${p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}</div>
        <div><strong>Onboarding</strong><br/>${p.onboarding_complete ? '✅ Complete' : '⏳ Incomplete'}</div>
        <div><strong>Metric records</strong><br/>${data.total_metrics}</div>
      </div>

      <div style="margin:14px 0 6px;"><strong>Posts:</strong> ${postSummaryHtml}</div>

      <div class="admin-section-title" style="margin-top:16px;">Recent Posts</div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Platform</th><th>Status</th><th>Hook</th><th>Published</th></tr></thead>
          <tbody>${recentPostsHtml}</tbody>
        </table>
      </div>

      <!-- Quick override form -->
      <div class="admin-section-title" style="margin-top:20px;">Override Subscription Tier</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">
        <select id="admin-tier-select" class="admin-select">
          <option value="">— keep current —</option>
          <option value="free_trial" ${p.subscription_tier === 'free_trial' ? 'selected' : ''}>free_trial</option>
          <option value="starter" ${p.subscription_tier === 'starter' ? 'selected' : ''}>starter</option>
          <option value="professional" ${p.subscription_tier === 'professional' ? 'selected' : ''}>professional</option>
          <option value="enterprise" ${p.subscription_tier === 'enterprise' ? 'selected' : ''}>enterprise</option>
          <option value="suspended" ${p.subscription_tier === 'suspended' ? 'selected' : ''}>suspended</option>
        </select>
        <input id="admin-notes-input" class="admin-input" type="text" placeholder="Admin notes (optional)" style="flex:1;min-width:200px;" value="${escapeAdminHtml(p.admin_notes || '')}" />
        <button class="btn btn-sm btn-primary" onclick="saveAdminUserOverride('${p.user_id}')">Save Override</button>
        <span id="admin-save-status-${p.user_id}" class="admin-muted"></span>
      </div>
    </div>`;
}

async function saveAdminUserOverride(userId) {
  const tier  = document.getElementById('admin-tier-select')?.value || undefined;
  const notes = document.getElementById('admin-notes-input')?.value;
  const statusEl = document.getElementById(`admin-save-status-${userId}`);

  const body = {};
  if (tier)               body.subscription_tier = tier;
  if (notes !== undefined) body.admin_notes       = notes;

  if (!Object.keys(body).length) return;

  try {
    if (statusEl) statusEl.textContent = 'Saving…';
    await apiFetch(`/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (statusEl) statusEl.textContent = '✅ Saved';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ ${err.message}`;
  }
}

// ================================================================
// QUEUES TAB
// ================================================================

async function loadAdminQueues() {
  const panel = document.getElementById('admin-tab-queues');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;

  try {
    const health = await apiFetch('/admin/health');

    const queueRows = Object.entries(health.queues || {}).map(([name, q]) => {
      if (q.error) return `<tr><td>${name}</td><td colspan="4" style="color:#dc2626;">${q.error}</td></tr>`;
      const failedClass = q.failed > 0 ? 'style="color:#dc2626;font-weight:700;"' : '';
      return `<tr>
        <td><code>${name}</code></td>
        <td>${q.waiting}</td>
        <td>${q.active}</td>
        <td>${q.delayed}</td>
        <td ${failedClass}>${q.failed}</td>
      </tr>`;
    }).join('');

    panel.innerHTML = `
      <div class="admin-queues-board-link">
        <a href="#" onclick="openBullBoard(event)" class="btn btn-primary">
          🔍 Open BullMQ Board — Full Queue Inspector ↗
        </a>
        <p class="admin-muted" style="margin-top:8px;">
          BullMQ Board lets you inspect, retry, and delete individual jobs.
          Opens in a new tab. Admin auth required.
        </p>
      </div>

      <div class="admin-section-title" style="margin-top:24px;">Current Queue Depths</div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th></tr>
          </thead>
          <tbody>${queueRows}</tbody>
        </table>
      </div>
      <button class="btn btn-sm" style="margin-top:12px;" onclick="loadAdminQueues()">🔄 Refresh</button>
    `;

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load queue data: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// ================================================================
// MESSAGES TAB
// ================================================================

// Sub-tab state — persisted so switching admin tabs and coming back
// returns to the same sub-view (inbox / compose / sent / broadcast).
let _adminMsgSubTab = 'inbox';

// Auto-refresh: poll the inbox every 30 seconds when it's the active sub-tab.
// Cleared whenever the admin leaves the inbox (switches sub-tab or main tab).
let _inboxPollTimer = null;

function startInboxPoll() {
  stopInboxPoll();
  _inboxPollTimer = setInterval(() => {
    // Only refresh if inbox is still the active sub-tab and thread is hidden
    if (_adminMsgSubTab === 'inbox' && document.getElementById('admin-msg-thread')?.classList.contains('hidden')) {
      loadAdminMessages('inbox');
    }
  }, 30000); // every 30 seconds
}

function stopInboxPoll() {
  if (_inboxPollTimer) { clearInterval(_inboxPollTimer); _inboxPollTimer = null; }
}

// ----------------------------------------------------------------
// loadAdminMessages — entry point for the Messages tab.
// Builds the sub-tab shell on first visit, then loads the sub-view.
// ----------------------------------------------------------------
async function loadAdminMessages(subTab) {
  const panel = document.getElementById('admin-tab-messages');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  if (subTab) _adminMsgSubTab = subTab;

  // Build the shell (sub-tabs + content areas) once
  if (!panel.querySelector('.admin-msg-subtabs')) {
    panel.innerHTML = `
      <div class="admin-msg-subtabs">
        <button id="admin-msub-inbox"     class="admin-tab" onclick="loadAdminMessages('inbox')">Inbox</button>
        <button id="admin-msub-compose"   class="admin-tab" onclick="loadAdminMessages('compose')">Compose</button>
        <button id="admin-msub-sent"      class="admin-tab" onclick="loadAdminMessages('sent')">Sent</button>
        <button id="admin-msub-broadcast" class="admin-tab" onclick="loadAdminMessages('broadcast')">Broadcasts</button>
      </div>
      <div id="admin-msg-content"></div>
      <div id="admin-msg-thread" class="hidden"></div>
    `;
  }

  // Highlight active sub-tab
  ['inbox','compose','sent','broadcast'].forEach(t => {
    document.getElementById(`admin-msub-${t}`)?.classList.toggle('active', t === _adminMsgSubTab);
  });

  // Hide thread whenever changing sub-tabs
  document.getElementById('admin-msg-thread')?.classList.add('hidden');
  document.getElementById('admin-msg-content')?.classList.remove('hidden');

  const contentEl = document.getElementById('admin-msg-content');
  if (!contentEl) return;

  if (_adminMsgSubTab === 'compose') {
    stopInboxPoll();
    renderAdminCompose(contentEl);
    return;
  }

  // Stop any existing poll; start a fresh one only for inbox
  stopInboxPoll();
  if (_adminMsgSubTab === 'inbox') startInboxPoll();

  contentEl.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;

  try {
    const { messages, unread } = await apiFetch(`/admin/messages?type=${_adminMsgSubTab}`);

    // Update inbox badge on the tab button
    const badge = document.getElementById('admin-msg-unread-badge');
    if (badge) {
      if (unread > 0) { badge.textContent = unread; badge.style.display = 'inline'; }
      else              badge.style.display = 'none';
    }

    if (!messages.length) {
      contentEl.innerHTML = `<div class="admin-muted" style="padding:24px 0;">No messages.</div>`;
      return;
    }

    const fromLabel = _adminMsgSubTab === 'sent' ? 'To' : 'From';
    const rows = messages.map(m => {
      const date    = new Date(m.created_at).toLocaleDateString();
      const preview = (m.body || '').replace(/\n/g, ' ').slice(0, 80);
      const unreadDot = (_adminMsgSubTab === 'inbox' && !m.read_at)
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;margin-right:6px;vertical-align:middle;"></span>'
        : '';
      const who = _adminMsgSubTab === 'sent'
        ? escapeAdminHtml(m.recipient_email || m.recipient_id || '—')
        : escapeAdminHtml(m.sender_email || '—');

      return `
        <tr class="admin-user-row" onclick="loadAdminMsgThread('${m.id}', '${_adminMsgSubTab}')">
          <td>${unreadDot}${escapeAdminHtml(m.subject)}</td>
          <td class="admin-muted">${who}</td>
          <td class="admin-muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeAdminHtml(preview)}</td>
          <td class="admin-muted">${date}</td>
        </tr>`;
    }).join('');

    contentEl.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table admin-users-table">
          <thead>
            <tr><th>Subject</th><th>${fromLabel}</th><th>Preview</th><th>Date</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  } catch (err) {
    contentEl.innerHTML = `<div class="admin-error">Failed to load messages: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// ----------------------------------------------------------------
// loadAdminMsgThread — open a message thread in the thread panel
// ----------------------------------------------------------------
async function loadAdminMsgThread(messageId, returnSubTab) {
  const contentEl = document.getElementById('admin-msg-content');
  const threadEl  = document.getElementById('admin-msg-thread');
  if (!threadEl) return;

  contentEl?.classList.add('hidden');
  threadEl.classList.remove('hidden');
  threadEl.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div>`;

  try {
    const { message, replies } = await apiFetch(`/admin/messages/${messageId}`);
    const allMsgs = [message, ...replies];

    const bubblesHtml = allMsgs.map(m => {
      const isAdmin = m.sender_type === 'admin';
      const mDate   = new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
        <div class="msg-bubble ${isAdmin ? 'msg-bubble-admin' : 'msg-bubble-user'}" style="max-width:75%;">
          <div class="msg-bubble-meta">
            <strong>${isAdmin ? `Admin (${escapeAdminHtml(m.sender_email)})` : escapeAdminHtml(m.sender_email)}</strong>
            <span>${mDate}</span>
          </div>
          <div class="msg-bubble-body">${escapeAdminHtml(m.body).replace(/\n/g, '<br>')}</div>
        </div>`;
    }).join('');

    threadEl.innerHTML = `
      <div class="admin-user-detail-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
          <button class="btn btn-sm btn-ghost" onclick="closeAdminMsgThread('${returnSubTab}')">← Back</button>
          <div style="font-size:15px;font-weight:700;">${escapeAdminHtml(message.subject)}</div>
          <button class="btn btn-sm btn-danger" onclick="deleteAdminMsg('${messageId}', '${returnSubTab}')">🗑️ Delete</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px;padding:14px;background:#f8fafc;border-radius:8px;margin-bottom:18px;">
          ${bubblesHtml}
        </div>

        <div style="border-top:1px solid #e2e8f0;padding-top:14px;">
          <div class="admin-section-title" style="margin-bottom:8px;">Reply</div>
          <textarea id="admin-reply-body" class="msg-textarea" rows="3" placeholder="Type your reply…"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;align-items:center;">
            <span id="admin-reply-status" class="admin-muted"></span>
            <button class="btn btn-primary btn-sm" onclick="sendAdminMsgReply('${messageId}', '${returnSubTab}')">Send Reply</button>
          </div>
        </div>
      </div>`;

  } catch (err) {
    threadEl.innerHTML = `<div class="admin-error">Failed to load message: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function closeAdminMsgThread(returnSubTab) {
  document.getElementById('admin-msg-thread')?.classList.add('hidden');
  document.getElementById('admin-msg-content')?.classList.remove('hidden');
  loadAdminMessages(returnSubTab);
}

async function sendAdminMsgReply(parentId, returnSubTab) {
  const bodyEl   = document.getElementById('admin-reply-body');
  const statusEl = document.getElementById('admin-reply-status');
  const body     = bodyEl?.value?.trim();

  if (!body) return;
  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    await apiFetch(`/admin/messages/${parentId}/reply`, {
      method: 'POST',
      body:   JSON.stringify({ body })
    });
    await loadAdminMsgThread(parentId, returnSubTab);
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ ${err.message}`;
  }
}

async function deleteAdminMsg(messageId, returnSubTab) {
  if (!confirm('Delete this message and all its replies?')) return;
  try {
    await apiFetch(`/admin/messages/${messageId}`, { method: 'DELETE' });
    closeAdminMsgThread(returnSubTab);
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// renderAdminCompose — compose form for admin to send/broadcast
// ----------------------------------------------------------------
function renderAdminCompose(el) {
  el.innerHTML = `
    <div class="admin-user-detail-card">
      <div class="admin-section-title" style="margin-bottom:16px;">Send a Message</div>
      <div id="admin-compose-alerts"></div>

      <!-- Recipient type selector -->
      <div style="display:flex;gap:20px;margin-bottom:18px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;">
          <input type="radio" name="admin-rcpt-type" value="user" checked onchange="toggleAdminRecipientType(this.value)" />
          Send to specific user
        </label>
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;">
          <input type="radio" name="admin-rcpt-type" value="broadcast" onchange="toggleAdminRecipientType(this.value)" />
          📢 Broadcast to ALL users
        </label>
      </div>

      <!-- User search (visible for direct messages) -->
      <div id="admin-compose-user-picker" style="margin-bottom:16px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px;">Recipient</label>
        <input type="text" id="admin-rcpt-search" class="admin-search"
          placeholder="Search by email or brand name…"
          oninput="adminRcptSearch(this.value)"
          autocomplete="off" style="width:100%;box-sizing:border-box;" />
        <div id="admin-rcpt-results" style="margin-top:4px;"></div>
        <input type="hidden" id="admin-rcpt-id" />
        <div id="admin-rcpt-selected" class="admin-muted" style="margin-top:5px;font-size:12px;"></div>
      </div>

      <!-- Broadcast warning (hidden until broadcast selected) -->
      <div id="admin-compose-broadcast-notice" class="hidden"
        style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:10px 14px;font-size:13px;color:#92400e;margin-bottom:16px;">
        ⚠️ This message will be visible to <strong>all</strong> registered users.
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px;">Subject</label>
        <input type="text" id="admin-compose-subject" class="admin-input"
          placeholder="Subject line…" maxlength="255" style="width:100%;box-sizing:border-box;" />
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:5px;">Message</label>
        <textarea id="admin-compose-body" class="msg-textarea" rows="5" placeholder="Message body…"></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center;">
        <span id="admin-compose-status" class="admin-muted"></span>
        <button class="btn btn-primary btn-sm" onclick="sendAdminMsg()">Send Message</button>
      </div>
    </div>`;
}

function toggleAdminRecipientType(type) {
  const isBroadcast = type === 'broadcast';
  document.getElementById('admin-compose-user-picker')?.classList.toggle('hidden', isBroadcast);
  document.getElementById('admin-compose-broadcast-notice')?.classList.toggle('hidden', !isBroadcast);
}

// Debounced user search for the compose recipient picker
let _adminRcptSearchTimer = null;
function adminRcptSearch(query) {
  clearTimeout(_adminRcptSearchTimer);
  const resultsEl = document.getElementById('admin-rcpt-results');

  if (!query.trim()) {
    if (resultsEl) resultsEl.innerHTML = '';
    return;
  }

  _adminRcptSearchTimer = setTimeout(async () => {
    try {
      const { users } = await apiFetch(`/admin/users?q=${encodeURIComponent(query)}&limit=8`);
      if (!resultsEl) return;

      if (!users.length) {
        resultsEl.innerHTML = '<div class="admin-muted" style="font-size:12px;padding:4px 0;">No users found.</div>';
        return;
      }

      resultsEl.innerHTML = `
        <div style="border:1px solid #e2e8f0;border-radius:6px;background:#fff;max-height:200px;overflow-y:auto;">
          ${users.map(u => `
            <div style="padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f1f5f9;"
                 onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''"
                 onclick="selectAdminRcpt('${u.user_id}', '${escapeAdminHtml(u.email)}')">
              ${escapeAdminHtml(u.email)}
              ${u.brand_name ? `<span class="admin-muted"> · ${escapeAdminHtml(u.brand_name)}</span>` : ''}
            </div>`).join('')}
        </div>`;
    } catch (_) {}
  }, 300);
}

function selectAdminRcpt(userId, email) {
  document.getElementById('admin-rcpt-id').value        = userId;
  document.getElementById('admin-rcpt-selected').textContent = `✅ Selected: ${email}`;
  document.getElementById('admin-rcpt-search').value    = email;
  const resultsEl = document.getElementById('admin-rcpt-results');
  if (resultsEl) resultsEl.innerHTML = '';
}

async function sendAdminMsg() {
  const isBroadcast = document.querySelector('input[name="admin-rcpt-type"]:checked')?.value === 'broadcast';
  const recipientId = document.getElementById('admin-rcpt-id')?.value;
  const subject     = document.getElementById('admin-compose-subject')?.value?.trim();
  const body        = document.getElementById('admin-compose-body')?.value?.trim();
  const statusEl    = document.getElementById('admin-compose-status');

  if (!isBroadcast && !recipientId) {
    showAlert('admin-compose-alerts', 'Select a recipient first', 'error');
    return;
  }
  if (!subject) { showAlert('admin-compose-alerts', 'Subject is required', 'error'); return; }
  if (!body)    { showAlert('admin-compose-alerts', 'Message body is required', 'error'); return; }
  if (isBroadcast && !confirm('Send this message to ALL users? This cannot be undone.')) return;

  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    await apiFetch('/admin/messages', {
      method: 'POST',
      body:   JSON.stringify({
        recipient_id: isBroadcast ? undefined : recipientId,
        is_broadcast: isBroadcast,
        subject,
        body
      })
    });

    showAlert('admin-compose-alerts', 'Message sent successfully!', 'success');

    // Clear the form
    document.getElementById('admin-compose-subject').value    = '';
    document.getElementById('admin-compose-body').value       = '';
    document.getElementById('admin-rcpt-id').value            = '';
    document.getElementById('admin-rcpt-selected').textContent = '';
    if (document.getElementById('admin-rcpt-search')) document.getElementById('admin-rcpt-search').value = '';
    if (statusEl) statusEl.textContent = '';

    // Navigate to sent/broadcast to confirm delivery
    setTimeout(() => loadAdminMessages(isBroadcast ? 'broadcast' : 'sent'), 1200);

  } catch (err) {
    showAlert('admin-compose-alerts', err.message, 'error');
    if (statusEl) statusEl.textContent = '';
  }
}

// ================================================================
// ISSUES TAB
// ================================================================

// Color + label helpers for ticket priority and status badges
function ticketPriorityBadge(p) {
  const map = {
    low:      { bg: '#f3f4f6', color: '#374151', label: 'Low' },
    medium:   { bg: '#fef3c7', color: '#92400e', label: 'Medium' },
    high:     { bg: '#fed7aa', color: '#9a3412', label: 'High' },
    critical: { bg: '#fee2e2', color: '#991b1b', label: 'Critical' }
  };
  const s = map[p] || map.medium;
  return `<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${s.bg};color:${s.color};font-weight:600;">${s.label}</span>`;
}
function ticketStatusBadge(st) {
  const map = {
    open:        { bg: '#dbeafe', color: '#1e40af', label: 'Open' },
    in_progress: { bg: '#ede9fe', color: '#5b21b6', label: 'In Progress' },
    resolved:    { bg: '#dcfce7', color: '#166534', label: 'Resolved' },
    closed:      { bg: '#f3f4f6', color: '#374151', label: 'Closed' }
  };
  const s = map[st] || map.open;
  return `<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${s.bg};color:${s.color};font-weight:600;">${s.label}</span>`;
}

// Main loader for the Issues tab
async function loadAdminIssues(statusFilter, priorityFilter) {
  const panel = document.getElementById('admin-tab-issues');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  // Build query params from filters
  let qs = '';
  const params = [];
  if (statusFilter && statusFilter !== 'all')     params.push(`status=${statusFilter}`);
  if (priorityFilter && priorityFilter !== 'all') params.push(`priority=${priorityFilter}`);
  if (params.length) qs = '?' + params.join('&');

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading tickets…</div>`;

  try {
    const { tickets } = await apiFetch(`/admin/tickets${qs}`);

    // Filter bar
    const sf = statusFilter || 'all';
    const pf = priorityFilter || 'all';
    const filterBar = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        <label style="font-size:13px;font-weight:600;">Status:
          <select onchange="loadAdminIssues(this.value, document.getElementById('issues-priority-filter').value)" style="margin-left:4px;padding:4px 8px;border-radius:4px;border:1px solid #d1d5db;">
            <option value="all" ${sf==='all'?'selected':''}>All</option>
            <option value="open" ${sf==='open'?'selected':''}>Open</option>
            <option value="in_progress" ${sf==='in_progress'?'selected':''}>In Progress</option>
            <option value="resolved" ${sf==='resolved'?'selected':''}>Resolved</option>
            <option value="closed" ${sf==='closed'?'selected':''}>Closed</option>
          </select>
        </label>
        <label style="font-size:13px;font-weight:600;">Priority:
          <select id="issues-priority-filter" onchange="loadAdminIssues(document.querySelector('#admin-tab-issues select').value, this.value)" style="margin-left:4px;padding:4px 8px;border-radius:4px;border:1px solid #d1d5db;">
            <option value="all" ${pf==='all'?'selected':''}>All</option>
            <option value="critical" ${pf==='critical'?'selected':''}>Critical</option>
            <option value="high" ${pf==='high'?'selected':''}>High</option>
            <option value="medium" ${pf==='medium'?'selected':''}>Medium</option>
            <option value="low" ${pf==='low'?'selected':''}>Low</option>
          </select>
        </label>
        <span style="font-size:13px;color:#6b7280;">${tickets.length} ticket${tickets.length !== 1 ? 's' : ''}</span>
      </div>`;

    if (tickets.length === 0) {
      panel.innerHTML = filterBar + '<p style="color:#6b7280;text-align:center;padding:40px 0;">No tickets found.</p>';
      return;
    }

    const rows = tickets.map(t => {
      const snippet = (t.what_happened || '').substring(0, 80) + ((t.what_happened || '').length > 80 ? '…' : '');
      const date = new Date(t.created_at).toLocaleDateString();
      return `
        <tr style="cursor:pointer;" onclick="openAdminTicketDetail('${t.id}')">
          <td style="font-size:13px;"><strong>${escapeAdminHtml(t.user_email)}</strong></td>
          <td style="font-size:13px;"><code>${escapeAdminHtml(t.feature)}</code></td>
          <td style="font-size:12px;color:#4b5563;">${escapeAdminHtml(snippet)}</td>
          <td>${ticketPriorityBadge(t.priority)}</td>
          <td>${ticketStatusBadge(t.status)}</td>
          <td style="font-size:12px;color:#9ca3af;white-space:nowrap;">${date}</td>
        </tr>`;
    }).join('');

    panel.innerHTML = filterBar + `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>User</th><th>Feature</th><th>Issue</th><th>Priority</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load tickets: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// Open a single ticket detail view in the Issues tab
async function openAdminTicketDetail(ticketId) {
  const panel = document.getElementById('admin-tab-issues');
  if (!panel) return;

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading ticket…</div>`;

  try {
    const { ticket: t } = await apiFetch(`/admin/tickets/${ticketId}`);

    panel.innerHTML = `
      <div style="margin-bottom:16px;">
        <button class="btn btn-sm" onclick="loadAdminIssues()">← Back to list</button>
      </div>

      <div style="border:1px solid var(--border-color,#e2e8f0);border-radius:8px;padding:20px;">
        <!-- Header row -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
          <div>
            <div style="font-size:16px;font-weight:700;">${escapeAdminHtml(t.user_email)}</div>
            <div style="font-size:12px;color:#9ca3af;">Submitted ${new Date(t.created_at).toLocaleString()}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            ${ticketPriorityBadge(t.priority)}
            ${ticketStatusBadge(t.status)}
          </div>
        </div>

        <!-- Feature -->
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">What part of the app</div>
          <div style="font-size:14px;"><code>${escapeAdminHtml(t.feature)}</code></div>
        </div>

        <!-- What happened -->
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">What happened</div>
          <div style="font-size:14px;white-space:pre-wrap;">${escapeAdminHtml(t.what_happened)}</div>
        </div>

        <!-- Expected -->
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">What they expected</div>
          <div style="font-size:14px;white-space:pre-wrap;">${escapeAdminHtml(t.expected)}</div>
        </div>

        <!-- Steps to reproduce -->
        ${t.steps ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">Steps to reproduce</div>
          <div style="font-size:14px;white-space:pre-wrap;">${escapeAdminHtml(t.steps)}</div>
        </div>` : ''}

        <!-- Browser info -->
        ${t.browser_info ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">Browser / Device</div>
          <div style="font-size:12px;color:#6b7280;">${escapeAdminHtml(t.browser_info)}</div>
        </div>` : ''}

        <!-- Screenshot -->
        ${t.screenshot_url ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">Screenshot</div>
          <a href="${escapeAdminHtml(t.screenshot_url)}" target="_blank">
            <img src="${escapeAdminHtml(t.screenshot_url)}" style="max-width:100%;max-height:300px;border-radius:6px;border:1px solid #e2e8f0;" />
          </a>
        </div>` : ''}

        <hr style="border:none;border-top:1px solid var(--border-color,#e2e8f0);margin:20px 0;" />

        <!-- Admin controls -->
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <label style="font-size:12px;font-weight:700;color:#6b7280;display:block;margin-bottom:4px;">Update Status</label>
            <select id="ticket-status-select" style="padding:6px 10px;border-radius:4px;border:1px solid #d1d5db;">
              <option value="open" ${t.status==='open'?'selected':''}>Open</option>
              <option value="in_progress" ${t.status==='in_progress'?'selected':''}>In Progress</option>
              <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
              <option value="closed" ${t.status==='closed'?'selected':''}>Closed</option>
            </select>
          </div>
          <div style="flex:1;min-width:200px;">
            <label style="font-size:12px;font-weight:700;color:#6b7280;display:block;margin-bottom:4px;">Admin Notes (internal only)</label>
            <textarea id="ticket-admin-notes" rows="3" style="width:100%;padding:8px;border-radius:4px;border:1px solid #d1d5db;font-size:13px;resize:vertical;">${escapeAdminHtml(t.admin_notes || '')}</textarea>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
          <button class="btn btn-sm" style="background:#2563eb;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;"
                  onclick="saveAdminTicketUpdate('${t.id}')">
            Save Changes
          </button>
          <span id="ticket-save-status" style="font-size:13px;color:#6b7280;"></span>
        </div>

        ${t.resolved_at ? `<div style="margin-top:12px;font-size:12px;color:#16a34a;">Resolved on ${new Date(t.resolved_at).toLocaleString()}</div>` : ''}
      </div>`;

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load ticket: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// Save admin status + notes updates on a ticket
async function saveAdminTicketUpdate(ticketId) {
  const statusEl = document.getElementById('ticket-status-select');
  const notesEl  = document.getElementById('ticket-admin-notes');
  const msgEl    = document.getElementById('ticket-save-status');

  if (msgEl) { msgEl.style.color = '#6b7280'; msgEl.textContent = 'Saving…'; }

  try {
    await apiFetch(`/admin/tickets/${ticketId}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: statusEl?.value,
        admin_notes: notesEl?.value || ''
      })
    });
    if (msgEl) { msgEl.style.color = '#16a34a'; msgEl.textContent = 'Saved!'; }
  } catch (err) {
    if (msgEl) { msgEl.style.color = '#dc2626'; msgEl.textContent = `Error: ${err.message}`; }
  }
}

// ================================================================
// CSS
// ================================================================

function injectAdminStyles() {
  if (document.getElementById('admin-styles')) return;
  const style = document.createElement('style');
  style.id = 'admin-styles';
  style.textContent = `
    /* Tabs */
    .admin-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 0;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .admin-tabs::-webkit-scrollbar { display: none; }
    .admin-tab {
      background: none;
      border: none;
      border-bottom: 3px solid transparent;
      padding: 8px 18px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      color: #64748b;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .admin-tab.active, .admin-tab:hover {
      color: #6366f1;
      border-bottom-color: #6366f1;
    }

    /* KPI cards */
    .admin-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 20px;
    }
    .admin-kpi {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 18px 16px;
      text-align: center;
    }
    .admin-kpi.kpi-alert {
      border-color: #fca5a5;
      background: #fff5f5;
    }
    .admin-kpi-value {
      font-size: 28px;
      font-weight: 800;
      color: #0f172a;
      line-height: 1;
    }
    .admin-kpi.kpi-alert .admin-kpi-value { color: #dc2626; }
    .admin-kpi-label {
      font-size: 12px;
      color: #64748b;
      margin-top: 6px;
    }

    /* Health banner */
    .admin-health-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 16px;
      border: 1.5px solid;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .admin-health-sub { font-size: 13px; color: #475569; }

    /* Tables */
    .admin-table-wrap { overflow-x: auto; }
    .admin-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .admin-table th {
      text-align: left;
      padding: 8px 12px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      font-weight: 600;
      color: #374151;
    }
    .admin-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #f1f5f9;
      color: #1e293b;
      vertical-align: middle;
    }
    .admin-users-table tbody tr.admin-user-row {
      cursor: pointer;
    }
    .admin-users-table tbody tr:hover td {
      background: #f0f9ff;
    }

    /* Users tab */
    .admin-users-top {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .admin-search {
      flex: 1;
      min-width: 240px;
      padding: 8px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 14px;
    }
    .admin-search:focus { outline: none; border-color: #6366f1; }

    /* User detail */
    .admin-user-detail { margin-top: 24px; }
    .admin-user-detail-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 20px;
    }
    .admin-user-detail-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .admin-user-detail-email { font-size: 16px; font-weight: 700; }
    .admin-detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      background: #f8fafc;
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
    }

    /* Override form */
    .admin-select, .admin-input {
      padding: 7px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 13px;
      background: #fff;
    }

    /* Queues tab */
    .admin-queues-board-link { margin-top: 8px; }

    /* Messages sub-tabs */
    .admin-msg-subtabs {
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 0;
    }

    /* Shared */
    .admin-section-title {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 10px;
    }
    .admin-loading {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 24px 0;
      color: #64748b;
      font-size: 14px;
    }
    .admin-error {
      padding: 16px;
      background: #fff5f5;
      border: 1px solid #fca5a5;
      border-radius: 8px;
      color: #dc2626;
      font-size: 13px;
    }
    .admin-muted { color: #64748b; font-size: 13px; }
    .admin-badge {
      display: inline-block;
      background: #f1f5f9;
      border-radius: 12px;
      padding: 2px 9px;
      font-size: 12px;
      font-weight: 600;
      color: #334155;
    }

    /* Revenue tab */
    .rev-stripe-notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: #fefce8;
      border: 1px solid #fde047;
      border-radius: 8px;
      font-size: 13px;
      color: #713f12;
      margin-bottom: 20px;
    }
    .rev-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .rev-kpi {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 18px 14px;
      text-align: center;
    }
    .rev-kpi-value {
      font-size: 26px;
      font-weight: 800;
      color: #0f172a;
      line-height: 1;
    }
    .rev-kpi-value.green { color: #16a34a; }
    .rev-kpi-value.indigo { color: #6366f1; }
    .rev-kpi-label {
      font-size: 12px;
      color: #64748b;
      margin-top: 6px;
    }
    .rev-kpi-sub {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 3px;
    }
    .rev-proj-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .rev-proj-table th {
      text-align: left;
      padding: 8px 12px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      font-weight: 600;
      color: #374151;
    }
    .rev-proj-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #f1f5f9;
      color: #1e293b;
    }
    .rev-proj-bar-wrap {
      height: 8px;
      background: #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
      min-width: 80px;
    }
    .rev-proj-bar {
      height: 100%;
      background: #6366f1;
      border-radius: 4px;
      transition: width 0.4s ease;
    }

    /* Limits tab */
    .limits-intro {
      font-size: 13px;
      color: #475569;
      margin-bottom: 20px;
    }
    .limits-table-wrap { overflow-x: auto; }
    .limits-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 560px;
    }
    .limits-table th {
      padding: 10px 14px;
      background: #f8fafc;
      border-bottom: 2px solid #e2e8f0;
      font-weight: 700;
      color: #374151;
      text-align: center;
    }
    .limits-table th:first-child { text-align: left; }
    .limits-table td {
      padding: 10px 14px;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: middle;
      text-align: center;
    }
    .limits-table td:first-child {
      text-align: left;
      font-weight: 600;
      color: #1e293b;
    }
    .limits-table tbody tr:hover td { background: #f8fafc; }
    .limits-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    /* Number input for limit value */
    .limit-val-input {
      width: 64px;
      padding: 5px 8px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 13px;
      text-align: center;
      background: #fff;
      transition: border-color 0.15s;
    }
    .limit-val-input:focus { outline: none; border-color: #6366f1; }
    .limit-val-input.saving { border-color: #a5b4fc; background: #eef2ff; }
    .limit-val-input.saved  { border-color: #86efac; background: #f0fdf4; }
    .limit-val-input.error  { border-color: #fca5a5; background: #fff5f5; }
    /* Toggle switch */
    .limit-toggle {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    .limit-toggle input { opacity: 0; width: 0; height: 0; }
    .limit-toggle-slider {
      position: absolute;
      inset: 0;
      background: #cbd5e1;
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .limit-toggle-slider::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      background: #fff;
      border-radius: 50%;
      top: 3px;
      left: 3px;
      transition: transform 0.2s;
    }
    .limit-toggle input:checked + .limit-toggle-slider { background: #6366f1; }
    .limit-toggle input:checked + .limit-toggle-slider::before { transform: translateX(16px); }

    /* Email tab */
    .email-sub-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 0;
    }
    .email-sub-tab {
      background: none;
      border: none;
      border-bottom: 3px solid transparent;
      padding: 6px 16px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: #64748b;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
    }
    .email-sub-tab.active, .email-sub-tab:hover {
      color: #6366f1;
      border-bottom-color: #6366f1;
    }
    .email-form-group {
      margin-bottom: 14px;
    }
    .email-form-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 4px;
    }
    .email-form-group input,
    .email-form-group select,
    .email-form-group textarea {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 13px;
      background: #fff;
      box-sizing: border-box;
    }
    .email-form-group input:focus,
    .email-form-group select:focus,
    .email-form-group textarea:focus {
      outline: none;
      border-color: #6366f1;
    }
    .email-textarea {
      font-family: 'Courier New', monospace;
      min-height: 140px;
      resize: vertical;
    }
    .email-filter-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-end;
    }
    .email-filter-row .email-form-group {
      flex: 1;
      min-width: 160px;
    }
    .email-status-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .email-status-draft    { background: #f1f5f9; color: #475569; }
    .email-status-sending  { background: #fef3c7; color: #92400e; }
    .email-status-sent     { background: #dcfce7; color: #166534; }
    .email-status-failed   { background: #fee2e2; color: #991b1b; }
    .email-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .email-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    .email-user-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .email-user-chip {
      display: inline-block;
      background: #eef2ff;
      color: #4338ca;
      padding: 3px 10px;
      border-radius: 14px;
      font-size: 12px;
      font-weight: 500;
    }
    .email-user-chip .remove-chip {
      cursor: pointer;
      margin-left: 4px;
      color: #6366f1;
      font-weight: 700;
    }

    /* ---- KPI Drill-down overlay ---- */
    .admin-drilldown-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .admin-drilldown-panel {
      background: var(--bg-primary, #fff);
      color: var(--text-primary, #1e293b);
      border-radius: 12px;
      width: 90%;
      max-width: 720px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .admin-drilldown-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color, #e2e8f0);
      font-weight: 700;
      font-size: 15px;
    }
    .admin-drilldown-close {
      background: none;
      border: none;
      font-size: 22px;
      cursor: pointer;
      color: var(--text-secondary, #64748b);
      padding: 4px 8px;
      line-height: 1;
    }
    .admin-drilldown-close:hover { color: var(--text-primary, #1e293b); }
    .admin-drilldown-body {
      overflow-y: auto;
      padding: 12px 20px;
      flex: 1;
    }
    .admin-drilldown-footer {
      padding: 12px 20px;
      border-top: 1px solid var(--border-color, #e2e8f0);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .admin-drilldown-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-color, #f1f5f9);
      font-size: 13px;
    }
    .admin-drilldown-row:hover { background: var(--bg-hover, #f8fafc); }
    .admin-drilldown-row label { flex: 1; cursor: pointer; }
    .admin-drilldown-select-all {
      padding: 8px 0 12px;
      border-bottom: 2px solid var(--border-color, #e2e8f0);
      margin-bottom: 4px;
      font-weight: 600;
      font-size: 13px;
    }
    .admin-kpi[onclick]:hover {
      border-color: var(--color-primary, #2563eb);
      box-shadow: 0 4px 6px -1px rgba(0,0,0,.1);
      transform: translateY(-1px);
      transition: all 0.15s ease;
    }

    /* ============================================================ */
    /* WATCHDOG TAB STYLES                                          */
    /* ============================================================ */

    /* Confidence gauge */
    .wd-gauge-wrap {
      display: flex;
      align-items: center;
      gap: 28px;
      padding: 20px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      margin-bottom: 20px;
    }
    .wd-gauge-ring {
      position: relative;
      width: 140px;
      height: 140px;
      flex-shrink: 0;
    }
    .wd-gauge-ring svg { transform: rotate(-90deg); }
    .wd-gauge-ring .wd-ring-bg {
      fill: none;
      stroke: #e2e8f0;
      stroke-width: 10;
    }
    .wd-gauge-ring .wd-ring-fg {
      fill: none;
      stroke-width: 10;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease, stroke 0.3s ease;
    }
    .wd-gauge-score {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 36px;
      line-height: 1;
    }
    .wd-gauge-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 4px;
    }
    .wd-gauge-info { flex: 1; }
    .wd-gauge-info h3 { margin: 0 0 8px; font-size: 16px; color: #0f172a; }
    .wd-gauge-info p { margin: 0; font-size: 13px; color: #64748b; line-height: 1.6; }

    /* Breakdown bars */
    .wd-breakdown {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .wd-break-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px;
    }
    .wd-break-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 6px;
    }
    .wd-break-bar-bg {
      height: 8px;
      background: #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
    }
    .wd-break-bar-fg {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .wd-break-val {
      font-size: 20px;
      font-weight: 800;
      color: #0f172a;
      margin-top: 4px;
    }

    /* Trend chart */
    .wd-chart-wrap {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .wd-chart-title {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 14px;
    }
    .wd-chart {
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 120px;
    }
    .wd-chart-bar {
      flex: 1;
      border-radius: 3px 3px 0 0;
      min-width: 3px;
      transition: height 0.3s ease;
      position: relative;
    }
    .wd-chart-bar:hover::after {
      content: attr(data-tip);
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: #fff;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      white-space: nowrap;
      z-index: 10;
    }

    /* Anomaly cards */
    .wd-anomaly {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .wd-anomaly.critical { border-left: 4px solid #dc2626; background: #fef2f2; }
    .wd-anomaly.warning  { border-left: 4px solid #f59e0b; background: #fffbeb; }
    .wd-anomaly .wd-anomaly-icon { font-size: 18px; flex-shrink: 0; }
    .wd-anomaly .wd-anomaly-body { flex: 1; }
    .wd-anomaly .wd-anomaly-title { font-weight: 600; color: #0f172a; }
    .wd-anomaly .wd-anomaly-time { color: #94a3b8; font-size: 11px; margin-top: 2px; }
    .wd-anomaly .wd-anomaly-details { color: #64748b; margin-top: 4px; }

    /* Pause banner */
    .wd-pause-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 20px;
      background: #fef2f2;
      border: 2px solid #dc2626;
      border-radius: 10px;
      margin-bottom: 20px;
      font-size: 14px;
      font-weight: 600;
      color: #991b1b;
    }

    /* Job duration bars */
    .wd-duration-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .wd-dur-card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px;
    }
    .wd-dur-label { font-size: 12px; font-weight: 600; color: #64748b; }
    .wd-dur-value { font-size: 20px; font-weight: 800; color: #0f172a; margin: 4px 0; }
    .wd-dur-range { font-size: 11px; color: #94a3b8; }

    /* Event log */
    .wd-event-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid #f1f5f9;
      font-size: 13px;
    }
    .wd-event-row:hover { background: #f8fafc; }
    .wd-event-sev {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .wd-event-sev.info     { background: #3b82f6; }
    .wd-event-sev.warning  { background: #f59e0b; }
    .wd-event-sev.critical { background: #dc2626; }
    .wd-event-time { color: #94a3b8; font-size: 11px; min-width: 80px; }
    .wd-event-title { flex: 1; color: #1e293b; }
  `;
  document.head.appendChild(style);
}

// ================================================================
// EMAIL TAB
// ================================================================

let _emailSubTab = 'groups';
let _emailCampaignPollTimer = null;

// ----------------------------------------------------------------
// loadAdminEmail — entry point for the Email tab
// ----------------------------------------------------------------
function loadAdminEmail() {
  const panel = document.getElementById('admin-tab-email');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  panel.innerHTML = `
    <div class="email-sub-tabs">
      <button class="email-sub-tab active" data-subtab="groups"    onclick="switchEmailSubTab('groups')">Groups</button>
      <button class="email-sub-tab"        data-subtab="campaigns" onclick="switchEmailSubTab('campaigns')">Campaigns</button>
    </div>
    <div id="email-sub-groups"></div>
    <div id="email-sub-campaigns" class="hidden"></div>
  `;

  loadEmailGroups();
}

function switchEmailSubTab(sub) {
  _emailSubTab = sub;
  stopCampaignPoll();
  document.querySelectorAll('.email-sub-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subtab === sub);
  });
  document.getElementById('email-sub-groups').classList.toggle('hidden', sub !== 'groups');
  document.getElementById('email-sub-campaigns').classList.toggle('hidden', sub !== 'campaigns');

  if (sub === 'groups')    loadEmailGroups();
  if (sub === 'campaigns') loadEmailCampaigns();
}

// ================================================================
// EMAIL GROUPS
// ================================================================

async function loadEmailGroups() {
  const el = document.getElementById('email-sub-groups');
  if (!el) return;
  el.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading groups…</div>`;

  try {
    const data = await apiFetch('/email/groups');
    const groups = data.groups || [];

    if (groups.length === 0) {
      el.innerHTML = `
        <div class="admin-muted" style="padding:20px 0;">No email groups yet.</div>
        <button class="btn btn-primary btn-sm" onclick="showCreateGroupForm()">+ Create Group</button>
      `;
      return;
    }

    const rows = groups.map(g => {
      const typeLabel = g.group_type === 'filter'
        ? '<span class="admin-badge">Filter</span>'
        : '<span class="admin-badge">Manual</span>';
      return `<tr>
        <td>${escapeAdminHtml(g.name)}</td>
        <td>${typeLabel}</td>
        <td class="admin-muted">${escapeAdminHtml(g.description || '—')}</td>
        <td class="admin-muted">${new Date(g.created_at).toLocaleDateString()}</td>
        <td>
          <button class="btn btn-sm" onclick="previewGroupMembers('${g.id}')">Preview</button>
          <button class="btn btn-sm" onclick="showEditGroupForm('${g.id}')">Edit</button>
          <button class="btn btn-sm" style="color:#dc2626;" onclick="deleteEmailGroup('${g.id}', '${escapeAdminHtml(g.name)}')">Delete</button>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div class="admin-muted">${groups.length} group${groups.length !== 1 ? 's' : ''}</div>
        <button class="btn btn-primary btn-sm" onclick="showCreateGroupForm()">+ Create Group</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="email-group-form-area"></div>
      <div id="email-group-preview-area"></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="admin-error">Failed to load groups: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// ----------------------------------------------------------------
// Create / Edit group form
// ----------------------------------------------------------------
function showCreateGroupForm() {
  renderGroupForm(null);
}

async function showEditGroupForm(groupId) {
  try {
    const data = await apiFetch(`/email/groups/${groupId}`);
    renderGroupForm(data.group);
  } catch (err) {
    alert('Failed to load group: ' + err.message);
  }
}

function renderGroupForm(group) {
  const area = document.getElementById('email-group-form-area')
            || document.getElementById('email-sub-groups');
  if (!area) return;

  // If no form area exists yet (no groups), use the sub panel
  let formArea = document.getElementById('email-group-form-area');
  if (!formArea) {
    const el = document.getElementById('email-sub-groups');
    el.innerHTML += '<div id="email-group-form-area"></div>';
    formArea = document.getElementById('email-group-form-area');
  }

  const isEdit = !!group;
  const name = group?.name || '';
  const desc = group?.description || '';
  const type = group?.group_type || 'filter';
  const criteria = group?.filter_criteria || {};
  const manualIds = group?.manual_user_ids || [];

  formArea.innerHTML = `
    <div class="email-card" style="margin-top:16px;">
      <div class="admin-section-title">${isEdit ? 'Edit Group' : 'Create Group'}</div>

      <div class="email-form-group">
        <label>Group Name</label>
        <input type="text" id="eg-name" value="${escapeAdminHtml(name)}" placeholder="e.g. All Starter Users" />
      </div>
      <div class="email-form-group">
        <label>Description (optional)</label>
        <input type="text" id="eg-desc" value="${escapeAdminHtml(desc)}" placeholder="What this group is for" />
      </div>
      <div class="email-form-group">
        <label>Group Type</label>
        <select id="eg-type" onchange="toggleGroupTypeFields()">
          <option value="filter" ${type === 'filter' ? 'selected' : ''}>Filter-based (dynamic)</option>
          <option value="manual" ${type === 'manual' ? 'selected' : ''}>Manual (hand-picked users)</option>
        </select>
      </div>

      <!-- Filter fields -->
      <div id="eg-filter-fields" class="${type !== 'filter' ? 'hidden' : ''}">
        <div class="admin-section-title" style="margin-top:12px;font-size:13px;">Filter Criteria</div>
        <div class="email-filter-row">
          <div class="email-form-group">
            <label>Subscription Tier</label>
            <select id="eg-tier">
              <option value="">Any</option>
              <option value="free_trial" ${criteria.subscription_tier === 'free_trial' ? 'selected' : ''}>Free Trial</option>
              <option value="starter" ${criteria.subscription_tier === 'starter' ? 'selected' : ''}>Starter</option>
              <option value="professional" ${criteria.subscription_tier === 'professional' ? 'selected' : ''}>Professional</option>
              <option value="enterprise" ${criteria.subscription_tier === 'enterprise' ? 'selected' : ''}>Enterprise</option>
            </select>
          </div>
          <div class="email-form-group">
            <label>Industry</label>
            <input type="text" id="eg-industry" value="${escapeAdminHtml(criteria.industry || '')}" placeholder="e.g. fitness" />
          </div>
          <div class="email-form-group">
            <label>Region</label>
            <input type="text" id="eg-region" value="${escapeAdminHtml(criteria.geo_region || '')}" placeholder="e.g. US-CA" />
          </div>
          <div class="email-form-group">
            <label>Business Type</label>
            <input type="text" id="eg-biz" value="${escapeAdminHtml(criteria.business_type || '')}" placeholder="e.g. saas" />
          </div>
        </div>
        <div class="email-filter-row" style="margin-top:8px;">
          <div class="email-form-group">
            <label>Signed Up After</label>
            <input type="date" id="eg-after" value="${criteria.signup_after || ''}" />
          </div>
          <div class="email-form-group">
            <label>Signed Up Before</label>
            <input type="date" id="eg-before" value="${criteria.signup_before || ''}" />
          </div>
          <div class="email-form-group">
            <label>Platforms Connected</label>
            <input type="text" id="eg-platforms" value="${(criteria.platforms_connected || []).join(', ')}" placeholder="facebook, instagram" />
          </div>
        </div>
      </div>

      <!-- Manual fields -->
      <div id="eg-manual-fields" class="${type !== 'manual' ? 'hidden' : ''}">
        <div class="admin-section-title" style="margin-top:12px;font-size:13px;">Select Users</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="eg-user-dropdown" style="flex:1;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
            <option value="">-- Choose a user to add --</option>
          </select>
          <button class="btn btn-sm btn-primary" onclick="addUserFromDropdown()">Add</button>
        </div>
        <div class="email-user-chips" id="eg-selected-users" style="margin-top:8px;">
          ${manualIds.map(id => `<span class="email-user-chip" data-uid="${id}">${id.slice(0,8)}… <span class="remove-chip" onclick="removeManualUser('${id}')">×</span></span>`).join('')}
        </div>
      </div>

      <div class="email-actions">
        <button class="btn btn-primary btn-sm" onclick="saveEmailGroup('${isEdit ? group.id : ''}')">${isEdit ? 'Update Group' : 'Create Group'}</button>
        <button class="btn btn-sm btn-ghost" onclick="loadEmailGroups()">Cancel</button>
        <span id="eg-save-status" class="admin-muted"></span>
      </div>
    </div>
  `;

  // Load the user dropdown and pre-select any existing manual users
  loadUserDropdown(manualIds);
}

function toggleGroupTypeFields() {
  const type = document.getElementById('eg-type')?.value;
  document.getElementById('eg-filter-fields')?.classList.toggle('hidden', type !== 'filter');
  document.getElementById('eg-manual-fields')?.classList.toggle('hidden', type !== 'manual');
  // Load users into dropdown when manual is selected
  if (type === 'manual') loadUserDropdown(_manualSelectedUsers.slice());
}

// Track manually selected user IDs
let _manualSelectedUsers = [];
// Cache all users so we don't re-fetch every time
let _allUsersCache = null;

async function loadUserDropdown(preSelectedIds = []) {
  _manualSelectedUsers = [...preSelectedIds];
  const dropdown = document.getElementById('eg-user-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = '<option value="">Loading users…</option>';

  try {
    if (!_allUsersCache) {
      const data = await apiFetch('/admin/users?limit=500');
      _allUsersCache = data.users || [];
    }
    refreshDropdownOptions();

    // If editing, show chips for pre-selected users
    if (preSelectedIds.length > 0) {
      const chipsEl = document.getElementById('eg-selected-users');
      if (chipsEl) {
        chipsEl.innerHTML = preSelectedIds.map(id => {
          const u = _allUsersCache.find(usr => usr.user_id === id);
          const label = u ? escapeAdminHtml(u.email) : id.slice(0, 8) + '…';
          return `<span class="email-user-chip" data-uid="${id}">${label} <span class="remove-chip" onclick="removeManualUser('${id}')">×</span></span>`;
        }).join('');
      }
    }
  } catch (_) {
    dropdown.innerHTML = '<option value="">Failed to load users</option>';
  }
}

function refreshDropdownOptions() {
  const dropdown = document.getElementById('eg-user-dropdown');
  if (!dropdown || !_allUsersCache) return;

  // Filter out already-selected users
  const available = _allUsersCache.filter(u => !_manualSelectedUsers.includes(u.user_id));

  dropdown.innerHTML = `<option value="">-- Choose a user to add (${available.length} available) --</option>`
    + available.map(u =>
      `<option value="${u.user_id}">${escapeAdminHtml(u.email)}${u.brand_name ? ' (' + escapeAdminHtml(u.brand_name) + ')' : ''}</option>`
    ).join('');
}

function addUserFromDropdown() {
  const dropdown = document.getElementById('eg-user-dropdown');
  if (!dropdown || !dropdown.value) return;

  const userId = dropdown.value;
  const selectedOption = dropdown.options[dropdown.selectedIndex];
  const label = selectedOption.textContent;

  if (_manualSelectedUsers.includes(userId)) return;
  _manualSelectedUsers.push(userId);

  // Add chip
  const chipsEl = document.getElementById('eg-selected-users');
  if (chipsEl) {
    chipsEl.innerHTML += `<span class="email-user-chip" data-uid="${userId}">${escapeAdminHtml(label)} <span class="remove-chip" onclick="removeManualUser('${userId}')">×</span></span>`;
  }

  // Refresh dropdown to remove the selected user from options
  refreshDropdownOptions();
}

function removeManualUser(userId) {
  _manualSelectedUsers = _manualSelectedUsers.filter(id => id !== userId);
  const chip = document.querySelector(`.email-user-chip[data-uid="${userId}"]`);
  if (chip) chip.remove();
  // Put the user back in the dropdown
  refreshDropdownOptions();
}

async function saveEmailGroup(groupId) {
  const statusEl = document.getElementById('eg-save-status');
  const name      = document.getElementById('eg-name')?.value?.trim();
  const desc      = document.getElementById('eg-desc')?.value?.trim();
  const groupType = document.getElementById('eg-type')?.value;

  if (!name) { if (statusEl) statusEl.textContent = 'Name is required'; return; }

  // Build the request body based on type
  const body = { name, description: desc, group_type: groupType };

  if (groupType === 'filter') {
    const criteria = {};
    const tier = document.getElementById('eg-tier')?.value;
    const ind  = document.getElementById('eg-industry')?.value?.trim();
    const reg  = document.getElementById('eg-region')?.value?.trim();
    const biz  = document.getElementById('eg-biz')?.value?.trim();
    const after  = document.getElementById('eg-after')?.value;
    const before = document.getElementById('eg-before')?.value;
    const plats  = document.getElementById('eg-platforms')?.value?.trim();

    if (tier)   criteria.subscription_tier = tier;
    if (ind)    criteria.industry = ind;
    if (reg)    criteria.geo_region = reg;
    if (biz)    criteria.business_type = biz;
    if (after)  criteria.signup_after = after;
    if (before) criteria.signup_before = before;
    if (plats)  criteria.platforms_connected = plats.split(',').map(s => s.trim()).filter(Boolean);

    body.filter_criteria = criteria;
  } else {
    body.manual_user_ids = _manualSelectedUsers;
  }

  try {
    if (statusEl) statusEl.textContent = 'Saving…';
    if (groupId) {
      await apiFetch(`/email/groups/${groupId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/email/groups', { method: 'POST', body: JSON.stringify(body) });
    }
    loadEmailGroups();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + err.message;
  }
}

async function deleteEmailGroup(groupId, name) {
  if (!confirm(`Delete group "${name}"? Any campaigns using this group will lose their target.`)) return;
  try {
    await apiFetch(`/email/groups/${groupId}`, { method: 'DELETE' });
    loadEmailGroups();
  } catch (err) {
    alert('Failed to delete group: ' + err.message);
  }
}

async function previewGroupMembers(groupId) {
  let previewArea = document.getElementById('email-group-preview-area');
  if (!previewArea) {
    const el = document.getElementById('email-sub-groups');
    if (el) el.innerHTML += '<div id="email-group-preview-area"></div>';
    previewArea = document.getElementById('email-group-preview-area');
  }
  if (!previewArea) return;

  previewArea.innerHTML = `<div class="email-card" style="margin-top:12px;"><div class="admin-loading"><div class="spinner spinner-sm"></div> Resolving members…</div></div>`;
  previewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const data = await apiFetch(`/email/groups/${groupId}/preview`);
    const users = data.users || [];
    if (users.length === 0) {
      previewArea.innerHTML = `<div class="email-card" style="margin-top:12px;">
        <div class="admin-section-title">Group Preview</div>
        <div class="admin-muted">No users match this group's criteria.</div>
        <button class="btn btn-sm btn-ghost" style="margin-top:8px;" onclick="document.getElementById('email-group-preview-area').innerHTML=''">Close</button>
      </div>`;
      return;
    }

    const rows = users.slice(0, 50).map(u => `<tr>
      <td>${escapeAdminHtml(u.email)}</td>
      <td>${escapeAdminHtml(u.brand_name || '—')}</td>
    </tr>`).join('');

    previewArea.innerHTML = `<div class="email-card" style="margin-top:12px;">
      <div class="admin-section-title">Group Preview — ${data.count} user${data.count !== 1 ? 's' : ''}</div>
      ${data.count > 50 ? '<div class="admin-muted" style="margin-bottom:8px;">Showing first 50</div>' : ''}
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Email</th><th>Brand</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <button class="btn btn-sm btn-ghost" style="margin-top:10px;" onclick="document.getElementById('email-group-preview-area').innerHTML=''">Close Preview</button>
    </div>`;
  } catch (err) {
    previewArea.innerHTML = `<div class="admin-error" style="margin-top:12px;">Failed to preview: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// ================================================================
// EMAIL CAMPAIGNS
// ================================================================

async function loadEmailCampaigns() {
  const el = document.getElementById('email-sub-campaigns');
  if (!el) return;
  el.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading campaigns…</div>`;

  try {
    const data = await apiFetch('/email/campaigns');
    const campaigns = data.campaigns || [];

    if (campaigns.length === 0) {
      el.innerHTML = `
        <div class="admin-muted" style="padding:20px 0;">No campaigns yet.</div>
        <button class="btn btn-primary btn-sm" onclick="showCreateCampaignForm()">+ Create Campaign</button>
      `;
      return;
    }

    const rows = campaigns.map(c => {
      const statusCls = `email-status-${c.status}`;
      const progress = c.status === 'sending'
        ? `${c.sent_count + c.failed_count}/${c.total_count}`
        : c.status === 'sent' || c.status === 'failed'
          ? `${c.sent_count} sent, ${c.failed_count} failed`
          : '—';

      return `<tr style="cursor:pointer;" onclick="loadCampaignDetail('${c.id}')">
        <td>${escapeAdminHtml(c.subject)}</td>
        <td>${escapeAdminHtml(c.group_name)}</td>
        <td><span class="email-status-badge ${statusCls}">${c.status}</span></td>
        <td class="admin-muted">${progress}</td>
        <td class="admin-muted">${c.sent_at ? new Date(c.sent_at).toLocaleDateString() : '—'}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div class="admin-muted">${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}</div>
        <button class="btn btn-primary btn-sm" onclick="showCreateCampaignForm()">+ Create Campaign</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Subject</th><th>Group</th><th>Status</th><th>Progress</th><th>Sent</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="email-campaign-detail-area"></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="admin-error">Failed to load campaigns: ${escapeAdminHtml(err.message)}</div>`;
  }
}

async function showCreateCampaignForm() {
  const el = document.getElementById('email-sub-campaigns');
  if (!el) return;

  // Fetch groups for the dropdown
  let groups = [];
  try {
    const data = await apiFetch('/email/groups');
    groups = data.groups || [];
  } catch (_) {}

  if (groups.length === 0) {
    alert('Create at least one email group before creating a campaign.');
    return;
  }

  const options = groups.map(g =>
    `<option value="${g.id}">${escapeAdminHtml(g.name)} (${g.group_type})</option>`
  ).join('');

  el.innerHTML = `
    <div class="email-card">
      <div class="admin-section-title">New Campaign</div>

      <div class="email-form-group">
        <label>Target Group</label>
        <select id="ec-group">${options}</select>
      </div>
      <div class="email-form-group">
        <label>Subject</label>
        <input type="text" id="ec-subject" placeholder="Email subject line" />
      </div>
      <div class="email-form-group">
        <label>Body (plain text)</label>
        <textarea id="ec-body" class="email-textarea" placeholder="Write your email here…"></textarea>
      </div>

      <div class="email-actions">
        <button class="btn btn-primary btn-sm" onclick="saveCampaignDraft()">Save as Draft</button>
        <button class="btn btn-sm btn-ghost" onclick="loadEmailCampaigns()">Cancel</button>
        <span id="ec-save-status" class="admin-muted"></span>
      </div>
    </div>
  `;
}

async function saveCampaignDraft() {
  const statusEl = document.getElementById('ec-save-status');
  const group_id = document.getElementById('ec-group')?.value;
  const subject  = document.getElementById('ec-subject')?.value?.trim();
  const body     = document.getElementById('ec-body')?.value?.trim();

  if (!subject || !body) {
    if (statusEl) statusEl.textContent = 'Subject and body are required';
    return;
  }

  try {
    if (statusEl) statusEl.textContent = 'Saving…';
    await apiFetch('/email/campaigns', {
      method: 'POST',
      body: JSON.stringify({ group_id, subject, body })
    });
    loadEmailCampaigns();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + err.message;
  }
}

async function loadCampaignDetail(campaignId) {
  stopCampaignPoll();

  let detailArea = document.getElementById('email-campaign-detail-area');
  if (!detailArea) {
    const el = document.getElementById('email-sub-campaigns');
    if (el) el.innerHTML += '<div id="email-campaign-detail-area"></div>';
    detailArea = document.getElementById('email-campaign-detail-area');
  }
  if (!detailArea) return;

  detailArea.innerHTML = `<div class="email-card" style="margin-top:16px;"><div class="admin-loading"><div class="spinner spinner-sm"></div> Loading…</div></div>`;
  detailArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const data = await apiFetch(`/email/campaigns/${campaignId}`);
    renderCampaignDetail(data, detailArea);

    // Auto-refresh while sending
    if (data.campaign.status === 'sending') {
      _emailCampaignPollTimer = setInterval(async () => {
        try {
          const refreshed = await apiFetch(`/email/campaigns/${campaignId}`);
          renderCampaignDetail(refreshed, detailArea);
          if (refreshed.campaign.status !== 'sending') stopCampaignPoll();
        } catch (_) { stopCampaignPoll(); }
      }, 5000);
    }
  } catch (err) {
    detailArea.innerHTML = `<div class="admin-error" style="margin-top:16px;">Failed: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function stopCampaignPoll() {
  if (_emailCampaignPollTimer) { clearInterval(_emailCampaignPollTimer); _emailCampaignPollTimer = null; }
}

function renderCampaignDetail(data, container) {
  const c = data.campaign;
  const logs = data.logs || [];
  const statusCls = `email-status-${c.status}`;

  const canSend = ['draft', 'failed'].includes(c.status);
  const sendBtn = canSend
    ? `<button class="btn btn-primary btn-sm" onclick="sendCampaign('${c.id}')">Send Now</button>`
    : '';

  const progressBar = c.total_count > 0
    ? `<div style="margin:12px 0;">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:4px;">
          <span>${c.sent_count + c.failed_count} / ${c.total_count}</span>
          <span>${Math.round((c.sent_count + c.failed_count) / c.total_count * 100)}%</span>
        </div>
        <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${Math.round(c.sent_count / c.total_count * 100)}%;background:#22c55e;float:left;"></div>
          <div style="height:100%;width:${Math.round(c.failed_count / c.total_count * 100)}%;background:#ef4444;float:left;"></div>
        </div>
      </div>`
    : '';

  const logRows = logs.slice(0, 100).map(l => {
    const lStatus = l.status === 'sent'
      ? '<span style="color:#16a34a;">sent</span>'
      : `<span style="color:#dc2626;">${escapeAdminHtml(l.status)}</span>`;
    return `<tr>
      <td>${escapeAdminHtml(l.email)}</td>
      <td>${lStatus}</td>
      <td class="admin-muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeAdminHtml(l.error_message || '—')}</td>
      <td class="admin-muted">${l.sent_at ? new Date(l.sent_at).toLocaleString() : '—'}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="email-card" style="margin-top:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:16px;font-weight:700;">${escapeAdminHtml(c.subject)}</div>
          <div class="admin-muted">Group: ${escapeAdminHtml(c.group_name)} · Created: ${new Date(c.created_at).toLocaleDateString()}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="email-status-badge ${statusCls}">${c.status}</span>
          ${sendBtn}
          <button class="btn btn-sm btn-ghost" onclick="document.getElementById('email-campaign-detail-area').innerHTML='';stopCampaignPoll();">Close</button>
        </div>
      </div>

      ${progressBar}

      <div style="margin:14px 0;">
        <div class="admin-section-title" style="font-size:12px;">Email Body</div>
        <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;font-size:13px;white-space:pre-wrap;max-height:200px;overflow-y:auto;">${escapeAdminHtml(c.body)}</pre>
      </div>

      <div class="admin-kpi-grid" style="margin-top:14px;grid-template-columns:repeat(3,1fr);">
        <div class="admin-kpi"><div class="admin-kpi-value">${c.total_count}</div><div class="admin-kpi-label">Total</div></div>
        <div class="admin-kpi"><div class="admin-kpi-value" style="color:#16a34a;">${c.sent_count}</div><div class="admin-kpi-label">Sent</div></div>
        <div class="admin-kpi ${c.failed_count > 0 ? 'kpi-alert' : ''}"><div class="admin-kpi-value">${c.failed_count}</div><div class="admin-kpi-label">Failed</div></div>
      </div>

      ${logs.length > 0 ? `
        <div class="admin-section-title" style="margin-top:20px;">Delivery Log${logs.length > 100 ? ' (first 100)' : ''}</div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Email</th><th>Status</th><th>Error</th><th>Sent At</th></tr></thead>
            <tbody>${logRows}</tbody>
          </table>
        </div>
      ` : ''}
    </div>
  `;
}

async function sendCampaign(campaignId) {
  if (!confirm('Send this campaign now? Emails will be sent to all group members.')) return;

  try {
    await apiFetch(`/email/campaigns/${campaignId}/send`, { method: 'POST' });
    // Reload the detail with polling
    loadCampaignDetail(campaignId);
  } catch (err) {
    alert('Failed to send: ' + err.message);
  }
}

// ----------------------------------------------------------------
// escapeAdminHtml — prevents XSS in admin-rendered content.
// Named separately from brief.js's escapeHtml to avoid collision.
// ----------------------------------------------------------------
function escapeAdminHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================================================================
// LIMITS TAB
// ================================================================

/**
 * loadAdminLimits — renders the tier limits editor.
 *
 * Fetches all rows from tier_limits (via GET /admin/tier-limits),
 * groups them by feature, and renders a table where:
 *   - Rows = features (briefs_per_month, ai_images_per_month, etc.)
 *   - Columns = tiers (free, starter, professional, enterprise)
 *   - Each cell = number input (limit value) + enabled toggle
 *
 * Changes auto-save on blur (value) or change (toggle) via
 * PUT /admin/tier-limits/:id.  Visual feedback on each input.
 */
async function loadAdminLimits() {
  const panel = document.getElementById('admin-tab-limits');
  if (!panel) return;

  panel.innerHTML = `<div class="admin-loading"><span>⏳</span> Loading tier limits…</div>`;

  let limits;
  let seedError;
  try {
    const res = await apiFetch('/admin/tier-limits');
    limits = res.limits || [];
    seedError = res.seedError;
  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load limits: ${escapeAdminHtml(err.message)}</div>`;
    return;
  }

  if (limits.length === 0) {
    const msg = seedError
      ? `Auto-seed failed: ${escapeAdminHtml(seedError)}. The tier_limits table may need to be created first.`
      : 'No tier limits configured. Run the SQL migration to seed the tier_limits table.';
    panel.innerHTML = `<div class="admin-muted">${msg}</div>`;
    return;
  }

  // Mark as loaded only after data is successfully fetched and non-empty.
  // This way, if the fetch returns empty (transient issue), clicking the
  // tab again will retry instead of showing stale empty state.
  panel.dataset.loaded = '1';

  // --- Build lookup: feature → tier → row ---
  const TIERS    = ['free_trial', 'starter', 'professional', 'enterprise'];
  const FEATURES = [...new Set(limits.map(l => l.feature))].sort();

  // Human-readable labels
  const TIER_LABELS = {
    free_trial: 'Free Trial',
    starter: 'Starter',
    professional: 'Professional',
    enterprise: 'Enterprise'
  };

  const FEATURE_LABELS = {
    briefs_per_month:       'Briefs / month',
    ai_images_per_month:    'AI images / month',
    platforms_connected:    'Platforms connected',
    scheduled_queue_size:   'Scheduled queue size',
    comment_monitoring:     'Comment monitoring',
    dm_lead_capture:        'DM & lead capture',
    intelligence_dashboard: 'Intelligence dashboard',
    performance_predictor:  'Performance predictor',
    pain_point_miner:       'Pain-point miner',
    brand_voice_tracker:    'Brand voice tracker'
  };

  const byFeatureTier = {};
  for (const row of limits) {
    if (!byFeatureTier[row.feature]) byFeatureTier[row.feature] = {};
    byFeatureTier[row.feature][row.tier] = row;
  }

  // --- Render table ---
  const headerCols = TIERS.map(t =>
    `<th>${TIER_LABELS[t] || t}</th>`
  ).join('');

  // Features that are simple on/off flags (no number input needed)
  const FLAG_FEATURES = ['comment_monitoring', 'dm_lead_capture', 'intelligence_dashboard', 'performance_predictor', 'pain_point_miner', 'brand_voice_tracker'];

  const bodyRows = FEATURES.map(feature => {
    const isFlag = FLAG_FEATURES.includes(feature);

    const cells = TIERS.map(tier => {
      const row = byFeatureTier[feature]?.[tier];
      if (!row) return `<td><span class="admin-muted">—</span></td>`;

      if (isFlag) {
        // Simple on/off toggle — no number input
        const isOn = row.limit_value > 0;
        return `
          <td>
            <div class="limits-cell" style="justify-content:center;">
              <label class="limit-toggle" title="${isOn ? 'On — click to turn off' : 'Off — click to turn on'}">
                <input
                  type="checkbox"
                  id="limit-flag-${row.id}"
                  data-id="${row.id}"
                  ${isOn ? 'checked' : ''}
                  onchange="saveLimitFlag(this)"
                />
                <span class="limit-toggle-slider"></span>
              </label>
            </div>
          </td>`;
      }

      // Numeric limit — number input + enabled toggle
      const displayVal = row.limit_value === -1 ? '' : row.limit_value;
      const checked    = row.enabled ? 'checked' : '';

      return `
        <td>
          <div class="limits-cell">
            <input
              type="number"
              class="limit-val-input"
              id="limit-val-${row.id}"
              data-id="${row.id}"
              data-feature="${feature}"
              data-tier="${tier}"
              value="${displayVal}"
              placeholder="∞"
              min="-1"
              onblur="saveLimitValue(this)"
            />
            <label class="limit-toggle" title="${row.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
              <input
                type="checkbox"
                id="limit-tog-${row.id}"
                data-id="${row.id}"
                ${checked}
                onchange="saveLimitToggle(this)"
              />
              <span class="limit-toggle-slider"></span>
            </label>
          </div>
        </td>`;
    }).join('');

    const label = FEATURE_LABELS[feature] || feature;
    return `<tr><td>${escapeAdminHtml(label)}</td>${cells}</tr>`;
  }).join('');

  panel.innerHTML = `
    <p class="limits-intro">
      Set per-tier usage caps. Enter a number for the limit, or leave blank / enter <strong>-1</strong> for unlimited.
      Toggle the switch to enable or disable a feature for a tier. Changes save instantly.
    </p>
    <div class="limits-table-wrap">
      <table class="limits-table">
        <thead>
          <tr>
            <th>Feature</th>
            ${headerCols}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

/**
 * saveLimitValue — called onblur on a limit value input.
 * Sends the new limit_value to PUT /admin/tier-limits/:id.
 * Blank input = -1 (unlimited).
 */
async function saveLimitValue(input) {
  const id  = input.dataset.id;
  // Blank or '-1' both mean unlimited (-1)
  const raw = input.value.trim();
  const val = raw === '' ? -1 : parseInt(raw, 10);

  if (isNaN(val)) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 1500);
    return;
  }

  input.classList.add('saving');
  input.disabled = true;

  try {
    await apiFetch(`/admin/tier-limits/${id}`, {
      method: 'PUT',
      body:   JSON.stringify({ limit_value: val })
    });

    // Show saved state briefly, then restore neutral style
    input.classList.remove('saving');
    input.classList.add('saved');
    // Update displayed value so -1 shows as placeholder
    input.value = val === -1 ? '' : val;
    setTimeout(() => input.classList.remove('saved'), 1200);

  } catch (err) {
    input.classList.remove('saving');
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);
    console.error('[Limits] Save failed:', err.message);
  } finally {
    input.disabled = false;
  }
}

/**
 * saveLimitToggle — called onchange on a limit enabled toggle.
 * Sends the new enabled boolean to PUT /admin/tier-limits/:id.
 */
async function saveLimitToggle(checkbox) {
  const id      = checkbox.dataset.id;
  const enabled = checkbox.checked;

  // Visually dim the row's value input while saving
  const row   = checkbox.closest('td');
  const input = row?.querySelector('.limit-val-input');
  if (input) { input.classList.add('saving'); input.disabled = true; }

  try {
    await apiFetch(`/admin/tier-limits/${id}`, {
      method: 'PUT',
      body:   JSON.stringify({ enabled })
    });

    if (input) {
      input.classList.remove('saving');
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 1200);
      input.disabled = false;
    }

    // Update the toggle's title tooltip
    const label = checkbox.closest('.limit-toggle');
    if (label) label.title = enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';

  } catch (err) {
    // Revert toggle on failure
    checkbox.checked = !enabled;
    if (input) {
      input.classList.remove('saving');
      input.classList.add('error');
      setTimeout(() => { input.classList.remove('error'); input.disabled = false; }, 2000);
    }
    console.error('[Limits] Toggle save failed:', err.message);
  }
}

// saveLimitFlag — for on/off feature flags (no number, just 1 or 0)
async function saveLimitFlag(checkbox) {
  const id = checkbox.dataset.id;
  const newValue = checkbox.checked ? 1 : 0;

  try {
    await apiFetch(`/admin/tier-limits/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ limit_value: newValue })
    });

    const label = checkbox.closest('.limit-toggle');
    if (label) label.title = newValue ? 'On — click to turn off' : 'Off — click to turn on';

  } catch (err) {
    checkbox.checked = !checkbox.checked;
    console.error('[Limits] Flag save failed:', err.message);
  }
}

// ================================================================
// REVENUE TAB
// ================================================================

/**
 * loadAdminRevenue — renders the revenue dashboard.
 *
 * Pulls data from GET /admin/revenue, which calculates everything
 * from the subscriptions table + plan prices in .env.
 *
 * Sections:
 *   1. Stripe notice (estimated data until Stripe is connected)
 *   2. Core KPI strip: MRR, ARR, ARPU, Churn Rate, CLV, Conversion Rate
 *   3. Subscriber breakdown by tier (count + MRR per tier)
 *   4. 6-month MRR projection table with mini bar charts
 *   5. Projected revenue for the remainder of the current year
 */
async function loadAdminRevenue() {
  const panel = document.getElementById('admin-tab-revenue');
  if (!panel) return;
  panel.dataset.loaded = '1';

  panel.innerHTML = `<div class="admin-loading"><span>⏳</span> Loading revenue data…</div>`;

  let d;
  try {
    d = await apiFetch('/admin/revenue');
  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load revenue data: ${escapeAdminHtml(err.message)}</div>`;
    return;
  }

  // --- Helper: format dollars ---
  function fmt(val) {
    if (val === null || val === undefined) return '—';
    return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtDec(val) {
    if (val === null || val === undefined) return '—';
    return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(val) {
    return val === null ? '—' : Number(val).toFixed(1) + '%';
  }

  // --- Stripe notice ---
  const stripeNotice = d.stripe_connected
    ? ''
    : `<div class="rev-stripe-notice">
         ℹ️ <strong>Estimated data</strong> — Revenue figures are calculated from your subscriptions table.
         Once Stripe processes live charges, this will update with verified payment data.
       </div>`;

  // --- Core KPI strip ---
  const kpis = `
    <div class="rev-kpi-grid">
      <div class="rev-kpi" title="Monthly Recurring Revenue — sum of all active paid subscribers × plan price">
        <div class="rev-kpi-value green">${fmt(d.mrr)}</div>
        <div class="rev-kpi-label">MRR</div>
        <div class="rev-kpi-sub">per 30-day cycle</div>
      </div>
      <div class="rev-kpi" title="Annual Run Rate — MRR × 12">
        <div class="rev-kpi-value indigo">${fmt(d.arr)}</div>
        <div class="rev-kpi-label">ARR (run rate)</div>
        <div class="rev-kpi-sub">if growth stays flat</div>
      </div>
      <div class="rev-kpi" title="Average Revenue Per User (paid subscribers only)">
        <div class="rev-kpi-value">${fmtDec(d.arpu)}</div>
        <div class="rev-kpi-label">ARPU</div>
        <div class="rev-kpi-sub">${d.active_paid} paid users</div>
      </div>
      <div class="rev-kpi" title="Monthly churn rate — % of paid subscribers who cancelled in the last 30 days">
        <div class="rev-kpi-value" style="color:${parseFloat(d.monthly_churn_rate) > 5 ? '#dc2626' : '#0f172a'};">${fmtPct(d.monthly_churn_rate)}</div>
        <div class="rev-kpi-label">Monthly Churn</div>
        <div class="rev-kpi-sub">${d.cancelled_last_30} cancelled (30d)</div>
      </div>
      <div class="rev-kpi" title="Customer Lifetime Value = ARPU ÷ monthly churn rate. Higher is better.">
        <div class="rev-kpi-value">${d.clv ? fmtDec(d.clv) : '—'}</div>
        <div class="rev-kpi-label">CLV</div>
        <div class="rev-kpi-sub">avg lifetime value</div>
      </div>
      <div class="rev-kpi" title="Free trial → paid conversion rate (all time)">
        <div class="rev-kpi-value">${fmtPct(d.conversion_rate)}</div>
        <div class="rev-kpi-label">Trial → Paid</div>
        <div class="rev-kpi-sub">${d.free_trial_count} on free trial</div>
      </div>
      <div class="rev-kpi" title="New paid subscriptions started in the last 30 days">
        <div class="rev-kpi-value green">${d.new_paid_last_30}</div>
        <div class="rev-kpi-label">New Paid (30d)</div>
        <div class="rev-kpi-sub">est. +${fmt(d.new_paid_last_30 * (d.arpu || 0))}/mo</div>
      </div>
      <div class="rev-kpi" title="Projected revenue for the remaining months of this calendar year">
        <div class="rev-kpi-value indigo">${fmt(d.projected_year_remainder)}</div>
        <div class="rev-kpi-label">Yr Remainder</div>
        <div class="rev-kpi-sub">projected total</div>
      </div>
    </div>`;

  // --- Tier breakdown table ---
  const TIER_LABELS = { starter: 'Starter', professional: 'Professional', enterprise: 'Enterprise' };
  const tierRows = Object.entries(d.tier_breakdown || {}).map(([tier, info]) => {
    const label = TIER_LABELS[tier] || tier;
    const pct   = d.active_paid > 0 ? Math.round(info.count / d.active_paid * 100) : 0;
    return `<tr>
      <td>${label}</td>
      <td>${fmtDec(info.price)}/mo</td>
      <td>${info.count}</td>
      <td>${pct}%</td>
      <td style="font-weight:700;color:#16a34a;">${fmt(info.mrr)}</td>
    </tr>`;
  }).join('');

  const tierTable = `
    <div class="admin-section-title" style="margin-top:0;">Subscribers by Tier</div>
    <div class="admin-table-wrap" style="margin-bottom:28px;">
      <table class="admin-table">
        <thead>
          <tr><th>Tier</th><th>Price</th><th>Active</th><th>% of Paid</th><th>MRR</th></tr>
        </thead>
        <tbody>
          ${tierRows || '<tr><td colspan="5" style="color:#6b7280;">No paid subscribers yet</td></tr>'}
          <tr style="font-weight:700;background:#f8fafc;">
            <td colspan="2">Total</td>
            <td>${d.active_paid}</td>
            <td>100%</td>
            <td style="color:#16a34a;">${fmt(d.mrr)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  // --- 6-month MRR projection table with inline bar ---
  const maxProj = Math.max(...(d.projections || []).map(p => p.mrr), d.mrr || 1);
  const projRows = (d.projections || []).map((p, i) => {
    const barPct  = maxProj > 0 ? Math.round(p.mrr / maxProj * 100) : 0;
    const delta   = i === 0 ? p.mrr - d.mrr : p.mrr - d.projections[i - 1].mrr;
    const deltaFmt= (delta >= 0 ? '+' : '') + fmt(delta);
    const deltaCol= delta >= 0 ? '#16a34a' : '#dc2626';
    return `<tr>
      <td>${escapeAdminHtml(p.month)}</td>
      <td style="font-weight:600;">${fmt(p.mrr)}</td>
      <td style="color:${deltaCol};font-size:12px;">${deltaFmt}</td>
      <td style="width:140px;">
        <div class="rev-proj-bar-wrap">
          <div class="rev-proj-bar" style="width:${barPct}%"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  const projTable = `
    <div class="admin-section-title">6-Month MRR Projection</div>
    <p style="font-size:12px;color:#6b7280;margin:0 0 10px;">
      Based on current MRR of ${fmt(d.mrr)}, ${fmtPct(d.monthly_churn_rate)} monthly churn,
      and ~${d.new_paid_last_30} new paid subscribers per 30 days.
      30-day rolling billing cycles.
    </p>
    <div class="admin-table-wrap">
      <table class="rev-proj-table">
        <thead>
          <tr><th>Month</th><th>Projected MRR</th><th>Change</th><th>Trend</th></tr>
        </thead>
        <tbody>
          ${projRows || '<tr><td colspan="4" style="color:#6b7280;">No projection data</td></tr>'}
        </tbody>
      </table>
    </div>`;

  panel.innerHTML = `
    ${stripeNotice}
    ${kpis}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;">
      <div>${tierTable}</div>
      <div>${projTable}</div>
    </div>
  `;
}

// ================================================================
// PLANS TAB — Visual plan card editor
// ================================================================

async function loadAdminPlans() {
  const panel = document.getElementById('admin-tab-plans');
  if (!panel) return;
  panel.dataset.loaded = '1';

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading plans…</div>`;

  let plans;
  try {
    const res = await apiFetch('/admin/plans');
    plans = res.plans || [];
  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load plans: ${escapeAdminHtml(err.message)}</div>`;
    return;
  }

  if (plans.length === 0) {
    panel.innerHTML = `<div class="admin-muted" style="padding:20px;">No plans found. Run the plans SQL migration in Supabase to seed the default plans.</div>`;
    return;
  }

  // Render a two-column layout: live preview on the left, editor on the right
  panel.innerHTML = `
    <div class="admin-section-title" style="margin-bottom:4px;">Subscription Plans</div>
    <p class="admin-muted" style="margin-bottom:16px;font-size:13px;">
      Edit plan names, prices, features, and colors. Changes update instantly for all users.<br>
      To change the actual dollar amount charged, create a new price in Stripe and paste the <code>price_</code> ID below.
    </p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;">
      <!-- Live preview -->
      <div>
        <div class="admin-section-title" style="font-size:13px;margin-bottom:10px;">Live Preview</div>
        <div id="plans-preview" style="display:flex;flex-direction:column;gap:16px;">
          ${plans.map(p => renderPlanPreviewCard(p)).join('')}
        </div>
      </div>

      <!-- Editor cards -->
      <div>
        <div class="admin-section-title" style="font-size:13px;margin-bottom:10px;">Edit Plans</div>
        <div id="plans-editor" style="display:flex;flex-direction:column;gap:16px;">
          ${plans.map(p => renderPlanEditorCard(p)).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderPlanPreviewCard(plan) {
  const features = Array.isArray(plan.features) ? plan.features : [];
  return `
    <div class="plan-preview-card" id="plan-preview-${plan.id}" style="border-left:4px solid ${plan.color};padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);${!plan.is_active ? 'opacity:0.5;' : ''}">
      ${plan.badge ? `<div style="font-size:11px;font-weight:600;color:${plan.color};text-transform:uppercase;margin-bottom:4px;">${escapeAdminHtml(plan.badge)}</div>` : ''}
      <div style="font-size:18px;font-weight:700;color:#1e293b;">${escapeAdminHtml(plan.name)}</div>
      <div style="margin:6px 0 12px;">
        <span style="font-size:28px;font-weight:800;color:#0f172a;">${escapeAdminHtml(plan.price_display)}</span>
        <span style="font-size:14px;color:#64748b;">${escapeAdminHtml(plan.period_label)}</span>
      </div>
      <ul style="list-style:none;padding:0;margin:0;font-size:13px;color:#334155;">
        ${features.map(f => `<li style="padding:3px 0;">✓ ${escapeAdminHtml(f)}</li>`).join('')}
      </ul>
      ${!plan.is_active ? '<div style="margin-top:8px;font-size:11px;color:#dc2626;font-weight:600;">HIDDEN FROM USERS</div>' : ''}
      ${!plan.stripe_price_id ? '<div style="margin-top:8px;font-size:11px;color:#f59e0b;font-weight:600;">⚠ No Stripe Price ID — users cannot purchase</div>' : ''}
    </div>
  `;
}

function renderPlanEditorCard(plan) {
  const features = Array.isArray(plan.features) ? plan.features : [];
  return `
    <div class="email-card" id="plan-editor-${plan.id}" style="border-left:4px solid ${plan.color};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-weight:700;font-size:15px;color:#1e293b;">${escapeAdminHtml(plan.tier.toUpperCase())}</div>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
          <input type="checkbox" id="plan-active-${plan.id}" ${plan.is_active ? 'checked' : ''}
            onchange="savePlanField('${plan.id}', 'is_active', this.checked)" />
          Visible
        </label>
      </div>

      <div class="email-form-group">
        <label>Display Name</label>
        <input type="text" id="plan-name-${plan.id}" value="${escapeAdminHtml(plan.name)}"
          onblur="savePlanField('${plan.id}', 'name', this.value)" />
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="email-form-group">
          <label>Price Display</label>
          <input type="text" id="plan-price-${plan.id}" value="${escapeAdminHtml(plan.price_display)}"
            onblur="savePlanField('${plan.id}', 'price_display', this.value)" placeholder="$29" />
        </div>
        <div class="email-form-group">
          <label>Period</label>
          <input type="text" id="plan-period-${plan.id}" value="${escapeAdminHtml(plan.period_label)}"
            onblur="savePlanField('${plan.id}', 'period_label', this.value)" placeholder="/month" />
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="email-form-group">
          <label>Card Color</label>
          <input type="color" id="plan-color-${plan.id}" value="${plan.color}"
            onchange="savePlanField('${plan.id}', 'color', this.value)" style="height:36px;padding:2px;cursor:pointer;" />
        </div>
        <div class="email-form-group">
          <label>Badge (optional)</label>
          <input type="text" id="plan-badge-${plan.id}" value="${escapeAdminHtml(plan.badge || '')}"
            onblur="savePlanField('${plan.id}', 'badge', this.value || null)" placeholder="e.g. Most Popular" />
        </div>
      </div>

      <div class="email-form-group">
        <label>Stripe Price ID</label>
        <input type="text" id="plan-stripe-${plan.id}" value="${escapeAdminHtml(plan.stripe_price_id || '')}"
          onblur="savePlanField('${plan.id}', 'stripe_price_id', this.value || null)" placeholder="price_xxx (from Stripe dashboard)" style="font-family:monospace;font-size:12px;" />
      </div>

      <div class="email-form-group">
        <label>Features (one per line)</label>
        <textarea id="plan-features-${plan.id}" rows="6" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;resize:vertical;font-family:inherit;"
          onblur="savePlanFeatures('${plan.id}')">${features.join('\n')}</textarea>
      </div>

      <div class="email-form-group">
        <label>Sort Order</label>
        <input type="number" id="plan-sort-${plan.id}" value="${plan.sort_order}" min="0" max="99"
          onblur="savePlanField('${plan.id}', 'sort_order', parseInt(this.value) || 0)" style="width:80px;" />
      </div>

      <div id="plan-status-${plan.id}" class="admin-muted" style="font-size:12px;margin-top:4px;"></div>
    </div>
  `;
}

async function savePlanField(planId, field, value) {
  const statusEl = document.getElementById(`plan-status-${planId}`);
  if (statusEl) statusEl.textContent = 'Saving…';

  try {
    const body = {};
    body[field] = value;
    const res = await apiFetch(`/admin/plans/${planId}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    if (statusEl) {
      statusEl.textContent = 'Saved ✓';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }

    // Update the live preview
    const previewEl = document.getElementById(`plan-preview-${planId}`);
    if (previewEl && res.plan) {
      previewEl.outerHTML = renderPlanPreviewCard(res.plan);
    }

  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + err.message;
  }
}

async function savePlanFeatures(planId) {
  const textarea = document.getElementById(`plan-features-${planId}`);
  if (!textarea) return;

  // Split by newline, trim each, remove empty lines
  const features = textarea.value.split('\n').map(f => f.trim()).filter(Boolean);
  await savePlanField(planId, 'features', features);
}

// ================================================================
// WATCHDOG TAB
// System health monitoring with confidence gauge, trend chart,
// anomaly cards, job duration stats, and event log.
// ================================================================

async function loadAdminWatchdog() {
  const panel = document.getElementById('admin-tab-watchdog');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading watchdog…</div>`;

  try {
    const wd = await apiFetch('/admin/watchdog');
    panel.innerHTML = buildWatchdogHtml(wd);

    // Update the badge on the tab
    const badge = document.getElementById('admin-watchdog-badge');
    const totalUnresolved = (wd.anomalies?.unresolved_critical || 0) + (wd.anomalies?.unresolved_warning || 0);
    if (badge) {
      if (totalUnresolved > 0) {
        badge.textContent = totalUnresolved;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load watchdog: ${escapeAdminHtml(err.message)}</div>`;
  }
}

function buildWatchdogHtml(wd) {
  const confidence = wd.confidence ?? 0;
  const status = wd.status || 'unknown';
  const paused = wd.pause_state?.paused || false;

  // Colors based on score
  const scoreColor = confidence >= 80 ? '#16a34a'
                   : confidence >= 50 ? '#f59e0b'
                   : '#dc2626';
  const statusLabel = paused ? 'PAUSED' : status.toUpperCase();

  // SVG ring gauge
  const circumference = 2 * Math.PI * 54; // radius 54
  const offset = circumference - (confidence / 100) * circumference;

  let html = '';

  // ---- Pause banner ----
  if (paused) {
    const reason = escapeAdminHtml(wd.pause_state?.reason || 'Unknown');
    const pausedAt = wd.pause_state?.paused_at ? new Date(wd.pause_state.paused_at).toLocaleString() : '';
    const pausedBy = wd.pause_state?.paused_by || '';
    html += `
      <div class="wd-pause-banner">
        <div>
          🛑 SYSTEM PAUSED — ${reason}
          <div style="font-size:12px;font-weight:400;color:#7f1d1d;margin-top:4px;">
            Paused ${pausedBy === 'watchdog' ? 'automatically' : 'by admin'} at ${pausedAt}
          </div>
        </div>
        <button class="btn btn-sm" style="background:#16a34a;color:#fff;border:none;"
          onclick="resumeSystem()">▶ Resume System</button>
      </div>`;
  }

  // ---- Confidence gauge + info ----
  html += `
    <div class="wd-gauge-wrap">
      <div class="wd-gauge-ring">
        <svg width="140" height="140" viewBox="0 0 120 120">
          <circle class="wd-ring-bg" cx="60" cy="60" r="54"/>
          <circle class="wd-ring-fg" cx="60" cy="60" r="54"
            stroke="${scoreColor}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"/>
        </svg>
        <div class="wd-gauge-score" style="color:${scoreColor};">
          ${confidence}
          <div class="wd-gauge-label" style="color:${scoreColor};">${statusLabel}</div>
        </div>
      </div>
      <div class="wd-gauge-info">
        <h3>System Health Confidence</h3>
        <p>
          Score is computed every 5 minutes from 6 weighted signals: Redis connectivity,
          queue flow, error rates, API call rates, worker liveness, and database health.
          ${confidence < 30 ? '<br><strong style="color:#dc2626;">Score below 30 for 2 consecutive checks triggers auto-pause.</strong>' : ''}
        </p>
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button class="btn btn-sm" onclick="panel=document.getElementById('admin-tab-watchdog');if(panel)panel.dataset.loaded='';loadAdminWatchdog();">🔄 Refresh</button>
          ${!paused ? '<button class="btn btn-sm" style="background:#dc2626;color:#fff;border:none;" onclick="pauseSystem()">⏸ Pause System</button>' : ''}
        </div>
      </div>
    </div>`;

  // ---- Score breakdown bars ----
  const breakdown = wd.breakdown || {};
  const breakdownItems = [
    { key: 'redis',    label: 'Redis',    max: 15 },
    { key: 'queues',   label: 'Queues',   max: 20 },
    { key: 'errors',   label: 'Errors',   max: 20 },
    { key: 'apiRate',  label: 'API Rate',  max: 15 },
    { key: 'workers',  label: 'Workers',  max: 15 },
    { key: 'database', label: 'Database', max: 15 }
  ];

  html += `<div class="admin-section-title">Score Breakdown</div><div class="wd-breakdown">`;
  for (const item of breakdownItems) {
    const val = breakdown[item.key] ?? item.max;
    const pct = Math.round((val / item.max) * 100);
    const color = pct >= 80 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#dc2626';
    html += `
      <div class="wd-break-card">
        <div class="wd-break-label">${item.label}</div>
        <div class="wd-break-bar-bg"><div class="wd-break-bar-fg" style="width:${pct}%;background:${color};"></div></div>
        <div class="wd-break-val" style="color:${color};">${val}/${item.max}</div>
      </div>`;
  }
  html += `</div>`;

  // ---- 24-hour trend chart ----
  const trend = wd.trend || [];
  if (trend.length > 1) {
    html += `
      <div class="wd-chart-wrap">
        <div class="wd-chart-title">Health Score — Last 24 Hours</div>
        <div class="wd-chart">`;

    for (const point of trend) {
      const h = Math.max(2, (point.confidence / 100) * 120);
      const color = point.confidence >= 80 ? '#16a34a'
                  : point.confidence >= 50 ? '#f59e0b'
                  : '#dc2626';
      const time = new Date(point.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += `<div class="wd-chart-bar" style="height:${h}px;background:${color};" data-tip="${point.confidence} — ${time}"></div>`;
    }

    html += `</div></div>`;
  }

  // ---- Anomalies ----
  const anomalies = wd.anomalies?.recent || [];
  const unresolvedAnomalies = anomalies.filter(a => !a.resolved);

  if (unresolvedAnomalies.length > 0) {
    html += `<div class="admin-section-title">Active Anomalies (${unresolvedAnomalies.length})</div>`;
    for (const a of unresolvedAnomalies.slice(0, 15)) {
      const icon = a.severity === 'critical' ? '🚨' : '⚠️';
      const time = new Date(a.created_at).toLocaleString();
      const detailStr = a.details ? Object.entries(a.details)
        .filter(([k]) => k !== 'userId')
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ') : '';

      html += `
        <div class="wd-anomaly ${a.severity}">
          <div class="wd-anomaly-icon">${icon}</div>
          <div class="wd-anomaly-body">
            <div class="wd-anomaly-title">${escapeAdminHtml(a.title)}</div>
            <div class="wd-anomaly-time">${time} · ${escapeAdminHtml(a.category || '')}</div>
            ${detailStr ? `<div class="wd-anomaly-details">${escapeAdminHtml(detailStr)}</div>` : ''}
          </div>
          <button class="btn btn-sm" style="font-size:11px;" onclick="resolveWatchdogEvent('${a.id}')">✓ Resolve</button>
        </div>`;
    }
  } else {
    html += `<div class="admin-section-title">Anomalies</div>
      <div style="padding:16px;background:#f0fdf4;border-radius:8px;color:#166534;font-size:13px;margin-bottom:20px;">
        ✅ No active anomalies detected
      </div>`;
  }

  // ---- Job Duration Stats ----
  const durStats = wd.duration_stats || {};
  const durEntries = Object.entries(durStats).filter(([, v]) => v.count > 0);

  if (durEntries.length > 0) {
    html += `<div class="admin-section-title">Job Execution Times (rolling avg)</div><div class="wd-duration-grid">`;
    for (const [name, stats] of durEntries) {
      const avgSec = (stats.avg / 1000).toFixed(1);
      const maxSec = (stats.max / 1000).toFixed(1);
      const minSec = (stats.min / 1000).toFixed(1);
      const avgColor = stats.avg > 30000 ? '#dc2626' : stats.avg > 10000 ? '#f59e0b' : '#16a34a';
      html += `
        <div class="wd-dur-card">
          <div class="wd-dur-label">${escapeAdminHtml(name)}</div>
          <div class="wd-dur-value" style="color:${avgColor};">${avgSec}s</div>
          <div class="wd-dur-range">min ${minSec}s · max ${maxSec}s · ${stats.count} samples</div>
        </div>`;
    }
    html += `</div>`;
  }

  // ---- Recent event log ----
  const events = wd.events || [];
  if (events.length > 0) {
    html += `<div class="admin-section-title">Recent Events (${events.length})</div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;max-height:400px;overflow-y:auto;">`;
    for (const e of events.slice(0, 50)) {
      const time = new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = new Date(e.created_at).toLocaleDateString();
      html += `
        <div class="wd-event-row">
          <div class="wd-event-sev ${e.severity}"></div>
          <div class="wd-event-time">${date} ${time}</div>
          <div class="wd-event-title">${escapeAdminHtml(e.title)}</div>
        </div>`;
    }
    html += `</div>`;
  }

  // ---- Issues list ----
  const issues = wd.issues || [];
  if (issues.length > 0) {
    html += `<div class="admin-section-title" style="margin-top:20px;">Current Issues</div>
      <ul style="font-size:13px;color:#64748b;padding-left:20px;">`;
    for (const issue of issues) {
      html += `<li style="margin-bottom:4px;">${escapeAdminHtml(issue)}</li>`;
    }
    html += `</ul>`;
  }

  return html;
}

// ---- Watchdog actions ----

async function pauseSystem() {
  const reason = prompt('Reason for pausing (optional):') || 'Manual pause by admin';
  try {
    await apiFetch('/admin/watchdog/pause', { method: 'POST', body: JSON.stringify({ reason }) });
    const panel = document.getElementById('admin-tab-watchdog');
    if (panel) { panel.dataset.loaded = ''; loadAdminWatchdog(); }
  } catch (err) {
    alert('Failed to pause: ' + err.message);
  }
}

async function resumeSystem() {
  try {
    await apiFetch('/admin/watchdog/resume', { method: 'POST' });
    const panel = document.getElementById('admin-tab-watchdog');
    if (panel) { panel.dataset.loaded = ''; loadAdminWatchdog(); }
  } catch (err) {
    alert('Failed to resume: ' + err.message);
  }
}

async function resolveWatchdogEvent(eventId) {
  try {
    await apiFetch(`/admin/watchdog/resolve/${eventId}`, { method: 'POST' });
    const panel = document.getElementById('admin-tab-watchdog');
    if (panel) { panel.dataset.loaded = ''; loadAdminWatchdog(); }
  } catch (err) {
    alert('Failed to resolve: ' + err.message);
  }
}

// ================================================================
// DIAGNOSTICS TAB (FEAT-020)
// Publishing failures, error categories, maintenance actions
// ================================================================

async function loadAdminDiagnostics() {
  const panel = document.getElementById('admin-tab-diagnostics');
  if (!panel) return;
  panel.dataset.loaded = 'true';

  panel.innerHTML = `<div class="admin-loading"><div class="spinner spinner-sm"></div> Loading diagnostics…</div>`;

  try {
    const data = await apiFetch('/admin/diagnostics');

    // Update badge if there are stuck posts or recent failures
    const badge = document.getElementById('admin-diag-badge');
    if (badge) {
      const total = data.summary.stuck_now + data.summary.failed_7d;
      if (total > 0) {
        badge.textContent = total;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

    // Error category summary cards
    const catCards = Object.entries(data.error_categories || {})
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => {
        const color = cat === 'Timeout' ? '#f59e0b'
          : cat === 'Token Expired' ? '#dc2626'
          : cat === 'Video Processing' ? '#8b5cf6'
          : cat === 'Permission Error' ? '#ef4444'
          : '#6b7280';
        return `<div style="display:inline-block;padding:8px 14px;margin:4px;border-radius:8px;background:${color}15;border:1px solid ${color}40;font-size:13px;">
          <strong style="color:${color}">${count}</strong> ${escapeAdminHtml(cat)}
        </div>`;
      }).join('');

    // Stuck posts section
    const stuckRows = (data.stuck_posts || []).map(p => {
      const mins = Math.round((Date.now() - new Date(p.updated_at).getTime()) / 60000);
      return `<tr>
        <td><code style="font-size:11px;">${escapeAdminHtml(p.id.slice(0, 8))}</code></td>
        <td>${escapeAdminHtml(p.platform)}</td>
        <td style="color:#f59e0b;font-weight:600;">${mins} min</td>
        <td>
          <button class="btn btn-sm" style="font-size:11px;" onclick="adminResetStuckPosts()">Reset</button>
        </td>
      </tr>`;
    }).join('');

    // Failed posts table
    const failedRows = (data.failed_posts || []).map(p => {
      const when = new Date(p.updated_at).toLocaleString();
      const catColor = p.error_category === 'Timeout' ? '#f59e0b'
        : p.error_category === 'Token Expired' ? '#dc2626'
        : p.error_category === 'Video Processing' ? '#8b5cf6'
        : '#6b7280';
      return `<tr>
        <td><code style="font-size:11px;">${escapeAdminHtml(p.id.slice(0, 8))}</code></td>
        <td>${escapeAdminHtml(p.user_name)}</td>
        <td>${escapeAdminHtml(p.platform)}</td>
        <td><span style="color:${catColor};font-weight:600;font-size:12px;">${escapeAdminHtml(p.error_category)}</span></td>
        <td style="font-size:12px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAdminHtml(p.error_message || '')}">${escapeAdminHtml(p.error_message || 'No details')}</td>
        <td style="font-size:11px;white-space:nowrap;">${when}</td>
        <td>
          <button class="btn btn-sm" style="font-size:11px;" onclick="adminRetryPost('${p.id}')">Retry</button>
        </td>
      </tr>`;
    }).join('');

    panel.innerHTML = `
      <!-- Summary Cards -->
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
        <div class="admin-kpi-card" style="border-left:4px solid #dc2626;">
          <div class="admin-kpi-value">${data.summary.failed_7d}</div>
          <div class="admin-kpi-label">Failed (7 days)</div>
        </div>
        <div class="admin-kpi-card" style="border-left:4px solid #f59e0b;">
          <div class="admin-kpi-value">${data.summary.stuck_now}</div>
          <div class="admin-kpi-label">Stuck Now</div>
        </div>
        <div class="admin-kpi-card" style="border-left:4px solid #6366f1;">
          <div class="admin-kpi-value">${data.summary.stale_dms}</div>
          <div class="admin-kpi-label">Stale DMs</div>
        </div>
      </div>

      <!-- Error Categories -->
      ${catCards ? `<div class="admin-section-title">Error Categories (7 days)</div><div style="margin-bottom:20px;">${catCards}</div>` : ''}

      <!-- Maintenance Actions -->
      <div class="admin-section-title">Maintenance</div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.8;">
        <strong>Order of execution when things look wrong:</strong>
        <ol style="margin:8px 0 0 0;padding-left:20px;">
          <li><strong>Reset Stuck Posts</strong> — clears posts frozen in "publishing" state (stuck &gt; 15 min). This unblocks the queue so new posts can process.</li>
          <li><strong>Review failed posts below</strong> — check the Error Category column. Token Expired = user needs to reconnect. Video Processing / Timeout = retry may work. Permission Error = check OAuth scopes.</li>
          <li><strong>Retry</strong> individual failed posts worth retrying (one-off errors, timeouts). Don't retry Token Expired until user reconnects.</li>
          <li><strong>Expire Stale DMs</strong> — cleans up DM conversations that have been active &gt; 24 hours (Meta's messaging window has closed, these can never complete).</li>
          <li><strong>Refresh</strong> — reload this panel to verify everything is clean.</li>
        </ol>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px;">
        <button class="btn btn-sm" onclick="adminResetStuckPosts()">
          1. Reset Stuck Posts (${data.summary.stuck_now})
        </button>
        <button class="btn btn-sm" onclick="adminExpireStaleDMs()">
          4. Expire Stale DMs (${data.summary.stale_dms})
        </button>
        <button class="btn btn-sm" onclick="loadAdminDiagnostics(); document.getElementById('admin-tab-diagnostics').dataset.loaded='';">
          5. Refresh
        </button>
        <button class="btn btn-sm" onclick="adminPurgeCloudflareCache()" title="Clears Cloudflare edge cache — use after deploying JS/CSS changes if users are seeing stale pages">
          🌐 Purge CDN Cache
        </button>
      </div>

      <!-- Stuck Posts -->
      ${stuckRows ? `
        <div class="admin-section-title">Currently Stuck in Publishing</div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Post</th><th>Platform</th><th>Stuck For</th><th>Action</th></tr></thead>
            <tbody>${stuckRows}</tbody>
          </table>
        </div>
      ` : ''}

      <!-- Failed Posts -->
      <div class="admin-section-title" style="margin-top:20px;">Recent Failures (7 days)</div>
      ${failedRows ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Post</th><th>User</th><th>Platform</th><th>Category</th><th>Error</th><th>When</th><th>Action</th></tr></thead>
            <tbody>${failedRows}</tbody>
          </table>
        </div>
      ` : '<p class="admin-muted">No failed posts in the last 7 days.</p>'}
    `;

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">Failed to load diagnostics: ${escapeAdminHtml(err.message)}</div>`;
  }
}

// Maintenance action: reset stuck posts
async function adminResetStuckPosts() {
  try {
    const result = await apiFetch('/admin/maintenance/reset-stuck', { method: 'POST' });
    alert(result.message);
    // Reload the tab
    const panel = document.getElementById('admin-tab-diagnostics');
    if (panel) { panel.dataset.loaded = ''; loadAdminDiagnostics(); }
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// Maintenance action: expire stale DM conversations
async function adminExpireStaleDMs() {
  try {
    const result = await apiFetch('/admin/maintenance/expire-stale-dms', { method: 'POST' });
    alert(result.message);
    const panel = document.getElementById('admin-tab-diagnostics');
    if (panel) { panel.dataset.loaded = ''; loadAdminDiagnostics(); }
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// Maintenance action: purge Cloudflare edge cache
// Use this after deploying JS/CSS changes when users are still seeing stale pages.
async function adminPurgeCloudflareCache() {
  if (!confirm('Purge the Cloudflare CDN cache?\n\nThis forces all users to download fresh JS/CSS files. Takes about 30 seconds to propagate. Safe to run at any time.')) return;
  try {
    const result = await apiFetch('/admin/maintenance/purge-cache', { method: 'POST' });
    alert(result.message);
  } catch (err) {
    alert('Cache purge failed: ' + err.message);
  }
}

// Maintenance action: retry a specific failed post
async function adminRetryPost(postId) {
  try {
    const result = await apiFetch(`/admin/maintenance/retry-failed/${postId}`, { method: 'POST' });
    alert(result.message);
    const panel = document.getElementById('admin-tab-diagnostics');
    if (panel) { panel.dataset.loaded = ''; loadAdminDiagnostics(); }
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ================================================================
// FEAT-001: Avatars Tab — Avatar Management + Prompt Suggestions
// ================================================================

async function loadAdminAvatars() {
  const panel = document.getElementById('admin-tab-avatars');
  if (!panel) return;

  panel.innerHTML = '<div class="loading-overlay"><div class="spinner spinner-lg"></div></div>';

  try {
    // Fetch avatars and pending suggestions in parallel
    const [avatarsRes, suggestionsRes] = await Promise.all([
      apiFetch('/evaluation/admin/avatars'),
      apiFetch('/evaluation/admin/suggestions')
    ]);

    const avatars = avatarsRes?.avatars || [];
    const suggestions = suggestionsRes?.suggestions || [];

    panel.dataset.loaded = 'true';

    // Build avatar table
    const avatarRows = avatars.map(a => `
      <tr>
        <td>${a.icon} ${escapeAdminHtml(a.name)}</td>
        <td>${a.active ? '<span style="color:#16a34a;">Active</span>' : '<span style="color:#94a3b8;">Inactive</span>'}</td>
        <td>${(a.field_focus || []).map(f => `<span class="admin-badge">${escapeAdminHtml(f)}</span>`).join(' ') || 'All'}</td>
        <td>${(a.post_type_focus || []).map(f => `<span class="admin-badge" style="background:#e0f2fe;">${escapeAdminHtml(f)}</span>`).join(' ') || 'Universal'}</td>
        <td>
          <button class="btn btn-xs btn-secondary" onclick="openAvatarEditor('${a.id}')">Edit</button>
          <button class="btn btn-xs ${a.active ? 'btn-danger' : 'btn-primary'}"
            onclick="toggleAvatarActive('${a.id}', ${!a.active})">${a.active ? 'Disable' : 'Enable'}</button>
        </td>
      </tr>
    `).join('');

    // Build suggestions cards
    const suggestionsHtml = suggestions.length === 0
      ? '<p class="text-muted">No pending prompt suggestions.</p>'
      : suggestions.map(s => `
        <div class="admin-card" style="border-left:4px solid #f59e0b;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong>${s.evaluation_avatars?.icon || '🤖'} ${escapeAdminHtml(s.evaluation_avatars?.name || 'Avatar')}</strong>
            <span class="text-muted" style="font-size:0.8rem;">${new Date(s.created_at).toLocaleDateString()}</span>
          </div>
          <div style="margin-bottom:8px;">
            <div style="font-size:0.85rem;font-weight:600;margin-bottom:4px;">Reason:</div>
            <div style="font-size:0.85rem;color:#555;">${escapeAdminHtml(s.reason || 'No reason provided')}</div>
          </div>
          <details style="margin-bottom:8px;">
            <summary style="cursor:pointer;font-size:0.85rem;font-weight:600;">View suggested prompt</summary>
            <pre style="font-size:0.8rem;background:#f8f9fa;padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;white-space:pre-wrap;margin-top:4px;">${escapeAdminHtml(s.suggested_prompt)}</pre>
          </details>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-xs btn-primary" onclick="approvePromptSuggestion('${s.id}')">Approve & Apply</button>
            <button class="btn btn-xs btn-danger" onclick="rejectPromptSuggestion('${s.id}')">Reject</button>
          </div>
        </div>
      `).join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;">Evaluation Avatars</h3>
        <button class="btn btn-sm btn-primary" id="btn-run-meta-analysis" onclick="runAvatarMetaAnalysis()">
          🧠 Analyze & Suggest Improvements
        </button>
      </div>
      <div id="meta-analysis-results" style="display:none;margin-bottom:16px;"></div>

      <div class="admin-card" style="margin-bottom:20px;">
        <h4 style="margin-bottom:12px;">Avatar Roster</h4>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Avatar</th>
              <th>Status</th>
              <th>Field Focus</th>
              <th>Post Type Focus</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${avatarRows}</tbody>
        </table>
      </div>

      <div class="admin-card" style="margin-bottom:20px;">
        <h4 style="margin-bottom:12px;">Pending Prompt Suggestions</h4>
        ${suggestionsHtml}
      </div>

      <div class="admin-card">
        <h4 style="margin-bottom:12px;">Evaluation Settings</h4>
        <div style="display:flex;align-items:center;gap:12px;">
          <label style="font-size:0.9rem;">Retention (days):</label>
          <input type="number" id="eval-retention-days" min="1" max="365" value="60"
                 class="form-control" style="width:80px;" />
          <button class="btn btn-sm btn-primary" onclick="saveEvalSettings()">Save</button>
        </div>
        <div class="text-muted text-sm" style="margin-top:4px;">
          Evaluation results older than this are automatically deleted. Range: 1-365 days.
        </div>
      </div>

      <!-- Hidden editor modal -->
      <div id="avatar-editor-modal" class="eval-popup-overlay" style="display:none;">
        <div class="eval-popup" style="max-width:700px;">
          <div class="eval-popup-header">
            <h3 id="avatar-editor-title">Edit Avatar</h3>
            <button class="eval-popup-close" onclick="closeAvatarEditor()">&times;</button>
          </div>
          <div style="padding:16px 20px;">
            <input type="hidden" id="avatar-editor-id" />

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="form-label">Name</label>
                <input type="text" id="avatar-editor-name" class="form-control" />
              </div>
              <div>
                <label class="form-label">Icon (emoji)</label>
                <input type="text" id="avatar-editor-icon" class="form-control" style="width:60px;" />
              </div>
            </div>

            <div style="margin-bottom:12px;">
              <label class="form-label">Description</label>
              <input type="text" id="avatar-editor-desc" class="form-control" />
            </div>

            <div style="margin-bottom:12px;">
              <label class="form-label">System Prompt</label>
              <textarea id="avatar-editor-prompt" class="form-control" rows="12"
                style="font-family:monospace;font-size:0.85rem;"></textarea>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
              <div>
                <label class="form-label">Field Focus (comma-separated)</label>
                <input type="text" id="avatar-editor-field-focus" class="form-control"
                  placeholder="hook, caption, hashtags, cta, media" />
                <div class="text-muted text-sm">Leave empty = all fields</div>
              </div>
              <div>
                <label class="form-label">Post Type Focus (comma-separated)</label>
                <input type="text" id="avatar-editor-posttype-focus" class="form-control"
                  placeholder="educational, promotional, storytelling" />
                <div class="text-muted text-sm">Leave empty = universal (all post types)</div>
              </div>
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button class="btn btn-secondary" onclick="closeAvatarEditor()">Cancel</button>
              <button class="btn btn-primary" onclick="saveAvatarEditor()">Save Changes</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Store avatars data for the editor
    panel._avatarsData = avatars;

  } catch (err) {
    panel.innerHTML = `<div class="admin-error">
      <p>Failed to load avatars: ${escapeAdminHtml(err.message)}</p>
      <p class="text-muted" style="margin-top:8px;font-size:0.85rem;">
        If you see "relation does not exist", run <code>migration_evaluation_system.sql</code> in Supabase SQL Editor first.
      </p>
    </div>`;
  }
}

// ----------------------------------------------------------------
// Avatar editor — open/close/save
// ----------------------------------------------------------------
function openAvatarEditor(avatarId) {
  const panel = document.getElementById('admin-tab-avatars');
  const avatars = panel?._avatarsData || [];
  const avatar = avatars.find(a => a.id === avatarId);
  if (!avatar) return;

  document.getElementById('avatar-editor-id').value = avatar.id;
  document.getElementById('avatar-editor-name').value = avatar.name;
  document.getElementById('avatar-editor-icon').value = avatar.icon;
  document.getElementById('avatar-editor-desc').value = avatar.description || '';
  document.getElementById('avatar-editor-prompt').value = avatar.system_prompt;
  document.getElementById('avatar-editor-field-focus').value = (avatar.field_focus || []).join(', ');
  document.getElementById('avatar-editor-posttype-focus').value = (avatar.post_type_focus || []).join(', ');
  document.getElementById('avatar-editor-title').textContent = `Edit: ${avatar.icon} ${avatar.name}`;

  document.getElementById('avatar-editor-modal').style.display = 'flex';
}

function closeAvatarEditor() {
  document.getElementById('avatar-editor-modal').style.display = 'none';
}

async function saveAvatarEditor() {
  const id = document.getElementById('avatar-editor-id').value;
  if (!id) return;

  const parseArray = (val) => val.split(',').map(s => s.trim()).filter(Boolean);

  const body = {
    name: document.getElementById('avatar-editor-name').value.trim(),
    icon: document.getElementById('avatar-editor-icon').value.trim(),
    description: document.getElementById('avatar-editor-desc').value.trim(),
    system_prompt: document.getElementById('avatar-editor-prompt').value,
    field_focus: parseArray(document.getElementById('avatar-editor-field-focus').value),
    post_type_focus: parseArray(document.getElementById('avatar-editor-posttype-focus').value)
  };

  try {
    await apiFetch(`/evaluation/admin/avatars/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    closeAvatarEditor();
    loadAdminAvatars(); // Refresh the table
    showToast('Avatar updated successfully.', 'success');
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

async function toggleAvatarActive(avatarId, active) {
  try {
    await apiFetch(`/evaluation/admin/avatars/${avatarId}`, {
      method: 'PUT',
      body: JSON.stringify({ active })
    });
    loadAdminAvatars();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ----------------------------------------------------------------
// Prompt suggestion approve/reject
// ----------------------------------------------------------------
async function approvePromptSuggestion(suggestionId) {
  if (!confirm('Apply this suggested prompt to the avatar? This replaces the current prompt.')) return;

  try {
    await apiFetch(`/evaluation/admin/suggestions/${suggestionId}/approve`, { method: 'POST' });
    loadAdminAvatars();
    showToast('Prompt suggestion approved and applied.', 'success');
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function rejectPromptSuggestion(suggestionId) {
  try {
    await apiFetch(`/evaluation/admin/suggestions/${suggestionId}/reject`, { method: 'POST' });
    loadAdminAvatars();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ----------------------------------------------------------------
// Evaluation settings
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// Meta-analysis — trigger avatar self-improvement agent
// ----------------------------------------------------------------
async function runAvatarMetaAnalysis() {
  const btn = document.getElementById('btn-run-meta-analysis');
  const resultsDiv = document.getElementById('meta-analysis-results');
  if (!btn || !resultsDiv) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner spinner-sm"></span> Analyzing...';
  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = '<div class="text-muted">Running meta-analysis across all avatars. This may take 30-60 seconds...</div>';

  try {
    const data = await apiFetch('/evaluation/admin/analyze', { method: 'POST' });
    const results = data?.results || [];

    if (results.length === 0) {
      resultsDiv.innerHTML = '<div class="text-muted">No avatars to analyze.</div>';
    } else {
      const statusColors = {
        suggested: '#16a34a',
        no_change: '#3b82f6',
        skipped: '#94a3b8',
        error: '#dc2626'
      };

      resultsDiv.innerHTML = `
        <div class="admin-card" style="border-left:4px solid #8b5cf6;">
          <h4 style="margin-bottom:8px;">Analysis Results</h4>
          ${results.map(r => `
            <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border, #e5e7eb);">
              <span style="font-size:1.2rem;">${r.icon || '🤖'}</span>
              <div style="flex:1;">
                <strong>${escapeAdminHtml(r.avatar)}</strong>
                <span class="admin-badge" style="background:${statusColors[r.status] || '#94a3b8'};color:#fff;margin-left:6px;">${r.status}</span>
                <div style="font-size:0.85rem;color:#555;margin-top:2px;">${escapeAdminHtml(r.reason || '')}</div>
                ${r.changes ? `<div style="font-size:0.8rem;color:#888;margin-top:2px;">Changes: ${r.changes.map(c => escapeAdminHtml(c)).join(', ')}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;

      // If any suggestions were created, refresh the suggestions section
      if (results.some(r => r.status === 'suggested')) {
        // Reload after a brief delay so user sees the results first
        setTimeout(() => loadAdminAvatars(), 2000);
      }
    }
  } catch (err) {
    resultsDiv.innerHTML = `<div class="admin-error">Analysis failed: ${escapeAdminHtml(err.message)}</div>`;
  }

  btn.disabled = false;
  btn.innerHTML = '🧠 Analyze & Suggest Improvements';
}

async function saveEvalSettings() {
  const days = document.getElementById('eval-retention-days')?.value;
  try {
    await apiFetch('/evaluation/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ retention_days: parseInt(days, 10) })
    });
    showToast('Evaluation settings saved.', 'success');
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}
