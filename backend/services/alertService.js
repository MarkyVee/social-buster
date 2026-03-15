/**
 * services/alertService.js
 *
 * Sends email alerts to the admin when the health check detects a problem
 * it cannot auto-fix. Only fires when status CHANGES (ok → degraded/critical),
 * not on every check — so you don't get spammed.
 *
 * Setup (add to .env):
 *   ALERT_EMAIL_FROM=alerts@yourdomain.com
 *   ALERT_EMAIL_TO=you@yourdomain.com   (comma-separated for multiple)
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=your-app-password          (Gmail: use App Password, not account password)
 *
 * If SMTP vars are not set, alerts are logged to console only — no crash.
 * Gmail App Password: myaccount.google.com → Security → 2FA → App Passwords
 */

const nodemailer = require('nodemailer');

// ----------------------------------------------------------------
// getTransporter — creates an SMTP transporter from env vars.
// Returns null if SMTP is not configured (alerts degrade to console).
// ----------------------------------------------------------------
function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465, // true for 465 (TLS), false for 587 (STARTTLS)
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

// ----------------------------------------------------------------
// sendAlert
//
// Sends an email to ALERT_EMAIL_TO (comma-separated list).
// subject — short subject line
// body    — plain text body (issues list, timestamps, etc.)
//
// Silently logs to console if SMTP is not configured.
// ----------------------------------------------------------------
async function sendAlert(subject, body) {
  const from    = process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER;
  const toList  = (process.env.ALERT_EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);

  // Always log to console — visible in Docker logs and any log aggregator
  console.error(`[ALERT] ${subject}\n${body}`);

  if (!from || toList.length === 0) {
    console.warn('[Alert] ALERT_EMAIL_TO not set — alert logged only, no email sent.');
    return;
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[Alert] SMTP not configured (SMTP_HOST/USER/PASS missing) — alert logged only.');
    return;
  }

  try {
    await transporter.sendMail({
      from,
      to:      toList.join(', '),
      subject: `[Social Buster] ${subject}`,
      text:    `${body}\n\nTimestamp: ${new Date().toISOString()}\nServer: ${process.env.FRONTEND_URL || 'localhost'}`
    });
    console.log(`[Alert] Email sent to ${toList.join(', ')}`);
  } catch (err) {
    // Never crash because email failed — alert was already logged to console
    console.error(`[Alert] Email send failed: ${err.message}`);
  }
}

module.exports = { sendAlert };
