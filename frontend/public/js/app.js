/**
 * app.js
 *
 * Core application controller for Social Buster.
 * Handles: auth state, routing, global fetch helper, and the app shell.
 *
 * Everything else (brief.js, preview.js, publish.js) hangs off the
 * objects and functions defined here.
 */

// ============================================================
// Global state — the single source of truth for the frontend
// ============================================================
const App = {
  user: null,          // Authenticated user object (id, email, profile)
  token: null,         // JWT string
  currentView: null,   // Which section is currently showing
  API_BASE: '/api'     // Backend API base path (served from same origin)
};

// ============================================================
// Token storage helpers
// Store the JWT in localStorage so it survives page refreshes.
// ============================================================

function saveToken(token, refreshToken) {
  App.token = token;
  localStorage.setItem('sb_token', token);
  if (refreshToken) localStorage.setItem('sb_refresh_token', refreshToken);
}

function loadToken() {
  const token = localStorage.getItem('sb_token');
  if (token) App.token = token;
  return token;
}

function clearToken() {
  App.token = null;
  App.user = null;
  localStorage.removeItem('sb_token');
  localStorage.removeItem('sb_refresh_token');
}

// ============================================================
// apiFetch — the global API request helper.
// Automatically attaches the Authorization header.
// Throws on non-OK HTTP responses with a clean error message.
// ============================================================
async function apiFetch(path, options = {}, _retried = false) {
  const headers = {
    'Content-Type': 'application/json',
    ...(App.token ? { Authorization: `Bearer ${App.token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, { ...options, headers, cache: 'no-store' });

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  // On 401, attempt a silent token refresh (once) before giving up.
  // This handles the common case where the 1-hour Supabase JWT expired
  // while the user had the tab open.
  if (response.status === 401 && !_retried) {
    const refreshToken = localStorage.getItem('sb_refresh_token');
    if (refreshToken) {
      try {
        const refreshRes = await fetch('/auth/refresh', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refresh_token: refreshToken })
        });
        const refreshBody = await refreshRes.json();

        if (refreshRes.ok && refreshBody.session) {
          // Save the new tokens and retry the original request exactly once
          saveToken(refreshBody.session.access_token, refreshBody.session.refresh_token);
          return apiFetch(path, options, true);
        }
      } catch (_) { /* fall through to logout */ }
    }

    // Refresh failed or no refresh token — session is unrecoverable, force logout
    clearToken();
    renderAuthScreen();
    throw new Error('Your session expired. Please log in again.');
  }

  if (!response.ok) {
    const message = body.error || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body;
}

// ============================================================
// showAlert — renders a temporary alert at the top of a container
// type: 'error' | 'success' | 'warning' | 'info'
// ============================================================
function showAlert(containerId, message, type = 'error', allowHtml = false) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  // allowHtml is only used for trusted internal messages (never user input)
  if (allowHtml) {
    alert.innerHTML = message;
  } else {
    alert.textContent = message;
  }

  // Remove any existing alert first
  const existing = container.querySelector('.alert');
  if (existing) existing.remove();

  container.insertBefore(alert, container.firstChild);

  // Auto-dismiss success alerts after 4 seconds
  if (type === 'success') {
    setTimeout(() => alert.remove(), 4000);
  }
}

// ============================================================
// ROUTING — show/hide views based on hash
// ============================================================

function navigate(view) {
  App.currentView = view;
  window.location.hash = view;
  renderView(view);
  updateSidebarActiveState(view);
}

function updateSidebarActiveState(view) {
  document.querySelectorAll('.sidebar-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === view);
  });
}

function renderView(view) {
  const contentEl = document.getElementById('main-content-area');
  if (!contentEl) return;

  switch (view) {
    case 'dashboard':
      renderDashboard(contentEl);
      break;
    case 'brief':
      // brief.js handles this — call its render function
      if (typeof renderBriefForm === 'function') renderBriefForm(contentEl);
      break;
    case 'posts':
      renderPostsPlaceholder(contentEl);
      break;
    case 'media':
      // media.js handles this — call its render function if loaded
      if (typeof renderMediaLibrary === 'function') renderMediaLibrary(contentEl);
      else renderMediaPlaceholder(contentEl);
      break;
    case 'queue':
      renderQueuePlaceholder(contentEl);
      break;
    case 'intelligence':
      renderIntelligencePlaceholder(contentEl);
      break;
    case 'profile':
      renderProfile(contentEl);
      break;
    case 'settings':
      renderSettings(contentEl);
      break;
    case 'messages':
      if (typeof renderMessagesView === 'function') renderMessagesView(contentEl);
      else contentEl.innerHTML = '<div class="page-header"><div class="page-title">Messages</div><p>messages.js not loaded.</p></div>';
      break;
    case 'admin':
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard(contentEl);
      else contentEl.innerHTML = '<div class="page-header"><div class="page-title">Admin</div><p>admin.js not loaded.</p></div>';
      break;
    default:
      renderDashboard(contentEl);
  }
}

// ============================================================
// AUTH SCREEN — shown to unauthenticated users
// ============================================================
function renderAuthScreen() {
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-logo">⚡ Social Buster</div>
        <div class="auth-tagline">AI-powered social media marketing platform</div>

        <div class="auth-tabs">
          <div class="auth-tab active" id="tab-login" onclick="switchAuthTab('login')">Sign In</div>
          <div class="auth-tab" id="tab-register" onclick="switchAuthTab('register')">Create Account</div>
        </div>

        <!-- Error / success messages appear here -->
        <div id="auth-alerts"></div>

        <!-- LOGIN FORM -->
        <form class="auth-form" id="login-form">
          <div class="form-group">
            <label for="login-email">Email address</label>
            <input type="email" id="login-email" placeholder="you@example.com" required autocomplete="email" />
          </div>
          <div class="form-group">
            <label for="login-password">Password</label>
            <input type="password" id="login-password" placeholder="••••••••" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="login-btn">
            Sign In
          </button>
          <div class="text-center text-sm text-muted mt-4">
            <a href="#" onclick="showResetForm()">Forgot your password?</a>
          </div>
        </form>

        <!-- REGISTER FORM (hidden by default) -->
        <form class="auth-form hidden" id="register-form">
          <div class="form-group">
            <label for="reg-email">Email address</label>
            <input type="email" id="reg-email" placeholder="you@example.com" required autocomplete="email" />
          </div>
          <div class="form-group">
            <label for="reg-password">Password</label>
            <input type="password" id="reg-password" placeholder="At least 8 characters" required autocomplete="new-password" />
            <div class="form-hint">Must be at least 8 characters</div>
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="register-btn">
            Create Account
          </button>
          <div class="text-center text-sm text-muted mt-4">
            By registering, you agree to our Terms of Service.
          </div>
        </form>

        <!-- RESET PASSWORD FORM (hidden by default) -->
        <form class="auth-form hidden" id="reset-form">
          <div class="form-group">
            <label for="reset-email">Email address</label>
            <input type="email" id="reset-email" placeholder="you@example.com" required />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg">Send Reset Link</button>
          <div class="text-center text-sm text-muted mt-4">
            <a href="#" onclick="switchAuthTab('login')">← Back to Sign In</a>
          </div>
        </form>
      </div>
    </div>
  `;

  // Attach form submit handlers
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  document.getElementById('reset-form').addEventListener('submit', handlePasswordReset);
}

function switchAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('reset-form').classList.add('hidden');

  // Clear any alerts when switching tabs
  const alertsEl = document.getElementById('auth-alerts');
  if (alertsEl) alertsEl.innerHTML = '';
}

function showResetForm() {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('reset-form').classList.remove('hidden');
}

// ---- Login handler ----
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    // Save the JWT and refresh token so sessions survive past the 1-hour expiry
    saveToken(data.session.access_token, data.session.refresh_token);
    App.user = data.user;

    // Enrich with full profile (is_admin, brand fields, etc.).
    // If /auth/me briefly fails (Supabase race condition), proceed anyway —
    // we have a valid session and the basic user object from the login response.
    try { await loadCurrentUser(); } catch { /* non-fatal — proceed to app */ }
    renderAppShell();

  } catch (err) {
    showAlert('auth-alerts', err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

// ---- Register handler ----
async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('register-btn');
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;

  btn.disabled = true;
  btn.textContent = 'Creating account...';

  try {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    saveToken(data.session.access_token, data.session.refresh_token);
    App.user = data.user;

    // Same race-condition guard as handleLogin above
    try { await loadCurrentUser(); } catch { /* non-fatal — proceed to app */ }
    renderAppShell();

  } catch (err) {
    showAlert('auth-alerts', err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

// ---- Password reset handler ----
async function handlePasswordReset(e) {
  e.preventDefault();
  const email = document.getElementById('reset-email').value.trim();

  try {
    await apiFetch('/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    showAlert('auth-alerts', 'If that email exists, a reset link has been sent.', 'success');
  } catch (err) {
    showAlert('auth-alerts', err.message, 'error');
  }
}

// ============================================================
// Load the current user's profile from /auth/me
// ============================================================
async function loadCurrentUser() {
  // Throws on failure — let the caller decide whether to log out or proceed.
  // (Right after login/register a brief Supabase propagation delay can cause a
  //  transient 401 — we don't want to log the user out in that case.)
  const data = await apiFetch('/auth/me');
  App.user = { ...App.user, ...data.user };
}

// ============================================================
// APP SHELL — shown to authenticated users
// ============================================================
function renderAppShell() {
  const app = document.getElementById('app');
  const userInitial = (App.user?.email || 'U')[0].toUpperCase();
  const userEmail = App.user?.email || '';

  app.innerHTML = `
    <div class="app-shell">

      <!-- ---- Sidebar ---- -->
      <nav class="sidebar">
        <div class="sidebar-logo">⚡ Social<span>Buster</span></div>

        <div class="sidebar-nav">
          <div class="sidebar-section-label">Create</div>
          <button class="sidebar-link" data-view="brief" onclick="navigate('brief')">
            <span class="sidebar-icon">✏️</span> New Brief
          </button>
          <button class="sidebar-link" data-view="posts" onclick="navigate('posts')">
            <span class="sidebar-icon">📝</span> Generated Posts
          </button>

          <div class="sidebar-section-label" style="margin-top:12px;">Manage</div>
          <button class="sidebar-link" data-view="queue" onclick="navigate('queue')">
            <span class="sidebar-icon">🗓️</span> Publishing Queue
          </button>
          <button class="sidebar-link" data-view="media" onclick="navigate('media')">
            <span class="sidebar-icon">🎬</span> Media Library
          </button>
          <button class="sidebar-link" data-view="messages" onclick="navigate('messages')" style="display:flex;align-items:center;">
            <span class="sidebar-icon">💬</span> Messages
            <span id="sidebar-msg-badge" class="msg-unread-badge" style="display:none;"></span>
          </button>

          <div class="sidebar-section-label" style="margin-top:12px;">Insights</div>
          <button class="sidebar-link" data-view="dashboard" onclick="navigate('dashboard')">
            <span class="sidebar-icon">📊</span> Dashboard
          </button>
          <button class="sidebar-link" data-view="intelligence" onclick="navigate('intelligence')">
            <span class="sidebar-icon">🧠</span> Intelligence
          </button>

          ${App.user?.is_admin ? `
          <div class="sidebar-section-label" style="margin-top:12px;">Admin</div>
          <button class="sidebar-link" data-view="admin" onclick="navigate('admin')">
            <span class="sidebar-icon">🛠️</span> Admin Dashboard
          </button>` : ''}
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-user" onclick="navigate('profile')" style="cursor:pointer;" title="Edit your profile">
            <div class="sidebar-avatar">${userInitial}</div>
            <div class="sidebar-user-email">${userEmail}</div>
          </div>
          <button class="sidebar-link" data-view="profile" onclick="navigate('profile')">
            <span class="sidebar-icon">👤</span> My Profile
          </button>
          <button class="sidebar-link" data-view="settings" onclick="navigate('settings')">
            <span class="sidebar-icon">⚙️</span> Settings & Billing
          </button>
          <button class="sidebar-link" onclick="logout()" style="color:#f87171;">
            <span class="sidebar-icon">🚪</span> Sign Out
          </button>
        </div>
      </nav>

      <!-- ---- Main content area ---- -->
      <main class="main-content">
        <div id="main-content-area"></div>
      </main>

    </div>
  `;

  // Navigate to the view from the hash, or default to dashboard
  const initialView = window.location.hash.replace('#', '') || 'dashboard';
  navigate(initialView);

  // Start polling for unread messages — updates the sidebar badge every 60s.
  // Guard against messages.js not being loaded yet (graceful degradation).
  startUnreadBadgePoller();
}

// ----------------------------------------------------------------
// startUnreadBadgePoller
// Checks for unread messages immediately on login, then every 60s.
// refreshMsgUnreadBadge and updateMsgSidebarBadge are defined in messages.js.
// ----------------------------------------------------------------
function startUnreadBadgePoller() {
  const refresh = () => {
    if (typeof refreshMsgUnreadBadge === 'function') refreshMsgUnreadBadge();
  };
  refresh(); // immediate check on login
  setInterval(refresh, 60 * 1000);
}

// ============================================================
// VIEWS — placeholder renderers (will be filled in per phase)
// ============================================================

function renderDashboard(el) {
  const brandName = App.user?.profile?.brand_name || 'your brand';
  const status    = getProfileCompletionStatus();

  // Show a prominent banner if the user hasn't filled in the mandatory profile fields.
  // Links directly to the profile page so they can fix it in one click.
  const profileBanner = !status.complete ? `
    <div class="profile-completion-banner" style="margin-bottom:24px;">
      <strong>Action required: complete your profile before generating posts.</strong>
      Missing fields: ${status.missing.map(m => m.label).join(', ')}.
      <a href="#profile" onclick="navigate('profile')" style="margin-left:8px;text-decoration:underline;color:inherit;">
        Complete Profile →
      </a>
    </div>
  ` : '';

  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Dashboard</div>
      <div class="page-subtitle">Welcome back — here's how ${brandName} is performing.</div>
    </div>

    ${profileBanner}

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Posts Published</div>
        <div class="stat-value">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Posts Scheduled</div>
        <div class="stat-value">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Comments Monitored</div>
        <div class="stat-value">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Leads Captured</div>
        <div class="stat-value">—</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Get Started</div>
      </div>
      <p class="text-muted text-sm" style="margin-bottom:16px;">
        Create your first content brief and let the AI generate platform-optimised posts for you.
      </p>
      <button class="btn btn-primary" onclick="navigate('brief')">
        ✏️ Create New Brief
      </button>
    </div>
  `;
}

async function renderPostsPlaceholder(el) {
  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">All Posts</div>
        <div class="page-subtitle">Your generated content, grouped by brief session.</div>
      </div>
      <button class="btn btn-primary" onclick="navigate('brief')">✏️ New Brief</button>
    </div>
    <div id="posts-alerts"></div>
    <div id="posts-list-container">
      <div class="loading-overlay"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const data = await apiFetch('/posts?status=draft');
    const posts = data.posts || [];

    const container = document.getElementById('posts-list-container');
    if (!container) return;

    if (posts.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align:center;padding:48px;">
          <div style="font-size:40px;margin-bottom:12px;">✏️</div>
          <div style="font-weight:600;margin-bottom:8px;">No posts yet</div>
          <p class="text-muted text-sm" style="margin-bottom:20px;">
            Create your first brief and the AI will generate platform-specific posts for you.
          </p>
          <button class="btn btn-primary" onclick="navigate('brief')">Create Your First Brief</button>
        </div>`;
      return;
    }

    // Group by brief_id to show as brief sessions
    const byBrief = {};
    posts.forEach(post => {
      const key = post.brief_id || 'no-brief';
      if (!byBrief[key]) byBrief[key] = [];
      byBrief[key].push(post);
    });

    const platformIcons = { instagram:'📸', facebook:'👥', tiktok:'🎵', linkedin:'💼', x:'𝕏', threads:'🧵', youtube:'▶️' };

    container.innerHTML = Object.entries(byBrief).map(([briefId, briefPosts]) => {
      const first = briefPosts[0];
      const platforms = [...new Set(briefPosts.map(p => p.platform))];
      const dateStr = new Date(first.created_at).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
      const postType = briefPosts[0].briefs?.post_type?.replace(/_/g,' ') || 'Brief';
      const approved = briefPosts.filter(p => p.status === 'approved' || p.status === 'published').length;
      return `
        <div class="card brief-session-card" id="brief-session-${briefId}" style="margin-bottom:16px;">
          <div class="card-header" style="align-items:flex-start;">
            <div style="flex:1;min-width:0;">
              <div class="card-title" style="margin-bottom:6px;text-transform:capitalize;">
                ${postType}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
                ${platforms.map(p => `<span style="font-size:18px;" title="${p}">${platformIcons[p]||'📱'}</span>`).join('')}
              </div>
              <div class="text-muted text-sm">${briefPosts.length} posts · ${dateStr}${approved > 0 ? ` · <span style="color:#16a34a;">${approved} approved</span>` : ''}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
              <button class="btn btn-secondary btn-sm" onclick="loadBriefPosts('${briefId}')">
                View Posts →
              </button>
              <button class="btn btn-danger btn-sm" onclick="deleteBriefSession('${briefId}')" title="Delete this session and all its posts">
                🗑️
              </button>
            </div>
          </div>
        </div>`;
    }).join('');

  } catch (err) {
    const container = document.getElementById('posts-list-container');
    if (container) {
      container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }
}

// Load a specific brief's posts and pass to preview.js for rendering
async function loadBriefPosts(briefId) {
  try {
    const data = await apiFetch(`/briefs/${briefId}`);
    if (typeof renderGeneratedPosts === 'function') {
      renderGeneratedPosts(data.brief, data.posts);
    }
  } catch (err) {
    alert('Failed to load posts: ' + err.message);
  }
}

// Delete an entire brief session (brief + all its posts via cascade)
async function deleteBriefSession(briefId) {
  if (!confirm('Delete this entire session and all its posts? This cannot be undone.')) return;

  try {
    await apiFetch(`/briefs/${briefId}`, { method: 'DELETE' });
  } catch (err) {
    showAlert('posts-alerts', `Could not delete session: ${err.message}`, 'error');
    return;
  }

  const card = document.getElementById(`brief-session-${briefId}`);
  if (card) {
    card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    card.style.opacity    = '0';
    card.style.transform  = 'scale(0.97)';
    setTimeout(() => card.remove(), 200);
  }
}

function renderMediaPlaceholder(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Media Library</div>
      <div class="page-subtitle">Connect your cloud storage to catalogue your videos and images.</div>
    </div>
    <div class="card">
      <p class="text-muted text-sm">Media library is coming in Phase 4.</p>
    </div>
  `;
}

async function renderQueuePlaceholder(el) {
  const platformIcons = {
    instagram:'📸', facebook:'👥', tiktok:'🎵',
    linkedin:'💼', x:'𝕏', threads:'🧵', youtube:'▶️'
  };

  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Publishing Queue</div>
        <div class="page-subtitle">Scheduled, approved, and recently published posts.</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="navigate('brief')">✏️ New Brief</button>
    </div>
    <div id="queue-alerts"></div>
    <div id="queue-container">
      <div class="loading-overlay" style="position:relative;height:120px;background:none;"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const data  = await apiFetch('/publish/queue');
    const posts = data.posts || [];
    const container = document.getElementById('queue-container');
    if (!container) return;

    if (posts.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align:center;padding:48px;">
          <div style="font-size:40px;margin-bottom:12px;">🗓️</div>
          <div style="font-weight:600;margin-bottom:8px;">Queue is empty</div>
          <p class="text-muted text-sm" style="margin-bottom:20px;">
            Approve a post and schedule it for publishing — it will appear here.
          </p>
          <button class="btn btn-primary" onclick="navigate('brief')">Create a Brief</button>
        </div>`;
      return;
    }

    // Group by status for display order: scheduled → approved → failed → published
    const order = ['scheduled','approved','publishing','failed','published'];
    const sorted = [...posts].sort((a, b) =>
      order.indexOf(a.status) - order.indexOf(b.status)
    );

    const statusBadge = s => {
      const map = {
        scheduled:  'background:#dbeafe;color:#1e40af',
        approved:   'background:#dcfce7;color:#166534',
        publishing: 'background:#fef9c3;color:#854d0e',
        failed:     'background:#fee2e2;color:#b91c1c',
        published:  'background:#f1f5f9;color:#475569'
      };
      return `<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:20px;${map[s]||''}">${s}</span>`;
    };

    container.innerHTML = sorted.map(post => {
      const icon       = platformIcons[post.platform] || '📱';
      const hook       = (post.hook || '').slice(0, 80);
      const schedTime  = post.scheduled_at
        ? new Date(post.scheduled_at).toLocaleString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
        : null;
      const pubTime    = post.published_at
        ? new Date(post.published_at).toLocaleString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
        : null;

      return `
        <div class="card" style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style="font-size:22px;">${icon}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${hook || '(no hook)'}
              </div>
              <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
                ${schedTime ? `⏰ Scheduled: ${schedTime}` : ''}
                ${pubTime   ? `✅ Published: ${pubTime}` : ''}
                ${post.error_message ? `<span style="color:#ef4444;">⚠ ${post.error_message.slice(0,80)}</span>` : ''}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
              ${statusBadge(post.status)}
              ${['scheduled','failed'].includes(post.status)
                ? `<button class="btn btn-secondary btn-xs" onclick="unqueuePost('${post.id}')">Unschedule</button>`
                : ''}
              ${post.status === 'approved'
                ? `<button class="btn btn-secondary btn-xs" onclick="publishNowFromQueue('${post.id}', '${post.platform}')">Publish Now</button>`
                : ''}
              ${post.status !== 'published'
                ? `<button class="btn btn-danger btn-xs" onclick="deleteQueuePost('${post.id}')">Delete</button>`
                : ''}
            </div>
          </div>
        </div>`;
    }).join('');

  } catch (err) {
    const container = document.getElementById('queue-container');
    if (container) container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

async function unqueuePost(postId) {
  try {
    await apiFetch(`/publish/queue/${postId}`, { method: 'DELETE' });
    showAlert('queue-alerts', 'Post returned to approved status.', 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

async function deleteQueuePost(postId) {
  if (!confirm('Permanently delete this post? This cannot be undone.')) return;
  try {
    await apiFetch(`/posts/${postId}`, { method: 'DELETE' });
    showAlert('queue-alerts', 'Post deleted.', 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

async function publishNowFromQueue(postId, platform) {
  if (!confirm(`Publish this ${platform} post immediately?`)) return;
  try {
    await apiFetch(`/publish/${postId}`, { method: 'POST' });
    showAlert('queue-alerts', `Post published to ${platform}!`, 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

async function renderIntelligencePlaceholder(el) {
  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Intelligence</div>
        <div class="page-subtitle">What the AI knows about your audience, trends, and top-performing content.</div>
      </div>
      <button class="btn btn-primary btn-sm" id="refresh-intelligence-btn" onclick="refreshIntelligence()">🔄 Refresh Research</button>
    </div>
    <div id="intelligence-alerts"></div>
    <div id="intelligence-container">
      <div class="loading-overlay" style="position:relative;height:120px;background:none;"><div class="spinner"></div></div>
    </div>
  `;

  // Load all intelligence data in parallel
  try {
    const [summaryData, researchData, commentsData, perfData] = await Promise.allSettled([
      apiFetch('/intelligence/summary'),
      apiFetch('/intelligence/research'),
      apiFetch('/intelligence/comments?limit=10'),
      apiFetch('/intelligence/performance')
    ]);

    const container = document.getElementById('intelligence-container');
    if (!container) return;

    const summary   = summaryData.status   === 'fulfilled' ? summaryData.value   : null;
    const research  = researchData.status  === 'fulfilled' ? researchData.value  : null;
    const comments  = commentsData.status  === 'fulfilled' ? commentsData.value  : null;
    const perf      = perfData.status      === 'fulfilled' ? perfData.value      : null;

    const sentimentColor = s =>
      s === 'positive' ? '#16a34a' : s === 'negative' ? '#b91c1c' : '#64748b';

    container.innerHTML = `
      <!-- Performance Summary -->
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div class="card-title">Performance Summary</div>
          <span class="text-muted text-sm">Last 30 days</span>
        </div>
        ${perf?.totals
          ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
              ${[
                ['Posts tracked', perf.totals.total_posts],
                ['Total likes',   perf.totals.total_likes],
                ['Total comments',perf.totals.total_comments],
                ['Total reach',   perf.totals.total_reach]
              ].map(([label, val]) => `
                <div class="stat-card">
                  <div class="stat-label">${label}</div>
                  <div class="stat-value">${val.toLocaleString()}</div>
                </div>`).join('')}
             </div>`
          : `<p class="text-muted text-sm">No performance data yet. Publish some posts first.</p>`
        }
        ${summary?.summary
          ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;color:#374151;background:#f8fafc;padding:12px;border-radius:8px;line-height:1.6;">${summary.summary}</pre>`
          : `<p class="text-muted text-sm">${summary?.message || 'No intelligence summary available.'}</p>`
        }
      </div>

      <!-- Research Brief -->
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div class="card-title">Niche Research</div>
          <button class="btn btn-secondary btn-sm" onclick="refreshIntelligence()">Refresh</button>
        </div>
        ${research?.research
          ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;color:#374151;background:#f8fafc;padding:12px;border-radius:8px;line-height:1.6;">${research.research}</pre>`
          : `<p class="text-muted text-sm">${research?.message || 'No research available.'}</p>
             <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="refreshIntelligence()">Generate Research Brief</button>`
        }
      </div>

      <!-- Recent Comments -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Comments</div>
          ${comments?.sentimentCounts
            ? `<div style="display:flex;gap:10px;font-size:12px;">
                <span style="color:#16a34a;">✅ ${comments.sentimentCounts.positive} positive</span>
                <span style="color:#64748b;">➖ ${comments.sentimentCounts.neutral} neutral</span>
                <span style="color:#b91c1c;">⚠️ ${comments.sentimentCounts.negative} negative</span>
               </div>`
            : ''}
        </div>
        ${comments?.comments?.length > 0
          ? `<div style="display:flex;flex-direction:column;gap:10px;">
              ${comments.comments.map(c => `
                <div style="display:flex;align-items:flex-start;gap:10px;padding:10px;background:#f8fafc;border-radius:8px;">
                  <span style="font-size:14px;flex-shrink:0;">${
                    c.sentiment === 'positive' ? '😊' : c.sentiment === 'negative' ? '😤' : '😐'
                  }</span>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;color:#0f172a;line-height:1.5;">${c.comment_text || ''}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:3px;">
                      @${c.author_handle || 'unknown'} · ${c.platform}
                      ${c.trigger_matched ? ' · <span style="color:#6366f1;">⚡ trigger matched</span>' : ''}
                      ${c.dm_sent ? ' · <span style="color:#16a34a;">DM sent</span>' : ''}
                    </div>
                  </div>
                </div>`).join('')}
             </div>`
          : `<p class="text-muted text-sm">No comments ingested yet. Comments appear here once posts are published and the comment agent has run.</p>`
        }
      </div>
    `;

  } catch (err) {
    const container = document.getElementById('intelligence-container');
    if (container) container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

async function refreshIntelligence() {
  const btn = document.getElementById('refresh-intelligence-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }

  try {
    await apiFetch('/intelligence/refresh', { method: 'POST' });
    showAlert('intelligence-alerts', 'Research refreshed successfully.', 'success');
    // Reload the whole view to show new research
    renderIntelligencePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('intelligence-alerts', err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh Research'; }
  }
}

// ============================================================
// PROFILE COMPLETION STATUS
// Returns which mandatory fields are still missing.
// Used to gate brief submission and show completion prompts.
//
// Mandatory = the 5 fields that form the cohort key for the
// intelligence engine. Without them, personalised recommendations
// can't be targeted correctly.
// ============================================================
function getProfileCompletionStatus() {
  const p = App.user?.profile || {};

  const MANDATORY = [
    { field: 'industry',           label: 'Industry'            },
    { field: 'business_type',      label: 'Business Type'       },
    { field: 'target_age_range',   label: 'Target Age Range'    },
    { field: 'state',              label: 'State (2-letter)'    }
  ];

  // preferred_platforms needs at least one selection
  const platformsMissing = !(p.preferred_platforms?.length > 0);

  const missing = MANDATORY.filter(m => !p[m.field]);
  if (platformsMissing) {
    missing.push({ field: 'preferred_platforms', label: 'Preferred Platforms (select at least one)' });
  }

  return {
    complete: missing.length === 0,
    missing
  };
}

// ============================================================
// RENDER PROFILE
// Dedicated "My Profile" view — brand profile form only.
// (Connected platforms and billing live in renderSettings.)
// ============================================================
async function renderProfile(el) {
  const profile = App.user?.profile || {};
  const status  = getProfileCompletionStatus();

  const completionBanner = !status.complete ? `
    <div class="profile-completion-banner">
      <strong>Complete your profile to unlock AI recommendations.</strong>
      The following required fields are missing:
      <ul style="margin:6px 0 0 16px;">
        ${status.missing.map(m => `<li>${m.label}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">My Profile</div>
      <div class="page-subtitle">Your brand details power AI-generated posts and personalised recommendations.</div>
    </div>

    ${completionBanner}
    <div id="profile-alerts"></div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Brand Profile</div>
        <div class="text-muted text-sm">
          Fields marked <span class="required-marker">*</span> are required for AI recommendations.
          The more you fill in, the smarter everything gets.
        </div>
      </div>

      <form class="auth-form" id="profile-form">

        <!-- Section: Your Account -->
        <div class="form-section-label">Your Account</div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-full-name">Full Name</label>
            <input type="text" id="s-full-name" value="${escapeHtmlAttr(profile.full_name || '')}" placeholder="Your full name" />
          </div>
          <div class="form-group">
            <label for="s-email">Email Address</label>
            <input type="email" id="s-email" value="${escapeHtmlAttr(App.user?.email || '')}" disabled style="background:var(--bg-secondary,#f5f5f5);cursor:not-allowed;opacity:0.7;" />
            <div class="text-muted text-sm" style="margin-top:4px;">To change your email, contact support.</div>
          </div>
        </div>

        <!-- Section: Brand Basics -->
        <div class="form-section-label">Brand Basics</div>
        <div class="form-group">
          <label for="s-brand-name">Brand Name</label>
          <input type="text" id="s-brand-name" value="${escapeHtmlAttr(profile.brand_name || '')}" placeholder="Your brand or business name" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-industry">Industry <span class="required-marker">*</span></label>
            <input type="text" id="s-industry" value="${escapeHtmlAttr(profile.industry || '')}" placeholder="e.g. Fitness, E-commerce, Real Estate" />
          </div>
          <div class="form-group">
            <label for="s-voice">Brand Voice</label>
            <input type="text" id="s-voice" value="${escapeHtmlAttr(profile.brand_voice || '')}" placeholder="e.g. Professional, Friendly, Bold" />
          </div>
        </div>
        <div class="form-group">
          <label for="s-audience">Target Audience Description</label>
          <textarea id="s-audience" placeholder="Describe who your ideal customer is...">${escapeHtmlAttr(profile.target_audience || '')}</textarea>
        </div>

        <!-- Section: Business Details -->
        <div class="form-section-label">Business Details</div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-business-type">Business Type <span class="required-marker">*</span></label>
            <select id="s-business-type">
              <option value="">— Select —</option>
              <option value="brick_and_mortar"  ${profile.business_type === 'brick_and_mortar'  ? 'selected' : ''}>Brick &amp; Mortar</option>
              <option value="online_only"        ${profile.business_type === 'online_only'        ? 'selected' : ''}>Online Only</option>
              <option value="hybrid"             ${profile.business_type === 'hybrid'             ? 'selected' : ''}>Hybrid (Online + Physical)</option>
              <option value="service_based"      ${profile.business_type === 'service_based'      ? 'selected' : ''}>Service Based</option>
              <option value="creator"            ${profile.business_type === 'creator'            ? 'selected' : ''}>Creator / Influencer</option>
            </select>
          </div>
          <div class="form-group">
            <label for="s-business-size">Business Size</label>
            <select id="s-business-size">
              <option value="">— Select —</option>
              <option value="solo"          ${profile.business_size === 'solo'          ? 'selected' : ''}>Solo / Just me</option>
              <option value="small_2_10"    ${profile.business_size === 'small_2_10'    ? 'selected' : ''}>Small (2–10 people)</option>
              <option value="medium_11_50"  ${profile.business_size === 'medium_11_50'  ? 'selected' : ''}>Medium (11–50 people)</option>
              <option value="large_50_plus" ${profile.business_size === 'large_50_plus' ? 'selected' : ''}>Large (50+ people)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-primary-goal">Primary Goal</label>
            <select id="s-primary-goal">
              <option value="">— Select —</option>
              <option value="grow_audience"    ${profile.primary_goal === 'grow_audience'    ? 'selected' : ''}>Grow Audience</option>
              <option value="generate_leads"   ${profile.primary_goal === 'generate_leads'   ? 'selected' : ''}>Generate Leads</option>
              <option value="drive_sales"      ${profile.primary_goal === 'drive_sales'      ? 'selected' : ''}>Drive Sales</option>
              <option value="build_brand"      ${profile.primary_goal === 'build_brand'      ? 'selected' : ''}>Build Brand Awareness</option>
              <option value="retain_customers" ${profile.primary_goal === 'retain_customers' ? 'selected' : ''}>Retain Customers</option>
            </select>
          </div>
          <div class="form-group">
            <label for="s-content-freq">How Often Do You Post?</label>
            <select id="s-content-freq">
              <option value="">— Select —</option>
              <option value="daily"          ${profile.content_frequency === 'daily'          ? 'selected' : ''}>Daily</option>
              <option value="few_per_week"   ${profile.content_frequency === 'few_per_week'   ? 'selected' : ''}>A few times a week</option>
              <option value="weekly"         ${profile.content_frequency === 'weekly'         ? 'selected' : ''}>Weekly</option>
              <option value="few_per_month"  ${profile.content_frequency === 'few_per_month'  ? 'selected' : ''}>A few times a month</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="max-width:200px;">
          <label for="s-years">Years in Business</label>
          <input type="number" id="s-years" min="0" max="100" value="${profile.years_in_business != null ? profile.years_in_business : ''}" placeholder="e.g. 3" />
        </div>

        <!-- Section: Your Audience -->
        <div class="form-section-label">Your Audience</div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-age-range">Target Age Range <span class="required-marker">*</span></label>
            <select id="s-age-range">
              <option value="">— Select —</option>
              <option value="18-24" ${profile.target_age_range === '18-24' ? 'selected' : ''}>18–24</option>
              <option value="25-34" ${profile.target_age_range === '25-34' ? 'selected' : ''}>25–34</option>
              <option value="35-44" ${profile.target_age_range === '35-44' ? 'selected' : ''}>35–44</option>
              <option value="45-54" ${profile.target_age_range === '45-54' ? 'selected' : ''}>45–54</option>
              <option value="55+"   ${profile.target_age_range === '55+'   ? 'selected' : ''}>55+</option>
              <option value="all"   ${profile.target_age_range === 'all'   ? 'selected' : ''}>All Ages</option>
            </select>
          </div>
          <div class="form-group">
            <label for="s-gender">Target Gender</label>
            <select id="s-gender">
              <option value="">— Select —</option>
              <option value="male"   ${profile.target_gender === 'male'   ? 'selected' : ''}>Primarily Male</option>
              <option value="female" ${profile.target_gender === 'female' ? 'selected' : ''}>Primarily Female</option>
              <option value="all"    ${profile.target_gender === 'all'    ? 'selected' : ''}>All / Mixed</option>
            </select>
          </div>
          <div class="form-group">
            <label for="s-aud-location">Audience Location</label>
            <select id="s-aud-location">
              <option value="">— Select —</option>
              <option value="local"         ${profile.audience_location === 'local'         ? 'selected' : ''}>Local (city/region)</option>
              <option value="national"      ${profile.audience_location === 'national'      ? 'selected' : ''}>National (U.S.)</option>
              <option value="international" ${profile.audience_location === 'international' ? 'selected' : ''}>International</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label for="s-interests">Audience Interests <span class="text-muted text-sm">(comma-separated, e.g. fitness, nutrition, weight loss)</span></label>
          <input type="text" id="s-interests" value="${escapeHtmlAttr((profile.audience_interests || []).join(', '))}" placeholder="fitness, nutrition, weight loss" />
        </div>

        <!-- Section: Location -->
        <div class="form-section-label">Your Location</div>
        <div class="form-row">
          <div class="form-group">
            <label for="s-city">City</label>
            <input type="text" id="s-city" value="${escapeHtmlAttr(profile.city || '')}" placeholder="e.g. Austin" />
          </div>
          <div class="form-group" style="max-width:120px;">
            <label for="s-state">State <span class="required-marker">*</span> <span class="text-muted text-sm">(2-letter abbreviation)</span></label>
            <input type="text" id="s-state" value="${escapeHtmlAttr(profile.state || '')}" placeholder="e.g. TX" maxlength="2" style="text-transform:uppercase;" />
          </div>
        </div>

        <!-- Section: Intelligence Seeding -->
        <div class="form-section-label">Intelligence Seeding <span class="text-muted text-sm" style="font-weight:normal;">— helps us make smarter recommendations from day one</span></div>
        <div class="form-group">
          <label for="s-ref-accounts">Reference Accounts <span class="text-muted text-sm">(2–3 competitor or aspirational social handles, comma-separated)</span></label>
          <input type="text" id="s-ref-accounts" value="${escapeHtmlAttr((profile.reference_accounts || []).join(', '))}" placeholder="@garyvee, @hubspot, @jenna_kutcher" />
          <div class="text-muted text-sm" style="margin-top:4px;">We use these to seed your AI recommendations before you have enough of your own post history.</div>
        </div>
        <div class="form-group">
          <label for="s-competitors">Primary Competitors <span class="text-muted text-sm">(optional, comma-separated handles)</span></label>
          <input type="text" id="s-competitors" value="${escapeHtmlAttr((profile.primary_competitors || []).join(', '))}" placeholder="@competitor1, @competitor2" />
        </div>

        <!-- Section: Posting Preferences -->
        <div class="form-section-label">Posting Preferences</div>
        <div class="form-group">
          <label>Preferred Platforms <span class="required-marker">*</span> <span class="text-muted text-sm">(select at least one)</span></label>
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;">
            ${['instagram','facebook','tiktok','linkedin','x','threads','youtube'].map(p => `
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;">
                <input type="checkbox" name="preferred_platforms" value="${p}"
                  ${(profile.preferred_platforms || []).includes(p) ? 'checked' : ''} />
                ${p.charAt(0).toUpperCase() + p.slice(1)}
              </label>
            `).join('')}
          </div>
        </div>
        <button type="submit" class="btn btn-primary" id="save-profile-btn">Save Profile</button>
      </form>
    </div>
  `;

  document.getElementById('profile-form').addEventListener('submit', handleSaveProfile);
}

async function renderSettings(el) {
  const sub = App.user?.subscription || {};

  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Settings & Billing</div>
      <div class="page-subtitle">Manage your connected platforms and subscription.</div>
    </div>

    <!-- Alerts for OAuth results and general settings errors -->
    <div id="settings-alerts"></div>

    <!-- ----------------------------------------------------------------
         Connected Social Platforms
         Shows all 7 platforms. Meta OAuth covers Facebook + Instagram.
         Threads has its own OAuth. Others show setup info for now.
    ---------------------------------------------------------------- -->
    <div class="card" style="margin-bottom:24px;">
      <div class="card-header">
        <div class="card-title">Connected Platforms</div>
        <div class="text-muted text-sm">Connect your social accounts to publish directly from Social Buster.</div>
      </div>
      <!-- Platforms grid — populated by loadConnectedPlatforms() below -->
      <div id="platforms-container" style="margin-top:12px;">
        <div class="loading-overlay" style="position:relative;height:60px;background:none;">
          <div class="spinner spinner-sm"></div>
        </div>
      </div>
    </div>

    <!-- Subscription -->
    <div class="card" id="subscription-card">
      <div class="card-header">
        <div class="card-title">Subscription</div>
        <span class="badge badge-${sub.status || 'active'}" style="text-transform:capitalize;">
          ${sub.plan || 'Free Trial'}
        </span>
      </div>
      <div id="subscription-content">
        <div class="loading-overlay" style="position:relative;height:60px;background:none;">
          <div class="spinner spinner-sm"></div>
        </div>
      </div>
    </div>
  `;

  // If the user just came back from a platform OAuth redirect, show the result
  checkPlatformOAuthResult();

  // Handle Stripe redirect results (?payment=success or ?payment=cancelled)
  checkPaymentRedirectResult();

  // Load connected platforms list and render the platform cards
  await loadConnectedPlatforms();

  // Load subscription details and render pricing section
  await renderSubscriptionSection();
}

// ----------------------------------------------------------------
// checkPaymentRedirectResult — shows a banner if the user just came
// back from Stripe Checkout (success or cancelled).
// ----------------------------------------------------------------
function checkPaymentRedirectResult() {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const result = params.get('payment');
  if (!result) return;

  // Clean the query param from the URL so a refresh doesn't re-show it
  window.history.replaceState(null, '', window.location.pathname + '#settings');

  if (result === 'success') {
    showAlert('settings-alerts',
      '🎉 Payment successful! Your plan has been upgraded. It may take a moment to activate.',
      'success');
  } else if (result === 'cancelled') {
    showAlert('settings-alerts', 'Payment cancelled — no charge was made.', 'info');
  }
}

// ----------------------------------------------------------------
// renderSubscriptionSection — fetches current plan and renders either:
//   a) Pricing cards (if on free trial) — lets the user choose + upgrade
//   b) Manage Billing button (if on paid plan) — opens Stripe portal
// ----------------------------------------------------------------
async function renderSubscriptionSection() {
  const el = document.getElementById('subscription-content');
  if (!el) return;

  let sub;
  try {
    const data = await apiFetch('/billing/status');
    sub = data.subscription;
  } catch (_) {
    sub = { plan: 'free', status: 'active' };
  }

  const plan   = sub?.plan   || 'free';
  const status = sub?.status || 'active';

  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  // Paid users — just show a manage billing button
  if (plan !== 'free') {
    el.innerHTML = `
      <p class="text-sm text-muted" style="margin-bottom:4px;">
        You're on the <strong>${plan.charAt(0).toUpperCase() + plan.slice(1)}</strong> plan.
        ${periodEnd ? `Renews <strong>${periodEnd}</strong>.` : ''}
        ${status === 'past_due' ? '<span style="color:#ef4444;"> ⚠ Payment past due — please update your card.</span>' : ''}
      </p>
      <p class="text-sm text-muted" style="margin-bottom:16px;">
        Manage your payment method, download invoices, or cancel from the billing portal.
      </p>
      <button class="btn btn-secondary" onclick="openBillingPortal()">💳 Manage Billing</button>
    `;
    return;
  }

  // Free trial users — show pricing cards
  const plans = [
    {
      key: 'starter',
      name: 'Starter',
      price: '$29',
      period: '/month',
      color: '#6366f1',
      features: [
        '20 AI post generations/month',
        '30 AI image generations/month',
        '4 social platforms',
        '25 posts in queue',
        'Comment monitoring'
      ]
    },
    {
      key: 'professional',
      name: 'Professional',
      price: '$79',
      period: '/month',
      color: '#0d9488',
      badge: 'Most Popular',
      features: [
        'Unlimited AI generations',
        'Unlimited AI images',
        'All 7 platforms',
        'Unlimited post queue',
        'Lead capture DMs',
        'Full media library',
        'Intelligence dashboard'
      ]
    },
    {
      key: 'enterprise',
      name: 'Enterprise',
      price: '$199',
      period: '/month',
      color: '#7c3aed',
      features: [
        'Everything in Professional',
        'Priority support',
        'Custom onboarding call',
        'SLA guarantee',
        'Unlimited platforms'
      ]
    }
  ];

  el.innerHTML = `
    <p class="text-sm text-muted" style="margin-bottom:20px;">
      You're on the <strong>Free Trial</strong>. Upgrade to unlock more generations, platforms, and features.
    </p>
    <div class="pricing-grid" id="pricing-grid">
      ${plans.map(p => `
        <div class="pricing-card ${p.badge ? 'pricing-card--featured' : ''}">
          ${p.badge ? `<div class="pricing-badge">${p.badge}</div>` : ''}
          <div class="pricing-name">${p.name}</div>
          <div class="pricing-price">
            <span class="pricing-amount">${p.price}</span>
            <span class="pricing-period">${p.period}</span>
          </div>
          <ul class="pricing-features">
            ${p.features.map(f => `<li>✓ ${f}</li>`).join('')}
          </ul>
          <button
            class="btn btn-primary pricing-upgrade-btn"
            id="upgrade-btn-${p.key}"
            onclick="startUpgrade('${p.key}')"
          >Upgrade to ${p.name}</button>
        </div>
      `).join('')}
    </div>
  `;
}

// ----------------------------------------------------------------
// checkPlatformOAuthResult — reads the sb_platform_oauth cookie that
// the backend sets after a social platform OAuth redirect completes.
// Shows a success or error message, then clears the cookie.
// ----------------------------------------------------------------
function checkPlatformOAuthResult() {
  const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('sb_platform_oauth='));
  if (!match) return;

  // Clear the cookie immediately so it won't fire again on refresh
  document.cookie = 'sb_platform_oauth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';

  try {
    const result = JSON.parse(decodeURIComponent(match.split('=').slice(1).join('=')));

    if (result.status === 'connected' && result.platforms?.length > 0) {
      const names = result.platforms.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' & ');
      showAlert('settings-alerts', `✅ ${names} connected successfully!`, 'success');

    } else if (result.status === 'page_select') {
      // Multiple Facebook Pages — show a picker so the user can choose which one to connect
      showMetaPagePicker(result.session);

    } else if (result.status === 'cancelled') {
      showAlert('settings-alerts', 'Platform connection was cancelled.', 'error');

    } else if (result.status === 'error') {
      showAlert('settings-alerts',
        result.message
          ? `Could not connect platform: ${result.message}`
          : 'Could not connect platform. Please try again.',
        'error');
    }
  } catch (e) { /* ignore malformed cookie */ }
}

// ----------------------------------------------------------------
// showMetaPagePicker
//
// Called when the backend returns status:'page_select' — meaning the
// user has more than one Facebook Page and we need them to choose.
//
// Fetches the page list from the backend (no tokens, names + IDs only),
// shows a modal, and on selection calls /oauth/meta/select-page to
// complete the connection.
// ----------------------------------------------------------------
async function showMetaPagePicker(sessionId) {
  // Fetch the list of pages for this session
  let pages;
  try {
    const data = await apiFetch(`/publish/oauth/meta/pages?session=${encodeURIComponent(sessionId)}`);
    pages = data.pages;
  } catch (err) {
    showAlert('settings-alerts', `Could not load your Facebook Pages: ${err.message}`, 'error');
    return;
  }

  // Build the modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'publish-modal-overlay';
  overlay.id = 'meta-page-picker-overlay';

  // Clicking outside the modal cancels
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Build one card per page
  const pageCards = pages.map(p => `
    <button
      class="meta-page-option"
      data-page-id="${p.id}"
      data-page-name="${p.name.replace(/"/g, '&quot;')}"
      type="button"
    >
      <span class="meta-page-name">${p.name}</span>
      ${p.has_instagram
        ? '<span class="meta-page-badge">+ Instagram linked</span>'
        : ''}
    </button>
  `).join('');

  overlay.innerHTML = `
    <div class="publish-modal" role="dialog" aria-modal="true" aria-label="Select Facebook Page">
      <div class="publish-modal-title">Select a Facebook Page</div>
      <div class="publish-modal-sub">
        Choose which Page to connect. If Instagram is linked to that Page, it will connect automatically.
      </div>
      <div class="meta-page-list" id="meta-page-list">
        ${pageCards}
      </div>
      <div style="margin-top:16px;">
        <button class="btn btn-secondary btn-full" onclick="document.getElementById('meta-page-picker-overlay').remove()">
          Cancel
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Wire up click handlers for each page card
  overlay.querySelectorAll('.meta-page-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pageId   = btn.dataset.pageId;
      const pageName = btn.dataset.pageName;

      // Disable all buttons while saving to prevent double-clicks
      overlay.querySelectorAll('.meta-page-option').forEach(b => b.disabled = true);
      btn.textContent = 'Connecting...';

      try {
        const result = await apiFetch('/publish/oauth/meta/select-page', {
          method: 'POST',
          body:   JSON.stringify({ session_id: sessionId, page_id: pageId })
        });

        overlay.remove();

        if (result.platforms?.length > 0) {
          const names = result.platforms.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' & ');
          showAlert('settings-alerts', `✅ ${names} connected successfully!`, 'success');
        } else {
          showAlert('settings-alerts', `✅ ${pageName} connected.`, 'success');
        }

        // Refresh the platform cards to show the new connection
        await loadConnectedPlatforms();

      } catch (err) {
        overlay.remove();
        showAlert('settings-alerts', `Could not connect ${pageName}: ${err.message}`, 'error');
      }
    });
  });
}

// ----------------------------------------------------------------
// loadConnectedPlatforms — fetches GET /publish/platforms and renders
// a card for each of the 7 supported platforms.
// ----------------------------------------------------------------
async function loadConnectedPlatforms() {
  const container = document.getElementById('platforms-container');
  if (!container) return;

  let connections = [];
  try {
    const data = await apiFetch('/publish/platforms');
    connections = data.connections || [];
  } catch (err) {
    container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    return;
  }

  // Platform definitions — group determines which OAuth flow to use.
  // meta  → Facebook + Instagram (one Meta App, one OAuth flow)
  // threads → Threads (same Meta App, separate threads.net OAuth)
  // others  → show setup info (coming soon)
  const platforms = [
    { id: 'instagram', label: 'Instagram',   icon: '📸', group: 'meta',    note: 'Requires an Instagram Professional account linked to a Facebook Page' },
    { id: 'facebook',  label: 'Facebook',    icon: '👥', group: 'meta',    note: 'Requires a Facebook Page (not a personal profile)' },
    { id: 'threads',   label: 'Threads',     icon: '🧵', group: 'threads', note: 'Requires a Threads account' },
    { id: 'tiktok',    label: 'TikTok',      icon: '🎵', group: 'tiktok',  note: 'Requires TikTok for Business — credentials needed in .env' },
    { id: 'linkedin',  label: 'LinkedIn',    icon: '💼', group: 'linkedin',note: 'Requires a LinkedIn App — credentials needed in .env' },
    { id: 'x',         label: 'X (Twitter)', icon: '𝕏',  group: 'x',      note: 'Requires a Twitter Developer App — credentials needed in .env' },
    { id: 'youtube',   label: 'YouTube',     icon: '▶️', group: 'youtube', note: 'Requires a YouTube API app — credentials needed in .env' }
  ];

  container.innerHTML = platforms.map(p => {
    const conn        = connections.find(c => c.platform === p.id);
    const isConnected = !!conn;
    const username    = conn?.platform_username || 'Connected';
    const connectedAt = conn?.connected_at
      ? new Date(conn.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

    return `
      <div class="provider-card ${isConnected ? 'provider-connected' : ''}"
           style="margin-bottom:10px;justify-content:space-between;align-items:center;">

        <!-- Icon + name + status -->
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
          <div style="font-size:22px;flex-shrink:0;">${p.icon}</div>
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:13px;">${p.label}</div>
            <div class="text-muted text-xs" style="margin-top:2px;">
              ${isConnected
                ? `✅ @${escapeHtml(username)}${connectedAt ? ' · connected ' + connectedAt : ''}`
                : escapeHtml(p.note)
              }
            </div>
          </div>
        </div>

        <!-- Connect / Disconnect button -->
        <div style="flex-shrink:0;margin-left:12px;">
          ${isConnected
            ? `<button class="btn btn-danger btn-xs"
                 onclick="disconnectPlatform('${p.id}', '${p.label}')">
                 Disconnect
               </button>`
            : `<button class="btn btn-primary btn-xs"
                 onclick="connectPlatform('${p.id}')">
                 Connect
               </button>`
          }
        </div>
      </div>`;
  }).join('');
}

// ----------------------------------------------------------------
// connectPlatform — starts the OAuth flow for a social platform.
// Instagram and Facebook both use the Meta OAuth flow (one app covers both).
// Threads uses the same Meta App credentials but a separate threads.net URL.
// Other platforms show instructions for now.
// ----------------------------------------------------------------
async function connectPlatform(platformId) {

  // Meta OAuth: covers Facebook + Instagram in a single login
  if (platformId === 'instagram' || platformId === 'facebook') {
    try {
      const data = await apiFetch('/publish/oauth/meta/start', { method: 'POST' });
      window.location.href = data.authUrl;
    } catch (err) {
      showAlert('settings-alerts', err.message, 'error');
    }
    return;
  }

  // Threads OAuth: uses Meta App but goes through threads.net
  if (platformId === 'threads') {
    try {
      const data = await apiFetch('/publish/oauth/threads/start', { method: 'POST' });
      window.location.href = data.authUrl;
    } catch (err) {
      showAlert('settings-alerts', err.message, 'error');
    }
    return;
  }

  // Other platforms — need separate developer apps set up first
  const setupGuide = {
    tiktok:   'TikTok requires a TikTok for Developers app. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to your .env, then rebuild.',
    linkedin: 'LinkedIn requires a LinkedIn Developer App. Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to your .env, then rebuild.',
    x:        'X (Twitter) requires a Twitter Developer App with OAuth 2.0 enabled. Add TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET to your .env, then rebuild.',
    youtube:  'YouTube requires a Google API project with the YouTube Data API enabled. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to your .env, then rebuild.'
  };

  showAlert('settings-alerts', setupGuide[platformId] || 'This platform connection is coming soon.', 'info');
}

// ----------------------------------------------------------------
// disconnectPlatform — removes the stored connection for a platform.
// ----------------------------------------------------------------
async function disconnectPlatform(platformId, platformLabel) {
  if (!confirm(`Disconnect ${platformLabel}?\n\nPosts already published will not be affected.`)) return;

  try {
    await apiFetch(`/publish/platforms/${platformId}`, { method: 'DELETE' });
    showAlert('settings-alerts', `${platformLabel} disconnected.`, 'success');
    await loadConnectedPlatforms(); // Refresh the platform cards
  } catch (err) {
    showAlert('settings-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// escapeHtmlAttr — escapes a string for use inside an HTML attribute value.
// Prevents XSS when inserting user data into value="..." attributes.
// (escapeHtml from media.js is only available on the media view — this
// version lives in app.js so Settings can use it.)
// ----------------------------------------------------------------
function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleSaveProfile(e) {
  e.preventDefault();
  const btn = document.getElementById('save-profile-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    // --- Validate mandatory fields before hitting the API ---
    // Collect values from the form right now (not from App.user.profile,
    // which hasn't been updated yet) so we validate what the user typed.
    const industryVal   = document.getElementById('s-industry')?.value.trim();
    const bizTypeVal    = document.getElementById('s-business-type')?.value;
    const ageRangeVal   = document.getElementById('s-age-range')?.value;
    const stateVal      = document.getElementById('s-state')?.value.trim();
    const platformsVal  = Array.from(
      document.querySelectorAll('input[name="preferred_platforms"]:checked')
    );

    const missingLabels = [];
    if (!industryVal)             missingLabels.push('Industry');
    if (!bizTypeVal)              missingLabels.push('Business Type');
    if (!ageRangeVal)             missingLabels.push('Target Age Range');
    if (!stateVal || stateVal.length < 2) missingLabels.push('State (2-letter abbreviation)');
    if (platformsVal.length === 0) missingLabels.push('Preferred Platforms (select at least one)');

    if (missingLabels.length > 0) {
      showAlert('profile-alerts',
        `Please fill in the following required fields: ${missingLabels.join(', ')}.`,
        'error'
      );
      btn.disabled = false;
      btn.textContent = 'Save Profile';
      return;
    }

    // Helper: parse a comma-separated input into a trimmed, non-empty array
    const parseList = (id) =>
      document.getElementById(id).value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // Collect all checked platform checkboxes
    const preferredPlatforms = Array.from(
      document.querySelectorAll('input[name="preferred_platforms"]:checked')
    ).map(cb => cb.value);

    // years_in_business must be a number or null (not empty string)
    const yearsRaw = document.getElementById('s-years').value.trim();
    const yearsInBusiness = yearsRaw !== '' ? parseInt(yearsRaw, 10) : null;

    await apiFetch('/auth/me', {
      method: 'PUT',
      body: JSON.stringify({
        // Personal
        full_name: document.getElementById('s-full-name').value.trim() || null,
        // Brand basics
        brand_name:      document.getElementById('s-brand-name').value.trim(),
        industry:        document.getElementById('s-industry').value.trim(),
        target_audience: document.getElementById('s-audience').value.trim(),
        brand_voice:     document.getElementById('s-voice').value.trim(),
        // Business details
        business_type:      document.getElementById('s-business-type').value  || null,
        business_size:      document.getElementById('s-business-size').value  || null,
        years_in_business:  yearsInBusiness,
        primary_goal:       document.getElementById('s-primary-goal').value   || null,
        content_frequency:  document.getElementById('s-content-freq').value   || null,
        // Audience
        target_age_range:   document.getElementById('s-age-range').value      || null,
        target_gender:      document.getElementById('s-gender').value         || null,
        audience_location:  document.getElementById('s-aud-location').value   || null,
        audience_interests: parseList('s-interests'),
        // Location (geo_region is derived server-side from state)
        city:  document.getElementById('s-city').value.trim()  || null,
        state: document.getElementById('s-state').value.trim().toUpperCase() || null,
        // Intelligence seeding
        reference_accounts:  parseList('s-ref-accounts'),
        primary_competitors: parseList('s-competitors'),
        // Preferences
        preferred_platforms: preferredPlatforms
      })
    });

    // Refresh the in-memory profile so completion status is up to date
    // (e.g. dashboard banner disappears without a full page reload)
    await loadCurrentUser();

    showAlert('profile-alerts', 'Profile saved successfully.', 'success');
  } catch (err) {
    showAlert('profile-alerts', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Profile';
  }
}

async function openBillingPortal() {
  try {
    const data = await apiFetch('/billing/portal', { method: 'POST' });
    window.location.href = data.portalUrl;
  } catch (err) {
    showAlert('settings-alerts', 'Failed to open billing portal: ' + err.message, 'error');
  }
}

// ----------------------------------------------------------------
// startUpgrade — creates a Stripe Checkout session for the chosen
// plan and redirects the user to complete payment.
// ----------------------------------------------------------------
async function startUpgrade(planKey) {
  const btn = document.getElementById(`upgrade-btn-${planKey}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }

  try {
    const data = await apiFetch('/billing/subscribe', {
      method: 'POST',
      body: JSON.stringify({ plan: planKey })
    });
    window.location.href = data.checkoutUrl;
  } catch (err) {
    showAlert('settings-alerts', 'Could not start checkout: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = `Upgrade to ${planKey}`; }
  }
}

// ============================================================
// LOGOUT
// ============================================================
async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // If logout API call fails, still clear local state
  }
  clearToken();
  window.location.hash = '';
  renderAuthScreen();
}

// ============================================================
// BOOT — runs when the page loads
// ============================================================
async function boot() {
  const token = loadToken();

  if (!token) {
    // No token stored — show the login screen
    renderAuthScreen();
    return;
  }

  // There is a stored token — verify it's still valid
  try {
    await loadCurrentUser();
    renderAppShell();
  } catch {
    // Token is invalid or expired — clear it and show login
    clearToken();
    renderAuthScreen();
  }
}

// Start the app when the DOM is ready
document.addEventListener('DOMContentLoaded', boot);
