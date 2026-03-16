/**
 * preview.js
 *
 * WYSIWYG platform preview renderer. Loaded after brief.js, so this file
 * intentionally overrides the renderGeneratedPosts() function defined there.
 *
 * How it works:
 *   1. renderGeneratedPosts(brief, posts) is called after the AI returns results.
 *   2. A tab bar shows one tab per selected platform.
 *   3. The active platform's posts are displayed as 3 side-by-side cards.
 *   4. Each card has two sections:
 *      - TOP:    a visual mockup styled to look like that platform (read-only)
 *      - BOTTOM: editable text fields — typing here updates the mockup live
 *   5. Save saves edits to the API. Approve opens the publish modal (publish.js).
 *
 * All platform-specific colours and layouts come from platforms.css.
 */

// ----------------------------------------------------------------
// Page-level state — stored here so tabs can re-render without
// making another API call.
// ----------------------------------------------------------------
let _previewBrief   = null;  // The brief object returned from /briefs
let _previewPosts   = null;  // All generated post objects
let _activePlatform = null;  // Which platform tab is currently active

// ----------------------------------------------------------------
// renderGeneratedPosts
// OVERRIDES the version in brief.js (this file loads after it in index.html).
// Called by brief.js after AI generation completes, and by app.js when
// the user opens a previously-generated brief from the posts list.
// ----------------------------------------------------------------
function renderGeneratedPosts(brief, posts) {
  _previewBrief   = brief;
  _previewPosts   = posts;

  const contentEl = document.getElementById('main-content-area');
  if (!contentEl) return;

  // Group posts into { platform: [post, post, post] }
  const byPlatform = groupByPlatform(posts);

  // Sort platforms into a consistent left-to-right display order
  const PLATFORM_ORDER = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'youtube'];
  const sortedPlatforms = Object.keys(byPlatform).sort(
    (a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b)
  );

  _activePlatform = sortedPlatforms[0];

  // Human-readable brief label for the page header
  const postTypeLabel = (typeof POST_TYPES !== 'undefined')
    ? (POST_TYPES.find(t => t.value === brief.post_type)?.label || brief.post_type)
    : brief.post_type;

  const PLATFORM_ICONS = {
    instagram: '📸', facebook: '👥', tiktok: '🎵',
    linkedin: '💼', x: '𝕏', threads: '🧵', youtube: '▶️'
  };

  contentEl.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:13px;color:#64748b;margin-bottom:6px;">
          <a href="#" onclick="navigate('posts');return false;"
             style="color:#6366f1;text-decoration:none;font-weight:500;">← All Posts</a>
        </div>
        <div class="page-title">Generated Posts</div>
        <div class="page-subtitle">
          ${postTypeLabel} &middot;
          <span style="color:#6366f1;">
            ${posts.length} posts across ${sortedPlatforms.length} platform${sortedPlatforms.length > 1 ? 's' : ''}
          </span>
        </div>
      </div>
      <button class="btn btn-secondary" onclick="navigate('brief')">✏️ New Brief</button>
    </div>

    <div id="posts-alerts"></div>

    <!-- Platform tab bar: one tab per selected platform -->
    <div class="preview-tabs" id="preview-tabs">
      ${sortedPlatforms.map(p => `
        <button
          class="preview-tab ${p === _activePlatform ? 'active' : ''}"
          data-platform="${p}"
          onclick="switchPreviewTab('${p}')"
        >
          ${PLATFORM_ICONS[p] || '📱'} ${capitalize(p)}
          <span class="preview-tab-count">${byPlatform[p].length}</span>
        </button>
      `).join('')}
    </div>

    <!-- Post cards — this div is replaced when the user switches tabs -->
    <div id="preview-posts-container">
      ${renderPlatformCards(byPlatform[_activePlatform] || [], _activePlatform)}
    </div>
  `;

  // Highlight the correct sidebar link
  if (typeof updateSidebarActiveState === 'function') {
    updateSidebarActiveState('posts');
  }
}

// ----------------------------------------------------------------
// switchPreviewTab — swaps the visible post cards to the new platform
// ----------------------------------------------------------------
function switchPreviewTab(platform) {
  _activePlatform = platform;

  // Update which tab looks active
  document.querySelectorAll('.preview-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.platform === platform);
  });

  // Swap out the post cards
  const byPlatform = groupByPlatform(_previewPosts);
  const container  = document.getElementById('preview-posts-container');
  if (container) {
    container.innerHTML = renderPlatformCards(byPlatform[platform] || [], platform);
  }
}

// ----------------------------------------------------------------
// renderPlatformCards — builds the 3-column options grid for one platform
// ----------------------------------------------------------------
function renderPlatformCards(posts, platform) {
  if (!posts.length) {
    return '<div class="card"><p class="text-muted text-sm">No posts for this platform.</p></div>';
  }

  // Always show Option 1, 2, 3 left-to-right
  const sorted = [...posts].sort((a, b) => a.option_number - b.option_number);

  // Build a JSON-safe list of post IDs for the "generate all" button
  const postIdsJson = JSON.stringify(sorted.map(p => p.id)).replace(/"/g, '&quot;');

  return `
    <!-- Bulk image generation — one click generates for all 3 options at once -->
    <div class="gen-all-bar">
      <span class="gen-all-hint">No images yet?</span>
      <button
        class="btn btn-sm btn-secondary"
        id="gen-all-btn-${platform}"
        onclick="generateAllImages(${postIdsJson}, '${platform}')"
      >✨ Generate Images for All 3</button>
      <span id="gen-all-status-${platform}" class="gen-all-status"></span>
    </div>
    <div class="post-options-grid">
      ${sorted.map(post => renderWysiwygCard(post, platform)).join('')}
    </div>
  `;
}

// ----------------------------------------------------------------
// renderWysiwygCard
// One card = platform mockup (top) + editable fields (bottom).
// The mockup and the edit fields are linked: typing in a field
// updates the corresponding element in the mockup instantly.
// ----------------------------------------------------------------
function renderWysiwygCard(post, platform) {
  const hashtagsDisplay = post.hashtags?.length
    ? post.hashtags.map(h => `#${h}`).join(' ')
    : '';

  return `
    <div class="wysiwyg-card post-card"
         data-post-id="${post.id}"
         data-dirty="false"
         data-platform="${post.platform || ''}"
         data-media-id="${post.media_id || ''}"
         data-media-type="${post.media_file_type || ''}"
         data-media-duration="${post.media_duration_seconds || ''}"
         data-trim-start-seconds="${post.trim_start_seconds || 0}"
         data-analysis-status="${post.media_analysis_status || ''}">

      <!-- TOP: Platform-styled visual mockup (auto-updates as user types) -->
      <div class="wysiwyg-preview">
        ${renderPlatformMockup(post, platform)}
      </div>

      <!-- BOTTOM: Editable fields -->
      <div class="wysiwyg-edit">

        <div class="wysiwyg-edit-header">
          <span class="post-card-option">Option ${post.option_number}</span>
          <div class="post-card-actions">
            <button
              class="btn btn-sm btn-secondary save-post-btn"
              data-id="${post.id}"
              onclick="savePostEdits('${post.id}')"
            >Save Draft</button>
            <button
              class="btn btn-sm btn-secondary schedule-post-btn"
              data-id="${post.id}"
              onclick="toggleInlineSchedule('${post.id}')"
            >🗓️ Schedule</button>
            <button
              class="btn btn-sm btn-primary publish-now-btn"
              data-id="${post.id}"
              onclick="handlePublishNow('${post.id}')"
            >🚀 Publish Now</button>
            <button
              class="btn btn-sm btn-danger delete-post-btn"
              data-id="${post.id}"
              onclick="deletePost('${post.id}')"
              title="Delete this post"
            >🗑️</button>
          </div>
        </div>

        <!-- Inline schedule form — hidden until user clicks Schedule -->
        <div class="inline-schedule-form" id="inline-schedule-${post.id}" style="display:none;">
          <label class="inline-schedule-label">Pick a date and time to auto-publish:</label>
          <div class="inline-schedule-row">
            <input
              type="datetime-local"
              class="form-control form-control-sm inline-schedule-input"
              id="inline-schedule-dt-${post.id}"
            />
            <button
              class="btn btn-sm btn-primary"
              onclick="submitInlineSchedule('${post.id}')"
            >Confirm</button>
            <button
              class="btn btn-sm btn-secondary"
              onclick="toggleInlineSchedule('${post.id}')"
            >Cancel</button>
          </div>
        </div>

        <div class="wysiwyg-fields">
          ${editableField(post.id, 'hook',    'Hook',           post.hook    || '')}
          ${editableField(post.id, 'caption', 'Caption',        post.caption || '', 'caption-field')}
          ${hashtagsDisplay
            ? editableField(post.id, 'hashtags', 'Hashtags', hashtagsDisplay, 'hashtag-field')
            : ''}
          ${editableField(post.id, 'cta',     'Call to Action', post.cta     || '')}
        </div>

        <!-- AI Image Generation — always visible regardless of media_recommendation.
             Default prompt = recommendation (if AI provided one) otherwise the caption.
             This means the button works even after a page reload when recommendation
             is no longer in memory. -->
        <div class="post-field post-field-media" style="margin-top:4px;">
          ${post.media_recommendation
            ? `<div class="post-field-label">🎬 Recommended Media</div>
               <div class="post-field-content media-rec" style="margin-bottom:6px;">${escapeHtml(post.media_recommendation)}</div>`
            : ''}
          <button
            class="btn btn-xs btn-secondary gen-image-btn"
            onclick="toggleGenerateImagePanel('${post.id}')"
          >✨ Generate AI Image</button>
          <!-- Inline AI image generation panel (hidden by default) -->
          <div id="gen-image-panel-${post.id}" class="gen-image-panel" style="display:none;">
            <div class="gen-image-prompt-row">
              <textarea
                id="gen-image-prompt-${post.id}"
                class="gen-image-prompt form-control"
                rows="3"
                placeholder="Describe the image you want to generate..."
              >${escapeHtml(post.media_recommendation || post.caption || '')}</textarea>
            </div>
            <div class="gen-image-size-row">
              <label class="gen-image-size-label">Format:</label>
              <select id="gen-image-size-${post.id}" class="form-control form-control-sm gen-image-size-select">
                <option value="square_hd"      selected>Square (1024×1024) — all platforms</option>
                <option value="landscape_16_9">Landscape 16:9 — Facebook, LinkedIn, YouTube</option>
                <option value="portrait_4_3"  >Portrait 4:3 — Instagram, TikTok</option>
              </select>
            </div>
            <div class="gen-image-actions">
              <button
                class="btn btn-sm btn-primary"
                id="gen-image-btn-${post.id}"
                onclick="generateImageForPost('${post.id}')"
              >✨ Generate</button>
              <button class="btn btn-sm btn-secondary" onclick="toggleGenerateImagePanel('${post.id}')">Cancel</button>
            </div>
            <!-- Generated image result shows here -->
            <div id="gen-image-result-${post.id}"></div>
          </div>
        </div>

        <!-- Media attachment — lets the user link a file from their media library -->
        <div class="post-field" style="margin-top:4px;">
          <div class="post-field-label">📎 Media</div>
          ${post.media_id
            ? `<div class="post-media-attached" id="post-media-${post.id}">
                 <div class="post-media-preview">
                   ${post.media_thumbnail_url
                     ? `<img src="${escapeHtml(post.media_thumbnail_url)}" alt="Media thumbnail" class="post-media-thumb" />`
                     : `<span class="post-media-icon">${post.media_file_type === 'video' ? '🎬' : '🖼️'}</span>`}
                 </div>
                 <div class="post-media-info">
                   <span class="post-media-name">${escapeHtml(post.media_filename || 'Attached media')}</span>
                   <button class="btn btn-xs btn-secondary post-media-remove" onclick="removePostMedia('${post.id}')">✕ Remove</button>
                 </div>
               </div>`
            : `<div class="post-media-empty" id="post-media-${post.id}">
                 <button class="btn btn-sm btn-secondary post-media-attach-btn" onclick="openMediaPicker('${post.id}')">
                   📎 Attach Media
                 </button>
               </div>`}

          <!-- Trim warning — shown for video attachments that exceed the platform limit -->
          <div id="trim-warning-${post.id}">
            ${buildTrimWarningHtml(post.id, post.platform, post.media_file_type, post.media_duration_seconds, post.trim_start_seconds || 0)}
          </div>
        </div>

        <div class="post-card-status" style="margin-top:6px;">
          <span class="badge badge-${post.status}" id="status-badge-${post.id}">${post.status}</span>
        </div>

      </div>
    </div>
  `;
}

