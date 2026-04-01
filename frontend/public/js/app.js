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
// APP_VERSION — bump this number every time ANY frontend JS or CSS
// file changes. Must match APP_VERSION in backend/server.js.
// When stale, all authenticated users see a "new version" banner.
// ============================================================
const APP_VERSION = 3;

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
// Chart.js instance management — destroy all before re-rendering views
// ============================================================
window._chartInstances = [];
function registerChart(chart) { window._chartInstances.push(chart); return chart; }
function destroyAllCharts() {
  window._chartInstances.forEach(c => { try { c.destroy(); } catch (_) {} });
  window._chartInstances = [];
}

// ============================================================
// Token storage helpers
// Store the JWT in localStorage so it survives page refreshes.
// ============================================================

function saveToken(token, refreshToken, sessionId) {
  App.token = token;
  localStorage.setItem('sb_token', token);
  if (refreshToken) localStorage.setItem('sb_refresh_token', refreshToken);
  if (sessionId) localStorage.setItem('sb_session_id', sessionId);
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
  localStorage.removeItem('sb_session_id');
  // Stop background pollers so they don't fire 401s after logout
  if (App._unreadPoller) { clearInterval(App._unreadPoller); App._unreadPoller = null; }
}

// ============================================================
// JWT expiry helpers
// Decode the JWT payload to read the `exp` claim. This avoids
// relying on fixed-interval timers which browsers throttle when
// the tab is backgrounded or the laptop sleeps.
// ============================================================

function getTokenExpiry(token) {
  if (!token) return 0;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000; // convert to milliseconds
  } catch { return 0; }
}

function isTokenExpiringSoon(token, bufferMs = 5 * 60 * 1000) {
  return getTokenExpiry(token) < Date.now() + bufferMs;
}

// ============================================================
// Global refresh lock + request queue
// Only one refresh request fires at a time. All concurrent 401s
// wait for the single refresh to complete, then retry together.
// This prevents Supabase refresh token rotation from invalidating
// tokens when multiple requests race.
// ============================================================

let _isRefreshing = false;
let _refreshSubscribers = [];

async function refreshTokenOnce() {
  // If another refresh is already in flight, wait for it
  if (_isRefreshing) {
    return new Promise((resolve, reject) => {
      _refreshSubscribers.push({ resolve, reject });
    });
  }

  _isRefreshing = true;
  const rt = localStorage.getItem('sb_refresh_token');

  try {
    if (!rt) throw new Error('No refresh token');
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    });
    const data = await res.json();
    if (!res.ok || !data.session) throw new Error('Refresh failed');

    saveToken(data.session.access_token, data.session.refresh_token);
    // Notify all queued requests that refresh succeeded
    _refreshSubscribers.forEach(s => s.resolve());
    return true;
  } catch (err) {
    _refreshSubscribers.forEach(s => s.reject(err));
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw err;
  } finally {
    _isRefreshing = false;
    _refreshSubscribers = [];
  }
}

// Listen for auth expiry — renders login screen safely AFTER
// any in-progress catch blocks have finished showing alerts.
window.addEventListener('auth:expired', () => {
  setTimeout(() => renderAuthScreen(), 100);
});

