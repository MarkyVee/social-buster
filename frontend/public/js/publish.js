/**
 * publish.js
 *
 * Handles the approve → schedule / publish-now flow.
 *
 * Entry point: showPublishOptions(postId)
 * Called by the Approve button on every post card in preview.js.
 *
 * What it does:
 *   1. Calls POST /posts/:id/approve to mark the post as approved.
 *   2. Shows a modal with two choices:
 *        - "Schedule" → datetime picker → calls POST /posts/:id/schedule
 *        - "Publish Now" → placeholder (real publishing comes in Phase 5)
 *   3. On success, updates the status badge on the post card.
 *   4. Closes the modal and shows a success alert.
 *
 * Styles for the modal come from platforms.css (.publish-modal-*).
 */

// ----------------------------------------------------------------
// showPublishOptions
// The main entry point. Called when the user clicks "Approve" on a post card.
//
// Flow:
//   1. Save any unsaved edits first (via savePostEdits from brief.js)
//   2. Call POST /posts/:id/approve
//   3. Show the modal so the user can choose Schedule or Publish Now
// ----------------------------------------------------------------
async function showPublishOptions(postId) {
  const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const approveBtn = card?.querySelector('.approve-post-btn');

  // Disable the button to prevent double-clicks
  if (approveBtn) {
    approveBtn.disabled  = true;
    approveBtn.textContent = 'Approving...';
  }

  try {
    // If the user made edits, save them before approving
    if (card?.dataset.dirty === 'true') {
      await savePostEdits(postId);
    }

    // Mark the post as approved in the database
    await apiFetch(`/posts/${postId}/approve`, { method: 'POST' });

    // Update the status badge on the card immediately
    const badge = document.getElementById(`status-badge-${postId}`);
    if (badge) {
      badge.className   = 'badge badge-approved';
      badge.textContent = 'approved';
    }

    if (approveBtn) {
      approveBtn.textContent = '✓ Approved';
      approveBtn.classList.replace('btn-primary', 'btn-secondary');
    }

    // Open the publish-options modal
    openPublishModal(postId);

  } catch (err) {
    // Show the error in the posts alert area
    if (typeof showAlert === 'function') {
      showAlert('posts-alerts', `Approval failed: ${err.message}`, 'error');
    }
    // Re-enable the button so the user can try again
    if (approveBtn) {
      approveBtn.disabled    = false;
      approveBtn.textContent = '✅ Approve';
    }
  }
}

// ----------------------------------------------------------------
// openPublishModal
// Injects the modal overlay into the DOM and wires up its buttons.
// ----------------------------------------------------------------
function openPublishModal(postId) {
  // Remove any existing modal (shouldn't happen, but be safe)
  closePublishModal();

  // Build a minimum datetime string for the schedule picker
  // (can't schedule in the past — set minimum to 5 minutes from now)
  const minDate = new Date(Date.now() + 5 * 60 * 1000);
  const minDateStr = minDate.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"

  const overlay = document.createElement('div');
  overlay.className = 'publish-modal-overlay';
  overlay.id = 'publish-modal-overlay';

  // Clicking outside the modal closes it
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePublishModal();
  });

  overlay.innerHTML = `
    <div class="publish-modal" role="dialog" aria-modal="true" aria-label="Publish options">

      <div class="publish-modal-title">✅ Post Approved</div>
      <div class="publish-modal-sub">
        What would you like to do with this post?
      </div>

      <!-- Two big option buttons -->
      <div class="publish-options">
        <button class="publish-option-btn" onclick="showScheduleForm('${postId}')">
          <span class="publish-option-icon">🗓️</span>
          <span class="publish-option-label">Schedule</span>
          <span class="publish-option-desc">Pick a date and time to auto-publish</span>
        </button>
        <button class="publish-option-btn" onclick="handlePublishNow('${postId}')">
          <span class="publish-option-icon">🚀</span>
          <span class="publish-option-label">Publish Now</span>
          <span class="publish-option-desc">Publish immediately to the platform</span>
        </button>
      </div>

      <!-- Schedule form — hidden until user clicks Schedule -->
      <div class="publish-schedule-form" id="publish-schedule-form">
        <div>
          <label for="schedule-datetime">Select date and time</label>
          <input
            type="datetime-local"
            id="schedule-datetime"
            min="${minDateStr}"
          />
        </div>
        <div class="publish-modal-actions">
          <button
            class="btn btn-primary"
            onclick="submitSchedule('${postId}')"
            id="confirm-schedule-btn"
          >
            Confirm Schedule
          </button>
          <button class="btn btn-secondary publish-modal-cancel" onclick="closePublishModal()">
            Cancel
          </button>
        </div>
      </div>

      <!-- Cancel button shown when schedule form is hidden -->
      <div id="publish-cancel-row" style="margin-top:4px;">
        <button class="btn btn-secondary btn-full" onclick="closePublishModal()">
          Close — I'll decide later
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);
}

// ----------------------------------------------------------------
// showScheduleForm
// Swaps the two option buttons out and shows the datetime picker.
// ----------------------------------------------------------------
function showScheduleForm(postId) {
  const scheduleForm = document.getElementById('publish-schedule-form');
  const cancelRow    = document.getElementById('publish-cancel-row');
  const options      = document.querySelector('.publish-options');

  if (options)      options.style.display      = 'none';
  if (cancelRow)    cancelRow.style.display     = 'none';
  if (scheduleForm) scheduleForm.classList.add('visible');

  // Focus the date input for keyboard accessibility
  document.getElementById('schedule-datetime')?.focus();
}

// ----------------------------------------------------------------
// submitSchedule
// Reads the datetime input and calls POST /posts/:id/schedule.
// ----------------------------------------------------------------
async function submitSchedule(postId) {
  const input = document.getElementById('schedule-datetime');
  const btn   = document.getElementById('confirm-schedule-btn');

  if (!input?.value) {
    alert('Please select a date and time.');
    return;
  }

  // Convert the local datetime string to a proper ISO UTC string
  const scheduledAt = new Date(input.value).toISOString();

  btn.disabled    = true;
  btn.textContent = 'Scheduling...';

  try {
    await apiFetch(`/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: scheduledAt })
    });

    // Update the status badge on the post card
    const badge = document.getElementById(`status-badge-${postId}`);
    if (badge) {
      badge.className   = 'badge badge-scheduled';
      badge.textContent = 'scheduled';
    }

    closePublishModal();

    // Show a success message in the posts area
    if (typeof showAlert === 'function') {
      const readableDate = new Date(scheduledAt).toLocaleString('en-AU', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      showAlert('posts-alerts', `Post scheduled for ${readableDate}`, 'success');
    }

  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Confirm Schedule';
    alert(`Scheduling failed: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// handlePublishNow
// Schedules the post for immediate publishing by setting scheduled_at
// to right now. The publish worker picks it up within 60 seconds.
// After queuing, shows a spinner on the card and polls for the result.
// ----------------------------------------------------------------
async function handlePublishNow(postId) {
  closePublishModal();

  try {
    await apiFetch(`/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: new Date().toISOString() })
    });

    // Show a "publishing" spinner on the card immediately
    showPublishingSpinner(postId);

    if (typeof showAlert === 'function') {
      showAlert('posts-alerts', 'Post queued — publishing within 60 seconds…', 'success');
    }

    // Poll the post status until the worker marks it published or failed
    pollPublishStatus(postId);

  } catch (err) {
    if (typeof showAlert === 'function') {
      showAlert('posts-alerts', `Publish failed: ${err.message}`, 'error');
    }
  }
}

