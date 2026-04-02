/**
 * agents/mediaAgent.js
 *
 * Background agent that scans connected cloud storage and catalogs media metadata.
 *
 * This agent NEVER runs in the request/response cycle.
 * It is triggered by:
 *   1. POST /media/scan  — user manually triggers a scan
 *   2. A scheduled cron job (Phase 5) — nightly scans for all users
 *
 * What it does per user:
 *   1. Reads all connected cloud providers from the cloud_connections table.
 *   2. For each provider, fetches the file list using that provider's API.
 *   3. Filters to video and image files only.
 *   4. Skips files already in the catalog (no duplicates).
 *   5. Inserts new items with their metadata.
 *   6. Updates last_scanned_at on the connection record.
 *
 * Cloud provider APIs (stubbed — implement once OAuth credentials are in .env):
 *   Google Drive : googleapis — drive.files.list()
 *   Dropbox      : dropbox SDK — filesListFolder()
 *   Box          : box-node-sdk — folders.getItems()
 */

const { supabaseAdmin }        = require('../services/supabaseService');
const { decryptToken }         = require('../services/tokenEncryption');
const { getGoogleDriveClient } = require('../services/googleDriveService');
const { mediaAnalysisQueue }   = require('../queues');
const { sendAlert }            = require('../services/alertService');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'];