// ----------------------------------------------------------------
// editableField — returns a contenteditable div for one post field.
// The oninput attribute calls liveUpdatePreview() on every keystroke.
// ----------------------------------------------------------------
function editableField(postId, field, label, value, extraClass = '') {
  return `
    <div class="post-field">
      <div class="post-field-label">${label}</div>
      <div
        class="post-field-content editable ${extraClass}"
        data-field="${field}"
        data-id="${postId}"
        contenteditable="true"
        spellcheck="${field !== 'hashtags'}"
        oninput="liveUpdatePreview('${postId}', '${field}', this)"
      >${escapeHtml(value)}</div>
    </div>
  `;
}

// ----------------------------------------------------------------
// liveUpdatePreview — fired on every keystroke inside an editable field.
// Finds the [data-preview="field"] element inside the mockup and updates
// its text so the visual preview always matches what the user is typing.
// ----------------------------------------------------------------
function liveUpdatePreview(postId, field, inputEl) {
  // Mark the card dirty so Save knows there are unsaved changes
  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  if (card) card.dataset.dirty = 'true';

  const preview  = card?.querySelector('.wysiwyg-preview');
  const targetEl = preview?.querySelector(`[data-preview="${field}"]`);
  if (!targetEl) return;

  const newText = inputEl.innerText;

  // YouTube titles live in a separate .preview-youtube-title element
  // as well as the hidden data-preview="hook" span — update both
  if (field === 'hook') {
    const ytTitle = preview.querySelector('.preview-youtube-title');
    if (ytTitle) ytTitle.textContent = newText;

    // Update X character count warning in real time
    const charCount = preview.querySelector('.x-char-count');
    if (charCount) {
      const len = newText.trim().length;
      charCount.textContent = `${len}/280`;
      charCount.style.color = len > 280 ? '#ef4444' : '#94a3b8';
    }
  }

  targetEl.textContent = newText;
}

