/**
 * media.js
 *
 * Media Library view for Social Buster.
 * Loaded after publish.js — depends on App, apiFetch, showAlert from app.js.
 *
 * What this module does:
 *   - Renders the Media Library page (called from app.js renderView)
 *   - Shows connected cloud storage providers (Google Drive, Dropbox, Box)
 *   - Displays catalogued media as a filterable grid (videos + images)
 *   - Lets users manually add a media item by URL
 *   - Triggers a background library scan via POST /media/scan
 *   - Lets users connect / disconnect a cloud provider via the API
 *
 * All data comes from:
 *   GET  /media           — list catalogued items (supports ?file_type, ?provider, ?q)
 *   GET  /media/providers — list connected cloud providers
 *   POST /media/scan      — trigger a background scan
 *   POST /media/add       — manually add a URL-based item
 *   DELETE /media/:id     — remove an item from the catalog
 */

// ----------------------------------------------------------------
// Module-level state — only lives as long as this view is on screen
// ----------------------------------------------------------------
let _mediaItems    = [];   // Current list being displayed
let _mediaFilter   = 'all'; // 'all' | 'video' | 'image'
let _mediaProviders = [];   // Connected cloud providers
let _analysisPoller = null; // setInterval handle for analysis status polling

// ----------------------------------------------------------------
// startAnalysisPoller / stopAnalysisPoller
//
// Polls GET /media/:id every 5 seconds for any video currently in
// 'analyzing' or 'pending' state. When a video finishes (status
// becomes 'ready', 'failed', or 'too_large') its badge is updated
// in-place — no full page re-render needed.
//
// The poller stops automatically when no more videos are in-progress.
// ----------------------------------------------------------------
function startAnalysisPoller() {
  if (_analysisPoller) return; // already running

  _analysisPoller = setInterval(async () => {
    // Find all videos still in-progress
    const inProgress = _mediaItems.filter(
      m => m.file_type === 'video' && (m.analysis_status === 'analyzing' || m.analysis_status === 'pending')
    );

    if (inProgress.length === 0) {
      stopAnalysisPoller();
      return;
    }

    // Poll each in-progress video for a status update
    for (const item of inProgress) {
      try {
        const data = await apiFetch(`/media/${item.id}`);
        const fresh = data.media;
        if (!fresh) continue;

        // Only update if status actually changed
        if (fresh.analysis_status !== item.analysis_status) {
          item.analysis_status = fresh.analysis_status;

          // Update just the analysis badge on this card — no full re-render
          const card = document.querySelector(`.media-card[data-id="${item.id}"]`);
          if (card) {
            const header = card.querySelector('.media-card-header');
            if (header) {
              // Remove old analysis badge (last child if it has the analysis class)
              const oldBadge = header.querySelector('.badge-analysis-ready, .badge-analysis-pending, .badge-analysis-failed');
              if (oldBadge) oldBadge.remove();

              // Insert new badge
              const badgeHtml =
                fresh.analysis_status === 'ready'
                  ? `<span class="badge badge-analysis-ready" title="AI analysis complete — clip suggestions available">✅ Analyzed</span>`
                  : fresh.analysis_status === 'failed'
                  ? `<span class="badge badge-analysis-failed" title="Analysis failed">⚠ Analysis failed</span>`
                  : fresh.analysis_status === 'too_large'
                  ? `<span class="badge badge-analysis-failed" title="Video exceeds the 500 MB / 5-minute analysis limit">⚠ Too large to analyze</span>`
                  : null;

              if (badgeHtml) header.insertAdjacentHTML('beforeend', badgeHtml);
            }
          }
        }
      } catch (_) { /* non-fatal — will retry next tick */ }
    }
  }, 5000); // poll every 5 seconds
}

function stopAnalysisPoller() {
  if (_analysisPoller) {
    clearInterval(_analysisPoller);
    _analysisPoller = null;
  }
}

