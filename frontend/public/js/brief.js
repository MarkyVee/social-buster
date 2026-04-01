/**
 * brief.js
 *
 * The content brief form — the main creative starting point for every post.
 * Renders the form, validates it, submits to the API, and shows results.
 *
 * Called from app.js when the user navigates to #brief.
 * renderBriefForm(containerEl) is called by app.js's renderView() function.
 */

// ----------------------------------------------------------------
// Form option definitions — kept here so they're easy to update.
//
// Each option includes semantic metadata used by two systems:
//   1. LLM prompt injection (llm_style_note) — richer generation
//   2. Video clip matching (video_energy, video_pacing, video_mood,
//      ideal_segments, avoid_segments) — used by the clip picker UI
//      when the video_segments phase is built.
//
// The backend (data/briefSemantics.js) holds its own copy of llm_style_note
// for server-side prompt injection. Keep both in sync if you change wording.
// ----------------------------------------------------------------

const POST_TYPES = [
  {
    value: 'educational', label: '📚 Educational', desc: 'Teach your audience something valuable',
    video_energy: [1, 4], video_pacing: ['slow', 'medium'],
    video_mood: ['calm', 'focused', 'professional'],
    ideal_segments: ['explanation', 'demonstration', 'whiteboard', 'talking-head'],
    avoid_segments: ['action', 'fast-cuts', 'high-energy'],
    llm_style_note: 'Build understanding progressively. Use analogies. Teach one clear concept. Avoid information overload.',
    platform_notes: { linkedin: 'longer captions ok', tiktok: 'hook must answer a question' }
  },
  {
    value: 'product_launch', label: '🚀 Product Launch', desc: 'Introduce a new product or service',
    video_energy: [6, 10], video_pacing: ['fast', 'medium'],
    video_mood: ['exciting', 'confident', 'aspirational'],
    ideal_segments: ['product-reveal', 'reaction', 'before-after', 'action'],
    avoid_segments: ['slow-explanation', 'talking-head'],
    llm_style_note: 'Lead with the transformation or result. Name the problem it solves before describing features. Build excitement and urgency.',
    platform_notes: { instagram: 'use Reels for reach', tiktok: 'show the reveal fast' }
  },
  {
    value: 'behind_the_scenes', label: '🎬 Behind the Scenes', desc: 'Show how your business really works',
    video_energy: [2, 6], video_pacing: ['slow', 'medium'],
    video_mood: ['authentic', 'candid', 'relatable'],
    ideal_segments: ['process', 'workspace', 'candid', 'talking-head'],
    avoid_segments: ['polished-promo', 'fast-cuts'],
    llm_style_note: 'Be real and unfiltered. Share the mess and the process, not just the highlight reel. First-person perspective creates intimacy.',
    platform_notes: { instagram: 'Stories style works well', threads: 'authentic beats polished here' }
  },
  {
    value: 'lead_generation', label: '🎯 Lead Generation', desc: 'Capture contact details or enquiries',
    video_energy: [4, 7], video_pacing: ['medium'],
    video_mood: ['professional', 'confident', 'helpful'],
    ideal_segments: ['talking-head', 'demonstration', 'testimonial'],
    avoid_segments: ['vague', 'no-cta'],
    llm_style_note: 'Lead with a specific pain point. Promise a clear, specific outcome. Make the CTA extremely specific — "DM me the word READY" not "reach out".',
    platform_notes: { linkedin: 'lead magnet angle works', instagram: 'comment trigger works well' }
  },
  {
    value: 'community_engagement', label: '💬 Community', desc: 'Spark conversation with your audience',
    video_energy: [2, 6], video_pacing: ['slow', 'medium'],
    video_mood: ['warm', 'relatable', 'curious'],
    ideal_segments: ['talking-head', 'candid', 'reaction'],
    avoid_segments: ['hard-sell', 'polished-promo'],
    llm_style_note: 'Make the audience the star. Ask a genuine question you actually want answered. The more specific and relatable the question, the more it gets answered.',
    platform_notes: { instagram: 'this-or-that performs', facebook: 'polls and questions win' }
  },
  {
    value: 'promotional', label: '🏷️ Promotional', desc: 'Drive sales with an offer or discount',
    video_energy: [5, 9], video_pacing: ['medium', 'fast'],
    video_mood: ['exciting', 'urgent', 'direct'],
    ideal_segments: ['product-showcase', 'before-after', 'testimonial'],
    avoid_segments: ['slow-build', 'indirect'],
    llm_style_note: 'State the offer in the first sentence. Use real urgency. Remove every word of friction. Benefits before features.',
    platform_notes: { tiktok: 'show product in first 3 seconds', facebook: 'tag a friend CTA works' }
  },
  {
    value: 'story_personal', label: '❤️ Story / Personal', desc: 'Share a personal story or experience',
    video_energy: [2, 5], video_pacing: ['slow', 'medium'],
    video_mood: ['emotional', 'vulnerable', 'authentic'],
    ideal_segments: ['talking-head', 'candid', 'b-roll-personal'],
    avoid_segments: ['polished', 'corporate'],
    llm_style_note: 'Open with the moment of tension — not the backstory. Use specific details: real numbers, real places, real emotions. Vulnerability earns trust.',
    platform_notes: { instagram: 'carousel works for story arcs', linkedin: 'professional lessons from personal story' }
  },
  {
    value: 'news_update', label: '📣 News / Update', desc: 'Share a business update or announcement',
    video_energy: [3, 7], video_pacing: ['medium'],
    video_mood: ['confident', 'clear', 'professional'],
    ideal_segments: ['talking-head', 'announcement', 'product-reveal'],
    avoid_segments: ['vague', 'burying-the-lede'],
    llm_style_note: 'State the news in the first sentence — never bury the lead. Answer: what changed, why it matters, what the audience should do.',
    platform_notes: { linkedin: 'milestone announcements perform well', x: 'short and direct wins' }
  }
];

const OBJECTIVES = [
  {
    value: 'engagement', label: '❤️ Engagement', desc: 'Likes, reactions, and interactions',
    video_preference: 'hook-heavy', caption_style: 'question-driven', cta_style: 'reaction-bait',
    energy_boost: +1,
    llm_style_note: 'The hook must trigger an emotional reaction (surprise, humor, validation). End with a question easy to answer in one word or emoji.'
  },
  {
    value: 'comments', label: '💬 Comments', desc: 'Get people talking in the comments',
    video_preference: 'conversational', caption_style: 'debate-starter', cta_style: 'comment-bait',
    energy_boost: 0,
    llm_style_note: 'Make a statement people want to agree with or push back on. "What would you add?" or "Drop a comment if this is you" closes drive comment volume.'
  },
  {
    value: 'sharing', label: '🔁 Sharing', desc: 'Get people to share your content',
    video_preference: 'high-value', caption_style: 'save-worthy', cta_style: 'tag-a-friend',
    energy_boost: 0,
    llm_style_note: 'Create content that makes people look good or smart for sharing it. "Tag someone who needs to hear this" in the CTA.'
  },
  {
    value: 'clicks', label: '🖱️ Clicks', desc: 'Drive traffic to a link',
    video_preference: 'teaser', caption_style: 'benefit-led', cta_style: 'link-in-bio',
    energy_boost: +1,
    llm_style_note: 'Tease the full value without giving it away. Create an open loop the link closes. "Link in bio to get the free [X]" — not just "click the link".'
  },
  {
    value: 'conversions', label: '💰 Conversions', desc: 'Sales, sign-ups, or bookings',
    video_preference: 'proof-heavy', caption_style: 'objection-busting', cta_style: 'direct-buy',
    energy_boost: +2,
    llm_style_note: 'Lead with social proof or a specific transformation result. Address the biggest objection before it arises. Urgency must be real. Direct CTA only.'
  },
  {
    value: 'awareness', label: '📡 Awareness', desc: 'Reach new people',
    video_preference: 'broad-appeal', caption_style: 'educational', cta_style: 'follow-save',
    energy_boost: 0,
    llm_style_note: 'Assume the reader knows nothing about this brand. Lead with a universal problem or curiosity hook. Make following or saving feel like a no-brainer.'
  },
  {
    value: 'community_conversation', label: '🗣️ Discussion', desc: 'Start a meaningful conversation',
    video_preference: 'opinion-led', caption_style: 'open-ended', cta_style: 'reply-bait',
    energy_boost: -1,
    llm_style_note: 'Share a genuine opinion or unpopular truth. Invite respectful debate. "I might be wrong — tell me what you think." Open-ended questions only.'
  }
];

