#!/usr/bin/env node
/**
 * test-instagram-dm.js
 *
 * Local webhook simulator for testing Instagram DM automation
 * WITHOUT needing a real connected Instagram Business account.
 *
 * What this script does:
 *   1. Signs webhook payloads with your FACEBOOK_APP_SECRET (passes signature verification)
 *   2. Sends simulated Instagram comment webhooks to your running server
 *   3. Sends simulated Instagram DM reply webhooks (for multi-step flows)
 *   4. Logs what happens at each step so you can verify the full pipeline
 *
 * Prerequisites:
 *   - Your server must be running (docker compose up or node server.js)
 *   - You need at least one published post in the DB with a platform_post_id
 *   - You need at least one active dm_automation with trigger keywords
 *   - FACEBOOK_APP_SECRET must be set in your .env
 *
 * Usage:
 *   node test-instagram-dm.js                    (runs full interactive test)
 *   node test-instagram-dm.js --comment "hello"  (send a single comment)
 *   node test-instagram-dm.js --reply "my email" (send a DM reply)
 *   node test-instagram-dm.js --status           (check DB state)
 *
 * The script will walk you through setup if anything is missing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const crypto = require('crypto');
const axios  = require('axios');
const readline = require('readline');

// --------------- CONFIG ---------------
const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3001';
const APP_SECRET = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;

// Simulated Instagram identifiers (fake, for testing only)
const FAKE_IG_USER_ID   = '17841400000000001';  // Simulated Instagram Business Account ID (your "page")
const FAKE_COMMENTER_ID = '17841400000000099';  // Simulated commenter's IGSID
const FAKE_COMMENTER    = 'test_commenter_bot';
const FAKE_MEDIA_ID     = '17900000000000001';  // Will be overridden with real platform_post_id

// --------------- HELPERS ---------------

// Sign a payload the same way Meta does, so our webhook endpoint accepts it
function signPayload(jsonString) {
  if (!APP_SECRET) {
    console.error('\n[ERROR] FACEBOOK_APP_SECRET (or META_APP_SECRET) is not set in .env');
    console.error('        The webhook endpoint will reject unsigned payloads.');
    process.exit(1);
  }
  return 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(jsonString)
    .digest('hex');
}

// Send a signed webhook payload to the server
async function sendWebhook(payload, label) {
  const jsonString = JSON.stringify(payload);
  const signature  = signPayload(jsonString);

  console.log(`\n--- Sending: ${label} ---`);
  console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const resp = await axios.post(`${SERVER_URL}/webhooks/meta`, jsonString, {
      headers: {
        'Content-Type':          'application/json',
        'X-Hub-Signature-256':   signature
      },
      timeout: 10_000
    });
    console.log(`[OK] Server responded: ${resp.status}`);
    return true;
  } catch (err) {
    if (err.response) {
      console.error(`[FAIL] Server responded: ${err.response.status} — ${JSON.stringify(err.response.data)}`);
    } else {
      console.error(`[FAIL] Could not reach server: ${err.message}`);
      console.error('       Is your server running? Try: cd docker && docker compose up');
    }
    return false;
  }
}

// Build an Instagram comment webhook payload
function buildCommentPayload(mediaId, commentText, commentId) {
  return {
    object: 'instagram',
    entry: [{
      id: FAKE_IG_USER_ID,
      changes: [{
        field: 'comments',
        value: {
          id:   commentId || `comment_${Date.now()}`,
          text: commentText,
          from: {
            id:       FAKE_COMMENTER_ID,
            username: FAKE_COMMENTER
          },
          media: {
            id: mediaId
          }
        }
      }]
    }]
  };
}

// Build an Instagram DM reply webhook payload (for multi-step conversations)
function buildDmReplyPayload(senderPsid, replyText) {
  return {
    object: 'instagram',
    entry: [{
      id: FAKE_IG_USER_ID,
      messaging: [{
        sender:    { id: senderPsid },
        recipient: { id: FAKE_IG_USER_ID },
        message:   { text: replyText, is_echo: false }
      }]
    }]
  };
}

// Prompt for user input
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// --------------- DB CHECK (via Supabase REST or direct) ---------------

let supabaseAdmin;
try {
  const { supabaseAdmin: sa } = require('./services/supabaseService');
  supabaseAdmin = sa;
} catch (e) {
  console.warn('[WARN] Could not load supabaseService — DB checks will be skipped');
}

// Find a published post that has a platform_post_id (needed to match the webhook)
async function findPublishedPost() {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('posts')
    .select('id, user_id, platform_post_id, platform, caption')
    .eq('status', 'published')
    .not('platform_post_id', 'is', null)
    .limit(10);

  if (error) { console.error('DB error:', error.message); return null; }
  return data || [];
}

// Find active automations for a user
async function findAutomations(userId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('dm_automations')
    .select('id, name, trigger_keywords, flow_type, resource_url, post_id, active')
    .eq('user_id', userId)
    .eq('active', true);

  if (error) { console.error('DB error:', error.message); return null; }
  return data || [];
}

// Check conversation state after sending webhook
async function checkConversations(automationId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('dm_conversations')
    .select('id, status, current_step, platform_user_id, author_handle, created_at')
    .eq('automation_id', automationId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) { console.error('DB error:', error.message); return null; }
  return data || [];
}

// Check collected data
async function checkCollectedData(conversationId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('dm_collected_data')
    .select('field_name, field_value, collected_at')
    .eq('conversation_id', conversationId);

  if (error) { console.error('DB error:', error.message); return null; }
  return data || [];
}

// Check comments table
async function checkComments(commentId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('comments')
    .select('id, comment_text, sentiment, trigger_matched, dm_sent, created_at')
    .eq('platform_comment_id', commentId)
    .limit(1);

  if (error) { console.error('DB error:', error.message); return null; }
  return data?.[0] || null;
}

// --------------- MAIN INTERACTIVE FLOW ---------------

async function main() {
  console.log('==============================================');
  console.log('  Instagram DM Automation — Webhook Simulator');
  console.log('==============================================\n');

  // Check app secret
  if (!APP_SECRET) {
    console.error('[ERROR] FACEBOOK_APP_SECRET or META_APP_SECRET not found in .env');
    process.exit(1);
  }
  console.log('[OK] App secret loaded for webhook signing\n');

  // Handle CLI args for quick commands
  const args = process.argv.slice(2);
  if (args.includes('--comment')) {
    const text = args[args.indexOf('--comment') + 1] || 'test comment';
    const mediaId = args[args.indexOf('--media') + 1] || FAKE_MEDIA_ID;
    const commentId = `comment_${Date.now()}`;
    await sendWebhook(buildCommentPayload(mediaId, text, commentId), `Instagram comment: "${text}"`);
    console.log(`\nComment ID: ${commentId}`);
    console.log('Check your server logs for processing output.');
    return;
  }
  if (args.includes('--reply')) {
    const text = args[args.indexOf('--reply') + 1] || 'test reply';
    const psid = args[args.indexOf('--psid') + 1] || FAKE_COMMENTER_ID;
    await sendWebhook(buildDmReplyPayload(psid, text), `Instagram DM reply: "${text}"`);
    console.log('\nCheck your server logs for processing output.');
    return;
  }

  // --------------- INTERACTIVE MODE ---------------

  // Step 1: Find a published post to target
  console.log('Step 1: Finding published posts with platform_post_id...\n');
  const posts = await findPublishedPost();

  if (!posts || posts.length === 0) {
    console.error('[PROBLEM] No published posts found with a platform_post_id.');
    console.log('\nTo test, you need at least one post in the DB with:');
    console.log('  status = "published"');
    console.log('  platform_post_id = some value (the ID returned by the platform after publishing)');
    console.log('\nYou can insert a fake one for testing:');
    console.log(`
  INSERT INTO posts (user_id, platform, status, platform_post_id, caption, scheduled_at)
  VALUES (
    '<your-user-id>',
    'instagram',
    'published',
    'FAKE_IG_MEDIA_12345',
    'Test post for DM automation',
    NOW()
  );
`);
    return;
  }

  console.log('Published posts found:\n');
  posts.forEach((p, i) => {
    console.log(`  [${i}] platform: ${p.platform} | platform_post_id: ${p.platform_post_id}`);
    console.log(`       caption: "${(p.caption || '').substring(0, 60)}..."`);
  });

  const postIdx = parseInt(await ask(`\nWhich post to simulate a comment on? [0-${posts.length - 1}]: `), 10);
  const targetPost = posts[postIdx] || posts[0];
  console.log(`\nUsing post: ${targetPost.platform_post_id}\n`);

  // Step 2: Check automations
  console.log('Step 2: Checking active DM automations for this user...\n');
  const automations = await findAutomations(targetPost.user_id);

  if (!automations || automations.length === 0) {
    console.error('[PROBLEM] No active DM automations found for this user.');
    console.log('\nCreate one in the app first (DM Automation section), or insert directly:');
    console.log(`
  -- Create automation
  INSERT INTO dm_automations (user_id, name, flow_type, trigger_keywords, resource_url, active)
  VALUES (
    '${targetPost.user_id}',
    'Test Automation',
    'single',
    ARRAY['info', 'interested', 'link'],
    'https://example.com/my-resource',
    true
  );

  -- Create the message step
  INSERT INTO dm_automation_steps (automation_id, step_order, message_template, collects_field)
  VALUES (
    '<automation-id-from-above>',
    1,
    'Hey {{commenter_name}}! Thanks for your interest. Here''s the link:',
    null
  );
`);
    return;
  }

  console.log('Active automations:\n');
  automations.forEach((a, i) => {
    const scope = a.post_id ? `post: ${a.post_id}` : 'GLOBAL (all posts)';
    console.log(`  [${i}] "${a.name}" (${a.flow_type})`);
    console.log(`       Keywords: [${a.trigger_keywords.join(', ')}]`);
    console.log(`       Scope: ${scope}`);
    if (a.resource_url) console.log(`       Resource URL: ${a.resource_url}`);
  });

  // Step 3: Simulate a comment
  console.log('\n\nStep 3: Simulating an Instagram comment...\n');
  const defaultKeyword = automations[0]?.trigger_keywords?.[0] || 'info';
  const commentText = await ask(`Comment text (should match a trigger keyword) [default: "${defaultKeyword}"]: `) || defaultKeyword;
  const commentId = `sim_comment_${Date.now()}`;

  const success = await sendWebhook(
    buildCommentPayload(targetPost.platform_post_id, commentText, commentId),
    `Instagram comment: "${commentText}" on media ${targetPost.platform_post_id}`
  );

  if (!success) return;

  // Wait for async processing
  console.log('\nWaiting 3 seconds for server to process...');
  await new Promise(r => setTimeout(r, 3000));

  // Step 4: Check results
  console.log('\nStep 4: Checking results...\n');

  const comment = await checkComments(commentId);
  if (comment) {
    console.log('Comment record:');
    console.log(`  Sentiment: ${comment.sentiment}`);
    console.log(`  Trigger matched: ${comment.trigger_matched}`);
    console.log(`  DM sent: ${comment.dm_sent}`);
  } else {
    console.log('[WARN] Comment not found in DB — check server logs for errors');
  }

  // Check conversations for the first automation
  for (const auto of automations) {
    const convos = await checkConversations(auto.id);
    if (convos && convos.length > 0) {
      console.log(`\nConversations for "${auto.name}":`);
      convos.forEach(c => {
        console.log(`  Status: ${c.status} | Step: ${c.current_step} | User: ${c.author_handle}`);
      });

      // If multi-step and active, offer to send a reply
      const activeConvo = convos.find(c => c.status === 'active');
      if (activeConvo && auto.flow_type === 'multi_step') {
        console.log('\n--- Multi-step conversation is ACTIVE — waiting for reply ---');
        const replyText = await ask('Simulate a reply (e.g. your email address): ');
        if (replyText) {
          // Use the PSID stored in the conversation (or our fake one)
          const psid = activeConvo.platform_user_id || FAKE_COMMENTER_ID;
          await sendWebhook(
            buildDmReplyPayload(psid, replyText),
            `Instagram DM reply: "${replyText}"`
          );

          console.log('\nWaiting 3 seconds...');
          await new Promise(r => setTimeout(r, 3000));

          // Check collected data
          const collected = await checkCollectedData(activeConvo.id);
          if (collected && collected.length > 0) {
            console.log('\nCollected lead data:');
            collected.forEach(d => console.log(`  ${d.field_name}: ${d.field_value}`));
          }

          // Check updated conversation
          const updatedConvos = await checkConversations(auto.id);
          const updated = updatedConvos?.find(c => c.id === activeConvo.id);
          if (updated) {
            console.log(`\nConversation status: ${updated.status} | Step: ${updated.current_step}`);
          }
        }
      }
    }
  }

  console.log('\n==============================================');
  console.log('  Test complete! Check server logs for details.');
  console.log('==============================================');
  console.log('\nIMPORTANT: The DM sending will FAIL at the Meta API level');
  console.log('(no real Instagram connection). That\'s expected — what we\'re');
  console.log('testing is the full pipeline: webhook → comment → trigger →');
  console.log('conversation → DM queue. Check server logs for:');
  console.log('  [Webhooks] Realtime instagram comment...');
  console.log('  [CommentAgent] Processing realtime comment...');
  console.log('  [DM Agent] Starting conversation...');
  console.log('  [DM Worker] Processing send-dm job...');
  console.log('  [DM Worker] Error... (expected — no real access token)\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
