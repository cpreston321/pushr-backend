import { appScreen, C, Facts, Layout, NoticeMark, when } from './_layout';

/** After a password change in Settings or a reset from an emailed link, so a change nobody asked for doesn't go unnoticed. */
export type PasswordChangedProps = { to: string; how: 'changed' | 'reset'; at: number };

const HOW = { changed: 'Changed in Settings', reset: 'Reset from an emailed link' };

export const subject = () => 'Your pushr password was changed';

export const text = (p: PasswordChangedProps) =>
  [
    `The password for your pushr account (${p.to}) was just changed.`,
    '',
    `How: ${HOW[p.how]}`,
    `When: ${when(p.at)}`,
    '',
    `If this wasn't you, reset your password now: ${appScreen('forgot-password')}`,
    '',
    FOOTNOTE,
    '',
    'pushr.sh'
  ].join('\n');

const FOOTNOTE = 'If this was you, there’s nothing to do.';

export default function PasswordChangedEmail(p: PasswordChangedProps) {
  return (
    <Layout
      heading="Your password was changed"
      preview="If this wasn't you, reset your password now."
      hero={<NoticeMark icon="password-changed" label="Security" tone={C.wireBright} />}
      body="The password for your pushr account was just changed. If this wasn't you, reset it now: the link opens the pushr app."
      details={
        <Facts
          rows={[
            ['Account', p.to],
            ['How', HOW[p.how]],
            ['When', when(p.at)]
          ]}
        />
      }
      cta={{ label: 'Reset password', url: appScreen('forgot-password') }}
      footnote={FOOTNOTE}
    />
  );
}

PasswordChangedEmail.PreviewProps = { to: 'avery@acme.com', how: 'changed', at: Date.UTC(2026, 9, 3, 21, 12) } satisfies PasswordChangedProps;