// ============================================================
// apiFetch — the global API request helper.
// Automatically attaches the Authorization header.
// Throws on non-OK HTTP responses with a clean error message.
// ============================================================
async function apiFetch(path, options = {}, _retried = false) {
  // Proactive refresh: if the JWT will expire within 5 minutes,
  // refresh it NOW before making the request. This avoids the
  // 401 → refresh → retry round trip entirely.
  if (App.token && isTokenExpiringSoon(App.token)) {
    try {
      await refreshTokenOnce();
    } catch {
      throw new Error('Your session expired. Please log in again.');
    }
  }

  const sessionId = localStorage.getItem('sb_session_id');
  const headers = {
    'Content-Type': 'application/json',
    ...(App.token ? { Authorization: `Bearer ${App.token}` } : {}),
    ...(sessionId ? { 'X-Session-ID': sessionId } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, { ...options, headers, cache: 'no-store' });

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  // Session invalidated = another device logged in. Don't retry, just log out.
  if (response.status === 401 && body.session_invalidated) {
    clearToken();
    alert('Your account was logged into from another device. Please log in again.');
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error(body.error);
  }

  // Reactive fallback: if we still get a 401 (clock skew, server-side
  // revocation, etc.), try one refresh + retry.
  if (response.status === 401 && !_retried) {
    try {
      await refreshTokenOnce();
      return apiFetch(path, options, true);
    } catch {
      throw new Error('Your session expired. Please log in again.');
    }
  }

  // Detect tier-limit 429 responses and tag them so callers can show upgrade prompts
  if (response.status === 429 && body.limit_reached) {
    const err = new Error(body.error || 'You have reached a plan limit.');
    err.limitReached = true;
    err.feature      = body.feature;
    err.limit        = body.limit;
    err.usage        = body.usage;
    err.tier         = body.tier;
    throw err;
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
// showToast — fixed-position notification immune to DOM re-renders.
// Appended to #global-toasts which lives outside #app, so no
// innerHTML rebuild can destroy it. Use for actions where the
// page may re-render immediately after (billing, OAuth, etc.).
// ============================================================
function showToast(message, type = 'success', durationMs = 5000) {
  const container = document.getElementById('global-toasts');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ============================================================
// Feature descriptions — shown in upgrade prompts so users know
// what they're missing and why it's worth upgrading.
// ============================================================
const FEATURE_INFO = {
  briefs_per_month: {
    name:  'AI Post Generation',
    desc:  'Generate scroll-stopping hooks, captions, hashtags, and CTAs powered by AI. Each brief analyzes trending content and your audience data to create posts that actually perform.',
    icon:  '✍️'
  },
  ai_images_per_month: {
    name:  'AI Image Generation',
    desc:  'Create eye-catching images for your posts with AI. Just describe what you want and get a publish-ready image in seconds — no design skills needed.',
    icon:  '🎨'
  },
  platforms_connected: {
    name:  'Platform Connections',
    desc:  'Connect more social media accounts to publish everywhere from one dashboard. Manage Facebook, Instagram, TikTok, LinkedIn, X, Threads, WhatsApp, and Telegram all in one place.',
    icon:  '🔗'
  },
  scheduled_queue_size: {
    name:  'Scheduled Post Queue',
    desc:  'Queue up more posts to publish automatically at the perfect time. Schedule a week (or month) of content in one sitting and let Social Buster handle the rest.',
    icon:  '📅'
  },
  comment_monitoring: {
    name:  'Comment-to-DM Automation',
    desc:  'Automatically send personalized DMs when someone comments a trigger word on your post. Turn comments into leads with multi-step conversations that collect emails, phone numbers, and more.',
    icon:  '💬'
  },
  dm_lead_capture: {
    name:  'Lead Capture & Export',
    desc:  'Collect and export lead data (emails, phone numbers, names) from your DM automations. Download CSV files to import into your CRM or email marketing tool.',
    icon:  '📊'
  },
  intelligence_dashboard: {
    name:  'Intelligence Dashboard',
    desc:  'See what\'s working and what isn\'t with AI-powered performance analytics. Get trend research, sentiment analysis on comments, and data-driven recommendations to improve every post.',
    icon:  '🧠'
  },
  performance_predictor: {
    name:  'Performance Predictor',
    desc:  'See predicted likes, comments, and reach before you publish. Uses your history and peer benchmarks to forecast engagement and suggest tweaks.',
    icon:  '📈'
  },
  pain_point_miner: {
    name:  'Audience Pain-Point Miner',
    desc:  'Discover what your audience is struggling with and asking about. AI clusters your comments into actionable themes with post ideas that address real needs.',
    icon:  '🎯'
  },
  brand_voice_tracker: {
    name:  'Brand Voice Tracker',
    desc:  'The AI learns your unique writing style from your published posts. After a few posts, every generated hook and caption sounds like you — not a generic template.',
    icon:  '🎙️'
  }
};

// ============================================================
// showUpgradePrompt — modal overlay encouraging the user to
// upgrade their plan. Shows what the locked feature does so
// it doubles as a selling point.
// ============================================================
function showUpgradePrompt(feature, errorMessage) {
  const info = FEATURE_INFO[feature] || {
    name: 'Premium Feature',
    desc: 'This feature is available on a higher plan. Upgrade to unlock it.',
    icon: '⭐'
  };

  // Remove any existing upgrade modal
  const existing = document.getElementById('upgrade-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'upgrade-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:440px;width:90%;padding:32px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:fadeInUp 0.25s ease-out;">
      <div style="font-size:48px;margin-bottom:12px;">${info.icon}</div>
      <h2 style="margin:0 0 8px;font-size:22px;color:#0f172a;">${info.name}</h2>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px;">${info.desc}</p>
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;color:#92400e;">${errorMessage || 'Upgrade your plan to unlock this feature.'}</p>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="document.getElementById('upgrade-modal').remove()" style="padding:10px 20px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#64748b;cursor:pointer;font-size:14px;">Maybe Later</button>
        <button onclick="document.getElementById('upgrade-modal').remove(); navigate('settings');" style="padding:10px 20px;border:none;border-radius:8px;background:var(--primary, #6366f1);color:#fff;cursor:pointer;font-size:14px;font-weight:600;">View Plans & Upgrade</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================
// renderUpgradePlaceholder — inline upgrade card shown in place
// of a feature's content area (e.g. intelligence dashboard).
// ============================================================
function renderUpgradePlaceholder(container, feature, errorMessage) {
  const info = FEATURE_INFO[feature] || {
    name: 'Premium Feature',
    desc: 'This feature is available on a higher plan.',
    icon: '⭐'
  };

  container.innerHTML = `
    <div style="text-align:center;padding:48px 24px;">
      <div style="font-size:64px;margin-bottom:16px;">${info.icon}</div>
      <h2 style="margin:0 0 8px;font-size:24px;color:#0f172a;">${info.name}</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;max-width:480px;margin:0 auto 24px;">${info.desc}</p>
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:14px;max-width:400px;margin:0 auto 24px;">
        <p style="margin:0;font-size:13px;color:#92400e;">${errorMessage || 'This feature is not included in your current plan.'}</p>
      </div>
      <button class="btn btn-primary" onclick="navigate('settings')" style="font-size:15px;padding:12px 32px;">
        View Plans & Upgrade
      </button>
    </div>
  `;
}

// ============================================================
// ROUTING — show/hide views based on hash
// ============================================================

function navigate(view) {
  // Stop media analysis poller when leaving the media view
  if (App.currentView === 'media' && view !== 'media') {
    if (typeof stopAnalysisPoller === 'function') stopAnalysisPoller();
  }
  App.currentView = view;
  destroyAllCharts();
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
    case 'automations':
      renderAutomationsView(contentEl);
      break;
    case 'admin':
      if (typeof renderAdminDashboard === 'function') renderAdminDashboard(contentEl);
      else contentEl.innerHTML = '<div class="page-header"><div class="page-title">Admin</div><p>admin.js not loaded.</p></div>';
      break;
    case 'affiliate':
      renderAffiliateView(contentEl);
      break;
    case 'help':
      renderHelpView(contentEl);
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
        <div class="auth-logo"><img src="/images/logo.png" alt="Social Buster"> Social Buster</div>
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
            By registering, you agree to our <a href="/terms.html" target="_blank" style="color:var(--color-primary);">Terms of Service</a> and <a href="/privacy.html" target="_blank" style="color:var(--color-primary);">Privacy Policy</a>.
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

    // Save the JWT, refresh token, and session ID (for single-session enforcement)
    saveToken(data.session.access_token, data.session.refresh_token, data.session_id);
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

    saveToken(data.session.access_token, data.session.refresh_token, data.session_id);
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
        <div class="sidebar-logo"><img src="/images/logo.png" alt="Social Buster"> Social<span>Buster</span></div>

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
          <button class="sidebar-link" data-view="automations" onclick="navigate('automations')">
            <span class="sidebar-icon">🤖</span> DM Automations
          </button>

          <div class="sidebar-section-label" style="margin-top:12px;">Insights</div>
          <button class="sidebar-link" data-view="dashboard" onclick="navigate('dashboard')">
            <span class="sidebar-icon">📊</span> Dashboard
          </button>
          <button class="sidebar-link" data-view="intelligence" onclick="navigate('intelligence')">
            <span class="sidebar-icon">🧠</span> Intelligence
          </button>

          ${App.user?.subscription?.plan === 'legacy' ? `
          <div class="sidebar-section-label" style="margin-top:12px;">Legacy</div>
          <button class="sidebar-link" data-view="affiliate" onclick="navigate('affiliate')">
            <span class="sidebar-icon">💎</span> Affiliate Program
          </button>` : ''}

          ${App.user?.is_admin ? `
          <div class="sidebar-section-label" style="margin-top:12px;">Admin</div>
          <button class="sidebar-link" data-view="admin" onclick="navigate('admin')">
            <span class="sidebar-icon">🛠️</span> Admin Dashboard
          </button>` : ''}
        </div>

        <div class="sidebar-footer">
          <button class="sidebar-link" data-view="help" onclick="navigate('help')">
            <span class="sidebar-icon">❓</span> Help & Tutorials
          </button>
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
  const refresh = async () => {
    // Skip if logged out or token is about to expire (let apiFetch handle refresh)
    if (!App.token || isTokenExpiringSoon(App.token)) return;
    if (typeof refreshMsgUnreadBadge === 'function') {
      try { await refreshMsgUnreadBadge(); } catch (_) { /* non-fatal */ }
    }
  };
  refresh(); // immediate check on login
  App._unreadPoller = setInterval(refresh, 60 * 1000);
}

// ============================================================
// VIEWS — placeholder renderers (will be filled in per phase)
// ============================================================

// ============================================================
// Chart.js helper — render a tiny sparkline in a KPI card
// ============================================================
function renderSparkline(canvasId, dataPoints, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  registerChart(new Chart(canvas, {
    type: 'line',
    data: {
      labels: dataPoints.map((_, i) => i),
      datasets: [{
        data: dataPoints.map(d => d.count),
        borderColor: color,
        backgroundColor: color + '20',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: { duration: 600 }
    }
  }));
}

// Show delta arrow (▲/▼) comparing today vs yesterday
function renderKpiDelta(elementId, delta) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (delta === 0 || delta === undefined || delta === null) {
    el.className = 'kpi-card__delta kpi-card__delta--flat';
    el.textContent = '— same as yesterday';
  } else {
    const arrow = delta > 0 ? '▲' : '▼';
    const cls = delta > 0 ? 'up' : 'down';
    el.className = `kpi-card__delta kpi-card__delta--${cls}`;
    el.textContent = `${arrow} ${Math.abs(delta)} vs yesterday`;
  }
}

async function renderDashboard(el) {
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

  // Render the shell immediately with loading placeholders, then fetch data
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Dashboard</div>
      <div class="page-subtitle">Welcome back — here's how ${brandName} is performing.</div>
    </div>

    ${profileBanner}

    <div class="kpi-grid">
      <div class="kpi-card kpi-card--green" onclick="navigate('posts')" title="View generated posts">
        <div class="kpi-card__label">Posts Published</div>
        <div class="kpi-card__value" id="dash-published">—</div>
        <div class="kpi-card__delta" id="dash-published-delta"></div>
        <canvas class="kpi-card__sparkline" id="spark-published"></canvas>
      </div>
      <div class="kpi-card kpi-card--blue" onclick="navigate('queue')" title="View publishing queue">
        <div class="kpi-card__label">Posts Scheduled</div>
        <div class="kpi-card__value" id="dash-scheduled">—</div>
        <div class="kpi-card__delta" id="dash-scheduled-delta"></div>
        <canvas class="kpi-card__sparkline" id="spark-scheduled"></canvas>
      </div>
      <div class="kpi-card kpi-card--indigo" onclick="navigate('automations')" title="View DM automations">
        <div class="kpi-card__label">DM Conversations</div>
        <div class="kpi-card__value" id="dash-conversations">—</div>
        <div class="kpi-card__delta" id="dash-conversations-delta"></div>
        <canvas class="kpi-card__sparkline" id="spark-conversations"></canvas>
      </div>
      <div class="kpi-card kpi-card--amber" onclick="navigate('automations')" title="View collected leads">
        <div class="kpi-card__label">Leads Captured</div>
        <div class="kpi-card__value" id="dash-leads">—</div>
        <div class="kpi-card__delta" id="dash-leads-delta"></div>
        <canvas class="kpi-card__sparkline" id="spark-leads"></canvas>
      </div>
      <div class="kpi-card kpi-card--purple" onclick="navigate('automations')" title="DM conversion rate">
        <div class="kpi-card__label">DM Conv. Rate</div>
        <div class="kpi-card__value" id="dash-dm-rate">—</div>
      </div>
    </div>

    <div id="dash-recent-posts" style="margin-bottom:24px;"></div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Quick Actions</div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="navigate('brief')">Create New Brief</button>
        <button class="btn btn-secondary" onclick="navigate('queue')">Publishing Queue</button>
        <button class="btn btn-secondary" onclick="navigate('media')">Media Library</button>
      </div>
    </div>
  `;

  // Fetch stats + trends in parallel — don't block the page render
  try {
    const [dmDashRes, trendsRes] = await Promise.all([
      apiFetch('/automations/dashboard').catch(() => null),
      apiFetch('/posts/dashboard-trends').catch(() => null)
    ]);

    // KPI counts come from dashboard-trends (lightweight count queries)
    const publishedCount = trendsRes?.kpi?.publishedTotal ?? 0;
    const scheduledCount = trendsRes?.kpi?.scheduledTotal ?? 0;

    // Update KPI card values
    const publishedEl = document.getElementById('dash-published');
    const scheduledEl = document.getElementById('dash-scheduled');
    const convsEl     = document.getElementById('dash-conversations');
    const leadsEl     = document.getElementById('dash-leads');
    const rateEl      = document.getElementById('dash-dm-rate');

    if (publishedEl) publishedEl.textContent = publishedCount;
    if (scheduledEl) scheduledEl.textContent = scheduledCount;
    if (convsEl)     convsEl.textContent = dmDashRes?.summary?.total_conversations ?? '—';
    if (leadsEl)     leadsEl.textContent = dmDashRes?.summary?.total_leads ?? '—';
    if (rateEl) {
      const rate = dmDashRes?.summary?.conversion_rate;
      rateEl.textContent = rate !== undefined && rate !== null ? rate + '%' : '—';
    }

    // Render sparklines and delta arrows from trend data
    if (trendsRes && window.Chart) {
      const sparkColors = {
        published: '#22c55e', scheduled: '#3b82f6',
        conversations: '#6366f1', leads: '#f59e0b'
      };
      ['published', 'scheduled', 'conversations', 'leads'].forEach(key => {
        const data = trendsRes[key];
        if (!data) return;
        renderSparkline('spark-' + key, data.trend, sparkColors[key]);
        renderKpiDelta('dash-' + key + '-delta', data.change);
      });
    }

    // Show recent published posts (last 5) — from dashboard-trends KPI data
    const recentContainer = document.getElementById('dash-recent-posts');
    if (recentContainer) {
      const recentPublished = trendsRes?.kpi?.recentPosts || [];

      if (recentPublished.length > 0) {
        recentContainer.innerHTML = `
          <div class="card">
            <div class="card-header">
              <div class="card-title">Recent Posts</div>
            </div>
            ${recentPublished.map(post => {
              const icon = platformLogoSvg(post.platform, 20);
              const hook = (post.hook || '(no hook)').slice(0, 60);
              const pubDate = post.published_at
                ? new Date(post.published_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
                : '';
              return `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9;">
                  <span style="display:flex;align-items:center;flex-shrink:0;">${icon}</span>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;font-weight:500;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${hook}</div>
                    <div style="font-size:11px;color:#94a3b8;">${pubDate}</div>
                  </div>
                </div>`;
            }).join('')}
          </div>`;
      }
    }
  } catch (err) {
    console.error('[Dashboard] Failed to load stats:', err.message);
  }
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

    const platformIcons = { instagram:'📸', facebook:'👥', tiktok:'🎵', linkedin:'💼', x:'𝕏', threads:'🧵', whatsapp:'💬', telegram:'✈️' };

    // Sort brief sessions newest first by the latest post creation date in each group
    const sortedBriefs = Object.entries(byBrief).sort(([, a], [, b]) => {
      const aLatest = Math.max(...a.map(p => new Date(p.created_at).getTime()));
      const bLatest = Math.max(...b.map(p => new Date(p.created_at).getTime()));
      return bLatest - aLatest;
    });

    container.innerHTML = sortedBriefs.map(([briefId, briefPosts]) => {
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

// ============================================================
// PUBLISHING QUEUE — List + Calendar views
// ============================================================

// Module-level state for the queue views
let queueViewMode = 'list';          // 'list' or 'calendar'
let queueCalendarMonth = new Date(); // tracks which month the calendar shows
let queueCachedPosts = [];           // avoid re-fetching when toggling views
let queueSelectedDay = null;         // which day is expanded in calendar view

// Platform SVG logos (inline, 20px default) — actual brand icons
function platformLogoSvg(platform, size = 20) {
  const logos = {
    instagram: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"><defs><radialGradient id="ig" cx="30%" cy="107%" r="150%"><stop offset="0%" stop-color="#fdf497"/><stop offset="5%" stop-color="#fdf497"/><stop offset="45%" stop-color="#fd5949"/><stop offset="60%" stop-color="#d6249f"/><stop offset="90%" stop-color="#285AEB"/></radialGradient></defs><rect width="22" height="22" x="1" y="1" rx="6" fill="url(#ig)"/><circle cx="12" cy="12" r="4.5" stroke="#fff" stroke-width="1.8" fill="none"/><circle cx="17.5" cy="6.5" r="1.2" fill="#fff"/></svg>`,
    facebook: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path d="M16.67 15.47l.53-3.47H13.8v-2.25c0-.95.46-1.87 1.95-1.87H17.3V5.01s-1.2-.2-2.35-.2c-2.4 0-3.97 1.45-3.97 4.08V12H7.9v3.47h3.08V24h3.8V15.47h1.89z" fill="#fff"/></svg>`,
    tiktok: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#010101"/><path d="M16.6 8.2c-.8-.5-1.3-1.3-1.5-2.2h-2.4v10.7c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5 1.1-2.5 2.5-2.5c.3 0 .5 0 .7.1V12c-.2 0-.5-.1-.7-.1-2.5 0-4.6 2-4.6 4.6s2 4.6 4.6 4.6 4.6-2 4.6-4.6V12c.9.7 2 1 3.2 1V10.7c-1 0-1.8-.4-2.4-1v-.5z" fill="#fff"/><path d="M16.6 8.2c.6.4 1.4.7 2.4.7v-.6c-.5 0-1-.1-1.4-.3l-1 .2z" fill="#69C9D0"/><path d="M10.2 19.2c1.4 0 2.5-1.1 2.5-2.5V6h2.4c0-.3-.1-.6-.1-.9h-3.1v10.7c0 1.4-1.1 2.5-2.5 2.5-.4 0-.9-.1-1.2-.3.5.7 1.2 1.2 2 1.2z" fill="#EE1D52"/></svg>`,
    linkedin: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#0A66C2"/><path d="M7.1 9.8h2.3v7.4H7.1V9.8zm1.1-3.5c.7 0 1.3.6 1.3 1.3s-.6 1.3-1.3 1.3S6.9 8.3 6.9 7.6s.6-1.3 1.3-1.3zm3.2 3.5h2.2v1c.3-.6 1.1-1.2 2.2-1.2 2.4 0 2.8 1.6 2.8 3.6v4.1h-2.3v-3.6c0-.9 0-2-1.2-2s-1.4 1-1.4 2v3.6h-2.3V9.8z" fill="#fff"/></svg>`,
    x: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#000"/><path d="M13.5 10.8L18.2 5h-1.1l-4.1 4.8L9.5 5H5l5 7.2L5 19h1.1l4.3-5L14.5 19H19l-5.5-8.2zm-1.5 1.8l-.5-.7L6.6 5.9h1.7l3.2 4.6.5.7 4.2 6h-1.7l-3.5-4.6z" fill="#fff"/></svg>`,
    threads: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#f1f1f1" stroke="#e0e0e0" stroke-width="0.5"/><path d="M15.24 11.36c-.06-.03-.12-.05-.18-.07-.15-1.52-1.02-2.5-2.42-2.58-.01 0-.02 0-.03 0-.84 0-1.57.36-2.06 1.02l.87.6c.36-.48.85-.65 1.2-.65.46 0 .82.15 1.05.44.17.21.28.5.33.86-.42-.07-.87-.09-1.35-.04-.96.1-1.77.64-1.77 1.63 0 .48.22.92.61 1.24.34.28.78.42 1.26.4.63-.03 1.12-.3 1.46-.78.26-.37.42-.84.49-1.44.3.18.52.42.64.72.2.5.22 1.33-.42 1.97-.56.56-1.23.8-2.13.81-1 0-1.76-.33-2.25-.97-.46-.6-.7-1.46-.7-2.56s.24-1.96.7-2.56c.49-.64 1.25-.97 2.25-.97.52 0 1.28.16 1.88.62.3.23.53.52.7.87l.93-.38c-.22-.46-.53-.84-.93-1.14-.76-.58-1.65-.84-2.58-.84-1.26 0-2.27.43-2.93 1.28-.57.73-.87 1.76-.87 3.12 0 1.36.3 2.39.87 3.12.66.85 1.67 1.28 2.93 1.28 1.1 0 1.96-.32 2.67-1.03.9-.9.84-2.04.5-2.91-.24-.61-.7-1.1-1.32-1.42zm-1.52 2.08c-.03.46-.14.81-.33 1.07-.25.34-.6.51-1.05.53-.32.02-.62-.06-.83-.24-.2-.17-.3-.39-.3-.63 0-.42.31-.72.98-.79.18-.02.35-.03.52-.03.26 0 .5.03.73.07.15.01.22.01.28.02z" fill="#000"/></svg>`,
    whatsapp: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#25D366"/><path d="M17.5 14.4c-.3-.1-1.6-.8-1.8-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.4.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.3 0-.5-.1-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.6-.7 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3z" fill="#fff"/></svg>`,
    telegram: `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path d="M5.4 11.9l8.8-3.4c.4-.2.8.1.7.5l-1.5 7c-.1.4-.5.5-.8.3l-2.3-1.7-1.1 1.1c-.1.1-.3.2-.5.1l.2-2.4 4.6-4.2c.2-.2 0-.3-.3-.1L8.5 13l-2.5-.8c-.5-.2-.5-.5.1-.7l-.1-.1-.6.5z" fill="#fff"/></svg>`
  };
  return logos[platform] || `<span style="font-size:${size}px;">📱</span>`;
}

// Emoji fallback icons (used in calendar chips on mobile where SVGs are too small)
const QUEUE_PLATFORM_ICONS = {
  instagram:'📸', facebook:'👥', tiktok:'🎵',
  linkedin:'💼', x:'𝕏', threads:'🧵', whatsapp:'💬', telegram:'✈️'
};
const QUEUE_PLATFORM_COLORS = {
  instagram: { bg: '#fce7f3', color: '#be185d' },
  facebook:  { bg: '#dbeafe', color: '#1e40af' },
  tiktok:    { bg: '#f0fdf4', color: '#166534' },
  linkedin:  { bg: '#eff6ff', color: '#1e3a5f' },
  x:         { bg: '#f1f5f9', color: '#0f172a' },
  threads:   { bg: '#f5f3ff', color: '#6d28d9' },
  whatsapp:  { bg: '#ecfdf5', color: '#065f46' },
  telegram:  { bg: '#e0f2fe', color: '#0369a1' }
};

async function renderQueuePlaceholder(el) {
  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Publishing Queue</div>
        <div class="page-subtitle">Posts scheduled for publishing and your recent publish history.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div class="queue-view-toggle">
          <button class="queue-view-btn ${queueViewMode === 'list' ? 'active' : ''}" onclick="switchQueueView('list')">📋 List</button>
          <button class="queue-view-btn ${queueViewMode === 'calendar' ? 'active' : ''}" onclick="switchQueueView('calendar')">📅 Calendar</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="navigate('brief')">✏️ New Brief</button>
      </div>
    </div>
    <div id="queue-alerts"></div>
    <div id="queue-container">
      <div class="loading-overlay" style="position:relative;height:120px;background:none;"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const data = await apiFetch('/publish/queue');
    queueCachedPosts = data.posts || [];
    renderQueueActiveView();
  } catch (err) {
    const container = document.getElementById('queue-container');
    if (container) container.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

// Switch between list and calendar without re-fetching
function switchQueueView(mode) {
  queueViewMode = mode;
  queueSelectedDay = null;
  // Update toggle button styles
  document.querySelectorAll('.queue-view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.includes(mode === 'list' ? 'List' : 'Calendar'));
  });
  renderQueueActiveView();
}

// Render whichever view is active
function renderQueueActiveView() {
  const container = document.getElementById('queue-container');
  if (!container) return;

  if (queueCachedPosts.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align:center;padding:48px;">
        <div style="font-size:40px;margin-bottom:12px;">🗓️</div>
        <div style="font-weight:600;margin-bottom:8px;">Nothing scheduled yet</div>
        <p class="text-muted text-sm" style="margin-bottom:20px;">
          Create a brief, generate posts, then hit Publish Now or Schedule.
        </p>
        <button class="btn btn-primary" onclick="navigate('brief')">Create a Brief</button>
      </div>`;
    return;
  }

  if (queueViewMode === 'calendar') {
    renderQueueCalendar(queueCachedPosts, container);
  } else {
    renderQueueList(queueCachedPosts, container);
  }
}

// ---- LIST VIEW ----
function renderQueueList(posts, container) {
  const statusOrder = { publishing: 0, scheduled: 1, paused: 2, approved: 3, failed: 4, published: 5 };
  const sorted = [...posts].sort((a, b) => {
    const orderDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  // Count how many posts are ahead in the queue (for ETA calculation).
  // The publish worker processes posts every 60 seconds, ~1 post per cycle.
  const pendingPosts = sorted.filter(p => ['scheduled', 'approved', 'publishing'].includes(p.status));

  container.innerHTML = sorted.map(post => {
    const queuePos = pendingPosts.indexOf(post);
    return renderQueuePostCard(post, queuePos >= 0 ? queuePos : -1, pendingPosts.length);
  }).join('');
}

// Shared post card renderer (used by list view and calendar day detail)
// queuePosition: 0-based index in the pending queue (-1 if not pending)
// totalPending: total number of posts ahead + this one
function renderQueuePostCard(post, queuePosition, totalPending) {
  const icon = platformLogoSvg(post.platform, 24);
  const hook = (post.hook || '').slice(0, 80);

  const statusBadge = s => {
    const labels = {
      scheduled:  { bg: '#dbeafe', color: '#1e40af', text: 'Scheduled' },
      approved:   { bg: '#dbeafe', color: '#1e40af', text: 'Scheduled' },
      publishing: { bg: '#fef9c3', color: '#854d0e', text: 'Publishing…' },
      paused:     { bg: '#fef3c7', color: '#92400e', text: 'Paused' },
      failed:     { bg: '#fee2e2', color: '#b91c1c', text: 'Failed' },
      published:  { bg: '#dcfce7', color: '#166534', text: 'Published' }
    };
    const { bg, color, text } = labels[s] || { bg: '#f1f5f9', color: '#475569', text: s };
    return `<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:20px;background:${bg};color:${color};">${text}</span>`;
  };

  const schedTime = post.scheduled_at
    ? new Date(post.scheduled_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : null;
  const pubTime = post.published_at
    ? new Date(post.published_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : null;

  let infoLine = '';
  if (post.status === 'publishing') {
    infoLine = `<span style="color:#854d0e;">⏳ Publishing now…</span>`;
  } else if (post.status === 'published' && pubTime) {
    infoLine = `✅ Published ${pubTime}`;
  } else if ((post.status === 'scheduled' || post.status === 'approved') && schedTime) {
    // Show ETA based on queue position (publish worker runs every 60s, ~1 post per cycle)
    let eta = '';
    if (queuePosition >= 0) {
      const schedDate = new Date(post.scheduled_at);
      const now = new Date();
      if (schedDate <= now || (schedDate - now) < 5 * 60 * 1000) {
        // Post is due now or within 5 min — show queue-based ETA
        const estMinutes = queuePosition + 1; // ~1 min per post ahead
        eta = estMinutes <= 1
          ? ' — publishing within 1 min'
          : ` — est. ~${estMinutes} min (${queuePosition} ahead)`;
      }
    }
    infoLine = `⏰ Sends ${schedTime}${eta}`;
  } else if (post.status === 'paused') {
    infoLine = `<span style="color:#92400e;">⏸ Paused${schedTime ? ` — was set for ${schedTime}` : ''}</span>`;
  } else if (post.status === 'failed') {
    const errMsg = post.error_message ? post.error_message.slice(0, 100) : 'Unknown error';
    infoLine = `<span style="color:#ef4444;">⚠ ${errMsg}</span>`;
  }

  const canPause  = ['scheduled', 'approved', 'publishing'].includes(post.status);
  const canResume = post.status === 'paused';
  const canCancel = ['scheduled', 'approved', 'failed', 'publishing', 'paused'].includes(post.status);
  const canRetry  = post.status === 'failed';
  const canDelete = ['scheduled', 'approved', 'failed', 'paused'].includes(post.status);

  return `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span style="display:flex;align-items:center;flex-shrink:0;">${icon}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${hook || '(no hook)'}
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${infoLine}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${statusBadge(post.status)}
          ${canPause
            ? `<button class="btn btn-secondary btn-xs" onclick="pauseQueuePost('${post.id}')">Pause</button>`
            : ''}
          ${canResume
            ? `<button class="btn btn-secondary btn-xs" onclick="resumeQueuePost('${post.id}')">Resume</button>`
            : ''}
          ${canRetry
            ? `<button class="btn btn-secondary btn-xs" onclick="retryQueuePost('${post.id}', '${post.platform}')">Retry</button>`
            : ''}
          ${canCancel && !canRetry
            ? `<button class="btn btn-secondary btn-xs" onclick="cancelQueuePost('${post.id}')">Cancel</button>`
            : ''}
          ${canDelete
            ? `<button class="btn btn-danger btn-xs" onclick="deleteQueuePost('${post.id}')">Delete</button>`
            : ''}
        </div>
      </div>
    </div>`;
}

// ---- CALENDAR VIEW ----
function renderQueueCalendar(posts, container) {
  const now   = new Date();
  const year  = queueCalendarMonth.getFullYear();
  const month = queueCalendarMonth.getMonth();

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

  // Build a map of date string → posts for this month
  const postsByDay = {};
  posts.forEach(post => {
    const d = post.scheduled_at || post.published_at || post.created_at;
    if (!d) return;
    const date = new Date(d);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!postsByDay[key]) postsByDay[key] = [];
    postsByDay[key].push(post);
  });

  // Calendar grid calculation
  const firstDay    = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  // Day name headers
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Build day cells
  let cells = '';

  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    cells += `<div class="queue-cal-day outside"><div class="queue-cal-daynum">${dayNum}</div></div>`;
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${month}-${d}`;
    const dayPosts = postsByDay[key] || [];
    const isToday = (now.getFullYear() === year && now.getMonth() === month && now.getDate() === d);
    const isSelected = (queueSelectedDay === key);

    const maxChips = 3;
    const chipsHtml = dayPosts.slice(0, maxChips).map(p => {
      const pc = QUEUE_PLATFORM_COLORS[p.platform] || { bg: '#f1f5f9', color: '#475569' };
      const statusClass = p.status === 'failed' ? ' status-failed' : p.status === 'published' ? ' status-published' : '';
      const hookPreview = (p.hook || '(no hook)').slice(0, 30);
      return `<div class="queue-cal-chip${statusClass}" style="background:${pc.bg};color:${pc.color};display:flex;align-items:center;gap:4px;" title="${hookPreview}">${platformLogoSvg(p.platform, 12)} ${hookPreview}</div>`;
    }).join('');

    const overflowHtml = dayPosts.length > maxChips
      ? `<div class="queue-cal-overflow">+${dayPosts.length - maxChips} more</div>`
      : '';

    cells += `
      <div class="queue-cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}" onclick="selectQueueDay('${key}')">
        <div class="queue-cal-daynum">${d}</div>
        <div class="queue-cal-chips">${chipsHtml}${overflowHtml}</div>
      </div>`;
  }

  // Next month leading days (fill to complete the grid row)
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remaining; i++) {
    cells += `<div class="queue-cal-day outside"><div class="queue-cal-daynum">${i}</div></div>`;
  }

  // Day detail panel (if a day is selected)
  let detailHtml = '';
  if (queueSelectedDay && postsByDay[queueSelectedDay]) {
    const dayPosts = postsByDay[queueSelectedDay];
    const parts = queueSelectedDay.split('-');
    const dateLabel = new Date(+parts[0], +parts[1], +parts[2]).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    detailHtml = `
      <div class="queue-cal-detail">
        <div class="queue-cal-detail-header">
          <h4>${dateLabel} — ${dayPosts.length} post${dayPosts.length !== 1 ? 's' : ''}</h4>
          <button class="queue-cal-detail-close" onclick="selectQueueDay(null)">✕</button>
        </div>
        ${dayPosts.map(p => renderQueuePostCard(p)).join('')}
      </div>`;
  }

  container.innerHTML = `
    <div class="queue-cal-header">
      <button class="queue-cal-nav" onclick="navigateQueueCalendar(-1)">◀</button>
      <h3>${monthNames[month]} ${year}</h3>
      <button class="queue-cal-nav" onclick="navigateQueueCalendar(1)">▶</button>
    </div>
    <div class="queue-cal-grid">
      ${dayNames.map(n => `<div class="queue-cal-dayname">${n}</div>`).join('')}
      ${cells}
    </div>
    ${detailHtml}
  `;
}

// Navigate calendar months
function navigateQueueCalendar(direction) {
  queueCalendarMonth.setMonth(queueCalendarMonth.getMonth() + direction);
  queueSelectedDay = null;
  renderQueueActiveView();
}

// Select/deselect a day in the calendar
function selectQueueDay(key) {
  queueSelectedDay = (queueSelectedDay === key) ? null : key;
  renderQueueActiveView();
}

// Cancels a scheduled post and returns it to drafts (user can re-edit and re-schedule)
async function pauseQueuePost(postId) {
  try {
    await apiFetch(`/posts/${postId}/pause`, { method: 'POST' });
    showAlert('queue-alerts', 'Post paused — it will not publish until you resume it.', 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

async function resumeQueuePost(postId) {
  try {
    await apiFetch(`/posts/${postId}/resume`, { method: 'POST' });
    showAlert('queue-alerts', 'Post resumed — publishing shortly.', 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

async function cancelQueuePost(postId) {
  try {
    await apiFetch(`/publish/queue/${postId}`, { method: 'DELETE' });
    showAlert('queue-alerts', 'Post cancelled — it\'s back in your drafts.', 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    showAlert('queue-alerts', err.message, 'error');
  }
}

// Retries a failed post by scheduling it for right now
async function retryQueuePost(postId, platform) {
  try {
    await apiFetch(`/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: new Date().toISOString() })
    });
    showAlert('queue-alerts', `Retrying ${platform} post — publishing within 60 seconds…`, 'success');
    renderQueuePlaceholder(document.getElementById('main-content-area'));
  } catch (err) {
    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else {
      showAlert('queue-alerts', err.message, 'error');
    }
  }
}

// Permanently deletes a post from the queue
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

    // If ALL requests were rejected with a limit error, show the upgrade placeholder
    const allLimited = [summaryData, researchData, commentsData, perfData].every(
      r => r.status === 'rejected' && r.reason?.limitReached
    );
    if (allLimited) {
      const container = document.getElementById('intelligence-container');
      if (container) {
        const reason = summaryData.reason;
        renderUpgradePlaceholder(container, reason.feature || 'intelligence_dashboard', reason.message);
      }
      return;
    }

    const container = document.getElementById('intelligence-container');
    if (!container) return;

    const summary   = summaryData.status   === 'fulfilled' ? summaryData.value   : null;
    const research  = researchData.status  === 'fulfilled' ? researchData.value  : null;
    const comments  = commentsData.status  === 'fulfilled' ? commentsData.value  : null;
    const perf      = perfData.status      === 'fulfilled' ? perfData.value      : null;

    // Build KPI cards from performance totals
    const perfCards = perf?.totals ? [
      { label: 'Posts Tracked',   value: perf.totals.total_posts,      color: 'indigo' },
      { label: 'Total Likes',     value: perf.totals.total_likes,      color: 'pink' },
      { label: 'Total Comments',  value: perf.totals.total_comments,   color: 'blue' },
      { label: 'Total Reach',     value: perf.totals.total_reach,      color: 'green' },
      { label: 'Impressions',     value: perf.totals.total_impressions, color: 'amber' }
    ] : [];

    // Sentiment counts
    const sc = comments?.sentimentCounts || { positive: 0, neutral: 0, negative: 0 };
    const sentimentTotal = sc.positive + sc.neutral + sc.negative;

    container.innerHTML = `
      <!-- Performance KPI cards -->
      ${perfCards.length > 0 ? `
        <div class="kpi-grid" style="margin-bottom:24px;">
          ${perfCards.map(c => `
            <div class="kpi-card kpi-card--${c.color}">
              <div class="kpi-card__label">${c.label}</div>
              <div class="kpi-card__value">${(c.value || 0).toLocaleString()}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- Platform breakdown + Sentiment donut row -->
      <div class="chart-row" style="margin-bottom:24px;">
        <div class="chart-card">
          <div class="chart-card__title">Engagement by Platform</div>
          <div id="intel-platform-chart" style="min-height:250px;display:flex;justify-content:center;">
            ${perf?.summary?.length > 0
              ? ''
              : '<div class="text-muted" style="padding:24px;text-align:center;align-self:center;">No platform data yet. Publish posts first.</div>'}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-card__title">Comment Sentiment</div>
          <div id="intel-sentiment-chart" style="min-height:250px;display:flex;justify-content:center;">
            ${sentimentTotal > 0
              ? ''
              : '<div class="text-muted" style="padding:24px;text-align:center;align-self:center;">No comments ingested yet.</div>'}
          </div>
        </div>
      </div>

      <!-- AI Intelligence Summary -->
      <div class="chart-card" style="margin-bottom:24px;">
        <div class="chart-card__title">Performance Intelligence</div>
        ${summary?.summary
          ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:#374151;background:#f8fafc;padding:16px;border-radius:8px;line-height:1.7;margin:0;">${summary.summary}</pre>`
          : `<p class="text-muted text-sm">${summary?.message || 'No intelligence summary available. Publish posts and let the performance agent run.'}</p>`
        }
      </div>

      <!-- Research Brief -->
      <div class="chart-card" style="margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div class="chart-card__title" style="margin-bottom:0;">Niche Research</div>
          <button class="btn btn-secondary btn-sm" onclick="refreshIntelligence()">Refresh</button>
        </div>
        ${research?.research
          ? `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:#374151;background:#f8fafc;padding:16px;border-radius:8px;line-height:1.7;margin:0;">${research.research}</pre>`
          : `<p class="text-muted text-sm">${research?.message || 'No research available.'}</p>
             <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="refreshIntelligence()">Generate Research Brief</button>`
        }
      </div>

      <!-- Recent Comments -->
      <div class="chart-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div class="chart-card__title" style="margin-bottom:0;">Recent Comments</div>
          ${sentimentTotal > 0 ? `
            <div style="display:flex;gap:12px;font-size:12px;">
              <span style="color:#22c55e;font-weight:600;">${sc.positive} positive</span>
              <span style="color:#94a3b8;font-weight:600;">${sc.neutral} neutral</span>
              <span style="color:#ef4444;font-weight:600;">${sc.negative} negative</span>
            </div>
          ` : ''}
        </div>
        ${comments?.comments?.length > 0
          ? `<div style="display:flex;flex-direction:column;gap:8px;">
              ${comments.comments.map(c => `
                <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:#f8fafc;border-radius:8px;border-left:3px solid ${
                  c.sentiment === 'positive' ? '#22c55e' : c.sentiment === 'negative' ? '#ef4444' : '#94a3b8'
                };">
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;color:#0f172a;line-height:1.5;">${escapeHtml(c.comment_text || '')}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:4px;">
                      @${escapeHtml(c.author_handle || 'unknown')} · ${escapeHtml(c.platform)}
                      ${c.trigger_matched ? ' · <span style="color:#6366f1;font-weight:600;">trigger matched</span>' : ''}
                      ${c.dm_sent ? ' · <span style="color:#22c55e;font-weight:600;">DM sent</span>' : ''}
                    </div>
                  </div>
                </div>`).join('')}
             </div>`
          : `<p class="text-muted text-sm">No comments ingested yet. Comments appear here once posts are published and the comment agent has run.</p>`
        }
      </div>
    `;

    // Render platform engagement chart (stacked bar: likes, comments, shares)
    if (perf?.summary?.length > 0 && window.Chart) {
      const platEl = document.getElementById('intel-platform-chart');
      if (platEl) {
        platEl.innerHTML = '<canvas id="intel-platform-canvas"></canvas>';
        registerChart(new Chart(document.getElementById('intel-platform-canvas'), {
          type: 'bar',
          data: {
            labels: perf.summary.map(p => p.platform.charAt(0).toUpperCase() + p.platform.slice(1)),
            datasets: [
              { label: 'Likes',    data: perf.summary.map(p => p.total_likes),    backgroundColor: '#ec4899' },
              { label: 'Comments', data: perf.summary.map(p => p.total_comments), backgroundColor: '#3b82f6' },
              { label: 'Shares',   data: perf.summary.map(p => p.total_shares),   backgroundColor: '#8b5cf6' }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } } },
            scales: {
              x: { stacked: true, grid: { display: false } },
              y: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' } }
            },
            animation: { duration: 600 }
          }
        }));
      }
    }

    // Render sentiment doughnut
    if (sentimentTotal > 0 && window.Chart) {
      const sentEl = document.getElementById('intel-sentiment-chart');
      if (sentEl) {
        sentEl.innerHTML = '<canvas id="intel-sentiment-canvas" style="max-height:250px;"></canvas>';
        registerChart(new Chart(document.getElementById('intel-sentiment-canvas'), {
          type: 'doughnut',
          data: {
            labels: ['Positive', 'Neutral', 'Negative'],
            datasets: [{
              data: [sc.positive, sc.neutral, sc.negative],
              backgroundColor: ['#22c55e', '#94a3b8', '#ef4444'],
              borderWidth: 0,
              hoverOffset: 6
            }]
          },
          options: {
            cutout: '62%',
            plugins: {
              legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / sentimentTotal * 100)}%)`
                }
              }
            },
            animation: { duration: 700 }
          }
        }));
      }
    }

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
    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else {
      showAlert('intelligence-alerts', err.message, 'error');
    }
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
          <div id="platform-checkboxes" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;">
            ${['instagram','facebook','tiktok','linkedin','x','threads','whatsapp','telegram'].map(p => {
              const comingSoon = p === 'whatsapp' || p === 'telegram';
              const displayName = p === 'x' ? 'X' : p.charAt(0).toUpperCase() + p.slice(1);
              return `
              <label style="display:flex;align-items:center;gap:8px;${comingSoon ? 'opacity:0.4;cursor:default;' : 'cursor:pointer;'}font-weight:normal;padding:6px 12px;border:1.5px solid #e2e8f0;border-radius:8px;transition:all 0.15s;"
                     ${comingSoon ? 'title="Coming soon"' : ''}>
                <input type="checkbox" name="preferred_platforms" value="${p}"
                  ${(profile.preferred_platforms || []).includes(p) ? 'checked' : ''}
                  ${comingSoon ? 'disabled' : ''} style="display:none;" />
                ${platformLogoSvg(p, 20)}
                <span style="font-size:13px;">${displayName}</span>${comingSoon ? '<span style="font-size:10px;color:#94a3b8;">(soon)</span>' : ''}
              </label>`;
            }).join('')}
          </div>
          <div id="platform-limit-hint" class="text-muted text-sm" style="margin-top:6px;display:none;"></div>
        </div>
        <button type="submit" class="btn btn-primary" id="save-profile-btn">Save Profile</button>
      </form>
    </div>
  `;

  document.getElementById('profile-form').addEventListener('submit', handleSaveProfile);

  // Fetch the user's platform limit and enforce it on checkboxes
  enforcePlatformCheckboxLimit();
}

// ============================================================
// enforcePlatformCheckboxLimit — fetches the user's tier limit
// for platforms_connected and prevents checking more than allowed.
// Shows the upgrade prompt if they try to exceed the cap.
// ============================================================
async function enforcePlatformCheckboxLimit() {
  try {
    const data = await apiFetch('/billing/my-limits');
    const platformLimit = data.limits?.platforms_connected;

    // No limit row, or feature not enabled → no restriction on checkboxes
    if (!platformLimit) return;

    // Toggle OFF = feature blocked for this tier → block all checkboxes
    // Toggle ON with limit_value = -1 → unlimited → no restriction
    const maxPlatforms = !platformLimit.enabled ? 0
      : platformLimit.limit_value === -1 ? Infinity
      : platformLimit.limit_value;

    // Show hint text under the checkboxes
    const hint = document.getElementById('platform-limit-hint');
    if (hint && maxPlatforms !== Infinity) {
      hint.style.display = 'block';
      hint.textContent = maxPlatforms === 0
        ? 'Platform selection is not available on your current plan.'
        : `Your plan allows up to ${maxPlatforms} platform${maxPlatforms !== 1 ? 's' : ''}.`;
    }

    // Add click handler to each checkbox
    const checkboxes = document.querySelectorAll('input[name="preferred_platforms"]');
    checkboxes.forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = document.querySelectorAll('input[name="preferred_platforms"]:checked');
        if (checked.length > maxPlatforms) {
          // Undo the check
          cb.checked = false;
          // Show upgrade prompt
          showUpgradePrompt('platforms_connected',
            maxPlatforms === 0
              ? 'Platform selection is not included in your plan. Upgrade to select platforms.'
              : `Your plan allows up to ${maxPlatforms} platform${maxPlatforms !== 1 ? 's' : ''}. Upgrade to add more.`
          );
        }
      });
    });

    // If already over the limit (e.g. downgraded), don't forcibly uncheck —
    // let them save, but prevent adding more.

  } catch (err) {
    // Non-fatal — if we can't fetch limits, don't block the profile page
    console.warn('[Profile] Could not fetch platform limits:', err.message);
  }
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
          ${['free', 'free_trial'].includes(sub.plan) ? 'Free Trial' : (sub.plan || 'Free Trial')}
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
      'Payment successful! Your plan is being activated...',
      'success');
    // Poll for the webhook to update the DB — it can take a few seconds
    // after Stripe redirects back before the subscription is created.
    let attempts = 0;
    const poller = setInterval(async () => {
      attempts++;
      try {
        await loadCurrentUser();
        const statusRes = await apiFetch('/billing/status').catch(() => null);
        const plan = statusRes?.subscription?.plan;
        if (plan && !['free', 'free_trial'].includes(plan)) {
          clearInterval(poller);
          renderSubscriptionSection();
          showAlert('settings-alerts', 'Your plan has been upgraded!', 'success');
        } else if (attempts >= 10) {
          clearInterval(poller);
          renderSubscriptionSection();
        }
      } catch (_) {
        if (attempts >= 10) clearInterval(poller);
      }
    }, 2000); // check every 2 seconds, up to 20 seconds
  } else if (result === 'cancelled') {
    showAlert('settings-alerts', 'Payment cancelled — no charge was made.', 'info');
  }
}

// ----------------------------------------------------------------
// renderSubscriptionSection — shows plan cards for all users.
// Current plan is highlighted. Users can upgrade, downgrade, or cancel.
// ----------------------------------------------------------------
async function renderSubscriptionSection() {
  const el = document.getElementById('subscription-content');
  if (!el) return;

  // Fetch current subscription + available plans in parallel
  let sub = { plan: 'free_trial', status: 'active' };
  let plans = [];

  try {
    const [statusRes, plansRes] = await Promise.all([
      apiFetch('/billing/status').catch(() => ({ subscription: sub })),
      apiFetch('/billing/plans').catch(() => ({ plans: [] }))
    ]);
    sub = statusRes.subscription || sub;
    plans = plansRes.plans || [];
  } catch (_) { /* use defaults */ }

  const currentPlan = sub.plan || 'free_trial';
  const isFreePlan = ['free', 'free_trial'].includes(currentPlan);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  // Update the card header badge to reflect the fresh subscription data
  const card = document.getElementById('subscription-card');
  if (card) {
    const badge = card.querySelector('.badge');
    if (badge) {
      badge.className = `badge badge-${sub.status || 'active'}`;
      badge.textContent = isFreePlan ? 'Free Trial' : (currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1));
    }
  }

  if (plans.length === 0) {
    el.innerHTML = `<p class="text-sm text-muted">Subscription plans are being configured — check back soon.</p>`;
    return;
  }

  // Build status message
  let statusMsg = '';
  if (isFreePlan) {
    statusMsg = `You're on the <strong>Free Trial</strong>. Upgrade to unlock more features.`;
  } else {
    statusMsg = `You're on the <strong>${currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}</strong> plan.`;
    if (sub.status === 'cancelling' && periodEnd) {
      statusMsg += `</p><div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin:12px 0;display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">&#9888;</span>
        <div><strong style="color:#92400e;">Cancellation scheduled</strong><br><span style="color:#78350f;font-size:13px;">Your subscription will end on <strong>${periodEnd}</strong>. You keep full access until then.</span></div>
      </div><p class="text-sm text-muted" style="margin-bottom:0;">`;
    } else if (periodEnd) {
      statusMsg += ` Renews <strong>${periodEnd}</strong>.`;
    }
    if (sub.status === 'past_due') statusMsg += ' <span style="color:#ef4444;">Payment past due — please update your card.</span>';
  }

  // Sort plans by sort_order and build the tier order for comparison
  const tierOrder = plans.map(p => p.tier);
  const currentIndex = tierOrder.indexOf(currentPlan);

  el.innerHTML = `
    <p class="text-sm text-muted" style="margin-bottom:20px;">${statusMsg}</p>
    <div class="pricing-grid" id="pricing-grid">
      ${plans.map(p => {
        const features = Array.isArray(p.features) ? p.features : [];
        const isCurrent = p.tier === currentPlan;
        const planIndex = tierOrder.indexOf(p.tier);
        const isFree = ['free', 'free_trial'].includes(p.tier);

        // Determine button state
        let btnHtml = '';
        if (isCurrent) {
          btnHtml = `<button class="btn pricing-upgrade-btn" disabled style="background:#e2e8f0;color:#64748b;cursor:default;">Current Plan</button>`;
        } else if (isFree && !isFreePlan) {
          // Paid user looking at the free card → show downgrade to free
          btnHtml = `<button class="btn pricing-upgrade-btn" id="downgrade-free-btn" onclick="downgradeToFree()" style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;">Downgrade to Free</button>`;
        } else if (isFree) {
          // Free user looking at the free card — no button needed
          btnHtml = '';
        } else if (isFreePlan) {
          // Free user → show upgrade buttons for paid plans (goes through Stripe Checkout)
          btnHtml = `<button class="btn btn-primary pricing-upgrade-btn" id="upgrade-btn-${p.tier}" onclick="startUpgrade('${p.tier}')">Upgrade to ${p.name}</button>`;
        } else if (planIndex > currentIndex) {
          // Current plan is lower → upgrade
          btnHtml = `<button class="btn btn-primary pricing-upgrade-btn" id="change-btn-${p.tier}" onclick="changePlan('${p.tier}')">Upgrade to ${p.name}</button>`;
        } else {
          // Current plan is higher → downgrade
          btnHtml = `<button class="btn pricing-upgrade-btn" id="change-btn-${p.tier}" onclick="changePlan('${p.tier}')" style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;">Downgrade to ${p.name}</button>`;
        }

        return `
          <div class="pricing-card ${p.badge ? 'pricing-card--featured' : ''} ${isCurrent ? 'pricing-card--current' : ''}" style="border-top:3px solid ${p.color || '#6366f1'};${isCurrent ? 'box-shadow:0 0 0 2px ' + (p.color || '#6366f1') + ';' : ''}">
            ${isCurrent ? '<div style="font-size:11px;font-weight:700;color:#16a34a;text-transform:uppercase;margin-bottom:4px;">Your Plan</div>' : ''}
            ${p.badge && !isCurrent ? `<div class="pricing-badge">${p.badge}</div>` : ''}
            <div class="pricing-name">${p.name}</div>
            <div class="pricing-price">
              <span class="pricing-amount">${p.price_display}</span>
              <span class="pricing-period">${p.period_label}</span>
            </div>
            <ul class="pricing-features">
              ${features.map(f => `<li>✓ ${f}</li>`).join('')}
            </ul>
            ${btnHtml}
          </div>
        `;
      }).join('')}
    </div>
    ${!isFreePlan ? `
      <div style="margin-top:20px;display:flex;gap:16px;align-items:center;">
        <a href="#" onclick="openBillingPortal(); return false;" style="font-size:13px;color:#6366f1;">Payment method & invoices</a>
        ${sub.status === 'cancelling'
          ? '<span style="font-size:13px;color:#f59e0b;">Cancellation pending</span>'
          : '<a href="#" onclick="confirmCancelSubscription(); return false;" style="font-size:13px;color:#dc2626;">Cancel subscription</a>'}
      </div>
    ` : ''}
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
    { id: 'threads',   label: 'Threads',     icon: '🧵', group: 'coming_soon', note: 'Coming soon — Threads integration (blocked by Meta OAuth issue)' },
    { id: 'tiktok',    label: 'TikTok',      icon: '🎵', group: 'coming_soon', note: 'Coming soon — TikTok for Business integration' },
    { id: 'linkedin',  label: 'LinkedIn',    icon: '💼', group: 'coming_soon', note: 'Coming soon — LinkedIn integration' },
    { id: 'x',         label: 'X (Twitter)', icon: '𝕏',  group: 'coming_soon', note: 'Coming soon — X (Twitter) integration' },
    { id: 'whatsapp',  label: 'WhatsApp',    icon: '💬', group: 'coming_soon', note: 'Coming soon — WhatsApp Business API integration' },
    { id: 'telegram',  label: 'Telegram',    icon: '✈️', group: 'coming_soon', note: 'Coming soon — Telegram Bot integration' }
  ];

  container.innerHTML = platforms.map(p => {
    const conn        = connections.find(c => c.platform === p.id);
    const isConnected = !!conn;
    const isComingSoon = p.group === 'coming_soon';
    const username    = conn?.platform_username || 'Connected';
    const connectedAt = conn?.connected_at
      ? new Date(conn.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

    return `
      <div class="provider-card ${isConnected ? 'provider-connected' : ''}"
           style="margin-bottom:10px;justify-content:space-between;align-items:center;${isComingSoon ? 'opacity:0.5;pointer-events:none;' : ''}">

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

        <!-- Connect / Disconnect / Coming Soon -->
        <div style="flex-shrink:0;margin-left:12px;">
          ${isComingSoon
            ? `<span style="font-size:11px;color:#94a3b8;background:#1e293b;padding:3px 10px;border-radius:10px;font-weight:600;letter-spacing:0.3px;">COMING SOON</span>`
            : isConnected
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
      if (err.limitReached) showUpgradePrompt(err.feature, err.message);
      else showAlert('settings-alerts', err.message, 'error');
    }
    return;
  }

  // Threads OAuth: uses Meta App but goes through threads.net
  if (platformId === 'threads') {
    try {
      const data = await apiFetch('/publish/oauth/threads/start', { method: 'POST' });
      window.location.href = data.authUrl;
    } catch (err) {
      if (err.limitReached) showUpgradePrompt(err.feature, err.message);
      else showAlert('settings-alerts', err.message, 'error');
    }
    return;
  }

  // WhatsApp + Telegram — token-based, show a form modal instead of OAuth redirect
  if (platformId === 'whatsapp' || platformId === 'telegram') {
    showTokenConnectModal(platformId);
    return;
  }

  // TikTok, LinkedIn, X — each has its own OAuth flow
  const oauthEndpoints = {
    tiktok:   '/publish/oauth/tiktok/start',
    linkedin: '/publish/oauth/linkedin/start',
    x:        '/publish/oauth/x/start'
  };

  const endpoint = oauthEndpoints[platformId];
  if (!endpoint) {
    showAlert('settings-alerts', 'This platform connection is coming soon.', 'info');
    return;
  }

  try {
    const data = await apiFetch(endpoint, { method: 'POST' });
    window.location.href = data.authUrl;
  } catch (err) {
    if (err.limitReached) showUpgradePrompt(err.feature, err.message);
    else showAlert('settings-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// showTokenConnectModal — shows a form for WhatsApp/Telegram token-based connection.
// These platforms don't use OAuth — the user enters credentials manually.
// ----------------------------------------------------------------
function showTokenConnectModal(platformId) {
  const isWA = platformId === 'whatsapp';
  const title = isWA ? 'Connect WhatsApp' : 'Connect Telegram';
  const tokenLabel = isWA
    ? 'Access Token <span class="text-muted text-sm">(from Meta Business Manager)</span>'
    : 'Bot Token <span class="text-muted text-sm">(from @BotFather)</span>';
  const idLabel = isWA
    ? 'Phone Number ID <span class="text-muted text-sm">(from WhatsApp Business API)</span>'
    : 'Channel Username or Chat ID <span class="text-muted text-sm">(e.g. @mychannel)</span>';
  const nameLabel = isWA ? 'Display Name' : 'Channel Name';

  // Create a simple modal overlay
  const overlay = document.createElement('div');
  overlay.id = 'token-connect-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--card-bg, #fff);border-radius:12px;padding:28px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h3 style="margin:0 0 16px 0;">${title}</h3>
      <div id="token-connect-alerts"></div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <label style="font-weight:600;font-size:13px;">${tokenLabel}
          <input type="text" id="tc-token" placeholder="${isWA ? 'EAAxxxxxxx...' : '123456:ABCdef...'}"
            style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border-color, #ddd);border-radius:6px;font-size:13px;" />
        </label>
        <label style="font-weight:600;font-size:13px;">${idLabel}
          <input type="text" id="tc-id" placeholder="${isWA ? '1234567890' : '@mychannel'}"
            style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border-color, #ddd);border-radius:6px;font-size:13px;" />
        </label>
        <label style="font-weight:600;font-size:13px;">${nameLabel}
          <input type="text" id="tc-name" placeholder="${isWA ? 'My Business' : 'My Channel'}"
            style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--border-color, #ddd);border-radius:6px;font-size:13px;" />
        </label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('token-connect-overlay').remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" id="tc-submit-btn">Connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Submit handler
  document.getElementById('tc-submit-btn').addEventListener('click', async () => {
    const token = document.getElementById('tc-token').value.trim();
    const id    = document.getElementById('tc-id').value.trim();
    const name  = document.getElementById('tc-name').value.trim();

    if (!token || !id) {
      showAlert('token-connect-alerts', 'Token and ID are required.', 'error');
      return;
    }

    try {
      document.getElementById('tc-submit-btn').disabled = true;
      document.getElementById('tc-submit-btn').textContent = 'Connecting...';

      await apiFetch('/publish/platforms/connect-token', {
        method: 'POST',
        body: JSON.stringify({
          platform:          platformId,
          access_token:      token,
          platform_user_id:  id,
          platform_username: name || (isWA ? 'WhatsApp' : 'Telegram Channel')
        })
      });

      overlay.remove();
      showAlert('settings-alerts', `${title.replace('Connect ', '')} connected successfully!`, 'success');
      await loadConnectedPlatforms();

    } catch (err) {
      document.getElementById('tc-submit-btn').disabled = false;
      document.getElementById('tc-submit-btn').textContent = 'Connect';
      if (err.limitReached) { overlay.remove(); showUpgradePrompt(err.feature, err.message); }
      else showAlert('token-connect-alerts', err.message, 'error');
    }
  });
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
    showToast('Failed to open billing portal: ' + err.message, 'error', 8000);
  }
}

// ----------------------------------------------------------------
// startUpgrade — creates a Stripe Checkout session for the chosen
// plan and redirects the user to complete payment.
// Used when a FREE user picks a paid plan (no existing subscription).
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
    if (err.message.includes('session expired')) return;
    showToast('Could not start checkout: ' + err.message, 'error', 8000);
    if (btn) { btn.disabled = false; btn.textContent = `Upgrade to ${planKey}`; }
  }
}

// ----------------------------------------------------------------
// changePlan — upgrade or downgrade an EXISTING paid subscription.
// Stripe prorates automatically.
// If the user has no Stripe subscription (admin override), falls back
// to Stripe Checkout so they can enter payment details.
// ----------------------------------------------------------------
async function changePlan(planKey) {
  const btn = document.getElementById(`change-btn-${planKey}`);
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Changing…'; }

  if (!confirm(`Change your plan to ${planKey.charAt(0).toUpperCase() + planKey.slice(1)}? Stripe will prorate the difference.`)) {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
    return;
  }

  try {
    await apiFetch('/billing/change', {
      method: 'POST',
      body: JSON.stringify({ plan: planKey })
    });
  } catch (err) {
    // If no Stripe subscription exists, fall back to Checkout
    if (err.message.includes('No active Stripe subscription')) {
      try {
        const data = await apiFetch('/billing/subscribe', {
          method: 'POST',
          body: JSON.stringify({ plan: planKey })
        });
        window.location.href = data.checkoutUrl;
        return;
      } catch (checkoutErr) {
        showToast('Could not start checkout: ' + checkoutErr.message, 'error', 8000);
      }
    } else if (err.message.includes('session expired')) {
      return;
    } else {
      showToast('Failed to change plan: ' + err.message, 'error', 8000);
    }
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
    return;
  }

  // Plan change succeeded — toast is immune to DOM re-renders
  showToast('Plan changed successfully!', 'success');
  renderSubscriptionSection().catch(() => {});
  loadCurrentUser().catch(() => {});
}

// ----------------------------------------------------------------
// downgradeToFree — immediately cancels subscription and reverts to free.
// ----------------------------------------------------------------
async function downgradeToFree() {
  if (!confirm('Downgrade to Free?\n\n• Your paid subscription will be cancelled immediately\n• Any remaining credit or time on your current plan will be lost\n• Upgrading again — even today — will require a new payment\n\nAre you sure?')) {
    return;
  }

  const btn = document.getElementById('downgrade-free-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Downgrading…'; }

  try {
    await apiFetch('/billing/downgrade-free', { method: 'POST' });
  } catch (err) {
    if (err.message.includes('session expired')) return;
    showToast('Failed to downgrade: ' + err.message, 'error', 8000);
    if (btn) { btn.disabled = false; btn.textContent = 'Downgrade to Free'; }
    return;
  }

  // Downgrade succeeded — show confirmation immediately, then refresh UI
  // Downgrade succeeded — toast is immune to DOM re-renders
  showToast('Downgraded to Free Trial.', 'success');
  renderSubscriptionSection().catch(() => {});
  loadCurrentUser().catch(() => {});
}

// ----------------------------------------------------------------
// confirmCancelSubscription — cancel subscription and revert to free.
// If the user has a Stripe subscription, it cancels at period end.
// If no Stripe subscription (admin override), reverts immediately.
// ----------------------------------------------------------------
async function confirmCancelSubscription() {
  if (!confirm('Are you sure you want to cancel? You\'ll keep access until the end of your billing period, then revert to Free.')) {
    return;
  }

  // Show loading state — Stripe API calls can take several seconds
  const cancelLink = document.querySelector('a[onclick*="confirmCancelSubscription"]');
  if (cancelLink) { cancelLink.textContent = 'Cancelling...'; cancelLink.style.pointerEvents = 'none'; }

  try {
    await apiFetch('/billing/cancel', { method: 'POST' });
  } catch (err) {
    if (cancelLink) { cancelLink.textContent = 'Cancel subscription'; cancelLink.style.pointerEvents = ''; }
    if (err.message.includes('session expired')) return;
    showToast('Failed to cancel: ' + err.message, 'error', 8000);
    return;
  }

  // Cancel succeeded — toast is immune to DOM re-renders
  showToast('Subscription will cancel at the end of your billing period.', 'success');
  renderSubscriptionSection().catch(() => {});
  loadCurrentUser().catch(() => {});
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
  // Check if this is a password recovery redirect from Supabase.
  // When the user clicks the reset link in their email, Supabase redirects to:
  //   /reset-password#access_token=...&refresh_token=...&type=recovery
  // We need to detect this and show the "set new password" form.
  const recoveryToken = detectRecoveryToken();
  if (recoveryToken) {
    renderNewPasswordScreen(recoveryToken);
    return;
  }

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
    // Check if this browser is running stale JS — non-blocking, runs in background
    checkAppVersion();
  } catch {
    // Token is invalid or expired — clear it and show login
    clearToken();
    renderAuthScreen();
  }
}

// ============================================================
// PASSWORD RECOVERY — detect Supabase recovery token in URL
// ============================================================

/**
 * Checks the URL for a Supabase recovery token.
 * Supabase redirects to: /reset-password#access_token=...&type=recovery
 * Returns the access_token if this is a recovery redirect, null otherwise.
 */
function detectRecoveryToken() {
  // The token can be in the hash fragment (most common) or query string
  const hash = window.location.hash;
  const params = new URLSearchParams(hash.replace(/^#/, ''));

  if (params.get('type') === 'recovery' && params.get('access_token')) {
    return params.get('access_token');
  }

  // Also check the pathname — Supabase sometimes redirects to /reset-password#...
  // and our SPA fallback serves index.html, so the path might be /reset-password
  if (window.location.pathname === '/reset-password') {
    // Tokens might be in the hash
    if (params.get('access_token')) {
      return params.get('access_token');
    }
  }

  return null;
}

/**
 * Renders a "Set New Password" screen for users coming from a password reset email.
 * Shows two password fields (new + confirm) and submits to POST /auth/update-password.
 */
function renderNewPasswordScreen(recoveryToken) {
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-logo"><img src="/images/logo.png" alt="Social Buster"> Social Buster</div>
        <div class="auth-tagline">Set your new password</div>

        <div id="auth-alerts"></div>

        <form class="auth-form" id="new-password-form">
          <div class="form-group">
            <label for="new-password">New Password</label>
            <input type="password" id="new-password" placeholder="At least 8 characters" required autocomplete="new-password" />
            <div class="form-hint">Must be at least 8 characters</div>
          </div>
          <div class="form-group">
            <label for="confirm-password">Confirm Password</label>
            <input type="password" id="confirm-password" placeholder="Type it again" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full btn-lg" id="new-password-btn">
            Update Password
          </button>
          <div class="text-center text-sm text-muted mt-4">
            <a href="/" onclick="window.location.hash='';window.location.pathname='/';">← Back to Sign In</a>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('new-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('new-password-btn');
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    // Validate passwords match
    if (newPassword !== confirmPassword) {
      showAlert('auth-alerts', 'Passwords do not match.', 'error');
      return;
    }

    if (newPassword.length < 8) {
      showAlert('auth-alerts', 'Password must be at least 8 characters.', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
      const res = await fetch('/auth/update-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: recoveryToken,
          new_password: newPassword
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update password');
      }

      // If the server returned a session, log the user in automatically
      if (data.session) {
        saveToken(data.session.access_token, data.session.refresh_token, data.session_id);
        App.user = data.user;

        // Clean up the URL so the recovery token is gone
        window.location.hash = '';
        history.replaceState(null, '', '/');

        showAlert('auth-alerts', 'Password updated! Logging you in...', 'success');
        setTimeout(async () => {
          try { await loadCurrentUser(); } catch { /* non-fatal */ }
          renderAppShell();
        }, 1000);
      } else {
        // Password updated but no auto-login — redirect to login
        window.location.hash = '';
        history.replaceState(null, '', '/');
        renderAuthScreen();
        // Small delay so the auth screen is rendered before we show the alert
        setTimeout(() => {
          showAlert('auth-alerts', 'Password updated! Please sign in with your new password.', 'success');
        }, 100);
      }

    } catch (err) {
      showAlert('auth-alerts', err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Update Password';
    }
  });
}

// ============================================================
// DM AUTOMATIONS VIEW — Dashboard with KPIs, funnel, trends, leads
// ============================================================

async function renderAutomationsView(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">DM Automations</div>
      <div class="page-subtitle">Performance dashboard, workflows, and collected leads.</div>
    </div>

    <!-- KPI cards row — Power BI style -->
    <div class="kpi-grid">
      <div class="kpi-card kpi-card--green">
        <div class="kpi-card__label">Conversion Rate</div>
        <div class="kpi-card__value" id="kpi-conversion">—</div>
        <div class="kpi-card__sub" id="kpi-conv-detail"></div>
      </div>
      <div class="kpi-card kpi-card--indigo">
        <div class="kpi-card__label">Total Conversations</div>
        <div class="kpi-card__value" id="kpi-conversations">—</div>
      </div>
      <div class="kpi-card kpi-card--amber">
        <div class="kpi-card__label">Leads Collected</div>
        <div class="kpi-card__value" id="kpi-leads">—</div>
      </div>
      <div class="kpi-card kpi-card--blue">
        <div class="kpi-card__label">Avg Completion</div>
        <div class="kpi-card__value" id="kpi-avg-time">—</div>
      </div>
      <div class="kpi-card kpi-card--purple">
        <div class="kpi-card__label">Active Automations</div>
        <div class="kpi-card__value" id="kpi-active">—</div>
      </div>
    </div>

    <!-- Funnel donut + Daily usage row -->
    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-card__title">Conversation Funnel</div>
        <div id="dm-funnel" style="display:flex;justify-content:center;min-height:260px;">
          <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-card__title">Daily DM Usage</div>
        <div id="dm-usage-bars" style="padding:0;">
          <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
        </div>
      </div>
    </div>

    <!-- 14-day trend + keyword performance row -->
    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-card__title">Conversations — Last 14 Days</div>
        <div id="dm-trend" style="min-height:220px;">
          <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-card__title">Keyword Performance</div>
        <div id="keyword-perf" style="min-height:220px;">
          <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
        </div>
      </div>
    </div>

    <!-- Per-automation performance table -->
    <div class="chart-card">
      <div class="chart-card__title">Automation Performance</div>
      <div class="text-muted text-sm" style="margin-top:-12px;margin-bottom:16px;">Set up automations from the "DM Automation" button on each published post.</div>
      <div id="automations-perf-list">
        <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
      </div>
    </div>

    <!-- Leads table -->
    <div class="chart-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <div class="chart-card__title" style="margin-bottom:2px;">Collected Leads</div>
          <div class="text-muted text-sm">Data collected from DM conversations.</div>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="exportLeadsCSV()">Export CSV</button>
      </div>
      <div id="leads-table">
        <div style="padding:12px;"><div class="spinner spinner-sm"></div></div>
      </div>
    </div>
  `;

  // Load dashboard + leads in parallel
  try {
    const [dashRes, leadsRes] = await Promise.all([
      apiFetch('/automations/dashboard'),
      apiFetch('/automations/leads').catch(() => ({ leads: [] }))
    ]);

    renderDmKpis(dashRes);
    renderDmFunnel(dashRes.funnel);
    renderDmUsageBars(dashRes.daily_usage);
    renderDmTrend(dashRes.daily_trend);
    renderAutomationPerfTable(dashRes.automations);
    renderKeywordPerf(dashRes.keywords);
    renderLeadsTableDirect(leadsRes.leads || []);

  } catch (err) {
    console.error('[DM Dashboard] Failed to load:', err);
    document.getElementById('automations-perf-list').innerHTML =
      `<div style="padding:12px;color:var(--danger);">Failed to load dashboard: ${err.message}</div>`;
  }
}

// --- KPI cards ---
function renderDmKpis(dash) {
  const s = dash.summary;
  const convEl = document.getElementById('kpi-conversion');
  if (convEl) {
    convEl.textContent = s.total_conversations > 0 ? s.conversion_rate + '%' : '—';
    convEl.style.color = s.conversion_rate >= 50 ? 'var(--success)' : s.conversion_rate >= 25 ? 'var(--warning, #e67e22)' : 'var(--danger)';
  }
  const detailEl = document.getElementById('kpi-conv-detail');
  if (detailEl && s.total_conversations > 0) {
    detailEl.textContent = `${dash.funnel.completed} of ${s.total_conversations} completed`;
  }
  const convsEl = document.getElementById('kpi-conversations');
  if (convsEl) convsEl.textContent = s.total_conversations;
  const leadsEl = document.getElementById('kpi-leads');
  if (leadsEl) leadsEl.textContent = s.total_leads;
  const timeEl = document.getElementById('kpi-avg-time');
  if (timeEl) {
    if (s.avg_completion_min !== null && s.avg_completion_min !== undefined) {
      timeEl.textContent = s.avg_completion_min < 60
        ? s.avg_completion_min + 'm'
        : Math.round(s.avg_completion_min / 60) + 'h';
    } else {
      timeEl.textContent = '—';
    }
  }
  const activeEl = document.getElementById('kpi-active');
  if (activeEl) activeEl.textContent = `${s.active_automations}/${s.total_automations}`;
}

// --- Funnel visualization (Chart.js doughnut) ---
function renderDmFunnel(funnel) {
  const el = document.getElementById('dm-funnel');
  if (!el) return;
  const total = Object.values(funnel).reduce((a, b) => a + b, 0);
  if (total === 0) {
    el.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">No conversations yet.</div>';
    return;
  }

  const stages = [
    { key: 'completed', label: 'Completed', color: '#22c55e' },
    { key: 'active',    label: 'Active',    color: '#3b82f6' },
    { key: 'expired',   label: 'Expired',   color: '#94a3b8' },
    { key: 'opted_out', label: 'Opted Out', color: '#f59e0b' },
    { key: 'failed',    label: 'Failed',    color: '#ef4444' }
  ];

  el.innerHTML = '<canvas id="funnel-donut" style="max-height:250px;"></canvas>';
  if (!window.Chart) return;

  registerChart(new Chart(document.getElementById('funnel-donut'), {
    type: 'doughnut',
    data: {
      labels: stages.map(s => s.label),
      datasets: [{
        data: stages.map(s => funnel[s.key] || 0),
        backgroundColor: stages.map(s => s.color),
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / total * 100)}%)`
          }
        }
      },
      animation: { duration: 700 }
    }
  }));
}

// --- Daily DM usage bars (Facebook + Instagram) ---
function renderDmUsageBars(usage) {
  const el = document.getElementById('dm-usage-bars');
  if (!el) return;

  const platforms = [
    { key: 'facebook',  label: 'Facebook',  color: '#1877f2' },
    { key: 'instagram', label: 'Instagram', color: '#e1306c' }
  ];

  el.innerHTML = platforms.map(p => {
    const data = usage[p.key] || { count: 0, limit: 100 };
    const pct = Math.min(100, Math.round((data.count / data.limit) * 100));
    const barColor = pct >= 90 ? '#e74c3c' : pct >= 70 ? '#e67e22' : p.color;
    return `
      <div style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span class="text-sm" style="font-weight:600;">${p.label}</span>
          <span class="text-sm">${data.count} / ${data.limit} DMs today</span>
        </div>
        <div style="background:var(--bg-secondary);border-radius:4px;height:12px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width 0.3s;"></div>
        </div>
        <div class="text-muted text-sm" style="margin-top:2px;">${data.limit - data.count} remaining</div>
      </div>
    `;
  }).join('');
}

// --- 14-day trend (Chart.js bar chart) ---
function renderDmTrend(trend) {
  const el = document.getElementById('dm-trend');
  if (!el || !trend || trend.length === 0) {
    if (el) el.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">No data yet.</div>';
    return;
  }
  if (!window.Chart) return;

  el.innerHTML = '<canvas id="trend-bar"></canvas>';
  registerChart(new Chart(document.getElementById('trend-bar'), {
    type: 'bar',
    data: {
      labels: trend.map(d => {
        const dt = new Date(d.date + 'T12:00:00');
        return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }),
      datasets: [{
        label: 'Conversations',
        data: trend.map(d => d.count),
        backgroundColor: '#6366f1',
        borderRadius: 4,
        maxBarThickness: 32
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false } }
      },
      animation: { duration: 600 }
    }
  }));
}

// --- Per-automation performance table ---
function renderAutomationPerfTable(automations) {
  const el = document.getElementById('automations-perf-list');
  if (!el) return;

  if (!automations || automations.length === 0) {
    el.innerHTML = `
      <div style="padding:16px;text-align:center;">
        <p class="text-muted">No automations yet.</p>
        <p class="text-muted text-sm">Publish a post to Facebook or Instagram, then click the "DM Automation" button on the post card.</p>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left;">
            <th style="padding:8px;">Name</th>
            <th style="padding:8px;">Platform</th>
            <th style="padding:8px;">Keywords</th>
            <th style="padding:8px;">Type</th>
            <th style="padding:8px;">Convos</th>
            <th style="padding:8px;">Completed</th>
            <th style="padding:8px;">Expired</th>
            <th style="padding:8px;">Opt-outs</th>
            <th style="padding:8px;">Conv. Rate</th>
            <th style="padding:8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${automations.map(a => {
            const rateColor = a.conversion_rate >= 50 ? 'var(--success)' : a.conversion_rate >= 25 ? '#e67e22' : 'var(--danger)';
            return `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px;">${escapeHtml(a.name)}</td>
                <td style="padding:8px;">
                  <span class="platform-chip platform-chip-${a.platform}">${a.platform}</span>
                </td>
                <td style="padding:8px;">
                  ${a.keywords.map(k =>
                    `<span class="badge" style="background:var(--primary-light);color:var(--primary);margin:1px;">${escapeHtml(k)}</span>`
                  ).join(' ')}
                </td>
                <td style="padding:8px;">${a.flow_type === 'single' ? 'Single' : 'Multi-step'}</td>
                <td style="padding:8px;font-weight:600;">${a.total}</td>
                <td style="padding:8px;color:var(--success);">${a.completed}</td>
                <td style="padding:8px;color:var(--text-muted);">${a.expired}</td>
                <td style="padding:8px;color:#e67e22;">${a.opted_out}</td>
                <td style="padding:8px;">
                  ${a.total > 0 ? `
                    <div class="rate-gauge">
                      <span class="rate-gauge__pct" style="color:${rateColor};">${a.conversion_rate}%</span>
                      <div class="rate-gauge__bar">
                        <div class="rate-gauge__fill" style="width:${Math.min(100, a.conversion_rate)}%;background:${rateColor};"></div>
                      </div>
                    </div>
                  ` : '—'}
                </td>
                <td style="padding:8px;">
                  <span class="badge badge-${a.active ? 'published' : 'draft'}">
                    ${a.active ? 'Active' : 'Paused'}
                  </span>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// --- Keyword performance (Chart.js horizontal bar) ---
function renderKeywordPerf(keywords) {
  const el = document.getElementById('keyword-perf');
  if (!el) return;

  if (!keywords || keywords.length === 0) {
    el.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;">No keyword data yet.</div>';
    return;
  }
  if (!window.Chart) return;

  el.innerHTML = '<canvas id="keyword-bar"></canvas>';
  registerChart(new Chart(document.getElementById('keyword-bar'), {
    type: 'bar',
    data: {
      labels: keywords.map(k => k.keyword),
      datasets: [
        { label: 'Triggered',  data: keywords.map(k => k.total),     backgroundColor: '#6366f1' },
        { label: 'Completed',  data: keywords.map(k => k.completed), backgroundColor: '#22c55e' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle', font: { size: 12 } } } },
      scales: {
        x: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#f1f5f9' } },
        y: { grid: { display: false } }
      },
      animation: { duration: 600 }
    }
  }));
}

// --- Leads table (uses single /automations/leads endpoint, no N+1) ---
function renderLeadsTableDirect(leads) {
  const tableEl = document.getElementById('leads-table');
  if (!tableEl) return;

  if (!leads || leads.length === 0) {
    tableEl.innerHTML = '<div style="padding:16px;text-align:center;" class="text-muted">No leads collected yet.</div>';
    return;
  }

  tableEl.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left;">
            <th style="padding:8px;">Date</th>
            <th style="padding:8px;">Handle</th>
            <th style="padding:8px;">Platform</th>
            <th style="padding:8px;">Automation</th>
            <th style="padding:8px;">Collected Data</th>
            <th style="padding:8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${leads.map(lead => `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:8px;" class="text-sm">${new Date(lead.created_at).toLocaleDateString()}</td>
              <td style="padding:8px;">@${escapeHtml(lead.author_handle || '?')}</td>
              <td style="padding:8px;">
                <span class="platform-chip platform-chip-${lead.platform}">${escapeHtml(lead.platform)}</span>
              </td>
              <td style="padding:8px;">${escapeHtml(lead.automation_name || '—')}</td>
              <td style="padding:8px;">
                ${(lead.dm_collected_data || []).map(d =>
                  `<span class="field-pill"><span class="field-pill__label">${escapeHtml(d.field_name)}</span><span class="field-pill__value">${escapeHtml(d.field_value)}</span></span>`
                ).join('') || '<span class="text-muted text-sm">—</span>'}
              </td>
              <td style="padding:8px;">
                <span class="badge badge-${lead.status === 'completed' ? 'published' : lead.status === 'active' ? 'scheduled' : 'draft'}">
                  ${lead.status}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Legacy function name kept for backward compatibility with any callers
async function loadLeadsTable() {
  try {
    const res = await apiFetch('/automations/leads');
    renderLeadsTableDirect(res.leads || []);
  } catch (err) {
    const tableEl = document.getElementById('leads-table');
    if (tableEl) tableEl.innerHTML = `<div style="padding:12px;color:var(--danger);">Failed to load leads: ${err.message}</div>`;
  }
}

async function exportLeadsCSV() {
  try {
    const response = await fetch('/automations/leads/export', {
      headers: { Authorization: `Bearer ${App.token}` }
    });

    // Handle tier-limit 429 — response is JSON, not CSV
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      if (body.limit_reached) {
        showUpgradePrompt(body.feature, body.error);
        return;
      }
    }

    if (!response.ok) throw new Error('Export failed');

    const blob = await response.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'leads.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to export: ' + err.message);
  }
}

// ============================================================
// HELP & TUTORIALS VIEW
// ============================================================
function renderHelpView(container) {
  // Help topics — each section is collapsible
  const topics = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      icon: '🚀',
      items: [
        { q: 'What is Social Buster?', a: 'Social Buster is an AI-powered social media marketing platform. It helps you create high-performing posts, schedule them across multiple platforms, and automate comment-to-DM lead capture — all from one dashboard.' },
        { q: 'How do I set up my profile?', a: 'Click <strong>My Profile</strong> in the sidebar. Fill in your brand name, industry, target audience, and geographic region. This information powers the AI — the more detail you provide, the better your generated content will be.' },
        { q: 'Which platforms are supported?', a: 'Currently <strong>Facebook</strong> and <strong>Instagram</strong> are fully connected for publishing. Threads is connected for OAuth. TikTok, LinkedIn, X (Twitter), and YouTube are coming soon.' },
        { q: 'How do I connect a social platform?', a: 'Go to <strong>Settings & Billing</strong> → scroll to <strong>Platform Connections</strong>. Click "Connect" next to the platform you want. You\'ll be redirected to that platform to authorize Social Buster. Once approved, you\'ll see a green "Connected" badge.' }
      ]
    },
    {
      id: 'briefs-generation',
      title: 'Briefs & AI Generation',
      icon: '✏️',
      items: [
        { q: 'What is a brief?', a: 'A brief is your creative input — it tells the AI what kind of post to generate. You pick the platforms, post type (educational, promotional, storytelling, etc.), tone, objective, and provide any specific instructions.' },
        { q: 'How do I create a brief?', a: 'Click <strong>New Brief</strong> in the sidebar. Select your target platforms, pick a post type and tone, add any custom instructions, then click <strong>Generate Posts</strong>. The AI will create tailored content for each platform.' },
        { q: 'Can I edit generated posts?', a: 'Yes! After generation, each post appears in the <strong>Generated Posts</strong> view. Click any post to open the full editor where you can modify the hook, caption, hashtags, CTA, and attached media.' },
        { q: 'What is the Intelligence pre-flight?', a: 'Before generating, the AI checks your performance history, trending topics, and audience data to inform the content. This "pre-flight" step is what makes Social Buster posts more effective than generic AI output.' },
        { q: 'How do I attach media to a post?', a: 'In the post editor, click <strong>Attach Media</strong>. You can pick from your Media Library (uploaded files, Google Drive, or AI-generated images). Media is processed and optimized for each platform automatically.' }
      ]
    },
    {
      id: 'media-library',
      title: 'Media Library',
      icon: '🎬',
      items: [
        { q: 'How do I add media?', a: 'Go to <strong>Media Library</strong> in the sidebar. You can connect Google Drive to scan for media files, or generate AI images directly in the app. All your media is stored and organized in one place.' },
        { q: 'How does Google Drive integration work?', a: 'In Settings, connect your Google Drive account. Social Buster will scan your Drive for images and videos. When you attach a Drive file to a post, it\'s automatically copied to our storage so publishing works reliably.' },
        { q: 'What is AI image generation?', a: 'In the Media Library, click <strong>Generate AI Image</strong>. Describe what you want and the AI will create a custom image. These images are saved to your library and can be attached to any post.' },
        { q: 'How does video clip selection work?', a: 'When you upload a video, Social Buster analyzes it in the background and identifies the best segments. When attaching video to a post, you\'ll see suggested clips with thumbnails — pick the one that fits your content.' }
      ]
    },
    {
      id: 'publishing',
      title: 'Publishing & Scheduling',
      icon: '🗓️',
      items: [
        { q: 'How do I publish a post?', a: 'From <strong>Generated Posts</strong>, approve the posts you want to publish. They\'ll appear in your <strong>Publishing Queue</strong>. You can publish immediately or schedule them for a specific date and time.' },
        { q: 'What does each post status mean?', a: '<strong>Draft</strong> = still editing. <strong>Approved</strong> = ready to publish. <strong>Scheduled</strong> = will publish at the set time. <strong>Publishing</strong> = currently being sent. <strong>Published</strong> = live on the platform. <strong>Failed</strong> = something went wrong (check the error message).' },
        { q: 'What if a post fails to publish?', a: 'Failed posts show an error message explaining what went wrong. Common issues: expired platform token (reconnect in Settings), duplicate content (Facebook rejects identical posts), or missing media. Fix the issue and retry from the queue.' },
        { q: 'Can I publish to multiple platforms at once?', a: 'Yes! When you create a brief, select multiple platforms. The AI generates platform-specific content for each one. When you approve them, each platform version publishes independently.' }
      ]
    },
    {
      id: 'dm-automation',
      title: 'DM Automation & Leads',
      icon: '🤖',
      items: [
        { q: 'What is comment-to-DM automation?', a: 'You set trigger keywords on a published post. When someone comments with one of those keywords, Social Buster automatically sends them a DM with your configured message. This turns commenters into leads.' },
        { q: 'How do I set up an automation?', a: 'Go to <strong>DM Automations</strong> in the sidebar. Click "New Automation", select a published post, add your trigger keywords (e.g., "info", "link", "interested"), write your DM message, and activate it.' },
        { q: 'What are multi-step conversations?', a: 'Instead of a single DM, you can create a conversation flow with multiple steps. Each step asks a question and waits for the user\'s reply before moving to the next. Great for collecting email, phone, or qualifying leads.' },
        { q: 'Where do I see my leads?', a: 'In the <strong>DM Automations</strong> view, click on any automation to see its leads. You can also export all leads as a CSV file for use in your CRM or email marketing tool.' },
        { q: 'Are there DM limits?', a: 'Yes — Meta enforces limits: ~100 DMs/day per Facebook Page and ~80 DMs/day per Instagram account. Social Buster tracks these limits automatically. Also, you can only DM users who interacted with your content within the last 24 hours.' }
      ]
    },
    {
      id: 'intelligence',
      title: 'Intelligence & Analytics',
      icon: '🧠',
      items: [
        { q: 'What is the Intelligence Dashboard?', a: 'It shows AI-powered insights about your content performance: what\'s working, what\'s not, trending topics in your niche, and recommendations for your next posts.' },
        { q: 'What is the main Dashboard?', a: 'The <strong>Dashboard</strong> gives you a quick overview: recent posts, publishing stats, connected platforms, and your account status.' },
        { q: 'How does the AI learn from my data?', a: 'Every time you publish and get engagement data back (likes, comments, shares), Social Buster feeds that into the intelligence engine. Over time, the AI learns what content resonates with your specific audience.' }
      ]
    },
    {
      id: 'settings-billing',
      title: 'Settings & Billing',
      icon: '⚙️',
      items: [
        { q: 'How do I manage my subscription?', a: 'Go to <strong>Settings & Billing</strong>. You\'ll see your current plan and usage. Click "Manage Subscription" to upgrade, downgrade, or update your payment method through our secure Stripe portal.' },
        { q: 'What plans are available?', a: '<strong>Free Trial</strong> — limited features to try the platform. <strong>Starter ($29/mo)</strong> — core features for individual creators. <strong>Professional ($79/mo)</strong> — full feature set with higher limits. <strong>Buster ($199/mo)</strong> — enterprise-grade with priority support and maximum limits.' },
        { q: 'How do I disconnect a platform?', a: 'Go to <strong>Settings & Billing</strong> → Platform Connections. Click "Disconnect" next to the platform. Your existing published posts won\'t be affected, but you won\'t be able to publish new ones until you reconnect.' },
        { q: 'How do I change my password?', a: 'Currently, password changes are handled through the Supabase auth system. Go to the login screen and use "Forgot Password" to reset it via email.' }
      ]
    },
    {
      id: 'troubleshooting',
      title: 'Troubleshooting',
      icon: '🔧',
      items: [
        { q: 'My post published as text-only (no image/video)', a: 'This usually means the media wasn\'t processed before publishing. Make sure your media shows a green "Ready" status in the post editor before approving. If it shows "Processing", wait for it to complete.' },
        { q: 'I got a "token expired" error', a: 'Your platform connection has expired. Go to <strong>Settings & Billing</strong> → Platform Connections and click "Reconnect" for the affected platform. You\'ll re-authorize and get a fresh token.' },
        { q: 'The AI generated content doesn\'t match my brand', a: 'Update your <strong>My Profile</strong> with more specific details: brand voice, industry, target audience, and any style preferences in the custom instructions field. The AI uses all of this to tailor content.' },
        { q: 'Publishing is stuck on "Publishing" status', a: 'If a post stays in "Publishing" for more than 3 minutes, the system will automatically reset it to "Failed" so you can retry. Check the error message for details.' },
        { q: 'I can\'t connect my Instagram account', a: 'Instagram publishing requires a <strong>Business or Creator account</strong> connected to a Facebook Page. Make sure your Instagram is linked to a Facebook Page in Instagram\'s settings, then connect Facebook in Social Buster — Instagram will be available automatically.' },
        { q: 'Google Drive files aren\'t showing up', a: 'After connecting Google Drive, click "Scan Drive" in the Media Library. Only image and video files in supported formats will appear. The scan runs automatically every 30 minutes after the first scan.' }
      ]
    }
  ];

  container.innerHTML = `
    <div class="page-header">
      <div class="page-title">Help & Tutorials</div>
      <p class="text-muted">Everything you need to know about using Social Buster</p>
    </div>

    <!-- Search -->
    <div class="form-group" style="max-width:500px; margin-bottom:24px;">
      <input type="text" id="help-search" class="form-input" placeholder="Search help topics..." oninput="filterHelpTopics(this.value)">
    </div>

    <!-- Video tutorials section -->
    <div class="card" style="margin-bottom:24px; border-left:4px solid var(--primary);">
      <div style="display:flex; align-items:center; gap:12px;">
        <span style="font-size:24px;">🎥</span>
        <div>
          <strong>Video Tutorials</strong>
          <p class="text-muted" style="margin:4px 0 0;">Video walkthroughs are coming soon. We'll cover platform setup, brief creation, DM automation, and more.</p>
        </div>
      </div>
    </div>

    <!-- Help topics -->
    <div id="help-topics">
      ${topics.map(section => `
        <div class="help-section card" data-section="${section.id}" style="margin-bottom:16px;">
          <div class="help-section-header" onclick="toggleHelpSection('${section.id}')" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; padding:4px 0;">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="font-size:20px;">${section.icon}</span>
              <strong style="font-size:16px;">${section.title}</strong>
              <span class="text-muted text-sm">(${section.items.length})</span>
            </div>
            <span class="help-chevron" id="chevron-${section.id}" style="transition:transform 0.2s; font-size:12px; color:var(--text-secondary);">▶</span>
          </div>
          <div class="help-section-body" id="body-${section.id}" style="display:none; margin-top:12px;">
            ${section.items.map((item, i) => `
              <div class="help-item" style="padding:12px 0; ${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
                <div class="help-question" style="font-weight:600; margin-bottom:6px; color:var(--text-primary);">${item.q}</div>
                <div class="help-answer text-muted" style="line-height:1.6;">${item.a}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>

    <!-- No results message (hidden by default) -->
    <div id="help-no-results" style="display:none; text-align:center; padding:40px; color:var(--text-secondary);">
      <span style="font-size:32px;">🔍</span>
      <p style="margin-top:12px;">No help topics match your search. Try different keywords.</p>
    </div>

    <!-- Contact support -->
    <div class="card" style="margin-top:8px; text-align:center; padding:24px;">
      <strong>Still need help?</strong>
      <p class="text-muted" style="margin:8px 0 0;">Send us a message from the <a href="#messages" onclick="navigate('messages')" style="color:var(--primary); text-decoration:underline;">Messages</a> page and we'll get back to you.</p>
    </div>
  `;
}

// Toggle a help section open/closed
function toggleHelpSection(sectionId) {
  const body    = document.getElementById('body-' + sectionId);
  const chevron = document.getElementById('chevron-' + sectionId);
  if (!body) return;

  const isOpen = body.style.display !== 'none';
  body.style.display    = isOpen ? 'none' : 'block';
  chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
}

// Filter help topics by search query
function filterHelpTopics(query) {
  const q = query.toLowerCase().trim();
  const sections = document.querySelectorAll('.help-section');
  let anyVisible = false;

  sections.forEach(section => {
    const items = section.querySelectorAll('.help-item');
    let sectionHasMatch = false;

    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      const match = !q || text.includes(q);
      item.style.display = match ? '' : 'none';
      if (match) sectionHasMatch = true;
    });

    section.style.display = sectionHasMatch ? '' : 'none';
    if (sectionHasMatch) anyVisible = true;

    // Auto-expand sections that have matches when searching
    if (q && sectionHasMatch) {
      const sectionId = section.dataset.section;
      const body = document.getElementById('body-' + sectionId);
      const chevron = document.getElementById('chevron-' + sectionId);
      if (body) body.style.display = 'block';
      if (chevron) chevron.style.transform = 'rotate(90deg)';
    }
  });

  const noResults = document.getElementById('help-no-results');
  if (noResults) noResults.style.display = anyVisible ? 'none' : 'block';
}

// ============================================================
// checkAppVersion — platform-wide stale JS detection.
// Runs after every successful login / page load for all users.
// Fetches GET /app-version (public, no auth) and compares the
// server's expected version to this file's APP_VERSION constant.
// If they don't match, shows a non-blocking yellow banner at the
// top of the main content area prompting the user to refresh.
// ============================================================
async function checkAppVersion() {
  try {
    const res = await fetch('/app-version');
    if (!res.ok) return; // Non-critical — fail silently
    const { version } = await res.json();

    if (version === APP_VERSION) return; // All good

    // Already showing a banner? Don't stack duplicates.
    if (document.getElementById('app-version-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'app-version-banner';
    banner.style.cssText = `
      background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px;
      padding: 10px 16px; margin: 0 0 16px 0;
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; font-size: 13px; color: #92400e;
    `;
    banner.innerHTML = `
      <span>🔄 <strong>A new version of Social Buster is available.</strong> Refresh to get the latest features and fixes.</span>
      <button onclick="location.reload(true)" style="
        background:#f59e0b; color:#fff; border:none; border-radius:6px;
        padding:6px 14px; font-size:12px; font-weight:600; cursor:pointer; flex-shrink:0;
      ">Refresh Now</button>
    `;

    // Prepend to the main content area so it appears above whatever view is loaded
    const content = document.getElementById('main-content-area');
    if (content) content.insertBefore(banner, content.firstChild);

  } catch (_) {
    // Version check is non-critical — never crash the app over this
  }
}

// ============================================================
// RENDER AFFILIATE VIEW
// Only accessible to Legacy members (plan === 'legacy').
// Shows: referral link, earnings summary, referral list,
// payout history, Stripe Connect status.
// ============================================================
async function renderAffiliateView(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">💎 Affiliate Program</div>
      <p style="color:var(--text-secondary);">Share your referral link, earn commissions on every referred subscriber.</p>
    </div>
    <div id="affiliate-content">
      <div class="loading-overlay" style="min-height:200px;"><div class="spinner"></div></div>
    </div>
  `;

  try {
    const data = await apiFetch('/affiliate/dashboard');

    if (data.suspended) {
      document.getElementById('affiliate-content').innerHTML = `
        <div class="card" style="border-left:4px solid #ef4444;padding:20px;">
          <strong style="color:#ef4444;">⚠️ Affiliate Account Suspended</strong>
          <p style="margin:8px 0 0;">${data.suspendedReason || 'Your affiliate account has been suspended. Please contact support.'}</p>
        </div>
      `;
      return;
    }

    // Format currency cents → dollars
    const fmt = (cents) => '$' + (cents / 100).toFixed(2);

    // Commission tier badge color
    const tierColor = data.activeReferrals >= 11 ? '#f59e0b' : data.activeReferrals >= 6 ? '#6366f1' : '#10b981';

    document.getElementById('affiliate-content').innerHTML = `

      <!-- ---- Referral Link ---- -->
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin:0 0 12px;">Your Referral Link</h3>
        ${data.referralLink ? `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="ref-link-input" type="text" readonly value="${data.referralLink}"
              style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);font-size:14px;">
            <button onclick="
              document.getElementById('ref-link-input').select();
              document.execCommand('copy');
              showToast('Referral link copied!', 'success');
            " style="padding:8px 16px;background:var(--primary,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
              Copy Link
            </button>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin:8px 0 0;">
            ${data.clickCount.toLocaleString()} click${data.clickCount !== 1 ? 's' : ''} total
            ${data.isCustomSlug ? '· Custom slug' : '· Auto-generated slug'}
          </p>
        ` : `<p style="color:var(--text-secondary);">Your referral link is being generated...</p>`}

        ${!data.isCustomSlug ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;">Set a custom slug (one-time, permanent)</p>
            <div style="display:flex;gap:8px;">
              <input id="slug-input" type="text" placeholder="your-brand-name"
                maxlength="40"
                style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;">
              <button onclick="affiliateSetSlug()" style="padding:8px 16px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
                Set Slug
              </button>
            </div>
            <p style="font-size:11px;color:var(--text-secondary);margin:6px 0 0;">
              3–40 characters, letters/numbers/hyphens only. Cannot be changed after setting.
            </p>
          </div>
        ` : ''}
      </div>

      <!-- ---- Stats Row ---- -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:20px;">
        <div class="card" style="text-align:center;padding:16px;">
          <div style="font-size:28px;font-weight:700;color:${tierColor};">${data.activeReferrals}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Active Referrals</div>
          <div style="font-size:11px;color:${tierColor};margin-top:4px;font-weight:600;">${data.tierLabel}</div>
        </div>
        <div class="card" style="text-align:center;padding:16px;">
          <div style="font-size:28px;font-weight:700;color:#f59e0b;">${Math.round(data.commissionRate * 100)}%</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Commission Rate</div>
        </div>
        <div class="card" style="text-align:center;padding:16px;">
          <div style="font-size:28px;font-weight:700;color:#10b981;">${fmt(data.eligibleEarnings)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Eligible (Next Payout)</div>
        </div>
        <div class="card" style="text-align:center;padding:16px;">
          <div style="font-size:28px;font-weight:700;">${fmt(data.lifetimeEarnings)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Lifetime Earned</div>
        </div>
      </div>

      <!-- ---- Stripe Connect ---- -->
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin:0 0 12px;">Payout Account (Stripe Connect)</h3>
        ${data.connectOnboarded ? `
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="color:#10b981;font-size:20px;">✓</span>
            <div>
              <div style="font-weight:600;">Connected & ready</div>
              <div style="font-size:12px;color:var(--text-secondary);">Payouts are sent on the 5th of each month (min $50).</div>
            </div>
          </div>
        ` : `
          <p style="color:var(--text-secondary);margin:0 0 12px;font-size:14px;">
            Connect your bank account via Stripe to receive monthly payouts. Required before any payout can be sent.
          </p>
          <button onclick="affiliateConnectStripe()" style="padding:10px 20px;background:#6366f1;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;">
            Connect Stripe Account
          </button>
        `}
      </div>

      <!-- ---- Tabs: Earnings / Referrals / Payouts ---- -->
      <div class="card">
        <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:16px;">
          <button id="aff-tab-earnings" onclick="affiliateTab('earnings')"
            style="padding:10px 20px;border:none;background:none;cursor:pointer;font-weight:600;border-bottom:2px solid var(--primary,#6366f1);color:var(--primary,#6366f1);">
            Earnings
          </button>
          <button id="aff-tab-referrals" onclick="affiliateTab('referrals')"
            style="padding:10px 20px;border:none;background:none;cursor:pointer;color:var(--text-secondary);">
            Referrals
          </button>
          <button id="aff-tab-payouts" onclick="affiliateTab('payouts')"
            style="padding:10px 20px;border:none;background:none;cursor:pointer;color:var(--text-secondary);">
            Payouts
          </button>
        </div>
        <div id="aff-tab-content">
          <!-- Loaded by affiliateTab() -->
          <div class="loading-overlay" style="min-height:100px;"><div class="spinner"></div></div>
        </div>
      </div>

      <!-- ---- How It Works ---- -->
      <div class="card" style="margin-top:20px;background:var(--bg-secondary);">
        <h3 style="margin:0 0 12px;">How Commissions Work</h3>
        <ul style="margin:0;padding-left:20px;line-height:1.8;font-size:14px;color:var(--text-secondary);">
          <li>Earn <strong>15%</strong> on 1–5 active referrals · <strong>20%</strong> on 6–10 · <strong>25%</strong> on 11+</li>
          <li>An "active referral" is someone who paid an invoice in the last 35 days</li>
          <li>Commissions become eligible to pay out 30 days after the invoice date</li>
          <li>Payouts run on the 5th of each month · minimum $50</li>
          <li>10% is held in reserve for 60 days in case of chargebacks, then released</li>
          <li>No commissions are earned on your own Legacy membership fee</li>
        </ul>
      </div>
    `;

    // Auto-load earnings tab
    affiliateTab('earnings');

  } catch (err) {
    console.error('[Affiliate] Dashboard load error:', err);
    document.getElementById('affiliate-content').innerHTML = `
      <div class="card" style="color:#ef4444;">Failed to load affiliate dashboard. Please refresh.</div>
    `;
  }
}

// ----------------------------------------------------------------
// Affiliate tab switcher — loads Earnings, Referrals, or Payouts
// ----------------------------------------------------------------
async function affiliateTab(tab) {
  // Update tab button styles
  ['earnings', 'referrals', 'payouts'].forEach(t => {
    const btn = document.getElementById(`aff-tab-${t}`);
    if (!btn) return;
    if (t === tab) {
      btn.style.borderBottom = '2px solid var(--primary,#6366f1)';
      btn.style.color = 'var(--primary,#6366f1)';
    } else {
      btn.style.borderBottom = '2px solid transparent';
      btn.style.color = 'var(--text-secondary)';
    }
  });

  const content = document.getElementById('aff-tab-content');
  if (!content) return;

  content.innerHTML = '<div class="loading-overlay" style="min-height:100px;"><div class="spinner"></div></div>';

  try {
    const fmt = (cents) => '$' + (cents / 100).toFixed(2);

    if (tab === 'earnings') {
      const data = await apiFetch('/affiliate/earnings?limit=25');
      if (!data.earnings.length) {
        content.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No earnings yet. Share your referral link to get started.</p>';
        return;
      }
      content.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--text-secondary);">
              <th style="text-align:left;padding:8px 4px;">Month</th>
              <th style="text-align:left;padding:8px 4px;">Plan</th>
              <th style="text-align:right;padding:8px 4px;">Invoice</th>
              <th style="text-align:right;padding:8px 4px;">Commission</th>
              <th style="text-align:left;padding:8px 4px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${data.earnings.map(e => `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 4px;">${e.period_month}</td>
                <td style="padding:8px 4px;text-transform:capitalize;">${e.referred_plan_at_time || '—'}</td>
                <td style="padding:8px 4px;text-align:right;">${fmt(e.invoice_amount)}</td>
                <td style="padding:8px 4px;text-align:right;color:#10b981;font-weight:600;">${fmt(e.commission_amount)}</td>
                <td style="padding:8px 4px;">
                  <span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;
                    background:${e.status === 'paid' ? '#d1fae5' : e.status === 'eligible' ? '#dbeafe' : e.status === 'clawed_back' ? '#fee2e2' : '#fef3c7'};
                    color:${e.status === 'paid' ? '#065f46' : e.status === 'eligible' ? '#1e40af' : e.status === 'clawed_back' ? '#991b1b' : '#92400e'};">
                    ${e.status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

    } else if (tab === 'referrals') {
      const data = await apiFetch('/affiliate/referrals?limit=25');
      if (!data.referrals.length) {
        content.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No referrals yet. Share your link to start earning.</p>';
        return;
      }
      content.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--text-secondary);">
              <th style="text-align:left;padding:8px 4px;">Signed Up</th>
              <th style="text-align:left;padding:8px 4px;">Plan</th>
              <th style="text-align:left;padding:8px 4px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${data.referrals.map(r => `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 4px;">${new Date(r.created_at).toLocaleDateString()}</td>
                <td style="padding:8px 4px;text-transform:capitalize;">${r.current_plan}</td>
                <td style="padding:8px 4px;">
                  <span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;
                    background:${r.status === 'active' ? '#d1fae5' : r.status === 'cancelled' ? '#fee2e2' : '#fef3c7'};
                    color:${r.status === 'active' ? '#065f46' : r.status === 'cancelled' ? '#991b1b' : '#92400e'};">
                    ${r.status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

    } else if (tab === 'payouts') {
      const data = await apiFetch('/affiliate/payouts?limit=25');
      if (!data.payouts.length) {
        content.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No payouts yet. Payouts run on the 5th of each month (min $50 eligible).</p>';
        return;
      }
      content.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--text-secondary);">
              <th style="text-align:left;padding:8px 4px;">Period</th>
              <th style="text-align:right;padding:8px 4px;">Gross</th>
              <th style="text-align:right;padding:8px 4px;">Deductions</th>
              <th style="text-align:right;padding:8px 4px;">Net Paid</th>
              <th style="text-align:left;padding:8px 4px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${data.payouts.map(p => `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 4px;">${p.period_month}</td>
                <td style="padding:8px 4px;text-align:right;">${fmt(p.gross_amount)}</td>
                <td style="padding:8px 4px;text-align:right;color:#ef4444;">
                  -${fmt((p.clawbacks_deducted || 0) + (p.reserve_withheld || 0) + (p.stripe_fees || 0))}
                </td>
                <td style="padding:8px 4px;text-align:right;font-weight:600;color:#10b981;">${fmt(p.net_amount)}</td>
                <td style="padding:8px 4px;">
                  <span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;
                    background:${p.status === 'paid' ? '#d1fae5' : p.status === 'failed' ? '#fee2e2' : p.status === 'held' ? '#fef3c7' : '#f3f4f6'};
                    color:${p.status === 'paid' ? '#065f46' : p.status === 'failed' ? '#991b1b' : p.status === 'held' ? '#92400e' : '#374151'};">
                    ${p.status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

  } catch (err) {
    content.innerHTML = `<p style="color:#ef4444;padding:16px;">Failed to load ${tab}. Please refresh.</p>`;
  }
}

// ----------------------------------------------------------------
// Set custom referral slug — one-time, permanent
// ----------------------------------------------------------------
async function affiliateSetSlug() {
  const input = document.getElementById('slug-input');
  if (!input) return;

  const slug = input.value.trim().toLowerCase();

  if (!slug || slug.length < 3) {
    showToast('Slug must be at least 3 characters.', 'error');
    return;
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    showToast('Only lowercase letters, numbers, and hyphens allowed.', 'error');
    return;
  }

  try {
    await apiFetch('/affiliate/slug', { method: 'POST', body: JSON.stringify({ slug }) });
    showToast('Custom slug set! Reloading...', 'success');
    setTimeout(() => navigate('affiliate'), 1200);
  } catch (err) {
    showToast(err.message || 'Failed to set slug.', 'error');
  }
}

// ----------------------------------------------------------------
// Start Stripe Connect onboarding — redirects to Stripe
// ----------------------------------------------------------------
async function affiliateConnectStripe() {
  try {
    const data = await apiFetch('/affiliate/connect', { method: 'POST' });
    if (data.url) {
      window.location.href = data.url;
    }
  } catch (err) {
    showToast(err.message || 'Failed to start Stripe Connect.', 'error');
  }
}

// Start the app when the DOM is ready
document.addEventListener('DOMContentLoaded', boot);