// ================================================================
// PLATFORM MOCKUP RENDERERS
// Each function returns an HTML string resembling that platform's UI.
// The data-preview="field" attributes are the live-update targets.
// ================================================================

function renderPlatformMockup(post, platform) {
  switch (platform) {
    case 'instagram': return renderInstagramMockup(post);
    case 'facebook':  return renderFacebookMockup(post);
    case 'tiktok':    return renderTiktokMockup(post);
    case 'linkedin':  return renderLinkedinMockup(post);
    case 'x':         return renderXMockup(post);
    case 'threads':   return renderThreadsMockup(post);
    case 'youtube':   return renderYoutubeMockup(post);
    default:          return renderGenericMockup(post);
  }
}

// ---- Helpers used by all mockup renderers ----

function _brandInitial() {
  return (window.App?.user?.profile?.brand_name || window.App?.user?.email || 'B')[0].toUpperCase();
}

function _brandName() {
  return escapeHtml(window.App?.user?.profile?.brand_name || 'Your Brand');
}

function _hashtagsText(post) {
  return post.hashtags?.length ? post.hashtags.map(h => `#${h}`).join(' ') : '';
}

// Returns the inner content for the .preview-media zone.
// If the post already has a thumbnail (loaded from DB or just attached),
// shows the real image.
// If the post has an ai_image_url (directly stored), shows that.
// Otherwise shows a clickable placeholder that opens the generate panel.
function _previewMediaContent(post, defaultIcon, defaultText) {
  // Use whatever image URL we have — thumbnail_url (video thumb or library image),
  // cloud_url (AI-generated images stored in Supabase), or ai_image_url (legacy field).
  // All external URLs go through /media/proxy to avoid ad-blocker issues.
  const rawUrl = post.media_thumbnail_url || post.ai_image_url || post.media_cloud_url || null;

  if (rawUrl) {
    const src = rawUrl.startsWith('http') ? `/media/proxy?url=${encodeURIComponent(rawUrl)}` : rawUrl;
    return `<img src="${src}" alt="Media preview"
              style="width:100%;height:100%;object-fit:cover;display:block;"
              onerror="this.style.display='none'" />`;
  }
  // No image yet — show placeholder with hint
  return `<span class="preview-media-icon">${defaultIcon}</span>
          <span class="preview-media-text">${defaultText}</span>
          <span class="preview-media-add-hint">Click ✨ Generate below to add an image</span>`;
}

// ----------------------------------------------------------------
// updatePreviewMediaZone
// Called by attachMediaToPost and removePostMedia (defined in brief.js)
// to keep the top mockup in sync with what's attached to the post.
//
// mediaItem — the attached media object, or null to restore placeholder.
// ----------------------------------------------------------------
function updatePreviewMediaZone(postId, mediaItem) {
  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  if (!card) return;

  const zone = card.querySelector('.preview-media');
  if (!zone) return;

  const platform = card.dataset.platform || '';

  if (!mediaItem) {
    // Restore the platform-appropriate placeholder
    const isVideoFirst = ['tiktok', 'youtube'].includes(platform);
    const icon = isVideoFirst ? '🎬' : '🖼️';
    const text = platform === 'tiktok'   ? 'Vertical video (9:16)'
               : platform === 'youtube'  ? 'Video thumbnail (16:9)'
               : 'Your image or video here';
    zone.innerHTML = `<span class="preview-media-icon">${icon}</span>
                      <span class="preview-media-text">${text}</span>`;
    return;
  }

  // Build the best available thumbnail URL.
  // Priority: stored thumbnail_url → Google Drive thumbnail API → image cloud_url → null
  const thumbUrl = mediaItem.thumbnail_url
    || (mediaItem.cloud_provider === 'google_drive' && mediaItem.cloud_file_id
        ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(mediaItem.cloud_file_id)}&sz=w640`
        : (mediaItem.file_type === 'image' ? mediaItem.cloud_url : null));

  if (thumbUrl) {
    // Google Drive thumbnail URLs work directly in the browser (user session handles auth).
    // All other URLs (supabase.co) go through our proxy to avoid ad-blocker blocks.
    const src = thumbUrl.includes('drive.google.com')
      ? thumbUrl
      : `/media/proxy?url=${encodeURIComponent(thumbUrl)}`;
    zone.innerHTML = `<img src="${src}" alt="Media preview"
                        style="width:100%;height:100%;object-fit:cover;display:block;"
                        onerror="this.outerHTML='<span class=\\'preview-media-icon\\'>🎬</span><span class=\\'preview-media-text\\' style=\\'color:#4ade80;\\'>Video attached</span>'" />`;
  } else if (mediaItem.file_type === 'video') {
    zone.innerHTML = `<span class="preview-media-icon">🎬</span>
                      <span class="preview-media-text" style="color:#4ade80;">Video attached</span>`;
  } else {
    zone.innerHTML = `<span class="preview-media-icon">🖼️</span>
                      <span class="preview-media-text" style="color:#4ade80;">Image attached</span>`;
  }
}

// ---- Instagram ----
function renderInstagramMockup(post) {
  const tags = _hashtagsText(post);
  return `
    <div class="preview-card preview-instagram">
      <div class="preview-header">
        <div class="preview-avatar">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">Sponsored</div>
        </div>
        <div class="preview-more">•••</div>
      </div>

      <div class="preview-media">
        ${_previewMediaContent(post, '🖼️', 'Your image or video here')}
      </div>

      <div class="preview-instagram-actions">
        <span class="preview-action-icon">🤍</span>
        <span class="preview-action-icon">💬</span>
        <span class="preview-action-icon">✈️</span>
        <span class="preview-instagram-actions-right">
          <span class="preview-action-icon">🔖</span>
        </span>
      </div>
      <div class="preview-likes">1,234 likes</div>

      <div class="preview-body">
        <div class="preview-hook">
          <strong>${_brandName()}</strong>
          <span data-preview="hook"> ${escapeHtml(post.hook)}</span>
        </div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>
    </div>
  `;
}

// ---- Facebook ----
function renderFacebookMockup(post) {
  const tags = _hashtagsText(post);
  return `
    <div class="preview-card preview-facebook">
      <div class="preview-header">
        <div class="preview-avatar">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">Just now &middot; 🌐</div>
        </div>
        <div class="preview-more">•••</div>
      </div>

      <div class="preview-body">
        <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>

      <div class="preview-media">
        ${_previewMediaContent(post, '🖼️', 'Your image or video here')}
      </div>

      <div class="preview-facebook-reactions">
        <span class="preview-fb-action">👍 Like</span>
        <span class="preview-fb-action">💬 Comment</span>
        <span class="preview-fb-action">↗️ Share</span>
      </div>
    </div>
  `;
}

// ---- TikTok ----
function renderTiktokMockup(post) {
  const tags = _hashtagsText(post);
  return `
    <div class="preview-card preview-tiktok">
      <div class="preview-header">
        <div class="preview-avatar">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">Following</div>
        </div>
        <div class="preview-more" style="color:#888;">•••</div>
      </div>

      <div class="preview-media">
        ${_previewMediaContent(post, '🎬', 'Vertical video (9:16)')}
      </div>

      <div class="preview-body">
        <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>

      <div class="preview-tiktok-sidebar">
        <span class="preview-tiktok-icon">🤍</span>
        <span class="preview-tiktok-icon">💬</span>
        <span class="preview-tiktok-icon">↗️</span>
        <span class="preview-tiktok-icon">🎵</span>
      </div>
    </div>
  `;
}

// ---- LinkedIn ----
function renderLinkedinMockup(post) {
  const tags = _hashtagsText(post);
  return `
    <div class="preview-card preview-linkedin">
      <div class="preview-header">
        <div class="preview-avatar" style="border-radius:6px;">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">Company &middot; Just now &middot; 🌐</div>
        </div>
        <div class="preview-more">•••</div>
      </div>

      <div class="preview-body">
        <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>

      <div class="preview-media">
        ${_previewMediaContent(post, '🖼️', 'Image or document')}
      </div>

      <div class="preview-linkedin-reactions">
        <span class="preview-fb-action">👍 React</span>
        <span class="preview-fb-action">💬 Comment</span>
        <span class="preview-fb-action">🔁 Repost</span>
        <span class="preview-fb-action">✉️ Send</span>
      </div>
    </div>
  `;
}

// ---- X (Twitter) ----
function renderXMockup(post) {
  const tags    = _hashtagsText(post);
  const hookLen = (post.hook || '').length;
  const over    = hookLen > 280;
  return `
    <div class="preview-card preview-x">
      <div class="preview-header">
        <div class="preview-avatar">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">@${_brandName().toLowerCase().replace(/\s+/g, '')} &middot; now</div>
        </div>
      </div>

      <div class="preview-body">
        <!-- On X, the hook IS the full post text (280-char limit) -->
        <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
        <div class="x-char-count" style="font-size:10px;margin-top:4px;color:${over ? '#ef4444' : '#94a3b8'};">
          ${hookLen}/280${over ? ' ⚠️ Too long — trim the hook' : ''}
        </div>
      </div>

      <div class="preview-x-actions">
        <span class="preview-x-action">💬 Reply</span>
        <span class="preview-x-action">🔁 Repost</span>
        <span class="preview-x-action">🤍 Like</span>
        <span class="preview-x-action">📊 Views</span>
      </div>
    </div>
  `;
}

// ---- Threads ----
function renderThreadsMockup(post) {
  return `
    <div class="preview-card preview-threads">
      <div class="preview-header">
        <div class="preview-avatar">${_brandInitial()}</div>
        <div class="preview-user-info">
          <div class="preview-username">${_brandName()}</div>
          <div class="preview-handle">now</div>
        </div>
        <div class="preview-more">•••</div>
      </div>

      <div class="preview-body">
        <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        <!-- Threads doesn't use hashtags — keep the update target hidden -->
        <span data-preview="hashtags" style="display:none;">${escapeHtml(_hashtagsText(post))}</span>
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>

      <div class="preview-threads-actions">
        <span class="preview-threads-action">🤍</span>
        <span class="preview-threads-action">💬</span>
        <span class="preview-threads-action">🔁</span>
        <span class="preview-threads-action">✈️</span>
      </div>
    </div>
  `;
}

// ---- YouTube ----
function renderYoutubeMockup(post) {
  const tags = _hashtagsText(post);
  return `
    <div class="preview-card preview-youtube">
      <div class="preview-media" style="position:relative;">
        ${_previewMediaContent(post, '🎬', 'Video thumbnail (16:9)')}
        <div class="preview-youtube-play">▶</div>
      </div>

      <div class="preview-body">
        <!-- Hook = video title on YouTube -->
        <div class="preview-youtube-title" data-preview="hook">${escapeHtml(post.hook)}</div>
        <div class="preview-youtube-channel">${_brandName()} &middot; 0 views &middot; just now</div>
        <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
        ${tags ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(tags)}</div>` : ''}
        ${post.cta ? `<div class="preview-cta" data-preview="cta">${escapeHtml(post.cta)}</div>` : ''}
      </div>
    </div>
  `;
}

