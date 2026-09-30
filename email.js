/**
 * Email over HTTPS (Railway's Free/Hobby plans block SMTP, so we use an email API).
 * Works with either provider — set ONE of these in Railway Variables:
 *   BREVO_API_KEY   (Brevo free plan: 300 emails/day)   https://www.brevo.com
 *   RESEND_API_KEY  (Resend)                            https://resend.com
 * Plus:
 *   EMAIL_FROM       the verified sender address, e.g. hello@yourdomain.com (or your Gmail verified in Brevo)
 *   EMAIL_FROM_NAME  optional display name, default "InTheLoop"
 * With no key set, emails are only logged (simulation mode), so the app still works end to end.
 */
const PROVIDER = process.env.BREVO_API_KEY ? 'brevo' : process.env.RESEND_API_KEY ? 'resend' : null;
const EMAIL_SIMULATION = !(PROVIDER && process.env.EMAIL_FROM);

/**
 * @param {{to:string, subject:string, html:string, fromName?:string,
 *          attachments?: {filename:string, content:string}[]}} msg  attachment content is base64
 */
async function sendEmail({ to, subject, html, fromName, attachments }) {
  const name = fromName || process.env.EMAIL_FROM_NAME || 'InTheLoop';
  if (EMAIL_SIMULATION) {
    console.log(`[SIMULATED EMAIL] to ${to}: ${subject}`);
    return { status: 'simulated' };
  }
  try {
    let res;
    if (PROVIDER === 'brevo') {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: process.env.EMAIL_FROM, name },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          ...(attachments && attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.content })) } : {}),
        }),
      });
    } else {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${name} <${process.env.EMAIL_FROM}>`,
          to: [to],
          subject,
          html,
          ...(attachments && attachments.length ? { attachments } : {}),
        }),
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`Email to ${to} failed (${res.status}): ${text.slice(0, 300)}`);
      return { status: 'failed', error: `HTTP ${res.status}` };
    }
    return { status: 'sent' };
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    return { status: 'failed', error: err.message };
  }
}

module.exports = { sendEmail, EMAIL_SIMULATION, EMAIL_PROVIDER: PROVIDER };