// ----------------------------------------------------------------
// scanUserMediaLibrary — main entry point.
// Scans all connected providers for one user.
// ----------------------------------------------------------------
async function scanUserMediaLibrary(userId) {
  console.log(`[MediaAgent] Starting scan for user ${userId}`);

  const { data: connections, error } = await supabaseAdmin
    .from('cloud_connections')
    .select('*')
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to fetch cloud connections: ${error.message}`);
  if (!connections || connections.length === 0) {
    console.log(`[MediaAgent] No cloud storage connected for user ${userId}`);
    return 0;
  }

  let totalAdded = 0;

  for (const connection of connections) {
    try {
      const added = await scanProvider(userId, connection);
      totalAdded += added;

      await supabaseAdmin
        .from('cloud_connections')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', connection.id);

    } catch (err) {
      console.error(`[MediaAgent] Error scanning ${connection.provider}:`, err.message);

      // If the error is a token failure (expired or missing refresh token),
      // email the user so they know to reconnect — otherwise this fails silently forever.
      const isTokenError = err.message?.toLowerCase().includes('refresh token') ||
                           err.message?.toLowerCase().includes('token') && err.message?.toLowerCase().includes('reconnect');
      if (isTokenError) {
        try {
          const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
          const userEmail = authData?.user?.email;
          if (userEmail) {
            await sendAlert(
              `Action required: reconnect your ${connection.provider === 'google_drive' ? 'Google Drive' : connection.provider} account`,
              `Hi,\n\nYour ${connection.provider === 'google_drive' ? 'Google Drive' : connection.provider} connection needs to be reconnected in Social Buster.\n\nReason: ${err.message}\n\nPlease log in and go to Media Library → Settings to reconnect.\n\nThis is an automated message from Social Buster.`
            );
            // Also send to admin so it shows up in server alerts
            console.warn(`[MediaAgent] Token failure for user ${userId} (${userEmail}) — alert sent.`);
          }
        } catch (alertErr) {
          // Never crash because the alert failed
          console.error('[MediaAgent] Failed to send token alert email:', alertErr.message);
        }
      }
    }
  }

  console.log(`[MediaAgent] Scan complete for user ${userId}: ${totalAdded} new items catalogued`);
  return totalAdded;
}

// ----------------------------------------------------------------
// scanProvider — scans one cloud provider connection.
// ----------------------------------------------------------------
async function scanProvider(userId, connection) {
  let files;
  switch (connection.provider) {
    case 'google_drive': files = await fetchGoogleDriveFiles(userId, connection); break;
    case 'dropbox':      files = await fetchDropboxFiles(accessToken);      break;
    case 'box':          files = await fetchBoxFiles(accessToken);           break;
    default:
      console.warn(`[MediaAgent] Unknown provider: ${connection.provider}`);
      return 0;
  }

  if (!files || files.length === 0) return 0;

  // Skip files already catalogued
  const fileIds = files.map(f => f.cloudFileId);
  const { data: existing } = await supabaseAdmin
    .from('media_items')
    .select('cloud_file_id')
    .eq('user_id', userId)
    .eq('cloud_provider', connection.provider)
    .in('cloud_file_id', fileIds);

  const existingIds = new Set((existing || []).map(e => e.cloud_file_id));
  const newFiles    = files.filter(f => !existingIds.has(f.cloudFileId));

  if (newFiles.length === 0) {
    console.log(`[MediaAgent] All files already catalogued in ${connection.provider}`);
    return 0;
  }

  const rows = newFiles.map(file => ({
    user_id:          userId,
    cloud_provider:   connection.provider,
    cloud_file_id:    file.cloudFileId,
    cloud_url:        file.webViewLink || null,
    filename:         file.name,
    file_type:        file.fileType,
    duration_seconds: file.durationSeconds || null,
    resolution:       file.resolution || null,
    themes:           [],
    platform_fit:     [],
    analysis_status:  'pending'  // Will be picked up by mediaAnalysisWorker for videos
  }));

  // Use .select() so we get the inserted IDs back to queue analysis jobs
  const { data: insertedItems, error: insertError } = await supabaseAdmin
    .from('media_items')
    .insert(rows)
    .select('id, file_type');

  if (insertError) {
    console.error(`[MediaAgent] Batch insert failed for ${connection.provider}: ${insertError.message}`, insertError);

    // Batch failed — try one by one to salvage partial results and log individual errors
    let salvaged = 0;
    for (const row of rows) {
      const { data: singleItem, error } = await supabaseAdmin
        .from('media_items')
        .insert(row)
        .select('id, file_type')
        .single();

      if (error) {
        console.error(`[MediaAgent] Single insert failed for "${row.filename}": ${error.message}`);
      } else if (singleItem) {
        salvaged++;
        await queueVideoAnalysis(singleItem);
      }
    }
    return salvaged;
  }

  // Queue an analysis job for each newly catalogued video
  for (const item of (insertedItems || [])) {
    await queueVideoAnalysis(item);
  }

  console.log(`[MediaAgent] Catalogued ${newFiles.length} new items from ${connection.provider}`);
  return newFiles.length;
}

// ================================================================
// PROVIDER FILE FETCHERS
// Each returns: [{ cloudFileId, name, fileType, webViewLink, durationSeconds, resolution }]
//
// These are STUBS. See the comments below for exact implementation
// instructions once OAuth credentials are added to .env.
// ================================================================

// Google Drive — uses the shared getGoogleDriveClient helper which handles
// token refresh automatically and saves new tokens back to the DB.
// folderId comes from cloud_connections.provider_user_id (set by the user after OAuth connect).
// If no folderId is set, we don't scan yet — the user needs to pick a folder first.
async function fetchGoogleDriveFiles(userId, connection) {
  const folderId = connection.provider_user_id;

  if (!folderId) {
    console.log('[MediaAgent] Google Drive connected but no folder selected yet — skipping scan.');
    return [];
  }

  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id') {
    console.warn('[MediaAgent] Google Drive credentials not configured (GOOGLE_CLIENT_ID/SECRET missing).');
    return [];
  }

  const { drive } = await getGoogleDriveClient(userId, connection);

  console.log(`[MediaAgent] Listing files in Google Drive folder: ${folderId}`);

  // List only video and image files inside the chosen folder (not trashed)
  const response = await drive.files.list({
    q:      `'${folderId}' in parents and (mimeType contains 'video/' or mimeType contains 'image/') and trashed=false`,
    fields: 'files(id,name,mimeType,webViewLink,videoMediaMetadata)',
    pageSize: 1000
  });

  const fileCount = (response.data.files || []).length;
  console.log(`[MediaAgent] Google Drive returned ${fileCount} file(s) from folder ${folderId}`);

  return (response.data.files || []).map(f => ({
    cloudFileId:     f.id,
    name:            f.name,
    fileType:        f.mimeType.startsWith('video/') ? 'video' : 'image',
    webViewLink:     f.webViewLink,
    durationSeconds: f.videoMediaMetadata?.durationMillis
      ? Math.round(parseInt(f.videoMediaMetadata.durationMillis) / 1000)
      : null,
    resolution: f.videoMediaMetadata?.width
      ? `${f.videoMediaMetadata.width}x${f.videoMediaMetadata.height}`
      : null
  }));
}

// Dropbox — npm install dropbox
// const { Dropbox } = require('dropbox');
// const dbx = new Dropbox({ accessToken });
// const res = await dbx.filesListFolder({ path: '', recursive: true });
// return res.result.entries
//   .filter(e => e['.tag'] === 'file' && isMediaFile(e.name))
//   .map(e => ({ cloudFileId: e.id, name: e.name, fileType: isVideo(e.name) ? 'video' : 'image',
//                webViewLink: null, durationSeconds: null, resolution: null }));
async function fetchDropboxFiles(accessToken) {
  console.warn('[MediaAgent] Dropbox scanning not yet implemented. Add dropbox SDK and configure DROPBOX_APP_KEY/SECRET.');
  return [];
}

// Box — npm install box-node-sdk
// const BoxSDK = require('box-node-sdk');
// const sdk = new BoxSDK({ clientID: process.env.BOX_CLIENT_ID, clientSecret: process.env.BOX_CLIENT_SECRET });
// const client = sdk.getBasicClient(accessToken);
// const items = await client.folders.getItems('0', { fields: 'id,name,type,shared_link' });
// return items.entries.filter(e => e.type === 'file' && isMediaFile(e.name))
//   .map(e => ({ cloudFileId: e.id, name: e.name, fileType: isVideo(e.name) ? 'video' : 'image',
//                webViewLink: e.shared_link?.url || null, durationSeconds: null, resolution: null }));
async function fetchBoxFiles(accessToken) {
  console.warn('[MediaAgent] Box scanning not yet implemented. Add box-node-sdk and configure BOX_CLIENT_ID/SECRET.');
  return [];
}

function isVideo(filename)     { return VIDEO_EXTENSIONS.includes('.' + filename.split('.').pop().toLowerCase()); }
function isImage(filename)     { return IMAGE_EXTENSIONS.includes('.' + filename.split('.').pop().toLowerCase()); }
function isMediaFile(filename) { return isVideo(filename) || isImage(filename); }

// ----------------------------------------------------------------
// queueVideoAnalysis
//
// Adds an 'analyze-video' job to the media-analysis queue for a
// newly catalogued video item. Images are skipped.
//
// BullMQ deduplicates by jobId across ALL states (waiting, active,
// completed, failed). Without the removal below, a video that was
// previously analyzed (job in completed set) would silently never
// get re-analyzed if its analysis_status was reset to 'pending'.
// ----------------------------------------------------------------
async function queueVideoAnalysis(item) {
  if (item.file_type !== 'video') return;

  const jobId = `analyze-video-${item.id}`;

  try {
    // Remove any existing non-active job with this ID before adding a fresh one.
    // If an old completed/failed job sits in Redis, add() with the same jobId
    // returns the stale job instead of creating a new runnable one.
    // We skip removal if the job is 'active' — that means analysis is currently running.
    try {
      const existing = await mediaAnalysisQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'active') await existing.remove();
      }
    } catch (_) { /* non-fatal — proceed with add even if removal fails */ }

    await mediaAnalysisQueue.add(
      'analyze-video',
      { mediaItemId: item.id },
      { jobId }
    );
    console.log(`[MediaAgent] Queued video analysis job for item ${item.id}`);
  } catch (err) {
    // Non-fatal — the video is usable even without segment analysis
    console.warn(`[MediaAgent] Failed to queue video analysis for ${item.id}: ${err.message}`);
  }
}

module.exports = { scanUserMediaLibrary, isVideo, isImage, isMediaFile };