const TONES = [
  {
    value: 'professional', label: '👔 Professional', desc: 'Polished, credible, business-appropriate',
    video_mood_match: ['professional', 'confident', 'calm'],
    energy_min: 2, energy_max: 6, pacing: ['slow', 'medium'],
    llm_style_note: 'Formal but not stiff. Clear and precise. No slang, no excessive punctuation. Build credibility through specifics and evidence, not assertions.'
  },
  {
    value: 'friendly', label: '😊 Friendly', desc: 'Warm, approachable, conversational',
    video_mood_match: ['warm', 'relatable', 'candid'],
    energy_min: 3, energy_max: 7, pacing: ['medium'],
    llm_style_note: 'Write like talking to a trusted friend. Use contractions and second person. Short sentences. Light emoji use. Make the reader feel seen, never talked at.'
  },
  {
    value: 'bold', label: '⚡ Bold', desc: 'Confident, direct, unapologetic',
    video_mood_match: ['energetic', 'confident', 'direct'],
    energy_min: 6, energy_max: 10, pacing: ['fast', 'medium'],
    llm_style_note: 'Short punchy sentences. No hedging words (perhaps, might, could, maybe). State opinions as facts. Use contrast: "Most people do X. Wrong." Avoid exclamation marks.'
  },
  {
    value: 'emotional', label: '💖 Emotional', desc: 'Heartfelt, empathetic, story-driven',
    video_mood_match: ['emotional', 'vulnerable', 'authentic'],
    energy_min: 1, energy_max: 5, pacing: ['slow', 'medium'],
    llm_style_note: 'Use specific sensory details — not "I was overwhelmed" but describe the exact moment. First-person present tense. Leave white space. Feel before tell.'
  },
  {
    value: 'humorous', label: '😄 Humorous', desc: 'Fun, witty, light-hearted',
    video_mood_match: ['playful', 'surprising', 'energetic'],
    energy_min: 4, energy_max: 9, pacing: ['fast', 'medium'],
    llm_style_note: 'Subvert expectations. Set up an assumption, flip it. Specificity makes things funnier. Understatement beats exaggeration. Emoji sparingly — they land harder.'
  },
  {
    value: 'authoritative', label: '🎯 Authoritative', desc: 'Expert, data-backed, decisive',
    video_mood_match: ['professional', 'confident', 'focused'],
    energy_min: 3, energy_max: 7, pacing: ['medium'],
    llm_style_note: 'Ground every claim in data or firsthand experience. "Most people believe X — the data says Y." Position as someone who has seen this play out. Never hedge.'
  },
  {
    value: 'inspirational', label: '✨ Inspirational', desc: 'Motivating, uplifting, aspirational',
    video_mood_match: ['uplifting', 'aspirational', 'energetic'],
    energy_min: 4, energy_max: 8, pacing: ['medium', 'fast'],
    llm_style_note: 'Speak to who the reader wants to become, not who they are now. Use "you can" and "you will." End with a CTA that feels like a gift, not a task.'
  }
];

const PLATFORMS = [
  { value: 'instagram', label: 'Instagram', icon: '📸' },
  { value: 'facebook',  label: 'Facebook',  icon: '👥' },
  { value: 'tiktok',    label: 'TikTok',    icon: '🎵' },
  { value: 'linkedin',  label: 'LinkedIn',  icon: '💼' },
  { value: 'x',         label: 'X',         icon: '𝕏' },
  { value: 'threads',   label: 'Threads',   icon: '🧵' },
  { value: 'whatsapp',  label: 'WhatsApp',  icon: '💬' },
  { value: 'telegram',  label: 'Telegram',  icon: '✈️' }
];

// ----------------------------------------------------------------
// Render a group of selectable tile buttons (Post Type, Objective, Tone)
// ----------------------------------------------------------------
function renderTileGroup(name, options, columns = 4) {
  return `
    <div class="tile-group" style="display:grid;grid-template-columns:repeat(${columns},1fr);gap:8px;">
      ${options.map(opt => `
        <label class="tile-option" data-value="${opt.value}">
          <input type="radio" name="${name}" value="${opt.value}" style="display:none;" />
          <div class="tile-label">${opt.label}</div>
          <div class="tile-desc">${opt.desc}</div>
        </label>
      `).join('')}
    </div>`;
}

