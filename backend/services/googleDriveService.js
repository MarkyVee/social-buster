/**
 * services/googleDriveService.js
 *
 * Shared helper for creating an authenticated Google Drive client.
 *
 * Token refresh strategy — explicit, not event-driven:
 *   1. Check if the stored access token is expired (or about to expire).
 *   2. If so, call refreshAccessToken() BEFORE making any API call.
 *   3. Save the new token to the DB immediately.
 *   4. Return the Drive client ready to use.
 *
 * This is more reliable than the googleapis 'tokens' event because that
 * event only fires AFTER an API call triggers a 401 and auto-retries,
 * which doesn't always happen consistently across googleapis versions.
 *
 * Used by:
 *   - agents/mediaAgent.js   (folder scans)
 *   - routes/media.js        (probe endpoint)
 */

const { google }                     = require('googleapis');
const { decryptToken, encryptToken } = require('./tokenEncryption');
const { supabaseAdmin }              = require('./supabaseService');
const path                           = require('path');
const fs                             = require('fs');
const { v4: uuidv4 }                 = require('uuid');

// ----------------------------------------------------------------
// getGoogleDriveClient
//
// userId     - The user's UUID (used to save refreshed tokens to DB)
// connection - Row from cloud_connections:
//              { access_token, refresh_token, token_expires_at }
//
// Returns: { drive, oauth2Client }
// Throws if the token is expired AND there is no refresh_token stored.
// ----------------------------------------------------------------
async function getGoogleDriveClient(userId, connection) {
  if (!connection.refresh_token) {
    throw new Error(
      'Google Drive refresh token is missing. Please disconnect and reconnect your Google Drive account.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token:  decryptToken(connection.access_token),
    refresh_token: decryptToken(connection.refresh_token),
    expiry_date:   connection.token_expires_at
      ? new Date(connection.token_expires_at).getTime()
      : undefined
  });

  // Explicitly refresh if the access token is expired or will expire in the next 5 minutes.
  // We do this proactively rather than waiting for a 401 response from the Drive API.
  const isExpired = !connection.token_expires_at ||
    new Date(connection.token_expires_at).getTime() < (Date.now() + 5 * 60 * 1000);

  if (isExpired) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();

      // Immediately save the fresh token to DB so future calls don't need to refresh
      await supabaseAdmin
        .from('cloud_connections')
        .update({
          access_token:     encryptToken(credentials.access_token),
          token_expires_at: credentials.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : null
        })
        .eq('user_id', userId)
        .eq('provider', 'google_drive');

      // Update the in-memory client with the fresh credentials
      oauth2Client.setCredentials(credentials);

    } catch (refreshErr) {
      throw new Error(
        `Failed to refresh Google Drive token: ${refreshErr.message}. ` +
        'Please disconnect and reconnect your Google Drive account.'
      );
    }
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  return { drive, oauth2Client };
}

// ----------------------------------------------------------------
// downloadGoogleDriveFile
//
// Downloads a Google Drive file to a local temp path using the Drive API
// with the user's stored OAuth credentials.
//
// This is necessary because Drive webViewLink URLs (drive.google.com/file/d/…)
// require authentication — unauthenticated HTTP requests return an HTML login
// page, not the actual file binary. The googleapis SDK handles auth correctly.
//
// userId   - user's UUID (used to fetch their cloud_connections row)
// driveUrl - webViewLink or open URL containing the file ID
// extension - file extension for the temp file (e.g. 'jpg', 'png')
//
// Returns: local temp file path
// ----------------------------------------------------------------
async function downloadGoogleDriveFile(userId, driveUrl, extension = 'jpg') {
  // Extract the file ID from common Drive URL formats:
  //   https://drive.google.com/file/d/{id}/view
  //   https://drive.google.com/open?id={id}
  const fileIdMatch =
    driveUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  if (!fileIdMatch) {
    throw new Error('Could not extract Google Drive file ID from URL: ' + driveUrl);
  }

  const fileId = fileIdMatch[1];

  // Fetch the user's Google Drive OAuth connection
  const { data: connection, error } = await supabaseAdmin
    .from('cloud_connections')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('provider', 'google_drive')
    .single();

  if (error || !connection) {
    throw new Error('No Google Drive connection found for this user — cannot download Drive image.');
  }

  const { drive } = await getGoogleDriveClient(userId, connection);

  // Ensure the temp directory exists (same path used by ffmpegService)
  const TEMP_DIR = process.env.FFMPEG_TEMP_DIR || '/tmp/social-buster/videos';
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const tempPath = path.join(TEMP_DIR, `gdrive_${uuidv4()}.${extension}`);

  // Download via Drive API — this uses the user's access token, so auth is
  // handled correctly regardless of file sharing settings.
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    response.data
      .on('error', reject)
      .pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return tempPath;
}

module.exports = { getGoogleDriveClient, downloadGoogleDriveFile };
