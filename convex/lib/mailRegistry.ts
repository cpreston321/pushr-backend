import type { ComponentType } from 'react';
import Invite, * as invite from '../mail/invite';
import InviteAccepted, * as inviteAccepted from '../mail/inviteAccepted';
import PasswordChanged, * as passwordChanged from '../mail/passwordChanged';
import PhoneStopped, * as phoneStopped from '../mail/phoneStopped';
import ResetPassword, * as resetPassword from '../mail/resetPassword';
import VerifyEmail, * as verifyEmail from '../mail/verifyEmail';
import Welcome, * as welcome from '../mail/welcome';
import type { EmailProps, Template } from './email';

/** Each template's component, subject and plain-text version, for emails.send to render. Only that Node action imports this. */
type Entry<T extends Template> = {
  component: ComponentType<EmailProps<T>>;
  subject: (props: EmailProps<T>) => string;
  text: (props: EmailProps<T>) => string;
};

export const TEMPLATES: { [T in Template]: Entry<T> } = {
  'reset-password': { component: ResetPassword, subject: resetPassword.subject, text: resetPassword.text },
  'verify-email': { component: VerifyEmail, subject: verifyEmail.subject, text: verifyEmail.text },
  invite: { component: Invite, subject: invite.subject, text: invite.text },
  welcome: { component: Welcome, subject: welcome.subject, text: welcome.text },
  'phone-stopped': { component: PhoneStopped, subject: phoneStopped.subject, text: phoneStopped.text },
  'password-changed': { component: PasswordChanged, subject: passwordChanged.subject, text: passwordChanged.text },
  'invite-accepted': { component: InviteAccepted, subject: inviteAccepted.subject, text: inviteAccepted.text },
};