// ---- Generic fallback (unknown platform) ----
function renderGenericMockup(post) {
  return `
    <div class="preview-card" style="padding:12px;">
      <div class="preview-hook" data-preview="hook">${escapeHtml(post.hook)}</div>
      <div class="preview-caption-text" data-preview="caption">${escapeHtml(post.caption)}</div>
      ${_hashtagsText(post) ? `<div class="preview-hashtags" data-preview="hashtags">${escapeHtml(_hashtagsText(post))}</div>` : ''}
    </div>
  `;
}

// ================================================================
// UTILITIES
// ================================================================

// Groups an array of post objects into { platform: [posts] }
function groupByPlatform(posts) {
  const groups = {};
  posts.forEach(post => {
    if (!groups[post.platform]) groups[post.platform] = [];
    groups[post.platform].push(post);
  });
  return groups;
}

// Capitalise the first letter of a string (e.g. 'instagram' → 'Instagram')
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// NOTE: escapeHtml() is defined in brief.js which loads before this file.
// It is available globally on the page — no need to redefine it here.

// ================================================================
// AI IMAGE GENERATION
// Generates an image from the "Recommended Media" description using
// fal.ai Flux Schnell via POST /media/generate-image.
// ================================================================

// ----------------------------------------------------------------
// toggleGenerateImagePanel — shows/hides the inline generate panel
// ----------------------------------------------------------------
function toggleGenerateImagePanel(postId) {
  const panel = document.getElementById(`gen-image-panel-${postId}`);
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
}