// ----------------------------------------------------------------
// renderBriefForm — called by app.js when navigating to #brief
// ----------------------------------------------------------------
function renderBriefForm(el) {
  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">New Content Brief</div>
      <div class="page-subtitle">Tell the AI what to create and it will generate 3 options per platform.</div>
    </div>

    <div id="brief-alerts"></div>

    <form id="brief-form">

      <!-- POST TYPE -->
      <div class="brief-section">
        <div class="brief-section-label">1. What type of post is this?</div>
        ${renderTileGroup('post_type', POST_TYPES, 4)}
        <div class="field-error hidden" id="err-post_type">Please select a post type</div>
      </div>

      <!-- OBJECTIVE -->
      <div class="brief-section">
        <div class="brief-section-label">2. What is the main objective?</div>
        ${renderTileGroup('objective', OBJECTIVES, 4)}
        <div class="field-error hidden" id="err-objective">Please select an objective</div>
      </div>

      <!-- TONE -->
      <div class="brief-section">
        <div class="brief-section-label">3. What tone should the content use?</div>
        ${renderTileGroup('tone', TONES, 4)}
        <div class="field-error hidden" id="err-tone">Please select a tone</div>
      </div>

      <!-- PLATFORMS -->
      <div class="brief-section">
        <div class="brief-section-label">4. Which platforms should we generate posts for?</div>
        <div class="platform-grid">
          ${PLATFORMS.map(p => {
            const activePlatforms = ['instagram', 'facebook'];
            const comingSoon = !activePlatforms.includes(p.value);
            return `
            <label class="platform-option${comingSoon ? ' platform-coming-soon' : ''}"
                   style="${comingSoon ? 'opacity:0.4;pointer-events:none;position:relative;' : ''}">
              <input type="checkbox" name="platforms" value="${p.value}" ${comingSoon ? 'disabled' : ''} />
              <div class="platform-icon">${p.icon}</div>
              <div class="platform-name">${p.label}</div>
              ${comingSoon ? '<div style="font-size:9px;color:#94a3b8;margin-top:2px;font-weight:600;letter-spacing:0.3px;">COMING SOON</div>' : ''}
            </label>`;
          }).join('')}
        </div>
        <div class="field-error hidden" id="err-platforms">Please select at least one platform</div>
        <!-- Timing hint — shown dynamically when 4+ platforms are selected -->
        <div class="form-hint hidden" id="platform-timing-hint" style="margin-top:8px;">
          ⏱ Selecting 4+ platforms generates in batches (~10–20 seconds each). Total time: ~30–60 seconds.
        </div>
      </div>

      <!-- PRE-FLIGHT INTELLIGENCE PANEL -->
      <!-- Populated by fetchAndRenderPreflight() once post_type + platform are selected -->
      <div id="brief-preflight" class="brief-preflight hidden"></div>

      <!-- OPTIONAL NOTES -->
      <div class="brief-section">
        <div class="brief-section-label">6. Any extra context or specific instructions? <span style="color:#94a3b8;font-weight:400;">(optional)</span></div>
        <textarea
          id="brief-notes"
          placeholder="e.g. 'Mention our summer sale ends Friday', 'Include the hook: Everyone told me I was wrong...', 'Avoid mentioning competitors'"
          rows="3"
          style="width:100%;"
        ></textarea>
      </div>

      <!-- SUBMIT -->
      <div class="brief-submit">
        <button type="submit" class="btn btn-primary btn-lg" id="brief-submit-btn">
          ✨ Generate Posts with AI
        </button>
        <div class="text-sm text-muted mt-4" id="brief-generate-hint">
          The AI will generate 3 options per selected platform.
          This usually takes 10–30 seconds.
        </div>
      </div>

    </form>

    <!-- LOADING STATE (hidden until submit) -->
    <div class="brief-loading hidden" id="brief-loading">
      <div class="spinner spinner-lg"></div>
      <div class="brief-loading-title">Generating your posts...</div>
      <div class="brief-loading-sub" id="brief-loading-status">
        The AI is writing platform-optimised content for you. This takes 10–30 seconds.
      </div>
    </div>
  `;

  // Inject styles for brief-specific UI elements
  injectBriefStyles();

  // Wire up tile selection behaviour
  initTileGroups();

  // Show a timing hint when the user selects 4 or more platforms.
  // Also refresh the pre-flight panel when the platform selection changes.
  document.querySelectorAll('input[name="platforms"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const count = document.querySelectorAll('input[name="platforms"]:checked').length;
      const hint  = document.getElementById('platform-timing-hint');
      if (hint) hint.classList.toggle('hidden', count < 4);

      maybeRefreshPreflight();
    });
  });

  // Attach form submit handler
  document.getElementById('brief-form').addEventListener('submit', handleBriefSubmit);
}

// ----------------------------------------------------------------
// Tile group interactivity — clicking a tile selects the radio.
// Also triggers the pre-flight panel refresh when post_type changes.
// ----------------------------------------------------------------
function initTileGroups() {
  document.querySelectorAll('.tile-option').forEach(tile => {
    tile.addEventListener('click', () => {
      const radio = tile.querySelector('input[type="radio"]');
      if (!radio) return;

      // Deselect all tiles in this group
      const groupName = radio.name;
      document.querySelectorAll(`input[name="${groupName}"]`).forEach(r => {
        r.closest('.tile-option').classList.remove('selected');
      });

      // Select this tile
      radio.checked = true;
      tile.classList.add('selected');

      // Clear the error for this field
      const errEl = document.getElementById(`err-${groupName}`);
      if (errEl) errEl.classList.add('hidden');

      // Refresh pre-flight panel when any of the three key signals change
      if (['post_type', 'objective', 'tone'].includes(groupName)) {
        maybeRefreshPreflight();
      }
    });
  });
}

// ----------------------------------------------------------------
// Validate form and return brief data or null if invalid
// ----------------------------------------------------------------
function validateBriefForm() {
  let valid = true;

  // Post type
  const postType = document.querySelector('input[name="post_type"]:checked');
  document.getElementById('err-post_type').classList.toggle('hidden', !!postType);
  if (!postType) valid = false;

  // Objective
  const objective = document.querySelector('input[name="objective"]:checked');
  document.getElementById('err-objective').classList.toggle('hidden', !!objective);
  if (!objective) valid = false;

  // Tone
  const tone = document.querySelector('input[name="tone"]:checked');
  document.getElementById('err-tone').classList.toggle('hidden', !!tone);
  if (!tone) valid = false;

  // Target audience
  // Platforms
  const platforms = [...document.querySelectorAll('input[name="platforms"]:checked')].map(cb => cb.value);
  document.getElementById('err-platforms').classList.toggle('hidden', platforms.length > 0);
  if (platforms.length === 0) valid = false;

  if (!valid) return null;

  return {
    post_type:       postType.value,
    objective:       objective.value,
    tone:            tone.value,
    platforms:       platforms,
    notes:           document.getElementById('brief-notes').value.trim() || null
  };
}

// ----------------------------------------------------------------
// Handle brief form submission
// ----------------------------------------------------------------
async function handleBriefSubmit(e) {
  e.preventDefault();

  // Gate: mandatory profile fields must be filled before AI generation.
  // The intelligence engine needs these to form a cohort key and produce
  // relevant recommendations. Without them the output is generic.
  if (typeof getProfileCompletionStatus === 'function') {
    const profileStatus = getProfileCompletionStatus();
    if (!profileStatus.complete) {
      const missingList = profileStatus.missing.map(m => m.label).join(', ');
      showAlert('brief-alerts',
        `Complete your profile before generating posts. Missing required fields: ${missingList}. ` +
        `<a href="#profile" onclick="navigate('profile')" style="text-decoration:underline;">Go to My Profile →</a>`,
        'error',
        true  // allowHtml — this message is internal, not user input
      );
      return;
    }
  }

  const briefData = validateBriefForm();
  if (!briefData) return; // Validation failed — errors shown inline

  const submitBtn = document.getElementById('brief-submit-btn');
  const form      = document.getElementById('brief-form');
  const loading   = document.getElementById('brief-loading');
  const statusEl  = document.getElementById('brief-loading-status');

  // Show loading state, hide form
  form.classList.add('hidden');
  loading.classList.remove('hidden');
  submitBtn.disabled = true;

  // Cycle status messages to reassure the user while waiting
  const statusMessages = [
    'The AI is reading your brief...',
    'Crafting platform-specific hooks...',
    'Writing captions and hashtags...',
    'Selecting the best CTAs...',
    'Almost done — polishing the final drafts...'
  ];
  let msgIndex = 0;
  const statusInterval = setInterval(() => {
    msgIndex = (msgIndex + 1) % statusMessages.length;
    if (statusEl) statusEl.textContent = statusMessages[msgIndex];
  }, 5000);

  try {
    // POST to /briefs — this triggers AI generation and may take 10-30 seconds
    const data = await apiFetch('/briefs', {
      method: 'POST',
      body: JSON.stringify(briefData)
    });

    clearInterval(statusInterval);

    // Success — navigate to the posts view and pass the generated posts
    // The posts view in app.js will display them
    renderGeneratedPosts(data.brief, data.posts);

  } catch (err) {
    clearInterval(statusInterval);

    // Hide loading, show form again with error
    loading.classList.add('hidden');
    form.classList.remove('hidden');
    submitBtn.disabled = false;

    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else {
      showAlert('brief-alerts', err.message, 'error');
    }
  }
}

// ----------------------------------------------------------------
// Render the generated posts results view.
// Groups posts by platform and shows all options.
// Phase 3 will replace this with full WYSIWYG previews.
// ----------------------------------------------------------------
function renderGeneratedPosts(brief, posts) {
  const contentEl = document.getElementById('main-content-area');
  if (!contentEl) return;

  // Group posts by platform
  const byPlatform = {};
  posts.forEach(post => {
    if (!byPlatform[post.platform]) byPlatform[post.platform] = [];
    byPlatform[post.platform].push(post);
  });

  const platformOrder = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'whatsapp', 'telegram'];
  const sortedPlatforms = Object.keys(byPlatform).sort(
    (a, b) => platformOrder.indexOf(a) - platformOrder.indexOf(b)
  );

  const platformIcons = { instagram:'📸', facebook:'👥', tiktok:'🎵', linkedin:'💼', x:'𝕏', threads:'🧵', whatsapp:'💬', telegram:'✈️' };

  const postTypeLabel = POST_TYPES.find(t => t.value === brief.post_type)?.label || brief.post_type;
  const objectiveLabel = OBJECTIVES.find(o => o.value === brief.objective)?.label || brief.objective;
  const toneLabel = TONES.find(t => t.value === brief.tone)?.label || brief.tone;

  contentEl.innerHTML = `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div class="page-title">Generated Posts</div>
        <div class="page-subtitle">
          ${postTypeLabel} · ${objectiveLabel} · ${toneLabel} ·
          <span style="color:#6366f1;">${posts.length} posts across ${sortedPlatforms.length} platform${sortedPlatforms.length > 1 ? 's' : ''}</span>
        </div>
      </div>
      <button class="btn btn-secondary" onclick="navigate('brief')">✏️ New Brief</button>
    </div>

    <div id="posts-alerts"></div>

    ${sortedPlatforms.map(platform => `
      <div class="platform-section" style="margin-bottom:32px;">
        <div class="platform-section-header">
          <span class="platform-badge">${platformIcons[platform] || '📱'} ${platform.charAt(0).toUpperCase() + platform.slice(1)}</span>
        </div>

        <div class="post-options-grid">
          ${byPlatform[platform].map(post => renderPostCard(post)).join('')}
        </div>
      </div>
    `).join('')}
  `;

  // Attach inline edit handlers
  initPostCardEditing();

  // Update sidebar active state
  updateSidebarActiveState('posts');
}

// ----------------------------------------------------------------
// Render a single post option card with inline editing
// ----------------------------------------------------------------
function renderPostCard(post) {
  const hashtagsText = post.hashtags?.length ? post.hashtags.map(h => `#${h}`).join(' ') : '';

  // Build the media attachment area.
  // If the post already has media attached (loaded from DB), show its details.
  // Otherwise show the "Attach Media" prompt.
  const mediaArea = post.media_id
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
       </div>`;

  // Embed brief context as data attributes so openMediaPicker can rank
  // the media library by relevance without needing a separate DB lookup.
  const briefPostType  = post.briefs?.post_type  || '';
  const briefObjective = post.briefs?.objective  || '';
  const briefTone      = post.briefs?.tone       || '';
  const briefPlatform  = post.platform           || '';

  return `
    <div class="post-card"
      data-post-id="${post.id}"
      data-media-id="${post.media_id || ''}"
      data-brief-post-type="${escapeHtml(briefPostType)}"
      data-brief-objective="${escapeHtml(briefObjective)}"
      data-brief-tone="${escapeHtml(briefTone)}"
      data-brief-platform="${escapeHtml(briefPlatform)}"
    >
      <div class="post-card-header">
        <div class="post-card-option">Option ${post.option_number}</div>
        <div class="post-card-actions">
          <button class="btn btn-sm btn-secondary save-post-btn" data-id="${post.id}" onclick="savePostEdits('${post.id}')">
            💾 Save
          </button>
          <button class="btn btn-sm btn-primary approve-post-btn" data-id="${post.id}" onclick="approvePost('${post.id}')">
            ✅ Approve
          </button>
          <button class="btn btn-sm btn-danger delete-post-btn" data-id="${post.id}" onclick="deletePost('${post.id}')" title="Delete this post">
            🗑️
          </button>
        </div>
      </div>

      <div class="post-field">
        <div class="post-field-label">Hook</div>
        <div
          class="post-field-content editable"
          data-field="hook"
          data-id="${post.id}"
          contenteditable="true"
          spellcheck="true"
        >${escapeHtml(post.hook)}</div>
      </div>

      <div class="post-field">
        <div class="post-field-label">Caption</div>
        <div
          class="post-field-content editable caption-field"
          data-field="caption"
          data-id="${post.id}"
          contenteditable="true"
          spellcheck="true"
        >${escapeHtml(post.caption)}</div>
      </div>

      ${hashtagsText ? `
      <div class="post-field">
        <div class="post-field-label">Hashtags</div>
        <div
          class="post-field-content editable hashtag-field"
          data-field="hashtags"
          data-id="${post.id}"
          contenteditable="true"
          spellcheck="false"
        >${escapeHtml(hashtagsText)}</div>
      </div>` : ''}

      <div class="post-field">
        <div class="post-field-label">Call to Action</div>
        <div
          class="post-field-content editable"
          data-field="cta"
          data-id="${post.id}"
          contenteditable="true"
          spellcheck="true"
        >${escapeHtml(post.cta)}</div>
      </div>

      ${post.media_recommendation ? `
      <div class="post-field post-field-media">
        <div class="post-field-label">🎬 Recommended Media</div>
        <div class="post-field-content media-rec">${escapeHtml(post.media_recommendation)}</div>
      </div>` : ''}

      <div class="post-field">
        <div class="post-field-label">📎 Media</div>
        ${mediaArea}
      </div>

      <div class="post-card-status">
        <span class="badge badge-${post.status}">${post.status}</span>
      </div>
    </div>
  `;
}

// ----------------------------------------------------------------
// Inline post editing — collect edits and save via PUT /posts/:id
// ----------------------------------------------------------------
function initPostCardEditing() {
  // Mark card as dirty when user edits any field
  document.querySelectorAll('.editable').forEach(el => {
    el.addEventListener('input', () => {
      const postId = el.dataset.id;
      const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
      if (card) card.dataset.dirty = 'true';
    });
  });
}

async function savePostEdits(postId) {
  const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
  if (!card) return;

  // Collect current values from all editable fields in this card
  const fields = {};
  card.querySelectorAll('.editable[data-field]').forEach(el => {
    const field = el.dataset.field;
    const text = el.innerText.trim();

    if (field === 'hashtags') {
      // Parse hashtag string back into an array
      fields.hashtags = text.split(/\s+/).map(h => h.replace(/^#/, '').trim()).filter(Boolean);
    } else {
      fields[field] = text;
    }
  });

  // Include media_id if it's stored on the card (set by attachMediaToPost / removePostMedia)
  // Only send it if the dataset key is present to avoid wiping an existing attachment
  // when the user saves text edits on a freshly-rendered card (where dataset.mediaId is '').
  if (card.dataset.mediaId !== undefined) {
    fields.media_id = card.dataset.mediaId || null;
  }

  // Include trim_start_seconds if set (from the WYSIWYG trim start input)
  if (card.dataset.trimStartSeconds !== undefined && card.dataset.trimStartSeconds !== '') {
    fields.trim_start_seconds = parseInt(card.dataset.trimStartSeconds, 10) || 0;
  }
  // Include trim_end_seconds if set (from the clip picker — where the clip ends).
  // Sending null explicitly clears a previously saved end point (e.g. user switches to manual slider).
  if (card.dataset.trimEndSeconds !== undefined && card.dataset.trimEndSeconds !== '') {
    fields.trim_end_seconds = parseInt(card.dataset.trimEndSeconds, 10) || null;
  }

  const saveBtn = card.querySelector('.save-post-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    await apiFetch(`/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify(fields)
    });

    card.dataset.dirty = 'false';
    saveBtn.textContent = '✓ Saved';
    setTimeout(() => { saveBtn.textContent = '💾 Save'; }, 2000);

  } catch (err) {
    showAlert('posts-alerts', `Failed to save: ${err.message}`, 'error');
    saveBtn.textContent = '💾 Save';
  } finally {
    saveBtn.disabled = false;
  }
}