// ----------------------------------------------------------------
// showPublishingSpinner
// Overlays a small animated spinner + "Publishing…" label on the
// status row of the post card so the user knows something is happening.
// ----------------------------------------------------------------
function showPublishingSpinner(postId) {
  // Update the badge to show "publishing…"
  const badge = document.getElementById(`status-badge-${postId}`);
  if (badge) {
    badge.className   = 'badge badge-scheduled';
    badge.textContent = 'publishing…';
  }

  // Inject a spinner below the badge if the status row exists
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

  // Dim the approve button to make it clear the card is locked
  const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const approveBtn = card?.querySelector('.approve-post-btn');
  if (approveBtn) {
    approveBtn.disabled    = true;
    approveBtn.textContent = '🔄 Publishing…';
  }
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
  const POLL_INTERVAL_MS = 5000;   // 5 seconds between checks
  const MAX_POLLS        = 36;     // 36 × 5s = 3 minutes max
  let   polls            = 0;

  const interval = setInterval(async () => {
    polls++;

    try {
      const data = await apiFetch(`/posts/${postId}`);
      const status = data?.post?.status;

      if (status === 'published') {
        clearInterval(interval);
        removePublishingSpinner(postId);

        // Update badge to published
        const badge = document.getElementById(`status-badge-${postId}`);
        if (badge) {
          badge.className   = 'badge badge-published';
          badge.textContent = 'published';
        }

        // Update the approve button
        const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
        const approveBtn = card?.querySelector('.approve-post-btn');
        if (approveBtn) {
          approveBtn.textContent = '✓ Published';
          approveBtn.disabled    = true;
        }

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

        const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
        const approveBtn = card?.querySelector('.approve-post-btn');
        if (approveBtn) {
          approveBtn.textContent = '✅ Approve';
          approveBtn.disabled    = false;
        }

        const errMsg = data?.post?.error_message || 'Unknown error';
        if (typeof showAlert === 'function') {
          showAlert('posts-alerts', `Publish failed: ${errMsg}`, 'error');
        }

      } else if (polls >= MAX_POLLS) {
        // Timed out — stop polling, leave badge as-is, show a warning
        clearInterval(interval);
        removePublishingSpinner(postId);

        const badge = document.getElementById(`status-badge-${postId}`);
        if (badge) {
          badge.className   = 'badge badge-scheduled';
          badge.textContent = 'pending';
        }

        const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
        const approveBtn = card?.querySelector('.approve-post-btn');
        if (approveBtn) {
          approveBtn.textContent = '✓ Approved';
          approveBtn.disabled    = false;
        }

        if (typeof showAlert === 'function') {
          showAlert('posts-alerts', 'Still publishing — check back shortly.', 'info');
        }
      }

    } catch (err) {
      // Network hiccup — keep polling, don't bail out on a single failure
      console.warn(`[publishStatus] Poll ${polls} failed for post ${postId}:`, err.message);
    }

  }, POLL_INTERVAL_MS);
}

// ----------------------------------------------------------------
// closePublishModal — removes the modal from the DOM
// ----------------------------------------------------------------
function closePublishModal() {
  const overlay = document.getElementById('publish-modal-overlay');
  if (overlay) overlay.remove();
}
