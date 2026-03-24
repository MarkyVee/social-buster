/**
 * agents/dmAgent.js
 *
 * Conversation state machine for the comment-to-DM automation system.
 *
 * Two flow types:
 *   1. Single message — commenter triggers keyword → gets one DM with a link/resource.
 *   2. Multi-step    — commenter triggers keyword → back-and-forth to collect info
 *                       (email, phone, name, custom fields) → final DM with resource.
 *
 * State transitions:
 *   COMMENT DETECTED (keyword match)
 *     → Create dm_conversation row (status: 'active', current_step: 1)
 *     → Send Step 1 message via messagingService
 *     → For single-message flows: mark 'completed' immediately
 *     → For multi-step: wait for reply via Meta webhook
 *
 *   REPLY RECEIVED (via webhooks.js → processIncomingReply)
 *     → Store the reply as collected data (dm_collected_data)
 *     → Advance current_step
 *     → Send next step message
 *     → If final step: mark 'completed'
 *
 *   24HR WINDOW EXPIRED (checked by dmWorker repeatable job)
 *     → Mark conversation as 'expired'
 *
 *   OPT-OUT (user sends "stop" / "unsubscribe")
 *     → Mark conversation as 'opted_out'
 *
 * Important: this agent is called by both commentAgent (trigger match) and
 * webhooks.js (incoming reply). It does NOT poll — all DM sending goes
 * through the dmQueue for rate limiting.
 */

const { supabaseAdmin }  = require('../services/supabaseService');
const { dmQueue }         = require('../queues');

const OPT_OUT_PHRASES = ['stop', 'unsubscribe', 'opt out', 'cancel', 'leave me alone'];

// ----------------------------------------------------------------
// startConversation — called when commentAgent detects a trigger keyword.
//
// Creates the dm_conversation row and queues the first DM for sending.
// For single-message flows, the conversation completes after this one DM.
// For multi-step flows, the conversation stays active until all steps done.
//
// Parameters:
//   userId         — our user (the business owner)
//   automation     — the dm_automations row (with steps pre-loaded)
//   comment        — { platformCommentId, text, authorHandle, authorPlatformId }
//   platform       — 'facebook' | 'instagram'
//   accessToken    — decrypted Page Access Token
// ----------------------------------------------------------------
async function startConversation(userId, automation, comment, platform, accessToken) {
  // Guard: don't DM the same person twice for the same automation.
  // BUT: if a previous attempt FAILED (conversation exists but DM never sent),
  // delete the stale row and allow a retry. This prevents failed attempts from
  // permanently blocking future DMs to the same person.
  const { data: existing } = await supabaseAdmin
    .from('dm_conversations')
    .select('id, status')
    .eq('automation_id', automation.id)
    .eq('platform_user_id', comment.authorPlatformId)
    .single();

  if (existing) {
    // Allow retry if the previous conversation failed or errored out.
    // "completed", "active", "expired", "opted_out" are legitimate end states — skip these.
    // "failed" means the DM was never delivered — delete the stale row and retry.
    if (existing.status === 'failed') {
      console.log(`[DMAgent] Previous DM to ${comment.authorHandle} failed — deleting stale conversation ${existing.id} and retrying`);
      await supabaseAdmin
        .from('dm_conversations')
        .delete()
        .eq('id', existing.id);
    } else {
      console.log(`[DMAgent] Skipping — already DM'd ${comment.authorHandle} for automation ${automation.id} (status: ${existing.status})`);
      return;
    }
  }

  // Load steps for this automation (ordered by step_order)
  const { data: steps, error: stepsError } = await supabaseAdmin
    .from('dm_automation_steps')
    .select('*')
    .eq('automation_id', automation.id)
    .order('step_order', { ascending: true });

  if (stepsError || !steps || steps.length === 0) {
    console.warn(`[DMAgent] No steps found for automation ${automation.id} — skipping`);
    return;
  }

  // Create conversation record
  const now = new Date().toISOString();
  const windowExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('dm_conversations')
    .insert({
      user_id:          userId,
      automation_id:    automation.id,
      platform,
      platform_user_id: comment.authorPlatformId,
      author_handle:    comment.authorHandle,
      current_step:     1,
      status:           'active',
      last_message_at:  now,
      window_expires_at: windowExpires
    })
    .select()
    .single();

  if (convError) {
    // Unique constraint violation = race condition, another job already created it
    if (convError.message?.includes('unique') || convError.code === '23505') {
      console.log(`[DMAgent] Race condition — conversation already exists for ${comment.authorHandle}`);
      return;
    }
    throw convError;
  }

  // Prepare the first message (replace placeholders)
  const firstStep = steps[0];
  const isFinalStep = automation.flow_type === 'single' || steps.length === 1;
  let messageText = replacePlaceholders(firstStep.message_template, {
    commenter_name: comment.authorHandle || 'there'
  });

  // Append the resource URL to the final step's message (if one is configured).
  // For single-message flows, this is the only message. For multi-step flows,
  // the resource URL is appended in processIncomingReply() on the last step.
  if (isFinalStep && automation.resource_url) {
    messageText += `\n\n${automation.resource_url}`;
  }

  // Queue the DM for sending (rate-limited via dmWorker)
  // Step 1 uses Messenger Send API with comment_id as recipient.
  // The feed webhook gives us the commenter's Facebook user ID, but the
  // Messenger Send API needs a PSID which we don't have yet. comment_id
  // as recipient handles this — this is how ManyChat et al. work.
  await dmQueue.add('send-dm', {
    conversationId: conversation.id,
    userId,
    platform,
    recipientId:    comment.authorPlatformId,
    commentId:      comment.platformCommentId,  // for Private Replies API
    messageText,
    stepOrder:      1,
    isFinalStep
  }, {
    jobId: `dm-${conversation.id}-step-1`,
    removeOnComplete: true
  });

  console.log(`[DMAgent] Started ${automation.flow_type} conversation with ${comment.authorHandle} (automation: ${automation.name || automation.id})`);
}