async function approvePost(postId) {
  const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
  if (!card) return;

  // If there are unsaved edits, save first
  if (card.dataset.dirty === 'true') {
    await savePostEdits(postId);
  }

  const approveBtn = card.querySelector('.approve-post-btn');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Approving...';

  try {
    await apiFetch(`/posts/${postId}/approve`, { method: 'POST' });

    // Update the status badge on the card
    const badge = card.querySelector('.badge');
    if (badge) {
      badge.className = 'badge badge-approved';
      badge.textContent = 'approved';
    }

    approveBtn.textContent = '✓ Approved';
    approveBtn.classList.remove('btn-primary');
    approveBtn.classList.add('btn-secondary');

    // Show publish options (Phase 5 will expand this)
    showAlert('posts-alerts', 'Post approved! Publishing options coming in Phase 5.', 'success');

  } catch (err) {
    if (err.limitReached) {
      showUpgradePrompt(err.feature, err.message);
    } else {
      showAlert('posts-alerts', `Failed to approve: ${err.message}`, 'error');
    }
    approveBtn.disabled = false;
    approveBtn.textContent = '✅ Approve';
  }
}

// ----------------------------------------------------------------
// Utility: escape HTML to prevent XSS in contenteditable fields
// ----------------------------------------------------------------
// capitalize — used by the pre-flight panel and elsewhere in this file
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----------------------------------------------------------------
// Inject brief-specific CSS styles that are unique to this view
// ----------------------------------------------------------------
// ================================================================
// INTELLIGENCE PRE-FLIGHT PANEL
//
// Shown between the platforms section and optional notes.
// Fires automatically once the user has selected a post_type and
// at least one platform. Uses the first selected platform for the
// cohort lookup (most relevant when one platform is chosen).
//
// Displays up to three signal cards:
//   1. From your history  — user's own top hooks + best posting time
//   2. From your industry peers — cohort avg metrics + top tones/hooks
//   3. What's trending — snippet from research cache
//
// All signals are ADVISORY. The user can read them, then proceed
// or adjust their notes/brief based on what they see.
// ================================================================

