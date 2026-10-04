/**
 * Transactional email through Resend's HTTP API. The emails themselves are
 * react-email templates in convex/mail/ (preview them with `bun run emails`);
 * these helpers name one and its props, and emails.send renders and sends it.
 *
 * Env: RESEND_API_KEY, and EMAIL_FROM (default "pushr <support@pushr.sh>";
 * the domain must be verified in Resend). The sender should be an inbox that
 * reads replies: receivers trust a no-reply address less. Without a key, emails are logged
 * and skipped, so local and self-hosted deployments keep working.
 */

/** A rendered email, ready for Resend. */
export type RenderedEmail = { to: string; subject: string; html: string; text: string; replyTo?: string };

export async function sendEmail(email: RenderedEmail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[email] RESEND_API_KEY not set; skipped "${email.subject}" to ${email.to}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? 'pushr <support@pushr.sh>',
      to: [email.to],
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
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

type Props = {
  'reset-password': import('../mail/resetPassword').ResetPasswordProps;
  'verify-email': import('../mail/verifyEmail').VerifyEmailProps;
  invite: import('../mail/invite').InviteProps;
  welcome: import('../mail/welcome').WelcomeProps;
  'phone-stopped': import('../mail/phoneStopped').PhoneStoppedProps;
  'password-changed': import('../mail/passwordChanged').PasswordChangedProps;
  'invite-accepted': import('../mail/inviteAccepted').InviteAcceptedProps;
};

export type Template = keyof Props;
export type EmailProps<T extends Template> = Props[T];

/** An email to send: which template, to whom, with what. */
export type Email = { [T in Template]: { to: string; template: T; props: Props[T] } }[Template];

export function resetPasswordEmail(to: string, url: string): Email {
  return { to, template: 'reset-password', props: { url, to } };
}


export function verifyEmailEmail(to: string, url: string): Email {
  return { to, template: 'verify-email', props: { url, to } };
}

export function inviteEmail(to: string, opts: Omit<Props['invite'], 'to'>): Email {
  return { to, template: 'invite', props: { to, ...opts } };
}

export function welcomeEmail(to: string, opts: { name?: string | null; confirmUrl?: string }): Email {
  return { to, template: 'welcome', props: { name: opts.name ?? null, ...(opts.confirmUrl ? { confirmUrl: opts.confirmUrl } : {}) } };
}

export function phoneStoppedEmail(to: string, props: Props['phone-stopped']): Email {
  return { to, template: 'phone-stopped', props };
}

export function passwordChangedEmail(to: string, how: Props['password-changed']['how']): Email {
  return { to, template: 'password-changed', props: { to, how, at: Date.now() } };
}

export function inviteAcceptedEmail(to: string, props: Props['invite-accepted']): Email {
  return { to, template: 'invite-accepted', props };
}