// ----------------------------------------------------------------
// renderMediaLibrary — called by app.js when the user navigates to 'media'
// This is the entry point for the entire media view.
// ----------------------------------------------------------------
async function renderMediaLibrary(el) {
  // Render the skeleton HTML immediately so the user sees structure
  el.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Media Library</div>
        <div class="page-subtitle">Your catalogued videos and images from connected cloud storage.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="openAddMediaModal()">+ Add by URL</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAllMedia()">🗑 Delete All</button>
        <button class="btn btn-primary btn-sm" id="scan-btn" onclick="triggerScan()">🔍 Scan Library</button>
      </div>
    </div>

    <!-- Alerts zone -->
    <div id="media-alerts"></div>

    <!-- Cloud storage connection cards -->
    <div class="card" style="margin-bottom:24px;">
      <div class="card-header">
        <div class="card-title">Cloud Storage</div>
        <div class="text-muted text-sm">Connect your storage so Social Buster can find your videos and images.</div>
      </div>
      <div id="providers-container" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;">
        <div class="loading-overlay" style="position:relative;height:60px;width:100%;background:none;">
          <div class="spinner spinner-sm"></div>
        </div>
      </div>
    </div>

    <!-- Filter bar + media grid -->
    <div class="card">
      <div class="card-header" style="flex-wrap:wrap;gap:8px;">
        <div class="card-title">Your Media</div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm media-filter-btn active" data-filter="all"    onclick="setMediaFilter('all')">All</button>
          <button class="btn btn-secondary btn-sm media-filter-btn"        data-filter="video"  onclick="setMediaFilter('video')">Videos</button>
          <button class="btn btn-secondary btn-sm media-filter-btn"        data-filter="image"  onclick="setMediaFilter('image')">Images</button>
        </div>
      </div>

      <!-- Search box -->
      <div style="margin-bottom:16px;">
        <input
          type="search"
          id="media-search"
          class="form-control"
          placeholder="Search by filename or theme..."
          oninput="onMediaSearch(this.value)"
          style="max-width:340px;"
        />
      </div>

      <!-- Grid renders here -->
      <div id="media-grid">
        <div class="loading-overlay" style="position:relative;height:120px;background:none;">
          <div class="spinner"></div>
        </div>
      </div>
    </div>
  `;

  // Check if we just came back from a Google OAuth flow
  checkOAuthResult();

  // Load providers and media in parallel
  await Promise.all([loadProviders(), loadMedia()]);
}

// ----------------------------------------------------------------
// loadProviders — fetch and render cloud provider cards
// ----------------------------------------------------------------
async function loadProviders() {
  const container = document.getElementById('providers-container');
  if (!container) return;

  try {
    const data = await apiFetch('/media/providers');
    _mediaProviders = data.providers || [];
  } catch (err) {
    _mediaProviders = [];
  }

  const providerDefs = [
    { id: 'google_drive', label: 'Google Drive', icon: '📁', supported: true  },
    { id: 'dropbox',      label: 'Dropbox',       icon: '📦', supported: false },
    { id: 'box',          label: 'Box',            icon: '🗄️', supported: false }
  ];

  container.innerHTML = providerDefs.map(def => {
    const conn        = _mediaProviders.find(p => p.provider === def.id);
    const isConnected = !!conn;
    const hasFolder   = !!conn?.provider_user_id;
    const lastScanned = conn?.last_scanned_at
      ? new Date(conn.last_scanned_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : null;

    if (!def.supported) {
      return `
        <div class="provider-card" style="opacity:0.55;">
          <div class="provider-icon">${def.icon}</div>
          <div class="provider-info">
            <div class="provider-name">${def.label}</div>
            <div class="provider-status text-muted text-xs">Coming soon</div>
          </div>
        </div>`;
    }

    if (!isConnected) {
      return `
        <div class="provider-card">
          <div class="provider-icon">${def.icon}</div>
          <div class="provider-info">
            <div class="provider-name">${def.label}</div>
            <div class="provider-status text-muted">Not connected</div>
            <button class="btn btn-primary btn-xs" style="margin-top:6px;" onclick="connectProvider('${def.id}')">
              Connect ${def.label}
            </button>
          </div>
        </div>`;
    }

    // Connected — show email + folder status
    return `
      <div class="provider-card provider-connected" style="flex-direction:column;align-items:flex-start;min-width:300px;">
        <div style="display:flex;align-items:center;gap:12px;width:100%;">
          <div class="provider-icon">${def.icon}</div>
          <div class="provider-info" style="flex:1;">
            <div class="provider-name">${def.label}</div>
            <div class="provider-status">✅ ${escapeHtml(conn.provider_email || 'Connected')}</div>
            ${hasFolder
              ? `<div class="text-muted text-xs" style="margin-top:2px;">📂 Folder linked${lastScanned ? ' · Scanned ' + lastScanned : ''}</div>`
              : `<div class="text-muted text-xs" style="margin-top:2px;">⚠️ No folder selected yet</div>`
            }
          </div>
          <button class="btn btn-danger btn-xs" onclick="disconnectProvider('${def.id}', '${def.label}')">Disconnect</button>
        </div>

        ${hasFolder
          ? `<div style="display:flex;gap:6px;margin-top:10px;">
               <button class="btn btn-secondary btn-sm" onclick="triggerScan()">🔍 Scan Now</button>
               <button class="btn btn-secondary btn-sm" onclick="toggleFolderSetup('${def.id}')">📂 Change Folder</button>
             </div>
             <div id="folder-setup-${def.id}" style="display:none;margin-top:12px;width:100%;">
               ${folderInputHtml(def.id)}
             </div>`
          : `<div id="folder-setup-${def.id}" style="margin-top:12px;width:100%;">
               ${folderInputHtml(def.id)}
             </div>`
        }
      </div>`;
  }).join('');
}

// ----------------------------------------------------------------
// folderInputHtml — the folder URL input + save button (used inline)
// ----------------------------------------------------------------
function folderInputHtml(providerId) {
  return `
    <p class="text-muted text-sm" style="margin-bottom:8px;">
      In Google Drive, open the folder with your videos/photos.
      Click <strong>Share</strong> → <strong>Copy link</strong>, then paste it below.
    </p>
    <input
      type="url"
      id="folder-url-${providerId}"
      class="form-control"
      placeholder="https://drive.google.com/drive/folders/..."
      style="margin-bottom:8px;"
    />
    <button class="btn btn-primary btn-sm" onclick="saveFolder('${providerId}')">Save &amp; Scan My Media</button>`;
}

// ----------------------------------------------------------------
// toggleFolderSetup — shows/hides the change-folder input
// ----------------------------------------------------------------
function toggleFolderSetup(providerId) {
  const el = document.getElementById(`folder-setup-${providerId}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ----------------------------------------------------------------
// saveFolder — sends the folder URL to the backend
// ----------------------------------------------------------------
async function saveFolder(providerId) {
  const input = document.getElementById(`folder-url-${providerId}`);
  const folderUrl = input?.value?.trim();
  if (!folderUrl) {
    showAlert('media-alerts', 'Please paste a folder link first.', 'error');
    return;
  }

  try {
    const data = await apiFetch(`/media/oauth/${providerId}/folder`, {
      method: 'POST',
      body: JSON.stringify({ folder_url: folderUrl })
    });
    showAlert('media-alerts', data.message, 'success');
    // Reload providers immediately so the folder-linked state shows correctly,
    // then reload media again after the background scan has had time to run
    await loadProviders();
    setTimeout(() => { loadProviders(); loadMedia(); }, 5000);
  } catch (err) {
    showAlert('media-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// loadMedia — fetch and render the media grid
// Respects the current filter and search state.
// ----------------------------------------------------------------
async function loadMedia(searchQuery = '') {
  const grid = document.getElementById('media-grid');
  if (!grid) return;

  // Build query params
  const params = new URLSearchParams();
  if (_mediaFilter !== 'all') params.set('file_type', _mediaFilter);
  if (searchQuery)             params.set('q', searchQuery);

  try {
    const data = await apiFetch(`/media?${params.toString()}`);
    _mediaItems = data.media || [];
  } catch (err) {
    grid.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    return;
  }

  renderMediaGrid(grid);

  // Start polling for analysis status updates on any in-progress videos.
  // Stops automatically once all videos reach a terminal state (ready/failed/too_large).
  stopAnalysisPoller(); // clear any previous poller before starting fresh
  const hasAnalyzing = _mediaItems.some(
    m => m.file_type === 'video' && (m.analysis_status === 'analyzing' || m.analysis_status === 'pending')
  );
  if (hasAnalyzing) startAnalysisPoller();
}

// ----------------------------------------------------------------
// renderMediaGrid — builds the grid HTML from _mediaItems
// ----------------------------------------------------------------
function renderMediaGrid(grid) {
  if (_mediaItems.length === 0) {
    grid.innerHTML = `
      <div style="text-align:center;padding:48px 24px;">
        <div style="font-size:40px;margin-bottom:12px;">🎬</div>
        <div style="font-weight:600;margin-bottom:8px;">No media catalogued yet</div>
        <p class="text-muted text-sm" style="margin-bottom:20px;">
          Connect your cloud storage and click <strong>Scan Library</strong> to catalogue your videos and images,
          or add one manually with <strong>+ Add by URL</strong>.
        </p>
      </div>`;
    return;
  }

  const platformIcons = {
    instagram:'📸', facebook:'👥', tiktok:'🎵',
    linkedin:'💼', x:'𝕏', threads:'🧵', youtube:'▶️'
  };

  const providerLabels = { google_drive:'Drive', dropbox:'Dropbox', box:'Box', manual:'Manual' };

  grid.innerHTML = `
    <div class="media-grid">
      ${_mediaItems.map(item => {
        const isVideo        = item.file_type === 'video';
        const duration       = isVideo && item.duration_seconds
          ? formatDuration(item.duration_seconds)
          : null;
        const analysisStatus = isVideo ? (item.analysis_status || 'pending') : null;
        const themes         = (item.themes || []).slice(0, 3);
        const fitChips = (item.platform_fit || []).map(p =>
          `<span class="platform-chip" title="${p}">${platformIcons[p] || p}</span>`
        ).join('');

        // Build thumbnail URL.
        // - Google Drive: free thumbnails by file ID (works when user is signed in)
        // - AI-generated / Supabase storage: route through our proxy endpoint so
        //   ad blockers never see a third-party request (they block supabase.co URLs)
        const thumbUrl = (item.cloud_provider === 'google_drive' && item.cloud_file_id)
          ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.cloud_file_id)}&sz=w320`
          : (item.cloud_url)
          ? `/media/proxy?url=${encodeURIComponent(item.cloud_url)}`
          : null;

        return `
          <div class="media-card" data-id="${item.id}">

            <!-- Thumbnail (or placeholder if not a Drive file) -->
            <div class="media-thumb-wrap">
              ${thumbUrl
                ? `<img
                     src="${thumbUrl}"
                     alt="${escapeHtml(item.filename)}"
                     class="media-thumb"
                     loading="lazy"
                     onerror="this.parentElement.innerHTML='<div class=media-thumb-placeholder>${isVideo ? '🎬' : '🖼️'}</div>'"
                   />`
                : `<div class="media-thumb-placeholder">${isVideo ? '🎬' : '🖼️'}</div>`
              }
              ${isVideo && duration ? `<span class="media-duration">${duration}</span>` : ''}
            </div>

            <!-- Type badge + provider badge + analysis status -->
            <div class="media-card-header">
              <span class="badge ${isVideo ? 'badge-video' : 'badge-image'}">
                ${isVideo ? '🎬 Video' : '🖼️ Image'}
              </span>
              <span class="badge badge-secondary">${providerLabels[item.cloud_provider] || item.cloud_provider}</span>
              ${analysisStatus === 'ready'
                ? `<span class="badge badge-analysis-ready" title="AI analysis complete — clip suggestions available">✅ Analyzed</span>`
                : analysisStatus === 'analyzing'
                ? `<span class="badge badge-analysis-pending" title="AI analysis in progress..."><span class="spinner spinner-xs"></span> Analyzing</span>`
                : analysisStatus === 'failed'
                ? `<span class="badge badge-analysis-failed" title="Analysis failed — will retry automatically">⚠ Analysis failed</span>`
                : analysisStatus === 'pending'
                ? `<span class="badge badge-analysis-pending" title="Deep analysis is queued and will run in the background">⏳ Analysis queued</span>`
                : analysisStatus === 'too_large'
                ? `<span class="badge badge-analysis-failed" title="Video exceeds the 500 MB / 5-minute analysis limit — use the manual slider to trim">⚠ Too large to analyze</span>`
                : ''
              }
            </div>

            <!-- Filename -->
            <div class="media-filename" title="${escapeHtml(item.filename)}">
              ${escapeHtml(item.filename)}
            </div>

            <!-- Theme tags -->
            ${themes.length > 0
              ? `<div class="media-themes">${themes.map(t => `<span class="theme-chip">${escapeHtml(t)}</span>`).join('')}</div>`
              : ''}

            <!-- Platform fit chips -->
            ${fitChips
              ? `<div class="media-platforms">${fitChips}</div>`
              : ''}

            <!-- Actions -->
            <div class="media-card-actions">
              ${item.cloud_url
                ? `<a href="${escapeHtml(item.cloud_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-xs">View</a>`
                : ''}
              ${isVideo && !item.duration_seconds && item.cloud_url
                ? `<button class="btn btn-secondary btn-xs" id="probe-btn-${item.id}" onclick="probeMediaItem('${item.id}')">🔍 Get Duration</button>`
                : ''}
              <button class="btn btn-danger btn-xs" onclick="deleteMediaItem('${item.id}', '${escapeHtml(item.filename)}')">Remove</button>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// ----------------------------------------------------------------
// setMediaFilter — called by the filter buttons
// ----------------------------------------------------------------
function setMediaFilter(filter) {
  _mediaFilter = filter;

  // Update active button styling
  document.querySelectorAll('.media-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  const searchVal = document.getElementById('media-search')?.value || '';
  loadMedia(searchVal);
}

// ----------------------------------------------------------------
// onMediaSearch — fires on every keystroke in the search box.
// Debounced to avoid hammering the API.
// ----------------------------------------------------------------
let _searchDebounce;
function onMediaSearch(value) {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => loadMedia(value.trim()), 350);
}

// ----------------------------------------------------------------
// triggerScan — calls POST /media/scan to start a background scan.
// The backend starts the scan asynchronously and returns immediately.
// ----------------------------------------------------------------
async function triggerScan() {
  const btn = document.getElementById('scan-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Scanning...';

  try {
    const data = await apiFetch('/media/scan', { method: 'POST' });
    showAlert('media-alerts', data.message || 'Scan started. New items will appear shortly.', 'success');

    // Refresh the grid after a short delay so newly-catalogued items show up
    setTimeout(() => {
      loadMedia(document.getElementById('media-search')?.value || '');
      loadProviders(); // Refresh last_scanned_at timestamps
    }, 3000);

  } catch (err) {
    // Common cause: no cloud storage connected yet
    showAlert('media-alerts', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Scan Library';
  }
}

// ----------------------------------------------------------------
// openAddMediaModal — shows the manual URL-add form in a modal
// ----------------------------------------------------------------
function openAddMediaModal() {
  // Remove any existing modal first
  const existing = document.getElementById('add-media-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'add-media-modal';
  modal.className = 'publish-modal-overlay';
  modal.innerHTML = `
    <div class="publish-modal" style="max-width:480px;">
      <div class="publish-modal-header">
        <h2 class="publish-modal-title">Add Media by URL</h2>
        <button class="publish-modal-close" onclick="closeAddMediaModal()">✕</button>
      </div>

      <div id="add-media-alerts"></div>

      <form id="add-media-form" onsubmit="submitAddMedia(event)">
        <div class="form-group">
          <label for="am-url">File URL <span class="text-danger">*</span></label>
          <input type="url" id="am-url" placeholder="https://drive.google.com/..." required />
          <div class="form-hint">A shareable link to the file in your cloud storage.</div>
        </div>

        <div class="form-group">
          <label for="am-filename">Filename <span class="text-danger">*</span></label>
          <input type="text" id="am-filename" placeholder="product-launch-teaser.mp4" required />
        </div>

        <div class="form-group">
          <label>File Type <span class="text-danger">*</span></label>
          <div style="display:flex;gap:16px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="radio" name="am-type" value="video" checked /> Video
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="radio" name="am-type" value="image" /> Image
            </label>
          </div>
        </div>

        <div class="form-group">
          <label>Platform Fit</label>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">
            ${['instagram','facebook','tiktok','linkedin','x','threads','youtube'].map(p => `
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
                <input type="checkbox" name="am-platforms" value="${p}" /> ${p}
              </label>`).join('')}
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
          <button type="button" class="btn btn-secondary" onclick="closeAddMediaModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="add-media-submit-btn">Add to Library</button>
        </div>
      </form>
    </div>
  `;

  // Close when clicking the backdrop
  modal.addEventListener('click', e => {
    if (e.target === modal) closeAddMediaModal();
  });

  document.body.appendChild(modal);
}

function closeAddMediaModal() {
  const modal = document.getElementById('add-media-modal');
  if (modal) modal.remove();
}

// ----------------------------------------------------------------
// submitAddMedia — sends the form data to POST /media/add
// ----------------------------------------------------------------
async function submitAddMedia(e) {
  e.preventDefault();

  const btn = document.getElementById('add-media-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  const platforms = [...document.querySelectorAll('input[name="am-platforms"]:checked')]
    .map(cb => cb.value);

  const payload = {
    cloud_url:    document.getElementById('am-url').value.trim(),
    filename:     document.getElementById('am-filename').value.trim(),
    file_type:    document.querySelector('input[name="am-type"]:checked')?.value || 'video',
    platform_fit: platforms
  };

  try {
    await apiFetch('/media/add', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    closeAddMediaModal();
    showAlert('media-alerts', `"${payload.filename}" added to your library.`, 'success');

    // Refresh the grid so the new item appears
    await loadMedia(document.getElementById('media-search')?.value || '');

  } catch (err) {
    const alertsEl = document.getElementById('add-media-alerts');
    if (alertsEl) {
      alertsEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
    btn.disabled = false;
    btn.textContent = 'Add to Library';
  }
}

// ----------------------------------------------------------------
// ----------------------------------------------------------------
// probeMediaItem — downloads the video temporarily and runs ffprobe
// to discover its duration. Updates the card without a full page reload.
// ----------------------------------------------------------------
async function probeMediaItem(itemId) {
  const btn = document.getElementById(`probe-btn-${itemId}`);
  if (btn) {
    btn.disabled = true;
    // Show a spinner inline — ffprobe on a remote URL can take up to 30 seconds
    btn.innerHTML = '<span class="spinner spinner-xs"></span> Checking...';
  }

  // Show a note in the main alerts area so the user knows something is happening
  showAlert('media-alerts', '🔍 Reading video metadata — this can take up to 30 seconds for non-Drive files…', 'info');

  try {
    const data = await apiFetch(`/media/${itemId}/probe`, { method: 'POST' });

    // Update the card in the _mediaItems cache so the next render is correct
    const item = _mediaItems.find(m => m.id === itemId);
    if (item) {
      item.duration_seconds = data.duration;
      item.resolution       = data.resolution;
    }

    // Update the card's duration overlay in-place (avoid full re-render)
    const card = document.querySelector(`.media-card[data-id="${itemId}"]`);
    if (card) {
      const thumbWrap = card.querySelector('.media-thumb-wrap');
      if (thumbWrap && data.duration) {
        // Remove the probe button and add the duration badge
        if (btn) btn.remove();
        const durationSpan = document.createElement('span');
        durationSpan.className = 'media-duration';
        durationSpan.textContent = formatDuration(data.duration);
        thumbWrap.appendChild(durationSpan);
      }
    }

    showAlert('media-alerts', `Duration: ${formatDuration(data.duration)} — saved to your library.`, 'success');

  } catch (err) {
    showAlert('media-alerts', `Could not check duration: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🔍 Get Duration';
    }
  }
}

// ----------------------------------------------------------------
// deleteMediaItem — removes a catalogued item (not the actual file)
// ----------------------------------------------------------------
async function deleteMediaItem(itemId, filename) {
  if (!confirm(`Remove "${filename}" from your library?\n\nThe original file in your cloud storage is NOT deleted — only the catalogue entry is removed.`)) return;

  try {
    await apiFetch(`/media/${itemId}`, { method: 'DELETE' });
    showAlert('media-alerts', `"${filename}" removed from your library.`, 'success');

    // Remove the card from the DOM immediately (no need to refetch)
    const card = document.querySelector(`.media-card[data-id="${itemId}"]`);
    if (card) card.remove();

    // If no cards remain, re-render the empty state
    const remaining = document.querySelectorAll('.media-card');
    if (remaining.length === 0) {
      const grid = document.getElementById('media-grid');
      if (grid) renderMediaGrid(grid);
    }
  } catch (err) {
    showAlert('media-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// deleteAllMedia — removes every item in the library for this user.
// AI-generated images are also purged from Supabase Storage.
// Cloud files (Drive, Dropbox, Box) are NOT deleted.
// ----------------------------------------------------------------
async function deleteAllMedia() {
  const count = _mediaItems.length;
  if (count === 0) {
    showAlert('media-alerts', 'Your library is already empty.', 'info');
    return;
  }

  if (!confirm(`Remove all ${count} item${count !== 1 ? 's' : ''} from your library?\n\nAI-generated images will be permanently deleted.\nFiles in Google Drive / Dropbox / Box are NOT affected.`)) return;

  try {
    const data = await apiFetch('/media/all', { method: 'DELETE' });
    showAlert('media-alerts', `All ${data.deleted} item${data.deleted !== 1 ? 's' : ''} removed from your library.`, 'success');

    // Clear local state and re-render the empty grid
    _mediaItems = [];
    const grid = document.getElementById('media-grid');
    if (grid) renderMediaGrid(grid);
  } catch (err) {
    showAlert('media-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// checkOAuthResult — called on page load.
// Reads the sb_oauth cookie that the backend sets after an OAuth redirect.
// Shows a success or error message, then clears the cookie.
// ----------------------------------------------------------------
function checkOAuthResult() {
  const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('sb_oauth='));
  if (!match) return;

  // Clear the cookie immediately
  document.cookie = 'sb_oauth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';

  try {
    const result = JSON.parse(decodeURIComponent(match.split('=').slice(1).join('=')));
    if (result.status === 'connected') {
      showAlert('media-alerts',
        `✅ Google Drive connected${result.email ? ' as ' + result.email : ''}! Now choose which folder to scan.`,
        'success');
    } else if (result.status === 'cancelled') {
      showAlert('media-alerts', 'Google Drive connection was cancelled.', 'error');
    } else if (result.status === 'error') {
      showAlert('media-alerts', 'Could not connect Google Drive. Please try again.', 'error');
    }
  } catch (e) { /* ignore malformed cookie */ }
}

// ----------------------------------------------------------------
// connectProvider — starts the OAuth login flow for a provider.
// For Google Drive: asks the backend for an auth URL, then redirects.
// ----------------------------------------------------------------
async function connectProvider(providerId) {
  if (providerId === 'google_drive') {
    try {
      const data = await apiFetch('/media/oauth/google_drive/start', { method: 'POST' });
      // Full page redirect to Google's login screen
      window.location.href = data.authUrl;
    } catch (err) {
      showAlert('media-alerts', err.message, 'error');
    }
  } else {
    showAlert('media-alerts', `${providerId} connection coming soon.`, 'error');
  }
}

// ----------------------------------------------------------------
// disconnectProvider — removes a cloud connection
// ----------------------------------------------------------------
async function disconnectProvider(providerId, providerLabel) {
  if (!confirm(`Disconnect ${providerLabel}?\n\nYour catalogued media items will remain, but future scans won't fetch new files from this provider.`)) return;

  try {
    await apiFetch(`/media/connect/${providerId}`, { method: 'DELETE' });
    showAlert('media-alerts', `${providerLabel} disconnected.`, 'success');
    await loadProviders(); // Refresh provider cards
  } catch (err) {
    showAlert('media-alerts', err.message, 'error');
  }
}

// ----------------------------------------------------------------
// Utility: format seconds as mm:ss (e.g. 125 → "2:05")
// ----------------------------------------------------------------
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ----------------------------------------------------------------
// Utility: escape HTML special characters to prevent XSS
// Used when inserting user-sourced strings (filenames, URLs) into innerHTML
// ----------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