let _preflightDebounceTimer = null;

// ----------------------------------------------------------------
// maybeRefreshPreflight — debounced trigger.
// Reads current form state and calls fetchAndRenderPreflight if
// both post_type and at least one platform are selected.
// ----------------------------------------------------------------
function maybeRefreshPreflight() {
  clearTimeout(_preflightDebounceTimer);

  _preflightDebounceTimer = setTimeout(() => {
    const postTypeEl  = document.querySelector('input[name="post_type"]:checked');
    const platformEls = document.querySelectorAll('input[name="platforms"]:checked');

    if (!postTypeEl || platformEls.length === 0) return;

    // Use the first selected platform for the cohort lookup
    const platform = platformEls[0].value;
    const postType = postTypeEl.value;

    fetchAndRenderPreflight(platform, postType);
  }, 600);
}

// ----------------------------------------------------------------
// fetchAndRenderPreflight — calls the API and renders the panel.
// Shows a loading state while the request is in flight.
// Silently hides the panel on error — it's non-critical.
// ----------------------------------------------------------------
async function fetchAndRenderPreflight(platform, postType) {
  const panel = document.getElementById('brief-preflight');
  if (!panel) return;

  // Show loading state
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="preflight-panel preflight-panel--loading">
      <div class="spinner spinner-xs"></div>
      <span>Loading intelligence signals…</span>
    </div>`;

  try {
    const params = new URLSearchParams({ platform, post_type: postType });
    const data   = await apiFetch(`/intelligence/preflight?${params}`);

    renderPreflightPanel(panel, data, platform, postType);

  } catch (_err) {
    // Non-critical — hide panel silently if API fails
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

// ----------------------------------------------------------------
// renderPreflightPanel — builds and injects the panel HTML.
// ----------------------------------------------------------------
function renderPreflightPanel(panel, data, platform, postType) {
  const { own_intelligence, signals, research } = data;

  // If nothing at all — show a gentle "building your profile" state
  const hasOwn     = !!own_intelligence;
  const hasCohort  = !!(signals && signals.cohort_sample_size >= 5);
  const hasResearch = !!research;

  if (!hasOwn && !hasCohort && !hasResearch) {
    panel.innerHTML = `
      <div class="preflight-panel preflight-panel--empty">
        <span class="preflight-empty-icon">📊</span>
        <div>
          <strong>Intelligence is building.</strong>
          Once you publish posts and let the platform poll performance, this panel will show
          your top-performing hooks, best times to post, and how you compare to industry peers.
        </div>
      </div>`;
    panel.classList.remove('hidden');
    return;
  }

  const cards = [];

  // ---- Card 1: Own performance history ----
  if (hasOwn) {
    // Extract the most useful lines from the plain-text summary:
    // lines starting with "•" and the "TOP PERFORMING HOOKS" section
    const lines    = own_intelligence.split('\n');
    const bullets  = lines.filter(l => l.startsWith('•')).slice(0, 4);
    const hookIdx  = lines.findIndex(l => l.includes('TOP PERFORMING HOOKS'));
    const hookLines = hookIdx >= 0
      ? lines.slice(hookIdx + 1, hookIdx + 4).filter(l => l.startsWith('•'))
      : [];

    const statsHtml = bullets.map(b => `<div class="preflight-stat">${escapeHtml(b)}</div>`).join('');
    const hooksHtml = hookLines.length
      ? `<div class="preflight-hook-label">Top-performing hooks:</div>` +
        hookLines.map(h => `<div class="preflight-hook">${escapeHtml(h)}</div>`).join('')
      : '';

    cards.push(`
      <div class="preflight-card">
        <div class="preflight-card-title">📈 From your history</div>
        ${statsHtml}
        ${hooksHtml}
      </div>`);
  }

  // ---- Card 2: Cohort benchmark ----
  if (hasCohort) {
    const s = signals;

    const bestHoursHtml = s.best_post_hours?.length
      ? `<div class="preflight-stat">⏰ Best time to post: ${formatPostHours(s.best_post_hours)}</div>`
      : '';

    const tonesHtml = s.top_tones?.length
      ? `<div class="preflight-stat">🎭 Top-performing tones: <strong>${s.top_tones.join(', ')}</strong></div>`
      : '';

    const hooksHtml = s.top_hooks?.length
      ? `<div class="preflight-hook-label">Hooks that outperform in your cohort:</div>` +
        s.top_hooks.slice(0, 3).map(h =>
          `<div class="preflight-hook">"${escapeHtml(h.slice(0, 90))}${h.length > 90 ? '…' : ''}"</div>`
        ).join('')
      : '';

    cards.push(`
      <div class="preflight-card">
        <div class="preflight-card-title">👥 From your industry peers</div>
        <div class="preflight-cohort-meta">
          ${s.cohort_sample_size} posts from similar businesses on ${capitalize(platform)}
          ${s.cohort_post_type && s.cohort_post_type !== 'any' ? ` · ${s.cohort_post_type} posts` : ''}
        </div>
        <div class="preflight-stat">👍 Cohort avg likes: <strong>${Math.round(s.cohort_avg_likes)}</strong></div>
        <div class="preflight-stat">📡 Cohort avg reach: <strong>${Math.round(s.cohort_avg_reach)}</strong></div>
        ${bestHoursHtml}
        ${tonesHtml}
        ${hooksHtml}
      </div>`);
  }

  // ---- Card 3: Trending topics ----
  if (hasResearch) {
    // Extract the first 4 bullet lines from the research text
    const researchBullets = research.split('\n')
      .filter(l => l.trim().startsWith('•') || l.trim().startsWith('-'))
      .slice(0, 4)
      .map(l => `<div class="preflight-stat">${escapeHtml(l.trim())}</div>`)
      .join('');

    if (researchBullets) {
      cards.push(`
        <div class="preflight-card">
          <div class="preflight-card-title">🔥 What's trending in your niche</div>
          ${researchBullets}
        </div>`);
    }
  }

  if (cards.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="preflight-panel">
      <div class="preflight-header">
        <div class="preflight-header-left">
          <span class="preflight-title">💡 Intelligence Pre-flight</span>
          <span class="preflight-subtitle">Signals to guide your brief before you generate</span>
        </div>
        <button class="preflight-dismiss" onclick="dismissPreflight()" title="Dismiss">✕</button>
      </div>
      <div class="preflight-cards">
        ${cards.join('')}
      </div>
    </div>`;
}