// ----------------------------------------------------------------
// generateImageForPost
// Reads the prompt + format from the panel, calls the API,
// and renders the result inline with "Attach to Post" option.
// ----------------------------------------------------------------
// autoAttach = true skips the "Attach to This Post" button and attaches immediately.
// Used by generateAllImages() so the user doesn't have to click 3 times.
async function generateImageForPost(postId, autoAttach = false) {
  const promptEl = document.getElementById(`gen-image-prompt-${postId}`);
  const sizeEl   = document.getElementById(`gen-image-size-${postId}`);
  const btn      = document.getElementById(`gen-image-btn-${postId}`);
  const result   = document.getElementById(`gen-image-result-${postId}`);

  const prompt = promptEl?.value?.trim();
  if (!prompt) {
    if (result) result.innerHTML = `<p class="gen-image-error">Please enter a prompt before generating.</p>`;
    return;
  }

  // Show loading state
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }
  if (result) result.innerHTML = `
    <div class="gen-image-loading">
      <div class="spinner spinner-sm"></div>
      <span>Generating your image — this takes about 5–10 seconds...</span>
    </div>`;

  try {
    const data = await apiFetch('/media/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        image_size: sizeEl?.value || 'square_hd'
      })
    });

    const item = data.media_item;

    // Route through /media/proxy so the browser only sees localhost:3001.
    // This bypasses ad blockers that block third-party domains (supabase.co).
    const proxySrc = `/media/proxy?url=${encodeURIComponent(item.cloud_url)}`;

    if (autoAttach) {
      // Auto-attach immediately — no button click needed
      if (result) result.innerHTML = `
        <div class="gen-image-preview">
          <img src="${proxySrc}" alt="Generated image" class="gen-image-result-img" />
          <div style="font-size:12px;color:#16a34a;margin-top:6px;">✅ Attached automatically</div>
        </div>`;
      await attachGeneratedImage(postId, item);
    } else {
      // Normal flow: show image + manual attach button
      if (result) result.innerHTML = `
        <div class="gen-image-preview">
          <img
            src="${proxySrc}"
            alt="Generated image"
            class="gen-image-result-img"
            onerror="this.alt='Image failed to load — try Delete All in Media Library and generate again'"
          />
          <div class="gen-image-result-actions">
            <button
              class="btn btn-sm btn-primary"
              onclick="attachGeneratedImage('${postId}', ${JSON.stringify(item).replace(/"/g, '&quot;')})"
            >📎 Attach to This Post</button>
            <span class="text-muted text-sm" style="margin-left:6px;">
              ✅ Saved to your Media Library
            </span>
          </div>
        </div>`;
    }

  } catch (err) {
    if (result) result.innerHTML = `<p class="gen-image-error">Generation failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate'; }
  }
}

// ----------------------------------------------------------------
// attachGeneratedImage
// Attaches the freshly generated image to the post and closes the panel.
// Reuses attachMediaToPost from brief.js (already available globally).
// ----------------------------------------------------------------
async function attachGeneratedImage(postId, mediaItem) {
  // attachMediaToPost is defined in brief.js and available globally
  if (typeof attachMediaToPost === 'function') {
    await attachMediaToPost(postId, mediaItem);
  }
  // Close the generate panel
  const panel = document.getElementById(`gen-image-panel-${postId}`);
  if (panel) panel.style.display = 'none';
}

// ----------------------------------------------------------------
// generateAllImages
// Generates AI images for all posts on the current platform tab at once.
// Runs all 3 in parallel, then auto-attaches each result so the mockups
// update without the user having to click "Attach" for each one.
//
// postIds  — array of post IDs (from renderPlatformCards)
// platform — the current platform string (used for the status label)
// ----------------------------------------------------------------
async function generateAllImages(postIds, platform) {
  const btn       = document.getElementById(`gen-all-btn-${platform}`);
  const statusEl  = document.getElementById(`gen-all-status-${platform}`);

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  if (statusEl) statusEl.textContent = 'Generating images — this takes about 10–15 seconds…';

  // For each post: open the panel (so the user can see progress), then generate + auto-attach
  const tasks = postIds.map(async (postId) => {
    // Open the panel so the spinner is visible
    const panel = document.getElementById(`gen-image-panel-${postId}`);
    if (panel) panel.style.display = 'block';

    // Run generation (this updates the result div inside the panel)
    await generateImageForPost(postId, /* autoAttach = */ true);
  });

  try {
    await Promise.allSettled(tasks);
    if (statusEl) statusEl.textContent = '✅ Done! Images attached to all 3 options.';
  } catch (_) {
    if (statusEl) statusEl.textContent = 'Some images may have failed — check each card.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate Images for All 3'; }
    // Clear the status after a few seconds
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  }
}

// ================================================================
// TRIM WARNING
// Shows a warning + trim-start input when an attached video is
// longer than the platform allows.
// ================================================================

// Platform video duration limits in seconds — mirrors ffmpegService.PLATFORM_LIMITS
const PLATFORM_VIDEO_LIMITS = {
  tiktok:    60,
  instagram: 90,
  youtube:   60,
  facebook:  180,
  linkedin:  600,
  x:         140,
  threads:   300
};

// ----------------------------------------------------------------
// buildTrimWarningHtml
// Returns the HTML for the trim warning + start input, or '' if
// no warning is needed.
//   platform         - 'instagram', 'tiktok', etc.
//   mediaType        - 'video' | 'image' | '' | null
//   durationSeconds  - video length in seconds (may be null if not probed yet)
//   trimStartSeconds - where the user wants the trim to start (default 0)
// ----------------------------------------------------------------
function buildTrimWarningHtml(postId, platform, mediaType, durationSeconds, trimStartSeconds = 0) {
  // Only show for video attachments on platforms with a limit
  if (mediaType !== 'video') return '';

  const limit = PLATFORM_VIDEO_LIMITS[platform];
  if (!limit) return '';

  // Read analysis_status from the card dataset so we can show the Smart Clip button
  const card           = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const analysisStatus = card?.dataset.analysisStatus || '';

  // If duration not known yet, show a spinner — autoProbeVideoInBackground in brief.js
  // is already fetching it; this will refresh once the probe comes back.
  if (!durationSeconds) {
    return `
      <div class="trim-info text-muted text-sm" style="margin-top:6px;display:flex;align-items:center;gap:6px;">
        <div class="spinner spinner-xs"></div>
        Checking video duration…
      </div>`;
  }

  const effectiveDuration = durationSeconds - trimStartSeconds;
  const overLimit  = effectiveDuration > limit;
  const hasOffset  = trimStartSeconds > 0;
  const hasClipBtn = !!analysisStatus; // only show button once we know the status

  if (!overLimit && !hasOffset && !hasClipBtn) return ''; // All good, no UI needed

  const limitFormatted    = formatPreviewDuration(limit);
  const durationFormatted = formatPreviewDuration(durationSeconds);
  const maxStart          = Math.max(0, durationSeconds - 1);

  // Build the Smart Clip button based on current analysis state
  let clipBtnHtml = '';
  if (hasClipBtn) {
    if (analysisStatus === 'ready') {
      clipBtnHtml = `<button class="btn btn-sm clip-picker-btn" onclick="openClipPicker('${postId}')">🎬 Smart Clip</button>`;
    } else if (analysisStatus === 'analyzing') {
      clipBtnHtml = `<button class="btn btn-sm clip-picker-btn" disabled title="Segment analysis is running — this takes 1–3 minutes"><span class="spinner spinner-xs"></span> Analysing video…</button>`;
      startAnalysisPolling(postId);
    } else if (analysisStatus === 'pending') {
      clipBtnHtml = `<button class="btn btn-sm clip-picker-btn" disabled title="Segment analysis is queued — will start automatically"><span class="spinner spinner-xs"></span> Analysis queued…</button>`;
      startAnalysisPolling(postId);
    } else if (analysisStatus === 'too_large') {
      clipBtnHtml = `<button class="btn btn-sm clip-picker-btn clip-picker-btn--failed" disabled title="Video exceeds the 500 MB / 5-min analysis limit — use the manual slider to set a clip start point">🎬 Too large to analyze</button>`;
    } else if (analysisStatus === 'failed') {
      clipBtnHtml = `<button class="btn btn-sm clip-picker-btn clip-picker-btn--failed" disabled title="Segment analysis failed — use the manual slider below">🎬 Analysis unavailable</button>`;
    }
  }

  // If the video is within limits and has no offset, just show the button (no trim warning box)
  if (!overLimit && !hasOffset) {
    return `<div class="trim-info" style="margin-top:6px;">${clipBtnHtml}</div>`;
  }

  return `
    <div class="trim-warning ${overLimit ? 'trim-warning-over' : 'trim-warning-ok'}" style="margin-top:6px;">
      <div class="trim-warning-top">
        ${overLimit
          ? `⚠️ <strong>${durationFormatted} video</strong> — exceeds ${capitalize(platform)}'s ${limitFormatted} limit. It will be auto-trimmed when published.`
          : `✅ <strong>${durationFormatted} video</strong> — within the ${limitFormatted} ${capitalize(platform)} limit.`}
        ${clipBtnHtml}
      </div>
      <div class="trim-start-row" style="margin-top:8px;">
        <div class="trim-slider-header">
          <label class="trim-start-label">Clip start point:</label>
          <span class="trim-slider-value" id="trim-slider-val-${postId}">
            ${trimStartSeconds}s → ends at ${formatPreviewDuration(Math.min(durationSeconds, trimStartSeconds + limit))}
          </span>
        </div>
        <input
          type="range"
          id="trim-start-${postId}"
          class="trim-slider"
          value="${trimStartSeconds}"
          min="0"
          max="${maxStart}"
          step="1"
          oninput="onTrimSliderMove('${postId}', this.value, ${durationSeconds}, ${limit})"
          onchange="onTrimStartChange('${postId}', this.value)"
          title="Drag to choose where the clip starts"
        />
        <div class="trim-slider-ticks">
          <span>0s</span>
          <span>${formatPreviewDuration(Math.floor(maxStart / 2))}</span>
          <span>${formatPreviewDuration(maxStart)}</span>
        </div>
      </div>
    </div>`;
}

// ----------------------------------------------------------------
// startAnalysisPolling
//
// Polls GET /media/:mediaId every 6 seconds while a video's
// analysis_status is 'pending' or 'analyzing'. When the status
// flips to 'ready', updates the card dataset and re-renders the
// trim/clip zone so the Smart Clip button appears — no page reload.
//
// Uses a module-level Set to avoid starting duplicate polls for
// the same postId (e.g. if buildTrimWarningHtml is called twice).
// ----------------------------------------------------------------
const _analysisPolls = new Set(); // tracks which postIds are already being polled

async function startAnalysisPolling(postId) {
  // Don't start a second poll for the same card
  if (_analysisPolls.has(postId)) return;
  _analysisPolls.add(postId);

  const card    = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const mediaId = card?.dataset.mediaId;
  if (!mediaId) { _analysisPolls.delete(postId); return; }

  // Poll every 6 seconds until status is terminal (ready / failed)
  const intervalId = setInterval(async () => {
    try {
      const data   = await apiFetch(`/media/${mediaId}`);
      const status = data?.media?.analysis_status;

      if (!status || status === 'pending' || status === 'analyzing') return; // keep polling

      // Terminal state reached — stop polling
      clearInterval(intervalId);
      _analysisPolls.delete(postId);

      // Update the card's dataset so buildTrimWarningHtml reads the new status
      const freshCard = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
      if (!freshCard) return;
      freshCard.dataset.analysisStatus = status;

      // Re-render only the trim/clip zone (not the whole card)
      const trimZone = document.getElementById(`trim-warning-${postId}`);
      if (!trimZone) return;

      const platform  = freshCard.dataset.platform || '';
      const mediaType = freshCard.dataset.mediaType || '';
      const duration  = parseInt(freshCard.dataset.mediaDuration, 10) || 0;
      const trimStart = parseInt(freshCard.dataset.trimStartSeconds, 10) || 0;

      trimZone.innerHTML = buildTrimWarningHtml(postId, platform, mediaType, duration, trimStart);

    } catch (_) {
      // Network error — keep polling, don't crash
    }
  }, 6000);
}

// ----------------------------------------------------------------
// formatPreviewDuration — converts seconds to mm:ss for display
// ----------------------------------------------------------------
function formatPreviewDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ----------------------------------------------------------------
// onTrimSliderMove — fired on every pixel of slider drag (oninput).
// Only updates the label — no API call yet. That waits for onchange.
// ----------------------------------------------------------------
function onTrimSliderMove(postId, value, totalDuration, platformLimit) {
  const start   = Math.max(0, parseInt(value, 10) || 0);
  const endSec  = Math.min(totalDuration, start + platformLimit);
  const valEl   = document.getElementById(`trim-slider-val-${postId}`);
  if (valEl) {
    valEl.textContent = `${start}s → ends at ${formatPreviewDuration(endSec)}`;
  }
}

// ----------------------------------------------------------------
// onTrimStartChange — called when user releases the slider (onchange).
// Saves the value to the card dataset and regenerates the warning HTML.
// ----------------------------------------------------------------
function onTrimStartChange(postId, value) {
  const trimStart = Math.max(0, parseInt(value, 10) || 0);
  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  if (card) {
    card.dataset.trimStartSeconds = trimStart;
    card.dataset.dirty = 'true';
  }

  // Refresh the warning UI with the new start offset
  const mediaType     = card?.dataset.mediaType || '';
  const duration      = parseInt(card?.dataset.mediaDuration, 10) || 0;
  const platform      = card?.dataset.platform || '';
  updateTrimWarning(postId, { file_type: mediaType, duration_seconds: duration }, trimStart);
}

// ----------------------------------------------------------------
// updateTrimWarning — called after attaching or removing media.
// Regenerates the trim warning section for the given post card.
//   mediaItem — the attached media object (or null if media removed)
//   trimStart — optional override for trim start seconds
// ----------------------------------------------------------------
function updateTrimWarning(postId, mediaItem, trimStart) {
  const container = document.getElementById(`trim-warning-${postId}`);
  if (!container) return;

  const card = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const platform = card?.dataset.platform || '';

  if (!mediaItem) {
    // Media removed — clear the warning
    container.innerHTML = '';
    return;
  }

  // Update card dataset with the new media metadata
  if (card) {
    if (mediaItem.file_type)        card.dataset.mediaType      = mediaItem.file_type;
    if (mediaItem.duration_seconds) card.dataset.mediaDuration  = mediaItem.duration_seconds;
    if (mediaItem.analysis_status)  card.dataset.analysisStatus = mediaItem.analysis_status;
  }

  const effectiveTrimStart = trimStart !== undefined
    ? trimStart
    : parseInt(card?.dataset.trimStartSeconds, 10) || 0;

  container.innerHTML = buildTrimWarningHtml(
    postId,
    platform,
    mediaItem.file_type,
    mediaItem.duration_seconds || parseInt(card?.dataset.mediaDuration, 10) || 0,
    effectiveTrimStart
  );
}

// ================================================================
// CLIP PICKER
//
// A modal panel that shows pre-analysed video segments as a
// thumbnail grid. The user can pick one, which sets the clip start
// point exactly like dragging the trim slider — but smarter.
//
// Flow:
//   1. User clicks "🎬 Smart Clip" (added by buildTrimWarningHtml)
//   2. openClipPicker fetches GET /media/:id/segments
//   3. If _previewBrief exists, also calls POST /media/match-clips
//      so segments are ranked by how well they match the post context
//   4. renderClipPickerModal builds the modal HTML and injects it
//   5. selectClip applies the chosen start point and closes the modal
// ================================================================

// ----------------------------------------------------------------
// openClipPicker — entry point, called by the Smart Clip button.
// Loads segments, optionally ranks them, then shows the modal.
// ----------------------------------------------------------------
// Media ID for the current clip picker session.
// Used by previewClipInPanel() to request a short-lived stream token.
let _clipPickerMediaId  = null;

async function openClipPicker(postId) {
  const card       = document.querySelector(`.wysiwyg-card[data-post-id="${postId}"]`);
  const mediaId    = card?.dataset.mediaId;
  const platform   = card?.dataset.platform || '';

  if (!mediaId) {
    console.warn('[ClipPicker] No mediaId on card — cannot open picker');
    return;
  }

  // Show a loading overlay while we fetch segments
  showClipPickerLoading(postId);

  try {
    // ---- Fetch all segments for this media item ----
    // apiFetch handles the Authorization header automatically
    const segData = await apiFetch(`/media/${mediaId}/segments`);
    const segments = segData.segments;

    if (!segments || segments.length === 0) {
      closeClipPicker();
      showClipPickerError('No segments found for this video. Analysis may still be running.');
      return;
    }

    // ---- Optionally rank segments using the brief context ----
    let rankedIds = null; // null = no ranking (show natural order)

    if (typeof _previewBrief !== 'undefined' && _previewBrief?.post_type) {
      try {
        const matchData = await apiFetch('/media/match-clips', {
          method: 'POST',
          body: JSON.stringify({
            media_item_id: mediaId,
            post_type:     _previewBrief.post_type,
            objective:     _previewBrief.objective,
            tone:          _previewBrief.tone,
            platform,
            limit:         segments.length // rank all, we'll show top ones first
          })
        });
        // rankedIds is ordered best→worst; segments not in this list come after
        rankedIds = (matchData.segments || []).map(s => s.id);
      } catch (matchErr) {
        // Non-fatal — fall back to unranked order
        console.warn('[ClipPicker] match-clips failed, showing unranked:', matchErr.message);
      }
    }

    renderClipPickerModal(postId, platform, segments, rankedIds);

    // Set AFTER renderClipPickerModal — that function calls closeClipPicker()
    // internally (to remove the loading spinner), which resets _clipPickerMediaId.
    // Setting it here ensures it's available when the user clicks a thumbnail.
    _clipPickerMediaId = mediaId;

  } catch (err) {
    console.error('[ClipPicker] Failed to load segments:', err.message);
    closeClipPicker();
    showClipPickerError(`Could not load clips: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// showClipPickerLoading — shows a lightweight overlay while fetching
// ----------------------------------------------------------------
function showClipPickerLoading(postId) {
  closeClipPicker(); // Remove any existing modal first

  const overlay = document.createElement('div');
  overlay.id = 'clip-picker-overlay';
  overlay.className = 'clip-picker-overlay';
  overlay.innerHTML = `
    <div class="clip-picker-modal clip-picker-modal--loading">
      <div class="clip-picker-header">
        <h3 class="clip-picker-title">🎬 Smart Clip</h3>
        <button class="clip-picker-close" onclick="closeClipPicker()" title="Close">✕</button>
      </div>
      <div class="clip-picker-loading-body">
        <div class="spinner spinner-md"></div>
        <p>Loading segments…</p>
      </div>
    </div>`;

  // Clicking the dark backdrop closes the picker
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeClipPicker();
  });

  document.body.appendChild(overlay);
}

