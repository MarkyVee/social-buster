/**
 * workers/emailWorker.js
 *
 * BullMQ worker for the 'email' queue.
 *
 * Processes 'send-campaign' jobs:
 *   1. Resolves the group's members (dynamic filter or static list)
 *   2. Sends one email per recipient via emailService (Resend)
 *   3. Logs each delivery in email_campaign_logs
 *   4. Updates campaign sent_count / failed_count / status
 *
 * Concurrency: 1 — one campaign at a time to avoid rate limit issues.
 * Per-email errors do NOT throw (same pattern as publishingAgent —
 * mark the individual as failed, don't block the rest of the campaign).
 *
 * The worker starts when this module is required (by workers/index.js).
 */

const { Worker } = require('bullmq');
const { connection }         = require('../queues');
const { supabaseAdmin }      = require('../services/supabaseService');
const { sendEmail }          = require('../services/emailService');
const { resolveGroupMembers } = require('../services/emailGroupResolver');

const worker = new Worker('email', async (job) => {
  if (job.name === 'send-campaign') {
    return await processSendCampaign(job);
  }

  console.warn(`[EmailWorker] Unknown job name: ${job.name}`);
}, {
  connection,
  concurrency: 1  // One campaign at a time — avoids rate limit bursts
});

// ----------------------------------------------------------------
// processSendCampaign — sends all emails for a campaign.
//
// Job data:
//   campaignId — UUID of the email_campaigns row
// ----------------------------------------------------------------
async function processSendCampaign(job) {
  const { campaignId } = job.data;

  // 1. Fetch the campaign
  const { data: campaign, error: campErr } = await supabaseAdmin
    .from('email_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (campErr || !campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  // Guard: only process if status is 'sending' (set by the route before queuing)
  if (campaign.status !== 'sending') {
    console.log(`[EmailWorker] Campaign ${campaignId} is "${campaign.status}", skipping`);
    return;
  }

  // 2. Fetch the group
  const { data: group, error: groupErr } = await supabaseAdmin
    .from('email_groups')
    .select('*')
    .eq('id', campaign.group_id)
    .single();

  if (groupErr || !group) {
    // Mark campaign as failed — group was deleted between creation and send
    await supabaseAdmin
      .from('email_campaigns')
      .update({ status: 'failed' })
      .eq('id', campaignId);
    throw new Error(`Group ${campaign.group_id} not found for campaign ${campaignId}`);
  }

  // 3. Resolve group members
  const { users } = await resolveGroupMembers(group);

  if (users.length === 0) {
    // No recipients — mark as sent with 0 totals
    await supabaseAdmin
      .from('email_campaigns')
      .update({ status: 'sent', total_count: 0, sent_at: new Date().toISOString() })
      .eq('id', campaignId);
    console.log(`[EmailWorker] Campaign ${campaignId} — no recipients, marked as sent`);
    return;
  }

  // 4. Update total count
  await supabaseAdmin
    .from('email_campaigns')
    .update({ total_count: users.length })
    .eq('id', campaignId);

  console.log(`[EmailWorker] Campaign ${campaignId} — sending to ${users.length} recipient(s)`);

  // 5. Send one email per user
  let sentCount   = 0;
  let failedCount = 0;

  for (const user of users) {
    const now = new Date().toISOString();

    try {
      await sendEmail(user.email, campaign.subject, campaign.body);

      // Log success
      await supabaseAdmin
        .from('email_campaign_logs')
        .insert({
          campaign_id: campaignId,
          user_id:     user.user_id,
          email:       user.email,
          status:      'sent',
          sent_at:     now
        });

      sentCount++;

      // Update running count on the campaign (so admin can see progress)
      await supabaseAdmin
        .from('email_campaigns')
        .update({ sent_count: sentCount })
        .eq('id', campaignId);

    } catch (err) {
      // Log failure — do NOT re-throw (don't block remaining recipients)
      await supabaseAdmin
        .from('email_campaign_logs')
        .insert({
          campaign_id:   campaignId,
          user_id:       user.user_id,
          email:         user.email,
          status:        'failed',
          error_message: err.message,
          sent_at:       now
        });

      failedCount++;

      await supabaseAdmin
        .from('email_campaigns')
        .update({ failed_count: failedCount })
        .eq('id', campaignId);

      console.error(`[EmailWorker] Failed to send to ${user.email}: ${err.message}`);
    }

    // Small delay between sends to avoid Resend rate limiting (100/day free tier)
    await new Promise(r => setTimeout(r, 100));
  }

  // 6. Mark campaign as complete
  const finalStatus = sentCount === 0 ? 'failed' : 'sent';
  await supabaseAdmin
    .from('email_campaigns')
    .update({
      status:       finalStatus,
      sent_count:   sentCount,
      failed_count: failedCount,
      sent_at:      new Date().toISOString()
    })
    .eq('id', campaignId);

  console.log(`[EmailWorker] Campaign ${campaignId} complete — sent: ${sentCount}, failed: ${failedCount}`);
  return { sentCount, failedCount };
}

// Worker event logging
worker.on('completed', (job) => {
  console.log(`[EmailWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[EmailWorker] Job ${job?.id} failed: ${err.message}`);
});

module.exports = worker;