// ----------------------------------------------------------------
// formatPostHours — converts an array of hours (0-23) to a
// human-readable string: e.g. [18, 19, 17] → "6pm, 7pm, 5pm"
// ----------------------------------------------------------------
function formatPostHours(hours) {
  return hours.map(h => {
    if (h === 0)  return '12am';
    if (h < 12)   return `${h}am`;
    if (h === 12) return '12pm';
    return `${h - 12}pm`;
  }).join(', ');
}

// ----------------------------------------------------------------
// dismissPreflight — hides the panel and clears the debounce so
// it doesn't come back until the user changes a selection again.
// ----------------------------------------------------------------
function dismissPreflight() {
  clearTimeout(_preflightDebounceTimer);
  const panel = document.getElementById('brief-preflight');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

// ----------------------------------------------------------------
function injectBriefStyles() {
  if (document.getElementById('brief-styles')) return; // Already injected

  const style = document.createElement('style');
  style.id = 'brief-styles';
  style.textContent = `
    /* Brief form sections */
    .brief-section {
      margin-bottom: 32px;
    }
    .brief-section-label {
      font-size: 15px;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 12px;
    }

    /* Tile option buttons (Post Type, Objective, Tone) */
    .tile-option {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px;
      border: 1.5px solid #e2e8f0;
      border-radius: 8px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      background: #fff;
      user-select: none;
    }
    .tile-option:hover {
      border-color: #6366f1;
      background: #f5f3ff;
    }
    .tile-option.selected {
      border-color: #6366f1;
      background: #eef2ff;
    }
    .tile-label {
      font-size: 13px;
      font-weight: 600;
      color: #0f172a;
    }
    .tile-desc {
      font-size: 11px;
      color: #64748b;
      line-height: 1.3;
    }

    /* Field errors */
    .field-error {
      color: #ef4444;
      font-size: 12px;
      margin-top: 6px;
    }

    /* Platform grid */
    .platform-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 8px;
    }
    @media (max-width: 900px) {
      .platform-grid { grid-template-columns: repeat(4, 1fr); }
    }
    .platform-option {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 12px 8px;
      border: 1.5px solid #e2e8f0;
      border-radius: 10px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      background: #fff;
      user-select: none;
    }
    .platform-option:hover {
      border-color: #6366f1;
      background: #f5f3ff;
    }
    .platform-option:has(input:checked) {
      border-color: #6366f1;
      background: #eef2ff;
    }
    .platform-icon { font-size: 22px; }
    .platform-name { font-size: 11px; font-weight: 600; color: #374151; }

    /* Brief submit */
    .brief-submit {
      padding-top: 8px;
    }

    /* Loading state */
    .brief-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 80px 40px;
      text-align: center;
    }
    .brief-loading-title {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }
    .brief-loading-sub {
      font-size: 14px;
      color: #64748b;
      max-width: 400px;
    }

    /* Generated posts layout */
    .platform-section-header {
      margin-bottom: 16px;
    }
    .platform-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      background: #1e293b;
      color: #fff;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .post-options-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    @media (max-width: 1100px) {
      .post-options-grid { grid-template-columns: 1fr; }
    }

    /* Post cards */
    .post-card {
      background: #fff;
      border: 1.5px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .post-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .post-card-option {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6366f1;
    }
    .post-card-actions {
      display: flex;
      gap: 6px;
    }

    /* Editable fields */
    .post-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .post-field-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #94a3b8;
    }
    .post-field-content {
      font-size: 13px;
      color: #0f172a;
      line-height: 1.5;
    }
    .post-field-content.editable {
      padding: 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      outline: none;
      min-height: 36px;
      transition: border-color 0.15s, background 0.15s;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .post-field-content.editable:hover {
      border-color: #e2e8f0;
      background: #f8fafc;
    }
    .post-field-content.editable:focus {
      border-color: #6366f1;
      background: #fafafe;
      box-shadow: 0 0 0 3px #e0e7ff;
    }
    .caption-field { max-height: 160px; overflow-y: auto; }
    .hashtag-field { color: #6366f1; font-size: 12px; }
    .post-field-media {
      background: #f8fafc;
      border-radius: 8px;
      padding: 8px;
    }
    .media-rec {
      font-size: 12px;
      color: #475569;
      font-style: italic;
    }
    .post-card-status {
      display: flex;
      justify-content: flex-end;
    }

    /* Responsive tile grid */
    @media (max-width: 900px) {
      .tile-group { grid-template-columns: repeat(2, 1fr) !important; }
    }

    /* ============================================================
       INTELLIGENCE PRE-FLIGHT PANEL
       ============================================================ */

    .brief-preflight {
      margin-bottom: 28px;
    }

    /* Loading + empty states */
    .preflight-panel--loading {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      font-size: 13px;
      color: #64748b;
    }
    .preflight-panel--empty {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      background: #f8fafc;
      border: 1px dashed #cbd5e1;
      border-radius: 10px;
      font-size: 13px;
      color: #64748b;
      line-height: 1.5;
    }
    .preflight-empty-icon { font-size: 22px; flex-shrink: 0; }

    /* Main panel wrapper */
    .preflight-panel {
      background: linear-gradient(135deg, #f0f9ff 0%, #faf5ff 100%);
      border: 1px solid #bae6fd;
      border-radius: 12px;
      overflow: hidden;
    }

    /* Panel header */
    .preflight-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px 10px;
      border-bottom: 1px solid #bae6fd;
    }
    .preflight-header-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .preflight-title {
      font-size: 14px;
      font-weight: 700;
      color: #0c4a6e;
    }
    .preflight-subtitle {
      font-size: 11px;
      color: #0369a1;
    }
    .preflight-dismiss {
      background: none;
      border: none;
      cursor: pointer;
      color: #94a3b8;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.1s, background 0.1s;
    }
    .preflight-dismiss:hover {
      color: #0f172a;
      background: rgba(0,0,0,0.06);
    }

    /* Cards row */
    .preflight-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0;
    }

    /* Individual signal card */
    .preflight-card {
      padding: 14px 16px;
      border-right: 1px solid #bae6fd;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .preflight-card:last-child { border-right: none; }
    @media (max-width: 700px) {
      .preflight-cards { grid-template-columns: 1fr; }
      .preflight-card  { border-right: none; border-bottom: 1px solid #bae6fd; }
      .preflight-card:last-child { border-bottom: none; }
    }

    .preflight-card-title {
      font-size: 12px;
      font-weight: 700;
      color: #0c4a6e;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .preflight-cohort-meta {
      font-size: 11px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .preflight-stat {
      font-size: 12px;
      color: #1e3a5f;
      line-height: 1.4;
    }
    .preflight-hook-label {
      font-size: 11px;
      font-weight: 600;
      color: #475569;
      margin-top: 4px;
    }
    .preflight-hook {
      font-size: 11px;
      color: #334155;
      background: rgba(255,255,255,0.65);
      border-left: 3px solid #38bdf8;
      padding: 4px 8px;
      border-radius: 0 4px 4px 0;
      line-height: 1.4;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

// ----------------------------------------------------------------
// openMediaPicker
//
// Opens a modal showing the user's media library so they can
// choose a file to attach to a post. Calls GET /media to load
// the catalog, renders a searchable/filterable grid, and on
// selection calls PUT /posts/:id with the chosen media_id.
// ----------------------------------------------------------------
async function openMediaPicker(postId) {
  // Remove any existing picker
  document.getElementById('media-picker-overlay')?.remove();

  // Read brief context from the post card's data attributes.
  // These are set by renderPostCard so we always know what brief this
  // post belongs to — which lets us rank media by relevance.
  const card         = document.querySelector(`[data-post-id="${postId}"]`);
  const briefContext = card ? {
    post_type: card.dataset.briefPostType  || '',
    objective: card.dataset.briefObjective || '',
    tone:      card.dataset.briefTone      || '',
    platform:  card.dataset.briefPlatform  || ''
  } : null;

  // Use the ranked endpoint if we have brief context, otherwise fall back
  // to the standard list (sorted by catalogued_at).
  let mediaItems = [];
  let isRanked   = false;
  let driveExpired = false;
  try {
    const [mediaResult, providersResult] = await Promise.allSettled([
      briefContext && (briefContext.post_type || briefContext.platform)
        ? apiFetch('/media/ranked', { method: 'POST', body: JSON.stringify(briefContext) })
        : apiFetch('/media'),
      apiFetch('/media/providers')
    ]);

    if (mediaResult.status === 'fulfilled') {
      mediaItems = mediaResult.value.media || [];
      isRanked   = !!(briefContext && (briefContext.post_type || briefContext.platform));
    } else {
      showAlert('posts-alerts', `Could not load media library: ${mediaResult.reason?.message}`, 'error');
      return;
    }

    // Check if Google Drive token is expired
    if (providersResult.status === 'fulfilled') {
      const drive = (providersResult.value.providers || []).find(p => p.provider === 'google_drive');
      if (drive?.token_expires_at && new Date(drive.token_expires_at) < new Date()) {
        driveExpired = true;
      }
    }
  } catch (err) {
    showAlert('posts-alerts', `Could not load media library: ${err.message}`, 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'publish-modal-overlay';
  overlay.id = 'media-picker-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Build match badge HTML for each item when the list is ranked.
  // Score thresholds: 65+ = Best Match, 35+ = Good Match, else no badge.
  function matchBadge(item) {
    if (!isRanked) return '';
    const score = item._match_score || 0;
    if (score >= 65) return `<span class="media-match-badge media-match-best">Best Match</span>`;
    if (score >= 35) return `<span class="media-match-badge media-match-good">Good Match</span>`;
    return '';
  }

  const subText = isRanked
    ? 'Sorted by best match for this post. Top results fit your platform, tone, and post type.'
    : 'Choose a file from your media library to attach to this post.';

  overlay.innerHTML = `
    <div class="publish-modal media-picker-modal" role="dialog" aria-modal="true" aria-label="Select media">
      <div class="publish-modal-title">📎 Attach Media</div>
      <div class="publish-modal-sub">${subText}</div>
      ${driveExpired ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 14px;margin:8px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:600;color:#dc2626;font-size:13px;">🔴 Google Drive disconnected</div>
          <div style="color:#b91c1c;font-size:12px;margin-top:2px;">Your Drive connection expired. Existing media is shown but new scans won't work. Reconnect in the Media Library.</div>
        </div>
        <a href="#media" onclick="document.getElementById('media-picker-overlay')?.remove()" style="white-space:nowrap;font-size:13px;color:#dc2626;font-weight:600;text-decoration:underline;">Go to Media Library →</a>
      </div>` : ''}

      <div class="media-picker-controls">
        <input
          type="text"
          id="media-picker-search"
          class="media-picker-search"
          placeholder="Search by filename..."
        />
        <div class="media-picker-filters">
          <button class="media-picker-filter active" data-type="">All</button>
          <button class="media-picker-filter" data-type="image">Images</button>
          <button class="media-picker-filter" data-type="video">Videos</button>
        </div>
      </div>

      <div class="media-picker-grid" id="media-picker-grid">
        ${mediaItems.length === 0
          ? `<div class="media-picker-empty">No media in your library yet. Go to the Media tab to connect Google Drive or add files manually.</div>`
          : mediaItems.map(item => `
              <div
                class="media-picker-item"
                data-id="${item.id}"
                data-name="${escapeHtml(item.filename)}"
                data-type="${item.file_type}"
                data-thumb="${escapeHtml(item.thumbnail_url || '')}"
                data-cloud-file-id="${escapeHtml(item.cloud_file_id || '')}"
                data-cloud-provider="${escapeHtml(item.cloud_provider || '')}"
                data-cloud-url="${escapeHtml(item.cloud_url || '')}"
                data-score="${item._match_score || 0}"
              >
                ${matchBadge(item)}
                <div class="media-picker-thumb">
                  ${(() => {
                    // Build thumbnail URL the same way the media library page does.
                    // Priority: stored thumbnail_url → Google Drive thumbnail API → proxy URL → icon fallback
                    const thumbSrc = item.thumbnail_url
                      || (item.cloud_provider === 'google_drive' && item.cloud_file_id
                          ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.cloud_file_id)}&sz=w320`
                          : item.cloud_url
                            ? `/media/proxy?url=${encodeURIComponent(item.cloud_url)}`
                            : null);
                    const icon = item.file_type === 'video' ? '🎬' : '🖼️';
                    return thumbSrc
                      ? `<img src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(item.filename)}"
                             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                          /><span class="media-picker-icon" style="display:none">${icon}</span>`
                      : `<span class="media-picker-icon">${icon}</span>`;
                  })()}
                </div>
                <div class="media-picker-name">${escapeHtml(item.filename)}</div>
                <div class="media-picker-meta">${item.file_type}${item.duration_seconds ? ' · ' + item.duration_seconds + 's' : ''}</div>
                <button class="media-picker-select-btn" type="button">✓ Select</button>
              </div>
            `).join('')}
      </div>

      <div style="margin-top:16px;">
        <button class="btn btn-secondary btn-full" onclick="document.getElementById('media-picker-overlay').remove()">
          Cancel
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // --- Search filtering ---
  const searchInput  = overlay.querySelector('#media-picker-search');
  const grid         = overlay.querySelector('#media-picker-grid');
  const filterBtns   = overlay.querySelectorAll('.media-picker-filter');
  let   activeType   = '';

  function filterGrid() {
    const term = searchInput.value.toLowerCase();
    grid.querySelectorAll('.media-picker-item').forEach(btn => {
      const nameMatch = btn.dataset.name.toLowerCase().includes(term);
      const typeMatch = !activeType || btn.dataset.type === activeType;
      btn.style.display = (nameMatch && typeMatch) ? '' : 'none';
    });
  }

  searchInput.addEventListener('input', filterGrid);

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      filterGrid();
    });
  });

  // --- Select a media item ---
  // Each card has a dedicated "✓ Select" button so clicking the thumbnail
  // (for a preview look) doesn't immediately attach — only the select button does.
  grid.querySelectorAll('.media-picker-select-btn').forEach(selectBtn => {
    const card = selectBtn.closest('.media-picker-item');
    selectBtn.addEventListener('click', () => attachMediaToPost(postId, {
      id:             card.dataset.id,
      filename:       card.dataset.name,
      file_type:      card.dataset.type,
      thumbnail_url:  card.dataset.thumb,
      cloud_file_id:  card.dataset.cloudFileId,
      cloud_provider: card.dataset.cloudProvider,
      cloud_url:      card.dataset.cloudUrl
    }));
  });
}

