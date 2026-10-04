import { Column, Row, Section, Text } from '@react-email/components';
import { AppMark, Avatar, Badge, C, firstName, initials, Layout, Panel } from './_layout';

/**
 * For someone invited to a shared app who doesn't use pushr yet, or hasn't
 * confirmed this address. It leads with the app, drawn as the site draws it,
 * and who's asking, so it reads as a person's invite rather than a system
 * email. The button is a one-tap invite link; someone without the app
 * installs it from that page, then taps the button again.
 */
export type InviteProps = {
  to: string;
  inviterName: string;
  inviterEmail?: string | null;
  appId: string;
  appName: string;
  /** The app's uploaded logo; without one, its initials on its color. */
  appLogoUrl?: string | null;
  appColor?: string | null;
  role: 'editor' | 'viewer';
  link: string;
};

const ROLE: Record<InviteProps['role'], { label: string; can: string }> = {
  editor: { label: 'Editor', can: 'You’ll get its pushes, and can send test pushes and change its monitors and settings.' },
  viewer: { label: 'Viewer', can: 'You’ll get its pushes and see its monitors.' }
};

const heading = (p: InviteProps) => `${firstName(p.inviterName)} invited you to ${p.appName}`;
const body = (p: InviteProps) =>
  `Open this on your iPhone to get ${p.appName}'s pushes there. New to pushr? Install it from the page that opens, then tap the button again.`;
const footnote = (p: InviteProps) => `This invite is for ${p.to} and expires in 30 days. If you weren't expecting it, ignore this email.`;

export const subject = (p: InviteProps) => `${p.inviterName} invited you to ${p.appName} on pushr`;

export const text = (p: InviteProps) =>
  [
    `${p.inviterName}${p.inviterEmail && p.inviterEmail !== p.inviterName ? ` (${p.inviterEmail})` : ''} invited you to ${p.appName} on pushr, as ${ROLE[p.role].label.toLowerCase()}.`,
    ROLE[p.role].can,
    '',
    `Accept: ${p.link}`,
    '',
    body(p),
    '',
    footnote(p),
    '',
    'pushr.sh'
  ].join('\n');

export default function InviteEmail(p: InviteProps) {
  const role = ROLE[p.role];
  const showEmail = !!p.inviterEmail && p.inviterEmail !== p.inviterName;
  return (
    <Layout
      heading={heading(p)}
      preview={`${p.inviterName} shared ${p.appName} with you. Get its pushes on your iPhone.`}
      body={body(p)}
      cta={{ label: `Join ${p.appName}`, url: p.link }}
      footnote={footnote(p)}
      hero={
        <Section style={{ paddingBottom: 22 }}>
          <AppMark id={p.appId} name={p.appName} logoUrl={p.appLogoUrl} color={p.appColor} />
        </Section>
      }
      details={
        <Panel>
          <Row>
            <Column style={{ width: 36, padding: '14px 0 14px 16px' }} valign="middle">
              {/* People are drawn as the dashboard draws an account: the site's blue gradient. */}
              <Avatar size={36} color={C.cobalt} label={initials(p.inviterName)} />
            </Column>
            <Column style={{ padding: '14px 16px 14px 12px' }} valign="middle">
              <Text style={{ margin: 0, fontSize: 12.5, color: C.faint }}>Invited by</Text>
              <Text style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.bone }}>{p.inviterName}</Text>
              {showEmail && <Text style={{ margin: 0, fontSize: 13, color: C.mute }}>{p.inviterEmail}</Text>}
            </Column>
          </Row>
          <Row>
            <Column style={{ borderTop: `1px solid ${C.hairline}`, padding: '12px 16px 14px' }}>
              <Text style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: C.mute }}>
                You’ll join as{' '}
                <Badge>{role.label}</Badge>
                . {role.can}
              </Text>
            </Column>
          </Row>
        </Panel>
      }
    />
  );
}

InviteEmail.PreviewProps = {
  to: 'sam@example.com',
  inviterName: 'Avery Chen',
  inviterEmail: 'avery@acme.com',
  appId: 'preview-northwind',
  appName: 'Northwind',
  appLogoUrl: null,
  appColor: '#C9A24A',
  role: 'editor',
  link: 'https://pushr.sh/invite/preview'
} satisfies InviteProps;
