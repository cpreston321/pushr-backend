import { C, Facts, Layout, NoticeMark } from './_layout';

export type ResetPasswordProps = { url: string; to?: string };

export const subject = () => 'Reset your pushr password';

export const text = ({ url }: ResetPasswordProps) =>
  `Reset your pushr password: ${url}\n\nThe link opens the pushr app and expires in one hour. If you didn't ask for this, ignore this email.\n\npushr.sh`;

export default function ResetPasswordEmail({ url, to }: ResetPasswordProps) {
  return (
    <Layout
      heading="Reset your password"
      preview="Choose a new password. The link expires in one hour."
      hero={<NoticeMark icon="reset-password" label="Security" tone={C.wireBright} />}
      body="Tap the button on your iPhone to choose a new password. The link opens the pushr app."
      details={<Facts rows={[...(to ? [['Account', to] as [string, string]] : []), ['Link expires', 'In 1 hour']]} />}
      cta={{ label: 'Reset password', url }}
      footnote="If you didn't ask for this, ignore this email. Your password stays the same."
    />
  );
}

ResetPasswordEmail.PreviewProps = { url: 'https://pushr.sh/reset-password?token=preview', to: 'avery@acme.com' } satisfies ResetPasswordProps;