// ----------------------------------------------------------------
// processIncomingReply — called when Meta sends a webhook with an
// incoming DM from a user who is in an active multi-step conversation.
//
// Parameters:
//   senderPlatformId — the user's PSID (Facebook) or IGSID (Instagram)
//   messageText      — what the user sent back
//   platform         — 'facebook' | 'instagram'
// ----------------------------------------------------------------
async function processIncomingReply(senderPlatformId, messageText, platform) {
  // Find the active conversation for this sender
  const { data: conversation, error } = await supabaseAdmin
    .from('dm_conversations')
    .select('*, dm_automations!inner(id, user_id, flow_type)')
    .eq('platform_user_id', senderPlatformId)
    .eq('platform', platform)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error(`[DMAgent] Supabase query error for sender ${senderPlatformId}: ${error.message || JSON.stringify(error)}`);
    return;
  }
  if (!conversation) {
    console.log(`[DMAgent] No active conversation found for PSID ${senderPlatformId} on ${platform} — may be a normal DM, not an automation reply`);
    return;
  }

  // Check for opt-out phrases
  const normalizedReply = messageText.toLowerCase().trim();
  if (OPT_OUT_PHRASES.some(phrase => normalizedReply === phrase)) {
    await supabaseAdmin
      .from('dm_conversations')
      .update({ status: 'opted_out' })
      .eq('id', conversation.id);
    console.log(`[DMAgent] User ${senderPlatformId} opted out of conversation ${conversation.id}`);
    return;
  }

  // Check if 24hr window has expired
  if (conversation.window_expires_at && new Date(conversation.window_expires_at) < new Date()) {
    await supabaseAdmin
      .from('dm_conversations')
      .update({ status: 'expired' })
      .eq('id', conversation.id);
    console.log(`[DMAgent] Conversation ${conversation.id} expired (24hr window)`);
    return;
  }

  // Load all steps for this automation
  const { data: steps } = await supabaseAdmin
    .from('dm_automation_steps')
    .select('*')
    .eq('automation_id', conversation.automation_id)
    .order('step_order', { ascending: true });

  if (!steps || steps.length === 0) return;

  // Get the current step (the one that was last sent, which asked for input)
  const currentStep = steps.find(s => s.step_order === conversation.current_step);

  // Store the collected data if this step collects a field
  if (currentStep && currentStep.collects_field) {
    const fieldName = currentStep.collects_field === 'custom'
      ? (currentStep.custom_field_label || 'custom')
      : currentStep.collects_field;

    await supabaseAdmin
      .from('dm_collected_data')
      .insert({
        conversation_id: conversation.id,
        user_id:         conversation.user_id,
        field_name:      fieldName,
        field_value:     messageText.trim()
      });
  }

  // Advance to the next step
  const nextStepOrder = conversation.current_step + 1;
  const nextStep      = steps.find(s => s.step_order === nextStepOrder);
  const isFinalStep   = !nextStep;

  if (isFinalStep) {
    // All steps done — check if there's a resource URL to deliver before completing.
    // This handles the case where the last step collects info (e.g., name) and
    // the user expects a resource link to be sent after providing that info.
    const { data: auto } = await supabaseAdmin
      .from('dm_automations')
      .select('resource_url')
      .eq('id', conversation.automation_id)
      .single();

    if (auto?.resource_url) {
      // Send the resource as a final delivery DM
      const deliveryMessage = `Thanks! Here's what you requested:\n\n${auto.resource_url}`;

      await dmQueue.add('send-dm', {
        conversationId: conversation.id,
        userId:         conversation.user_id,
        platform,
        recipientId:    senderPlatformId,
        messageText:    deliveryMessage,
        stepOrder:      conversation.current_step + 1,
        isFinalStep:    true
      }, {
        jobId: `dm-${conversation.id}-delivery`,
        removeOnComplete: true
      });

      console.log(`[DMAgent] Queued resource delivery for conversation ${conversation.id}`);
    }

    // Mark conversation completed
    await supabaseAdmin
      .from('dm_conversations')
      .update({
        status:       'completed',
        current_step: conversation.current_step,
        last_reply_at: new Date().toISOString()
      })
      .eq('id', conversation.id);
    console.log(`[DMAgent] Conversation ${conversation.id} completed — all data collected`);
    return;
  }

  // Load all collected data so far (for placeholder replacement)
  const { data: collectedData } = await supabaseAdmin
    .from('dm_collected_data')
    .select('field_name, field_value')
    .eq('conversation_id', conversation.id);

  const placeholders = { commenter_name: conversation.author_handle || 'there' };
  if (collectedData) {
    collectedData.forEach(d => { placeholders[d.field_name] = d.field_value; });
  }

  let nextMessage = replacePlaceholders(nextStep.message_template, placeholders);

  // Append resource URL to the final step's message (if configured on the automation).
  // For multi-step flows, the resource is delivered after all info has been collected.
  const isLastStep = nextStepOrder >= steps.length;
  if (isLastStep) {
    // Load the automation to check for resource_url
    const { data: auto } = await supabaseAdmin
      .from('dm_automations')
      .select('resource_url')
      .eq('id', conversation.automation_id)
      .single();
    if (auto?.resource_url) {
      nextMessage += `\n\n${auto.resource_url}`;
    }
  }

  // Update conversation state
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('dm_conversations')
    .update({
      current_step:      nextStepOrder,
      last_reply_at:     now,
      window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    })
    .eq('id', conversation.id);

  // Get the access token for sending the next DM
  const { data: conn } = await supabaseAdmin
    .from('platform_connections')
    .select('access_token')
    .eq('user_id', conversation.user_id)
    .eq('platform', platform)
    .single();

  if (!conn) {
    console.error(`[DMAgent] No ${platform} connection for user ${conversation.user_id}`);
    return;
  }

  // Queue the next DM
  await dmQueue.add('send-dm', {
    conversationId: conversation.id,
    userId:         conversation.user_id,
    platform,
    recipientId:    senderPlatformId,
    messageText:    nextMessage,
    stepOrder:      nextStepOrder,
    isFinalStep:    nextStepOrder >= steps.length
  }, {
    jobId: `dm-${conversation.id}-step-${nextStepOrder}`,
    removeOnComplete: true
  });

  console.log(`[DMAgent] Queued step ${nextStepOrder} for conversation ${conversation.id}`);
}

// ----------------------------------------------------------------
// expireStaleConversations — called by dmWorker on a repeatable schedule.
// Marks any active conversations whose 24hr window has expired.
// ----------------------------------------------------------------
async function expireStaleConversations() {
  const now = new Date().toISOString();

  const { data: expired, error } = await supabaseAdmin
    .from('dm_conversations')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('window_expires_at', now)
    .select('id');

  if (error) {
    console.error('[DMAgent] Failed to expire stale conversations:', error.message);
    return;
  }

  if (expired && expired.length > 0) {
    console.log(`[DMAgent] Expired ${expired.length} stale conversation(s)`);
  }
}

// ----------------------------------------------------------------
// replacePlaceholders — swaps {{key}} tokens in a message template
// with actual values from collected data or comment metadata.
//
// Supported: {{commenter_name}}, {{email}}, {{phone}}, {{name}}, any custom field
// Unknown placeholders are left as-is (not replaced with empty string).
// ----------------------------------------------------------------
function replacePlaceholders(template, values) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return values[key] !== undefined ? values[key] : match;
  });
}

module.exports = {
  startConversation,
  processIncomingReply,
  expireStaleConversations
};