// ----------------------------------------------------------------
// attachMediaToPost
// Saves media_id to the post via PUT /posts/:id, then updates
// the post card UI to show the attached file.
// ----------------------------------------------------------------
async function attachMediaToPost(postId, mediaItem) {
  document.getElementById('media-picker-overlay')?.remove();

  try {
    await apiFetch(`/posts/${postId}`, {
      method: 'PUT',
      body:   JSON.stringify({ media_id: mediaItem.id })
    });
  } catch (err) {
    showAlert('posts-alerts', `Could not attach media: ${err.message}`, 'error');
    return;
  }

  // Update the card dataset so savePostEdits knows the media_id and trim info.
  // The card may be a .post-card (brief.js simple view) or a .wysiwyg-card (preview.js).
  const card = document.querySelector(`.post-card[data-post-id="${postId}"], .wysiwyg-card[data-post-id="${postId}"]`);
  if (card) {
    card.dataset.mediaId       = mediaItem.id;
    card.dataset.mediaType     = mediaItem.file_type || '';
    card.dataset.mediaDuration = mediaItem.duration_seconds || '';
  }

  // Swap the empty area for the attached view
  const area = document.getElementById(`post-media-${postId}`);
  if (area) {
    area.className = 'post-media-attached';
    area.innerHTML = `
      <div class="post-media-preview">
        ${mediaItem.thumbnail_url
          ? `<img src="${escapeHtml(mediaItem.thumbnail_url)}" alt="Media thumbnail" class="post-media-thumb" />`
          : `<span class="post-media-icon">${mediaItem.file_type === 'video' ? '🎬' : '🖼️'}</span>`}
      </div>
      <div class="post-media-info">
        <span class="post-media-name">${escapeHtml(mediaItem.filename)}</span>
        <button class="btn btn-xs btn-secondary post-media-remove" onclick="removePostMedia('${postId}')">✕ Remove</button>
      </div>
    `;
  }

  // Update the top mockup preview zone to show the actual thumbnail / video indicator
  if (typeof updatePreviewMediaZone === 'function') {
    updatePreviewMediaZone(postId, mediaItem);
  }

  // If this is a WYSIWYG card, update the trim warning section now that we know the media type
  if (typeof updateTrimWarning === 'function') {
    updateTrimWarning(postId, mediaItem);
  }

  // If this is a video without a known duration, silently probe it in the background.
  // The user doesn't need to go to the Media Library — we fetch the duration automatically
  // and refresh the trim warning once we have it.
  if (mediaItem.file_type === 'video' && !mediaItem.duration_seconds && mediaItem.id) {
    autoProbeVideoInBackground(postId, mediaItem.id);
  }
}

