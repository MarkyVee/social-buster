/**
 * publish.js
 *
 * Handles the Schedule and Publish Now actions on post cards.
 *
 * Entry points (called from buttons injected by preview.js):
 *   - toggleInlineSchedule(postId)  — shows/hides the date picker on the card
 *   - submitInlineSchedule(postId)  — reads the date, calls POST /posts/:id/schedule
 *   - handlePublishNow(postId)      — schedules for right now, polls until published
 *
 * Supporting helpers:
 *   - showPublishingSpinner(postId) — overlays a "Publishing…" indicator on the card
 *   - removePublishingSpinner(postId)
 *   - pollPublishStatus(postId)     — polls GET /posts/:id every 5s until done
 */

// ----------------------------------------------------------------
// toggleInlineSchedule
// Shows or hides the date/time picker row on the post card.
// Called by the "🗓️ Schedule" button.
// ----------------------------------------------------------------
function toggleInlineSchedule(postId) {
  const form = document.getElementById(`inline-schedule-${postId}`);
  if (!form) return;

  const isVisible = form.style.display !== 'none';

  if (isVisible) {
    // Hide the form
    form.style.display = 'none';
  } else {
    // Set the minimum allowed time to 5 minutes from now
    const minDate    = new Date(Date.now() + 5 * 60 * 1000);
    const minDateStr = minDate.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const input      = document.getElementById(`inline-schedule-dt-${postId}`);
    if (input) input.min = minDateStr;

    form.style.display = 'block';
    input?.focus();
  }
}

// ----------------------------------------------------------------
// submitInlineSchedule
// Reads the date/time input and calls POST /posts/:id/schedule.
// Saves any unsaved edits on the card first.
// ----------------------------------------------------------------
async function submitInlineSchedule(postId) {
  const input = document.getElementById(`inline-schedule-dt-${postId}`);
  const card  = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);

  if (!input?.value) {
    alert('Please pick a date and time first.');
    return;
  }

  // Disable the confirm button while we work
  const confirmBtn = input.closest('.inline-schedule-row')?.querySelector('.btn-primary');
  if (confirmBtn) {
    confirmBtn.disabled     = true;
    confirmBtn.textContent  = 'Scheduling…';
  }

  try {
    // Save any unsaved edits before scheduling
    if (card?.dataset.dirty === 'true') {
      await savePostEdits(postId);
    }

    // Convert the local datetime to a UTC ISO string
    const scheduledAt = new Date(input.value).toISOString();

    await apiFetch(`/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: scheduledAt })
    });

    // Hide the schedule form
    const form = document.getElementById(`inline-schedule-${postId}`);
    if (form) form.style.display = 'none';

    // Update the status badge on the card
    const badge = document.getElementById(`status-badge-${postId}`);
    if (badge) {
      badge.className   = 'badge badge-scheduled';
      badge.textContent = 'scheduled';
    }

    // Disable the action buttons — post is now locked in the queue
    lockPostCard(postId, 'scheduled');

    // Show a confirmation message
    const readableDate = new Date(scheduledAt).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    if (typeof showAlert === 'function') {
      showAlert('posts-alerts', `Scheduled for ${readableDate} — go to Queue to manage it.`, 'success');
    }

  } catch (err) {
    if (confirmBtn) {
      confirmBtn.disabled    = false;
      confirmBtn.textContent = 'Confirm';
    }
    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else {
      alert(`Scheduling failed: ${err.message}`);
    }
  }
}

// ----------------------------------------------------------------
// handlePublishNow
// Saves unsaved edits, then schedules the post for right now.
// The publishing worker picks it up within 60 seconds.
// Shows a spinner on the card and polls until published or failed.
// ----------------------------------------------------------------
async function handlePublishNow(postId) {
  const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const publishBtn = card?.querySelector('.publish-now-btn');

  if (publishBtn) {
    publishBtn.disabled    = true;
    publishBtn.textContent = 'Publishing…';
  }

  try {
    // Save any unsaved edits before publishing
    if (card?.dataset.dirty === 'true') {
      await savePostEdits(postId);
    }

    // Schedule for right now — the worker will pick it up within 60 seconds
    await apiFetch(`/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: new Date().toISOString() })
    });

    // Show a spinning indicator on the card
    showPublishingSpinner(postId);

    if (typeof showAlert === 'function') {
      showAlert('posts-alerts', 'Post queued — publishing within 60 seconds…', 'success');
    }

    // Poll every 5s until the worker marks it published or failed
    pollPublishStatus(postId);

  } catch (err) {
    if (publishBtn) {
      publishBtn.disabled    = false;
      publishBtn.textContent = '🚀 Publish Now';
    }
    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else if (typeof showAlert === 'function') {
      showAlert('posts-alerts', `Publish failed: ${err.message}`, 'error');
    }
  }
}

