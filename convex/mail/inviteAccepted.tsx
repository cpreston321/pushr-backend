import { Column, Row, Text } from '@react-email/components';
import { AppMark, appScreen, Avatar, Badge, C, firstName, initials, Layout, NoticeMark, Panel } from './_layout';

/** To whoever sent an invite, once it's accepted. */
export type InviteAcceptedProps = {
  memberName: string;
  memberEmail: string;
  appId: string;
  appName: string;
  appLogoUrl?: string | null;
  appColor?: string | null;
  role: 'editor' | 'viewer';
};

const ROLE = { editor: 'Editor', viewer: 'Viewer' };
const body = (p: InviteAcceptedProps) => `They accepted your invite and now get ${p.appName}'s pushes on their phone.`;
const footnote = (p: InviteAcceptedProps) => `You're getting this because you invited ${p.memberEmail} to ${p.appName}.`;

export const subject = (p: InviteAcceptedProps) => `${p.memberName} joined ${p.appName}`;

export const text = (p: InviteAcceptedProps) =>
  [
    `${p.memberName}${p.memberName !== p.memberEmail ? ` (${p.memberEmail})` : ''} joined ${p.appName} as ${ROLE[p.role].toLowerCase()}.`,
    body(p),
    '',
    `See who's in ${p.appName}: ${appScreen('apps')}`,
    '',
    footnote(p),
    '',
    'pushr.sh'
  ].join('\n');

export default function InviteAcceptedEmail(p: InviteAcceptedProps) {
  return (
    <Layout
      heading={`${firstName(p.memberName)} joined ${p.appName}`}
      preview={body(p)}
      body={body(p)}
      hero={
        <NoticeMark
          mark={<AppMark id={p.appId} name={p.appName} logoUrl={p.appLogoUrl} color={p.appColor} size={48} />}
          label="New member"
          tone={C.ok}
        />
      }
      details={
        <Panel>
          <Row>
            <Column style={{ width: 36, padding: '14px 0 14px 16px' }} valign="middle">
              <Avatar size={36} color={C.cobalt} label={initials(p.memberName)} />
            </Column>
            <Column style={{ padding: '14px 8px 14px 12px' }} valign="middle">
              <Text style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.bone }}>{p.memberName}</Text>
              {p.memberName !== p.memberEmail && <Text style={{ margin: 0, fontSize: 13, color: C.mute }}>{p.memberEmail}</Text>}
            </Column>
            <Column align="right" valign="middle" style={{ padding: '14px 16px 14px 0' }}>
              <Badge>{ROLE[p.role]}</Badge>
            </Column>
          </Row>
        </Panel>
      }
      cta={{ label: 'View members', url: appScreen('apps') }}
      footnote={footnote(p)}
    />
  );
}

InviteAcceptedEmail.PreviewProps = {
  memberName: 'Sam Rivera',
  memberEmail: 'sam@example.com',
  appId: 'preview-northwind',
  appName: 'Northwind',
  appLogoUrl: null,
  appColor: '#C9A24A',
  role: 'editor'
} satisfies InviteAcceptedProps;
