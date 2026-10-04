import { C, Facts, Layout, NoticeMark } from './_layout';

export type VerifyEmailProps = { url: string; to?: string };

export const subject = () => 'Confirm your email for pushr';

export const text = ({ url }: VerifyEmailProps) =>
  `Confirm your email for pushr: ${url}\n\nThe link expires in one hour. If you didn't create a pushr account, ignore this email.\n\npushr.sh`;

export default function VerifyEmailEmail({ url, to }: VerifyEmailProps) {
  return (
    <Layout
      heading="Confirm your email"
      preview="Confirm your email to accept invites and recover your account."
      hero={<NoticeMark icon="verify-email" label="Account" tone={C.ok} />}
      body="Confirming lets you accept invites to shared apps and recover your account if you forget your password."
      details={<Facts rows={[...(to ? [['Email', to] as [string, string]] : []), ['Link expires', 'In 1 hour']]} />}
      cta={{ label: 'Confirm email', url }}
      footnote="If you didn't create a pushr account, ignore this email."
    />
  );
}

VerifyEmailEmail.PreviewProps = { url: 'https://pushr.sh/api/auth/verify-email?token=preview', to: 'avery@acme.com' } satisfies VerifyEmailProps;
