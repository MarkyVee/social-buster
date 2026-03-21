/**
 * services/emailService.js
 *
 * Adapter for sending emails via the Resend API.
 *
 * Resend free tier: 3,000 emails/month, 100/day.
 * Paid: $20/month for 50,000 emails.
 *
 * To swap providers (e.g. SendGrid, Mailgun), change this file only.
 * No other file calls the Resend API directly.
 *
 * Required env vars:
 *   RESEND_API_KEY   — API key from https://resend.com/api-keys
 *   EMAIL_FROM       — sender address (default: Social Buster <noreply@socialbuster.com>)
 */

const axios = require('axios');

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * sendEmail — sends a single plain-text email via Resend.
 *
 * @param {string} to       — recipient email address
 * @param {string} subject  — email subject line
 * @param {string} body     — plain text body
 * @returns {{ success: boolean, id: string }} — Resend message ID on success
 * @throws on missing config or API failure
 */
async function sendEmail(to, subject, body) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('[EmailService] RESEND_API_KEY is not set — cannot send email');
  }

  const from = process.env.EMAIL_FROM || 'Social Buster <noreply@socialbuster.com>';

  try {
    const response = await axios.post(
      RESEND_API_URL,
      { from, to, subject, text: body },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json'
        },
        timeout: 15000  // 15 seconds — email API calls should be fast
      }
    );

    return { success: true, id: response.data?.id || 'unknown' };

  } catch (err) {
    // Extract Resend's actual error message (same pattern as fbCall in platformAPIs.js)
    const resendError = err.response?.data?.message
                     || err.response?.data?.error
                     || err.message;
    throw new Error(`[EmailService] Resend error: ${resendError}`);
  }
}

module.exports = { sendEmail };