// ----------------------------------------------------------------
// showClipPickerError — replaces overlay with an error message
// ----------------------------------------------------------------
function showClipPickerError(message) {
  const overlay = document.createElement('div');
  overlay.id = 'clip-picker-overlay';
  overlay.className = 'clip-picker-overlay';
  overlay.innerHTML = `
    <div class="clip-picker-modal clip-picker-modal--error">
      <div class="clip-picker-header">
        <h3 class="clip-picker-title">🎬 Smart Clip</h3>
        <button class="clip-picker-close" onclick="closeClipPicker()" title="Close">✕</button>
      </div>
      <div class="clip-picker-error-body">
        <p>${message}</p>
        <button class="btn btn-sm" onclick="closeClipPicker()">Close</button>
      </div>
    </div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeClipPicker();
  });

  document.body.appendChild(overlay);
}

// ----------------------------------------------------------------
// renderClipPickerModal — builds and injects the full segment grid.
//
//   segments  — full segment objects from GET /media/:id/segments
//   rankedIds — ordered array of segment IDs (best match first),
//               or null if no ranking is available
// ----------------------------------------------------------------
function renderClipPickerModal(postId, platform, segments, rankedIds) {
  closeClipPicker(); // Remove loading modal

  // Sort segments: ranked first (by score), then remaining in natural order
  let displaySegments;
  if (rankedIds && rankedIds.length > 0) {
    const rankedSet  = new Set(rankedIds);
    const ranked     = rankedIds.map(id => segments.find(s => s.id === id)).filter(Boolean);
    const unranked   = segments.filter(s => !rankedSet.has(s.id));
    displaySegments  = [...ranked, ...unranked];
  } else {
    displaySegments  = [...segments].sort((a, b) => a.start_seconds - b.start_seconds);
  }

  const hasBriefContext = typeof _previewBrief !== 'undefined' && _previewBrief?.post_type;
  const topMatchId      = rankedIds?.[0];

  // Build segment card HTML
  const cardsHtml = displaySegments.map((seg, idx) => {
    const duration    = seg.end_seconds - seg.start_seconds;
    const isBest      = seg.id === topMatchId;
    const thumbSrc    = seg.thumbnail_url || '';
    const startFmt    = formatPreviewDuration(seg.start_seconds);
    const endFmt      = formatPreviewDuration(seg.end_seconds);
    const energyBars  = buildEnergyBarHtml(seg.energy_level || 5);
    const pacingLabel = seg.pacing   ? capitalize(seg.pacing)  : '—';
    const platforms   = Array.isArray(seg.platform_fit) ? seg.platform_fit : [];
    const platformTag = platforms.includes(platform)
      ? `<span class="clip-platform-match">✓ ${capitalize(platform)}</span>`
      : '';

    // Mood badge — color-coded by mood type (see CSS .clip-mood-badge--)
    const moodHtml = seg.mood
      ? `<span class="clip-mood-badge clip-mood-badge--${seg.mood}">${seg.mood}</span>`
      : '';

    // Top 4 tags from the vision AI analysis
    const tagList  = Array.isArray(seg.tags) ? seg.tags.slice(0, 4) : [];
    const tagsHtml = tagList.length > 0
      ? `<div class="clip-tags-row">${tagList.map(t => `<span class="clip-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    // 1-2 sentence description from the vision AI
    const descHtml = seg.description
      ? `<div class="clip-card-desc">${escapeHtml(seg.description)}</div>`
      : '';

    // Clicking the thumbnail area previews the clip.
    // The "Use this clip" button at the bottom selects it.
    // Separating preview and select prevents accidental picks.
    return `
      <div class="clip-card ${isBest ? 'clip-card--best-match' : ''}">
        ${isBest ? '<div class="clip-best-match-badge">Best match</div>' : ''}
        <button
          class="clip-card-thumb-wrap clip-card-thumb-wrap--btn"
          onclick="previewClipInPanel(${seg.start_seconds}, ${seg.end_seconds})"
          title="▶ Click to preview this clip"
        >
          ${thumbSrc
            ? `<img class="clip-card-thumb" src="${thumbSrc}" alt="Segment ${idx + 1} thumbnail" loading="lazy" />`
            : `<div class="clip-card-thumb clip-card-thumb--placeholder">🎬</div>`}
          <span class="clip-card-duration">${duration}s</span>
          <span class="clip-card-play-icon">▶</span>
        </button>
        <div class="clip-card-meta">
          <div class="clip-card-time">${startFmt} → ${endFmt}</div>
          ${descHtml}
          <div class="clip-card-stats">
            ${energyBars}
            <span class="clip-pacing-badge clip-pacing-badge--${seg.pacing || 'moderate'}">${pacingLabel}</span>
            ${moodHtml}
          </div>
          ${tagsHtml}
          ${platformTag}
        </div>
        <button
          class="clip-card-select-btn"
          onclick="selectClip('${postId}', ${seg.start_seconds})"
        >✓ Use this clip</button>
      </div>`;
  }).join('');

  const subtitle = hasBriefContext
    ? 'Segments are ranked by how well they match your brief.'
    : 'Pick a segment to set as your clip start point.';

  const overlay = document.createElement('div');
  overlay.id = 'clip-picker-overlay';
  overlay.className = 'clip-picker-overlay';
  overlay.innerHTML = `
    <div class="clip-picker-modal">
      <div class="clip-picker-header">
        <div>
          <h3 class="clip-picker-title">🎬 Smart Clip</h3>
          <p class="clip-picker-subtitle">${subtitle}</p>
        </div>
        <button class="clip-picker-close" onclick="closeClipPicker()" title="Close">✕</button>
      </div>

      <!--
        Preview panel — hidden until a thumbnail is clicked.
        previewClipInPanel() populates this with a <video> element.
        The video seeks to start_seconds automatically and pauses at end_seconds.
      -->
      <div id="clip-preview-panel" class="clip-preview-panel"></div>

      <div class="clip-cards-grid">
        ${cardsHtml}
      </div>
      <div class="clip-picker-footer">
        <button class="btn btn-sm btn-ghost" onclick="closeClipPicker()">✓ Select Current Video</button>
      </div>
    </div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeClipPicker();
  });

  document.body.appendChild(overlay);
}

