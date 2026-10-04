import { Body, Button, Column, Container, Font, Head, Heading, Html, Img, Link, Preview, Row, Section, Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';

/*
 * Every pushr email, drawn like pushr.sh: the ink canvas, a card with the
 * site's 7% hairline, the site's type and colors. react-email turns these into
 * tables and inline styles, so Gmail, Outlook and Apple Mail render them the
 * same. Preview them all with `bun run emails`.
 */

export const SITE = 'https://pushr.sh';
// The site's stacks (apps/web/src/index.css): Apple's own faces first, Inter where they're missing.
export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const DISPLAY = "-apple-system,BlinkMacSystemFont,'SF Pro Display',Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace";

/** The site's tokens, by the same names. Hairlines are its fg/7% and fg/8%, mixed onto the surface beneath. */
export const C = {
  ink: '#0a0a0b',
  ink2: '#111113',
  card: '#161618',
  hairline: '#262628',
  bone: '#f5f5f7',
  mute: '#a1a1a6',
  faint: '#8d8d93',
  dim: '#6e6e73',
  wireBright: '#8fb0ff',
  cobalt: '#3e7bfa',
  ok: '#5fd67f',
  gold: '#f5c76b',
  violet: '#c792ea',
  // The blue of the pushr icon (apps/web/public/pushr-icon.png), for the button.
  accent: '#278ee8'
};

/**
 * The HTML bgcolor attribute, which desktop Outlook keeps when it drops a CSS
 * background. React passes it through untouched; its types just don't list it.
 */
export const bgcolor = (color: string) => ({ bgcolor: color }) as Record<string, string>;

/** Initials as the site draws them (AppAvatar): a name's first and last, or one word's first two letters. */
export function initials(name: string): string {
  const words = name.replace(/@.*/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const APP_COLORS = ['#17B8A0', '#3E7BFA', '#C9A24A', '#C15CF0', '#2FB566', '#F0355A', '#6558F5', '#E0763B', '#4CA5E8', '#D4499B'];

/** An app's hue from its id when it has no logo color: FNV-1a, as the site and the iPhone app do (lib/appColor.ts). */
export function appColor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return APP_COLORS[Math.abs(hash) % APP_COLORS.length];
}

/** The site's avatar fill: the color, lightened 18% toward white at the top-left. */
export function avatarGradient(color: string): string {
  const n = parseInt(color.replace('#', ''), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.18);
  const light = `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
  return `linear-gradient(160deg, ${light}, ${color})`;
}

export function Layout({
  heading,
  preview,
  body,
  cta,
  footnote,
  hero,
  details,
  children
}: {
  heading: string;
  /** The line inboxes show beside the subject. */
  preview: string;
  body: string;
  cta?: { label: string; url: string } | null;
  footnote: string;
  /** Above the heading, such as the app an invite is for. */
  hero?: ReactNode;
  /** Between the body and the button. */
  details?: ReactNode;
  /** Placed after the button. */
  children?: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        {/* Inter for clients without Apple's fonts that load web fonts; one variable file covers every weight.
            Served from the sending domain: receivers trust off-domain assets less. */}
        <Font
          fontFamily="Inter"
          fallbackFontFamily={['Helvetica', 'Arial', 'sans-serif']}
          webFont={{ url: `${SITE}/fonts/inter.woff2`, format: 'woff2' }}
          fontWeight="100 900"
          fontStyle="normal"
        />
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
        <title>{heading}</title>
      </Head>
      <Preview>{preview}</Preview>
      <Body {...bgcolor(C.ink)} style={{ margin: 0, padding: 0, backgroundColor: C.ink, fontFamily: FONT, WebkitFontSmoothing: 'antialiased' }}>
        <Section {...bgcolor(C.ink)} style={{ backgroundColor: C.ink, padding: '48px 16px' }}>
          <Container style={{ maxWidth: 480 }}>
            {/* The site header's lockup: the icon and "pushr". */}
            <Section style={{ padding: '0 4px 24px' }}>
              <Link href={SITE} style={{ textDecoration: 'none' }}>
                <Img
                  src={`${SITE}/pushr-icon.png`}
                  width="28"
                  height="28"
                  alt=""
                  style={{ display: 'inline-block', verticalAlign: 'middle', borderRadius: 7, border: 0 }}
                />
                <span style={{ verticalAlign: 'middle', marginLeft: 8, fontSize: 16, fontWeight: 600, color: C.bone, letterSpacing: '-0.02em' }}>pushr</span>
              </Link>
            </Section>
            <Section {...bgcolor(C.card)} style={{ backgroundColor: C.card, border: `1px solid ${C.hairline}`, borderRadius: 24, padding: '36px 32px' }}>
              {hero}
              <Heading
                as="h1"
                style={{ margin: 0, fontFamily: DISPLAY, fontSize: 26, lineHeight: 1.15, fontWeight: 700, color: C.bone, letterSpacing: '-0.02em' }}
              >
                {heading}
              </Heading>
              <Text style={{ margin: 0, paddingTop: 12, fontSize: 16, lineHeight: 1.55, color: C.mute }}>{body}</Text>
              {details}
              {cta && (
                <Section style={{ paddingTop: 28 }}>
                  <Button
                    href={cta.url}
                    // The icon's blue, and set as an image too: dark-mode clients recolor a light
                    // background (a white pill came out black) but leave gradients alone.
                    style={{
                      display: 'inline-block',
                      backgroundColor: C.accent,
                      backgroundImage: `linear-gradient(${C.accent}, ${C.accent})`,
                      color: '#ffffff',
                      textDecoration: 'none',
                      fontSize: 15,
                      fontWeight: 600,
                      padding: '13px 24px',
                      borderRadius: 999
                    }}
                  >
                    {cta.label}
                  </Button>
                </Section>
              )}
              {children}
              <Text style={{ margin: 0, paddingTop: 28, fontSize: 13, lineHeight: 1.5, color: C.faint }}>{footnote}</Text>
            </Section>
            <Text style={{ margin: 0, padding: '24px 4px 0', fontSize: 12.5, lineHeight: 1.6, color: C.dim }}>
              <Link href={SITE} style={FOOT_LINK}>
                pushr.sh
              </Link>
              {'  ·  '}
              <Link href={`${SITE}/support`} style={FOOT_LINK}>
                Support
              </Link>
              {'  ·  '}
              <Link href={`${SITE}/privacy`} style={FOOT_LINK}>
                Privacy
              </Link>
            </Text>
          </Container>
        </Section>
      </Body>
    </Html>
  );
}

const FOOT_LINK: CSSProperties = { color: C.faint, textDecoration: 'none' };

/** A screen in the iPhone app: pushr.sh/app/… is a Universal Link that opens it there. */
export const appScreen = (path: string) => `${SITE}/app/${path}`;

export function firstName(name: string): string {
  // An address stands in when someone has no name; keep it whole.
  return name.includes('@') ? name : (name.trim().split(/\s+/)[0] ?? name);
}

/** "Oct 3, 2026 at 9:12 PM UTC". The server can't know the reader's zone, so it says which one it used. */
export function when(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${date} at ${time} UTC`;
}

/**
 * A circle with initials, as the site's AppAvatar: a sized table cell (Yahoo
 * ignores CSS height), bgcolor for Outlook, and the gradient where it's drawn.
 * Outlook squares the corners; nothing else changes there.
 */
export function Avatar({ size, color, label }: { size: number; color: string; label: string }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0}>
      <tbody>
        <tr>
          <td
            width={String(size)}
            height={String(size)}
            align="center"
            {...bgcolor(color)}
            style={{
              backgroundColor: color,
              backgroundImage: avatarGradient(color),
              borderRadius: size / 2,
              color: '#ffffff',
              fontSize: Math.round(size * 0.36),
              fontWeight: 700,
              lineHeight: `${size}px`
            }}
          >
            {label}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** An app as the site draws it: its logo, or its initials on its color. */
export function AppMark({ id, name, logoUrl, color, size = 56 }: { id: string; name: string; logoUrl?: string | null; color?: string | null; size?: number }) {
  return logoUrl ? (
    <Img src={logoUrl} width={String(size)} height={String(size)} alt={name} style={{ borderRadius: size / 2, border: 0 }} />
  ) : (
    <Avatar size={size} color={color ?? appColor(id)} label={initials(name)} />
  );
}

/**
 * The top of a notice: a mark (an icon tile from pushr.sh/email, drawn as a
 * PNG so its corners hold in Outlook, or an app) and, in its tone, what kind
 * of notice this is.
 */
export function NoticeMark({ icon, mark, label, tone }: { icon?: string; mark?: ReactNode; label: string; tone: string }) {
  return (
    <Section style={{ paddingBottom: 18 }}>
      {mark ?? <Img src={`${SITE}/email/${icon}.png`} width="48" height="48" alt="" style={{ display: 'block', border: 0 }} />}
      <Text style={{ margin: 0, paddingTop: 18, fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: tone }}>
        {label}
      </Text>
    </Section>
  );
}

/** The site's Badge, accent tone: cobalt at 14% over ink-2, mixed ahead of time for Outlook. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 8px',
        borderRadius: 999,
        backgroundColor: '#17202f',
        color: C.wireBright,
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: '22px'
      }}
    >
      {children}
    </span>
  );
}

/** The inset box that holds an email's specifics: ink-2 on the card, hairline rows. */
export function Panel({ children }: { children: ReactNode }) {
  return (
    <Section {...bgcolor(C.ink2)} style={{ marginTop: 24, border: `1px solid ${C.hairline}`, borderRadius: 18, backgroundColor: C.ink2 }}>
      {children}
    </Section>
  );
}

/** Label and value rows inside a Panel. */
export function Facts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <Panel>
      {rows.map(([label, value], i) => (
        <Row key={label}>
          <Column
            valign="top"
            style={{ width: 120, padding: '12px 0 12px 16px', borderTop: i ? `1px solid ${C.hairline}` : undefined, fontSize: 13.5, color: C.faint }}
          >
            {label}
          </Column>
          <Column valign="top" style={{ padding: '12px 16px 12px 8px', borderTop: i ? `1px solid ${C.hairline}` : undefined, fontSize: 13.5, color: C.bone }}>
            {value}
          </Column>
        </Row>
      ))}
    </Panel>
  );
}
