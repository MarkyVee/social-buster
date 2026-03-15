/**
 * messages.js
 *
 * User-facing inbox for messages from the Social Buster team.
 *
 * Three views within the messages page:
 *   list    — inbox or sent tab, showing all messages
 *   thread  — full message + replies + reply form
 *   compose — new message to admin
 *
 * Called from app.js renderView('messages').
 * Uses apiFetch() and showAlert() defined in app.js.
 */

// ----------------------------------------------------------------
// renderMessagesView — entry point called by app.js renderView()
// ----------------------------------------------------------------
function renderMessagesView(el) {
  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Messages</div>
        <div class="page-subtitle">Messages from the Social Buster team, and your support requests.</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="showMsgCompose()">✉️ New Message</button>
    </div>

    <!-- Inbox / Sent tabs -->
    <div style="display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid #e2e8f0;padding-bottom:0;">
      <button id="msg-tab-inbox" class="msg-tab active" onclick="switchMsgTab('inbox')">Inbox</button>
      <button id="msg-tab-sent"  class="msg-tab"        onclick="switchMsgTab('sent')">Sent</button>
    </div>

    <!-- Message list, thread, and compose panels — only one shown at a time -->
    <div id="msg-list-panel"></div>
    <div id="msg-thread-panel"  class="hidden"></div>
    <div id="msg-compose-panel" class="hidden"></div>
  `;

  injectMsgStyles();
  loadMsgInbox();
}

// ----------------------------------------------------------------
// switchMsgTab — swap between inbox and sent
// ----------------------------------------------------------------
function switchMsgTab(tab) {
  document.getElementById('msg-tab-inbox')?.classList.toggle('active', tab === 'inbox');
  document.getElementById('msg-tab-sent')?.classList.toggle('active', tab === 'sent');

  // Always go back to the list panel when switching tabs
  document.getElementById('msg-thread-panel')?.classList.add('hidden');
  document.getElementById('msg-compose-panel')?.classList.add('hidden');
  document.getElementById('msg-list-panel')?.classList.remove('hidden');

  if (tab === 'inbox') loadMsgInbox();
  else                 loadMsgSent();
}

// ================================================================
// LIST VIEWS
// ================================================================

async function loadMsgInbox() {
  const el = document.getElementById('msg-list-panel');
  if (!el) return;
  el.innerHTML = msgSpinner();

  try {
    const { messages } = await apiFetch('/messages?type=inbox');
    el.innerHTML = buildMsgListHtml(messages, 'inbox');

    // Keep sidebar badge in sync
    const unread = messages.filter(m => !m.read_at && !m.is_broadcast).length;
    updateMsgSidebarBadge(unread);

  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

async function loadMsgSent() {
  const el = document.getElementById('msg-list-panel');
  if (!el) return;
  el.innerHTML = msgSpinner();

  try {
    const { messages } = await apiFetch('/messages?type=sent');
    el.innerHTML = buildMsgListHtml(messages, 'sent');
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

function buildMsgListHtml(messages, type) {
  if (!messages.length) {
    const emptyText = type === 'sent'
      ? 'No messages sent yet. Use "New Message" to contact the support team.'
      : 'No messages yet. The Social Buster team will reach out here.';
    return `
      <div class="card" style="text-align:center;padding:48px 20px;">
        <div style="font-size:36px;margin-bottom:10px;">💬</div>
        <div class="text-muted text-sm">${emptyText}</div>
      </div>`;
  }

  return messages.map(m => {
    const isUnread = !m.read_at && !m.is_broadcast && type === 'inbox';
    const date     = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const preview  = (m.body || '').replace(/\n/g, ' ').slice(0, 100);

    return `
      <div class="msg-row ${isUnread ? 'msg-unread' : ''}" onclick="loadMsgThread('${m.id}', '${type}')">
        <div class="msg-row-left">
          ${m.is_broadcast ? '<span class="msg-broadcast-badge">📢 Broadcast</span>' : ''}
          <div class="msg-subject">${escapeHtml(m.subject)}</div>
          <div class="msg-preview">${escapeHtml(preview)}${(m.body || '').length > 100 ? '…' : ''}</div>
        </div>
        <div class="msg-row-right">
          <div class="msg-date">${date}</div>
          ${isUnread ? '<div class="msg-unread-dot"></div>' : ''}
        </div>
      </div>`;
  }).join('');
}

// ================================================================
// THREAD VIEW
// ================================================================

async function loadMsgThread(messageId, returnTab) {
  const listEl   = document.getElementById('msg-list-panel');
  const threadEl = document.getElementById('msg-thread-panel');
  if (!threadEl) return;

  listEl?.classList.add('hidden');
  document.getElementById('msg-compose-panel')?.classList.add('hidden');
  threadEl.classList.remove('hidden');
  threadEl.innerHTML = msgSpinner();

  try {
    const { message, replies } = await apiFetch(`/messages/${messageId}`);
    threadEl.innerHTML = buildThreadHtml(message, replies, returnTab);

    // Update badge now that this message is read
    refreshMsgUnreadBadge();

  } catch (err) {
    threadEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

function buildThreadHtml(message, replies, returnTab) {
  const allMsgs = [message, ...replies];

  const bubblesHtml = allMsgs.map(m => {
    const isUser = m.sender_type === 'user';
    const mDate  = new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-admin'}">
        <div class="msg-bubble-meta">
          <strong>${isUser ? 'You' : 'Social Buster Team'}</strong>
          <span>${mDate}</span>
        </div>
        <div class="msg-bubble-body">${escapeHtml(m.body).replace(/\n/g, '<br>')}</div>
      </div>`;
  }).join('');

  return `
    <div class="msg-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <button class="btn btn-sm btn-ghost" onclick="closeMsgThread('${returnTab}')">← Back</button>
        <div style="font-size:15px;font-weight:700;flex:1;text-align:center;padding:0 12px;">${escapeHtml(message.subject)}</div>
        <div style="width:72px;"></div>
      </div>

      <div class="msg-bubbles">${bubblesHtml}</div>

      <!-- Reply form -->
      <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-top:4px;">
        <textarea id="msg-reply-body" class="msg-textarea" rows="3" placeholder="Write your reply…"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;align-items:center;">
          <span id="msg-reply-status" class="text-muted text-sm"></span>
          <button class="btn btn-primary btn-sm" onclick="sendMsgReply('${message.id}', '${returnTab}')">Send Reply</button>
        </div>
      </div>
    </div>`;
}

