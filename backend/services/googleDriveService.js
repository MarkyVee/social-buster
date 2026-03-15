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

module.exports = { getGoogleDriveClient };