// ----------------------------------------------------------------
// buildEnergyBarHtml — renders a mini 5-bar energy indicator.
// energyLevel is 1-10; we map to 5 visual bars (2 levels each).
// ----------------------------------------------------------------
function buildEnergyBarHtml(energyLevel) {
  const filled = Math.round((energyLevel / 10) * 5); // 0–5 bars
  let bars = '';
  for (let i = 1; i <= 5; i++) {
    bars += `<span class="clip-energy-bar ${i <= filled ? 'clip-energy-bar--on' : ''}"></span>`;
  }
  return `<span class="clip-energy-wrap" title="Energy level ${energyLevel}/10">${bars}</span>`;
}

// ----------------------------------------------------------------
// previewClipInPanel — plays the chosen segment in the preview panel.
//
// Chrome's autoplay policy requires play() to be called within a
// synchronous user-gesture handler. An await before play() breaks
// that chain. So we:
//   1. Inject the <video> element immediately (sync, within the click)
//   2. Show a "loading" overlay on the video
//   3. Fetch the stream token async in the background
//   4. Once the token arrives, set src and call play()
//
// By the time play() is called, Chrome considers it part of the
// same gesture because the video element was created synchronously.
// ----------------------------------------------------------------
async function previewClipInPanel(startSeconds, endSeconds) {
  const panel = document.getElementById('clip-preview-panel');
  if (!panel) return;

  if (!_clipPickerMediaId) {
    panel.innerHTML = '<p class="clip-preview-unavailable">Preview not available — media ID missing.</p>';
    panel.classList.add('clip-preview-panel--active');
    return;
  }

  const startFmt = formatPreviewDuration(startSeconds);
  const endFmt   = formatPreviewDuration(endSeconds);
  const duration = endSeconds - startSeconds;

  // Stop any previous video that was playing
  const existing = document.getElementById('clip-preview-video');
  if (existing) { existing.pause(); existing.src = ''; }

  // --- STEP 1: inject the video element SYNCHRONOUSLY ---
  // This keeps us inside the user-gesture context for autoplay.
  // muted is required for autoplay in Chrome/Safari — the user can
  // unmute using the video controls once playback starts.
  panel.innerHTML = `
    <div class="clip-preview-wrap">
      <div class="clip-preview-video-wrap">
        <video
          id="clip-preview-video"
          class="clip-preview-video"
          controls
          preload="auto"
          playsinline
          muted
        ></video>
        <div id="clip-preview-overlay" class="clip-preview-overlay">
          <div class="spinner spinner-sm"></div>
        </div>
      </div>
      <div class="clip-preview-info">
        <span class="clip-preview-label">▶ ${startFmt} → ${endFmt} · ${duration}s</span>
        <button class="clip-preview-close-btn" onclick="clearClipPreview()">✕ Close preview</button>
      </div>
    </div>`;

  panel.classList.add('clip-preview-panel--active');

  const video   = document.getElementById('clip-preview-video');
  const overlay = document.getElementById('clip-preview-overlay');

  // Wire up the end-of-segment pause listener now
  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= endSeconds) video.pause();
  });

  // --- STEP 2: fetch the token async ---
  let streamUrl;
  try {
    const tokenData = await apiFetch(`/media/${_clipPickerMediaId}/stream-token`, { method: 'POST' });
    streamUrl = `/media/${_clipPickerMediaId}/stream?token=${tokenData.token}`;
  } catch (err) {
    console.error('[ClipPicker] stream-token failed:', err.message);
    panel.innerHTML = `<p class="clip-preview-unavailable">Preview unavailable: ${err.message}</p>`;
    return;
  }

  // --- STEP 3: set src, seek, play ---
  // Seek inside loadedmetadata — this is the earliest point where currentTime
  // assignment is reliable. Then play on canplay once buffering has started.
  video.addEventListener('loadedmetadata', () => {
    if (overlay) overlay.remove();
    if (startSeconds > 0) video.currentTime = startSeconds;
  });

  video.addEventListener('canplay', () => {
    video.play().catch(() => {
      // Autoplay still blocked (page in background) — controls are visible so user can tap
    });
  }, { once: true });

  video.src = streamUrl;
  video.load();
}