// ----------------------------------------------------------------
// lockPostCard
// Disables the action buttons after a post is scheduled or publishing,
// so the user can't accidentally click them again.
// ----------------------------------------------------------------
function lockPostCard(postId, reason) {
  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  if (!card) return;

  const scheduleBtn = card.querySelector('.schedule-post-btn');
  const publishBtn  = card.querySelector('.publish-now-btn');
  const saveBtn     = card.querySelector('.save-post-btn');

  if (reason === 'scheduled') {
    if (scheduleBtn) { scheduleBtn.disabled = true; scheduleBtn.textContent = '✓ Scheduled'; }
    if (publishBtn)  { publishBtn.disabled  = true; }
    if (saveBtn)     { saveBtn.disabled     = true; }
  }
}

// ----------------------------------------------------------------
// showPublishingSpinner
// Overlays a small "Publishing…" label on the card's status row
// so the user sees something is happening.
// ----------------------------------------------------------------
function showPublishingSpinner(postId) {
  const badge = document.getElementById(`status-badge-${postId}`);
  if (badge) {
    badge.className   = 'badge badge-scheduled';
    badge.textContent = 'publishing…';
  }

  const statusRow = badge?.closest('.post-card-status');
  if (statusRow && !statusRow.querySelector('.publish-status-spinner')) {
    const spinner = document.createElement('div');
    spinner.className = 'publish-status-spinner';
    spinner.innerHTML = `
      <span class="publish-spinner-dot"></span>
      <span class="publish-spinner-label">Publishing to platform…</span>
    `;
    statusRow.appendChild(spinner);
  }

  // Lock all action buttons while publishing
  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  card?.querySelectorAll('.post-card-actions button').forEach(btn => {
    btn.disabled = true;
  });
}

// ----------------------------------------------------------------
// removePublishingSpinner
// Removes the spinner added by showPublishingSpinner.
// ----------------------------------------------------------------
function removePublishingSpinner(postId) {
  const badge     = document.getElementById(`status-badge-${postId}`);
  const statusRow = badge?.closest('.post-card-status');
  statusRow?.querySelector('.publish-status-spinner')?.remove();
}

// ----------------------------------------------------------------
// pollPublishStatus
// Polls GET /posts/:id every 5 seconds for up to 3 minutes.
// Stops when the status becomes 'published' or 'failed'.
// ----------------------------------------------------------------
function pollPublishStatus(postId) {
  const POLL_INTERVAL_MS = 5000;  // 5 seconds between checks
  const MAX_POLLS        = 36;    // 36 × 5s = 3 minutes max
  let   polls            = 0;

  const interval = setInterval(async () => {
    polls++;

    try {
      const data   = await apiFetch(`/posts/${postId}`);
      const status = data?.post?.status;

      if (status === 'published') {
        clearInterval(interval);
        removePublishingSpinner(postId);

        const badge = document.getElementById(`status-badge-${postId}`);
        if (badge) {
          badge.className   = 'badge badge-published';
          badge.textContent = 'published';
        }

        const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
        card?.querySelectorAll('.post-card-actions button').forEach(btn => {
          btn.disabled    = true;
          btn.textContent = '✓ Published';
        });

        if (typeof showAlert === 'function') {
          showAlert('posts-alerts', '🎉 Post published successfully!', 'success');
        }

      } else if (status === 'failed') {
        clearInterval(interval);
        removePublishingSpinner(postId);

        const badge = document.getElementById(`status-badge-${postId}`);
        if (badge) {
          badge.className   = 'badge badge-failed';
          badge.textContent = 'failed';
        }

        // Re-enable Publish Now so the user can retry
        const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
        const publishBtn = card?.querySelector('.publish-now-btn');
        if (publishBtn) {
          publishBtn.disabled    = false;
          publishBtn.textContent = '🚀 Publish Now';
        }

        const errMsg = data?.post?.error_message || 'Unknown error';
        if (typeof showAlert === 'function') {
          showAlert('posts-alerts', `Publish failed: ${errMsg}`, 'error');
        }

      } else if (polls >= MAX_POLLS) {
        clearInterval(interval);
        removePublishingSpinner(postId);

        const badge = document.getElementById(`status-badge-${postId}`);
        if (badge) {
          badge.className   = 'badge badge-scheduled';
          badge.textContent = 'pending';
        }

        if (typeof showAlert === 'function') {
          showAlert('posts-alerts', 'Still publishing — check the Queue tab for status.', 'info');
        }
      }

    } catch (err) {
      // Network hiccup — keep polling, don't bail on a single failure
      console.warn(`[publishStatus] Poll ${polls} failed for post ${postId}:`, err.message);
    }

  }, POLL_INTERVAL_MS);
}