// ----------------------------------------------------------------
// autoProbeVideoInBackground
// Silently calls POST /media/:id/probe to get the video's duration
// without any loading UI. On success, updates the card dataset and
// refreshes the trim warning. On failure, does nothing — the user
// can still use the Media Library probe button as a fallback.
// ----------------------------------------------------------------
async function autoProbeVideoInBackground(postId, mediaItemId) {
  try {
    const result = await apiFetch(`/media/${mediaItemId}/probe`, { method: 'POST' });

    // Update the card dataset with the freshly-discovered duration
    const card = document.querySelector(`.post-card[data-post-id="${postId}"], .wysiwyg-card[data-post-id="${postId}"]`);
    if (card) {
      card.dataset.mediaDuration = result.duration || '';
    }

    // Refresh the trim warning now that we have a real duration.
    // Also pass analysis_status so the Smart Clip button appears if analysis is ready.
    if (typeof updateTrimWarning === 'function') {
      updateTrimWarning(postId, {
        file_type:        card?.dataset.mediaType || 'video',
        duration_seconds: result.duration,
        analysis_status:  result.analysis_status
      });
    }
  } catch (_err) {
    // Probe failed — replace the spinner with a soft fallback message so the
    // user isn't left staring at an infinite spinner.
    const card = document.querySelector(`.post-card[data-post-id="${postId}"], .wysiwyg-card[data-post-id="${postId}"]`);
    const trimArea = card?.querySelector('.trim-info');
    if (trimArea) {
      trimArea.innerHTML = `<span class="text-muted text-sm">⚠️ Could not read video duration — use the Media Library to probe manually.</span>`;
    }
  }
}

// ----------------------------------------------------------------
// removePostMedia
// Detaches media from a post by setting media_id to null.
// ----------------------------------------------------------------
async function removePostMedia(postId) {
  try {
    await apiFetch(`/posts/${postId}`, {
      method: 'PUT',
      body:   JSON.stringify({ media_id: null })
    });
  } catch (err) {
    showAlert('posts-alerts', `Could not remove media: ${err.message}`, 'error');
    return;
  }

  // Clear card dataset
  const card = document.querySelector(`.post-card[data-post-id="${postId}"], .wysiwyg-card[data-post-id="${postId}"]`);
  if (card) {
    card.dataset.mediaId       = '';
    card.dataset.mediaType     = '';
    card.dataset.mediaDuration = '';
  }

  // Clear the trim warning if present
  if (typeof updateTrimWarning === 'function') {
    updateTrimWarning(postId, null);
  }

  // Reset the top mockup preview zone to show the placeholder again
  if (typeof updatePreviewMediaZone === 'function') {
    updatePreviewMediaZone(postId, null);
  }

  // Swap back to the empty "Attach Media" prompt
  const area = document.getElementById(`post-media-${postId}`);
  if (area) {
    area.className = 'post-media-empty';
    area.innerHTML = `
      <button class="btn btn-sm btn-secondary post-media-attach-btn" onclick="openMediaPicker('${postId}')">
        📎 Attach Media
      </button>
    `;
  }
}

// ----------------------------------------------------------------
// deletePost
// Deletes a draft post via DELETE /posts/:id, then removes the card
// from the DOM with a short fade animation.
// Called from both the simple post card (brief.js) and the WYSIWYG
// card (preview.js) — the button is wired to this function in both.
// ----------------------------------------------------------------
async function deletePost(postId) {
  if (!confirm('Delete this post? This cannot be undone.')) return;

  try {
    await apiFetch(`/posts/${postId}`, { method: 'DELETE' });
  } catch (err) {
    showAlert('posts-alerts', `Could not delete post: ${err.message}`, 'error');
    return;
  }

  // Find the card — works for both .post-card and .wysiwyg-card
  const card = document.querySelector(
    `.post-card[data-post-id="${postId}"], .wysiwyg-card[data-post-id="${postId}"]`
  );
  if (!card) return;

  // Fade and shrink the card out before removing it
  card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
  card.style.opacity    = '0';
  card.style.transform  = 'scale(0.96)';

  setTimeout(() => {
    // Find the parent grid before removing the card
    const grid = card.closest('.post-options-grid, .wysiwyg-cards-grid');
    card.remove();

    // If the grid is now empty, hide the entire platform section
    if (grid && grid.children.length === 0) {
      const section = grid.closest('.platform-section, .platform-tab-content');
      if (section) {
        section.style.transition = 'opacity 0.2s ease';
        section.style.opacity    = '0';
        setTimeout(() => section.remove(), 200);
      }
    }
  }, 200);
}