// ----------------------------------------------------------------
// clearClipPreview — collapses the preview panel without closing
// the entire clip picker, so the user can choose a different clip.
// ----------------------------------------------------------------
function clearClipPreview() {
  const video = document.getElementById('clip-preview-video');
  if (video) { video.pause(); video.src = ''; }

  const panel = document.getElementById('clip-preview-panel');
  if (panel) {
    panel.innerHTML = '';
    panel.classList.remove('clip-preview-panel--active');
  }
}

// ----------------------------------------------------------------
// selectClip — called when the user clicks a segment card.
// Sets the trim start point and closes the modal.
// ----------------------------------------------------------------
function selectClip(postId, startSeconds) {
  // Apply the chosen start point exactly as if the user dragged the slider
  onTrimStartChange(postId, startSeconds);

  // Also update the slider input position if it's currently visible
  const slider = document.getElementById(`trim-start-${postId}`);
  if (slider) {
    slider.value = startSeconds;
  }

  closeClipPicker();
}

// ----------------------------------------------------------------
// closeClipPicker — removes the modal overlay from the DOM.
// Also stops any in-progress video preview.
// ----------------------------------------------------------------
function closeClipPicker() {
  // Stop the preview video before removing the DOM node so the browser
  // doesn't keep buffering in the background after the picker is closed.
  const video = document.getElementById('clip-preview-video');
  if (video) { video.pause(); video.src = ''; }

  const overlay = document.getElementById('clip-picker-overlay');
  if (overlay) overlay.remove();

  _clipPickerMediaId = null;
}

