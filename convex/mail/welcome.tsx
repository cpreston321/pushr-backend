import { CodeInline, Column, Hr, Img, Link, Row, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { bgcolor, C, Layout, MONO, SITE } from './_layout';

/**
 * Sent once per new account. Email sign-ups get it in place of the plain
 * verification email, so it carries the confirm button; Sign in with Apple
 * accounts arrive verified and get it without one.
 */
export type WelcomeProps = { name?: string | null; confirmUrl?: string };

const firstName = (name?: string | null) => name?.trim().split(/\s+/)[0];
const FOOTNOTE = "You're getting this because you created a pushr account. If that wasn't you, ignore this email.";

export const subject = () => 'Welcome to pushr';

export const text = ({ name, confirmUrl }: WelcomeProps) => {
  const first = firstName(name);
  return [
    first ? `Welcome to pushr, ${first}!` : 'Welcome to pushr!',
    '',
    confirmUrl ? `Confirm your email: ${confirmUrl}\n` : '',
    'Your first push:',
    '1. In the app, open Apps and tap + to create a source app.',
    '2. Copy its token (starts with pshr_, shown once, next to a ready-to-run command).',
    '3. curl -X POST "$PUSHR_URL/notify" -H "Authorization: Bearer $PUSHR_TOKEN" -d \'{"title":"Hello from my server"}\'',
    '',
    `Docs: ${SITE}/docs`,
    '',
    FOOTNOTE,
    '',
    'pushr.sh'
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
};

export default function WelcomeEmail({ name, confirmUrl }: WelcomeProps) {
  const first = firstName(name);
  return (
    <Layout
      heading={first ? `Welcome, ${first}.` : 'Welcome to pushr.'}
      preview="Your first push, in a minute."
      body={
        confirmUrl
          ? 'Your phone is on the wire. Confirm your email first: it lets you accept invites and reset your password.'
          : 'Your account is ready and your phone is on the wire.'
      }
      cta={confirmUrl ? { label: 'Confirm email', url: confirmUrl } : null}
      footnote={FOOTNOTE}
    >
      <Hr style={{ margin: '32px 0 0', borderColor: C.hairline }} />
      <Section style={{ paddingTop: 28 }}>
        <Text style={{ margin: 0, paddingBottom: 18, fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: C.dim }}>
          Your first push, in a minute
        </Text>
        <Step n={1} title="Create a source app">
          In the app, open Apps and tap +. One per project, script or service.
        </Step>
        <Step n={2} title="Copy its token">
          It starts with <Code>pshr_</Code> and is shown once, next to a ready-to-run command with your server URL filled in.
        </Step>
        <Step n={3} title="Send it">
          From any terminal, CI job or server, it looks like this:
        </Step>
        <Terminal />
        <Text style={{ margin: 0, paddingTop: 18, fontSize: 14, lineHeight: 1.55, color: C.mute }}>
          Prefer code? <Code>bun add @pushrsh/sdk</Code> or <Code>brew install cpreston321/tap/pushrsh</Code>. Everything else is in the{' '}
          <Link href={`${SITE}/docs`} style={{ color: C.wireBright, textDecoration: 'none' }}>
            docs
          </Link>
          .
        </Text>
      </Section>
    </Layout>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Row>
      <Column valign="top" style={{ width: 36, paddingBottom: 18 }}>
        {/* A sized cell rather than CSS height (Yahoo drops it), in a solid color rather than rgba() (Outlook drops it). */}
        <table role="presentation" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td
                width="24"
                height="24"
                align="center"
                {...bgcolor(STEP_BG)}
                style={{ backgroundColor: STEP_BG, borderRadius: 12, color: C.wireBright, fontSize: 12, fontWeight: 700, lineHeight: '24px' }}
              >
                {n}
              </td>
            </tr>
          </tbody>
        </table>
      </Column>
      <Column valign="top" style={{ padding: '2px 0 18px' }}>
        <Text style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.bone }}>{title}</Text>
        <Text style={{ margin: 0, paddingTop: 3, fontSize: 14, lineHeight: 1.55, color: C.mute }}>{children}</Text>
      </Column>
    </Row>
  );
}

/**
 * The site's CodeBlock: one ink-2 frame, a header of three dots and the
 * language, then the command in the site's shell colors. Plain spans in the
 * frame's own cell, with no <pre> background that clients draw as a second box.
 */
function Terminal() {
  const cell = { backgroundColor: C.ink2, borderLeft: `1px solid ${C.hairline}`, borderRight: `1px solid ${C.hairline}` };
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ marginTop: -4, borderCollapse: 'separate' }}>
      <tbody>
        <tr>
          <td {...bgcolor(C.ink2)} style={{ ...cell, borderTop: `1px solid ${C.hairline}`, borderRadius: '18px 18px 0 0', padding: '12px 16px 0' }}>
            {/* An image sized by attributes: Yahoo drops CSS height on a drawn dot. */}
            <Img src={`${SITE}/email/terminal-dots.png`} width="36" height="8" alt="" style={{ display: 'inline-block', border: 0, verticalAlign: 'middle' }} />
            <span style={{ marginLeft: 10, fontSize: 12, color: C.dim, verticalAlign: 'middle' }}>bash</span>
          </td>
        </tr>
        <tr>
          <td
            {...bgcolor(C.ink2)}
            style={{ ...cell, borderBottom: `1px solid ${C.hairline}`, borderRadius: '0 0 18px 18px', padding: '12px 16px 16px', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, color: C.mute }}
          >
            {CURL.map((line, i) => (
              <div key={i} style={{ fontFamily: MONO }}>
                {line.map(([kind, s], j) => (
                  <span key={j} style={{ fontFamily: MONO, ...SHELL[kind] }}>
                    {s}
                  </span>
                ))}
              </div>
            ))}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <CodeInline style={{ fontFamily: MONO, fontSize: '0.92em', color: C.bone, backgroundColor: 'transparent' }}>{children}</CodeInline>;
}

// The site's shell colors (TokenReveal): command, flag, string, $VARIABLE, continuation.
const SHELL = {
  cmd: { color: '#ffffff', fontWeight: 600 },
  flag: { color: '#c792ea' },
  str: { color: '#a8e6a3' },
  var: { color: '#f5c76b' },
  cont: { color: C.dim },
  sp: {}
};

type Tok = [keyof typeof SHELL, string];

const NBSP = ' ';
const CURL: Tok[][] = [
  [['cmd', 'curl'], ['sp', ' '], ['flag', '-X'], ['sp', ' POST '], ['str', '"'], ['var', '$PUSHR_URL'], ['str', '/notify"'], ['sp', ' '], ['cont', '\\']],
  [['sp', NBSP + NBSP], ['flag', '-H'], ['sp', ' '], ['str', '"Authorization: Bearer '], ['var', '$PUSHR_TOKEN'], ['str', '"'], ['sp', ' '], ['cont', '\\']],
  [['sp', NBSP + NBSP], ['flag', '-d'], ['sp', ' '], ['str', `'{"title":"Hello from my server"}'`]]
];

// Cobalt at 16% over the card, mixed ahead of time.
const STEP_BG = '#1c263c';

WelcomeEmail.PreviewProps = { name: 'Avery Chen', confirmUrl: 'https://pushr.sh/api/auth/verify-email?token=preview' } satisfies WelcomeProps;
