/**
 * Transactional email through Resend's HTTP API.
 *
 * Env: RESEND_API_KEY, and EMAIL_FROM (default "pushr.sh <no-reply@pushr.sh>";
 * the domain must be verified in Resend). Without a key, emails are logged
 * and skipped, so local and self-hosted deployments keep working.
 */

type Email = { to: string; subject: string; html: string; text: string };

export async function sendEmail(email: Email): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[email] RESEND_API_KEY not set; skipped "${email.subject}" to ${email.to}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? 'pushr.sh <no-reply@pushr.sh>',
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text
    })
  });
  if (!res.ok) {
    // Thrown so Better Auth reports the failure instead of claiming the email went out.
    throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

const SITE = 'https://pushr.sh';
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Matches pushr.sh: near-black canvas, a dark card with a hairline border,
 * white headline, gray body, and the site's white pill button. Tables and
 * inline styles only, so Gmail, Outlook and Apple Mail render it the same.
 */
function layout(heading: string, body: string, cta: { label: string; url: string }, footnote: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#0a0a0b;font-family:${FONT};-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0b;padding:48px 16px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
    <tr><td style="padding:0 4px 24px">
      <a href="${SITE}" style="text-decoration:none">
        <img src="${SITE}/pushr-icon.png" width="28" height="28" alt="" style="vertical-align:middle;border-radius:7px;border:0">
        <span style="vertical-align:middle;margin-left:8px;font-size:16px;font-weight:600;color:#f5f5f7;letter-spacing:-0.02em">pushr.sh</span>
      </a>
    </td></tr>
    <tr><td style="background:#161618;border:1px solid #232326;border-radius:24px;padding:36px 32px">
      <div style="font-size:26px;line-height:1.15;font-weight:700;color:#f5f5f7;letter-spacing:-0.03em">${esc(heading)}</div>
      <div style="padding-top:12px;font-size:16px;line-height:1.55;color:#a1a1a6">${esc(body)}</div>
      <div style="padding-top:28px">
        <a href="${esc(cta.url)}" style="display:inline-block;background:#f5f5f7;color:#0a0a0b;text-decoration:none;font-size:15px;font-weight:600;padding:13px 24px;border-radius:999px">${esc(cta.label)}</a>
      </div>
      <div style="padding-top:28px;font-size:13px;line-height:1.5;color:#6e6e73">${esc(footnote)}</div>
    </td></tr>
    <tr><td style="padding:24px 4px 0;font-size:12.5px;line-height:1.6;color:#6e6e73">
      <a href="${SITE}" style="color:#8d8d93;text-decoration:none">pushr.sh</a>
      &nbsp;·&nbsp; <a href="${SITE}/support" style="color:#8d8d93;text-decoration:none">Support</a>
      &nbsp;·&nbsp; <a href="${SITE}/privacy" style="color:#8d8d93;text-decoration:none">Privacy</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function resetPasswordEmail(to: string, url: string): Email {
  return {
    to,
    subject: 'Reset your pushr.sh password',
    html: layout(
      'Reset your password',
      'Tap the button on your iPhone to choose a new password. The link opens the pushr.sh app and expires in one hour.',
      { label: 'Reset password', url },
      "If you didn't ask for this, ignore this email. Your password stays the same."
    ),
    text: `Reset your pushr.sh password: ${url}\n\nThe link opens the pushr.sh app and expires in one hour. If you didn't ask for this, ignore this email.\n\npushr.sh`
  };
}

export function verifyEmailEmail(to: string, url: string): Email {
  return {
    to,
    subject: 'Confirm your email for pushr.sh',
    html: layout(
      'Confirm your email',
      'Confirming lets you accept invites to shared apps and recover your account if you forget your password.',
      { label: 'Confirm email', url },
      "If you didn't create a pushr.sh account, ignore this email."
    ),
    text: `Confirm your email for pushr.sh: ${url}\n\nIf you didn't create a pushr.sh account, ignore this email.\n\npushr.sh`
  };
}