function closeMsgThread(returnTab) {
  document.getElementById('msg-thread-panel')?.classList.add('hidden');
  document.getElementById('msg-list-panel')?.classList.remove('hidden');
  if (returnTab === 'sent') loadMsgSent();
  else                      loadMsgInbox();
}

async function sendMsgReply(parentId, returnTab) {
  const bodyEl   = document.getElementById('msg-reply-body');
  const statusEl = document.getElementById('msg-reply-status');
  const body     = bodyEl?.value?.trim();

  if (!body) return;
  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    await apiFetch(`/messages/${parentId}/reply`, {
      method: 'POST',
      body:   JSON.stringify({ body })
    });
    // Reload thread to show the new reply
    await loadMsgThread(parentId, returnTab);
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ ${err.message}`;
  }
}

// ================================================================
// COMPOSE VIEW
// ================================================================

function showMsgCompose() {
  document.getElementById('msg-list-panel')?.classList.add('hidden');
  document.getElementById('msg-thread-panel')?.classList.add('hidden');

  const el = document.getElementById('msg-compose-panel');
  if (!el) return;
  el.classList.remove('hidden');

  el.innerHTML = `
    <div class="msg-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <button class="btn btn-sm btn-ghost" onclick="closeMsgCompose()">← Back</button>
        <div style="font-size:15px;font-weight:700;">New Message to Support</div>
        <div style="width:72px;"></div>
      </div>

      <div id="msg-compose-alerts"></div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px;">Subject</label>
        <input type="text" id="msg-compose-subject" class="msg-input" placeholder="What's this about?" maxlength="255" />
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px;">Message</label>
        <textarea id="msg-compose-body" class="msg-textarea" rows="5" placeholder="Describe your question or issue…"></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;align-items:center;">
        <span id="msg-compose-status" class="text-muted text-sm"></span>
        <button class="btn btn-sm btn-ghost" onclick="closeMsgCompose()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="sendNewMsg()">Send Message</button>
      </div>
    </div>`;
}

function closeMsgCompose() {
  document.getElementById('msg-compose-panel')?.classList.add('hidden');
  document.getElementById('msg-list-panel')?.classList.remove('hidden');
}

async function sendNewMsg() {
  const subject  = document.getElementById('msg-compose-subject')?.value?.trim();
  const body     = document.getElementById('msg-compose-body')?.value?.trim();
  const statusEl = document.getElementById('msg-compose-status');

  if (!subject) { showAlert('msg-compose-alerts', 'Subject is required', 'error'); return; }
  if (!body)    { showAlert('msg-compose-alerts', 'Message body is required', 'error'); return; }

  if (statusEl) statusEl.textContent = 'Sending…';

  try {
    await apiFetch('/messages', {
      method: 'POST',
      body:   JSON.stringify({ subject, body })
    });
    // Show the sent tab so the user sees their message
    switchMsgTab('sent');
  } catch (err) {
    showAlert('msg-compose-alerts', err.message, 'error');
    if (statusEl) statusEl.textContent = '';
  }
}

// ================================================================
// UNREAD BADGE HELPERS
// Called by app.js startUnreadBadgePoller() on a 60-second interval.
// ================================================================

async function refreshMsgUnreadBadge() {
  try {
    const { unread } = await apiFetch('/messages/unread-count');
    updateMsgSidebarBadge(unread);
  } catch (_) {
    // Non-fatal — badge just stays as-is
  }
}

function updateMsgSidebarBadge(count) {
  const badge = document.getElementById('sidebar-msg-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent  = count > 99 ? '99+' : String(count);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ================================================================
// CSS — injected once on first load
// ================================================================

function injectMsgStyles() {
  if (document.getElementById('msg-styles')) return;
  const style = document.createElement('style');
  style.id = 'msg-styles';
  style.textContent = `
    /* Tab bar */
    .msg-tab {
      background: none; border: none; border-bottom: 3px solid transparent;
      padding: 7px 18px; cursor: pointer; font-size: 14px; font-weight: 600;
      color: #64748b; margin-bottom: -2px; transition: color 0.15s, border-color 0.15s;
    }
    .msg-tab.active, .msg-tab:hover { color: #6366f1; border-bottom-color: #6366f1; }

    /* Message list rows */
    .msg-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 16px; background: #fff; border: 1px solid #e2e8f0;
      border-radius: 8px; margin-bottom: 8px; cursor: pointer; gap: 12px;
      transition: background 0.12s;
    }
    .msg-row:hover  { background: #f8fafc; }
    .msg-unread     { border-left: 3px solid #6366f1; background: #fafafe; }
    .msg-row-left   { flex: 1; min-width: 0; }
    .msg-row-right  { flex-shrink: 0; text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .msg-subject    { font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 3px; }
    .msg-preview    { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }
    .msg-date       { font-size: 11px; color: #94a3b8; }
    .msg-unread-dot { width: 8px; height: 8px; border-radius: 50%; background: #6366f1; }
    .msg-broadcast-badge {
      display: inline-block; font-size: 11px; font-weight: 600; color: #7c3aed;
      background: #ede9fe; padding: 1px 7px; border-radius: 10px; margin-bottom: 4px;
    }

    /* Card wrapper for thread and compose */
    .msg-card {
      background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px;
    }

    /* Conversation bubbles */
    .msg-bubbles       { display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px; }
    .msg-bubble        { max-width: 78%; padding: 12px 15px; border-radius: 12px; }
    .msg-bubble-admin  { background: #f1f5f9; align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg-bubble-user   { background: #eef2ff; align-self: flex-end;   border-bottom-right-radius: 4px; }
    .msg-bubble-meta   { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-size: 12px; color: #64748b; }
    .msg-bubble-body   { font-size: 13px; color: #1e293b; line-height: 1.6; }

    /* Textarea and input */
    .msg-textarea {
      width: 100%; box-sizing: border-box; padding: 9px 12px; border: 1px solid #e2e8f0;
      border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical;
      transition: border-color 0.15s;
    }
    .msg-textarea:focus { outline: none; border-color: #6366f1; }
    .msg-input {
      width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #e2e8f0;
      border-radius: 6px; font-size: 13px; transition: border-color 0.15s;
    }
    .msg-input:focus { outline: none; border-color: #6366f1; }

    /* Sidebar unread badge */
    .msg-unread-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; border-radius: 9px; background: #6366f1;
      color: #fff; font-size: 10px; font-weight: 700; padding: 0 4px;
      margin-left: auto; line-height: 1;
    }
  `;
  document.head.appendChild(style);
}

// ----------------------------------------------------------------
// escapeHtml — used in messages.js (avoids collision with other files)
// Same logic as escapeAdminHtml in admin.js.
// ----------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function msgSpinner() {
  return `<div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:#64748b;font-size:14px;"><div class="spinner spinner-sm"></div> Loading…</div>`;
}
