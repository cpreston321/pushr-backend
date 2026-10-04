import { appScreen, C, Facts, Layout, NoticeMark, when } from './_layout';

/**
 * Apple stopped taking pushes for one of the account's phones (Expo reported
 * DeviceNotRegistered). Sent once per phone, and not when a newer phone has
 * already taken its place, which is what a reinstall looks like.
 */
export type PhoneStoppedProps = { phoneName: string; lastSeenAt: number; otherPhones: number };

const others = (n: number) => (n === 0 ? 'None. Nothing is getting your pushes.' : n === 1 ? '1 other phone' : `${n} other phones`);

export const subject = (p: PhoneStoppedProps) => `pushr can't reach ${p.phoneName}`;

export const text = (p: PhoneStoppedProps) =>
  [
    `pushr can't reach ${p.phoneName}.`,
    '',
    "Apple stopped accepting pushes for it, so it won't get alerts until pushr is opened on it again. That usually means pushr was deleted from it, or the phone was reset or replaced.",
    '',
    `Last opened pushr: ${when(p.lastSeenAt)}`,
    `Still getting pushes: ${others(p.otherPhones)}`,
    '',
    `Open pushr on the phone to reconnect it: ${appScreen('settings/devices')}`,
    '',
    FOOTNOTE,
    '',
    'pushr.sh'
  ].join('\n');

const FOOTNOTE = "If you removed pushr from this phone on purpose, there's nothing to do.";

export default function PhoneStoppedEmail(p: PhoneStoppedProps) {
  const reachable = p.otherPhones === 0 ? <span style={{ color: C.gold }}>{others(0)}</span> : others(p.otherPhones);
  return (
    <Layout
      heading={`pushr can't reach ${p.phoneName}`}
      preview={p.otherPhones === 0 ? 'Your alerts have nowhere to go.' : "One of your phones stopped getting pushes."}
      hero={<NoticeMark icon="phone-stopped" label="Delivery" tone={C.gold} />}
      body="Apple stopped accepting pushes for this phone, so it won't get alerts until pushr is opened on it again. That usually means pushr was deleted from it, or the phone was reset or replaced."
      details={
        <Facts
          rows={[
            ['Phone', p.phoneName],
            ['Last opened', when(p.lastSeenAt)],
            ['Still reachable', reachable]
          ]}
        />
      }
      cta={{ label: 'Open pushr on this phone', url: appScreen('settings/devices') }}
      footnote={FOOTNOTE}
    />
  );
}

PhoneStoppedEmail.PreviewProps = { phoneName: "Avery's iPhone", lastSeenAt: Date.UTC(2026, 9, 1, 18, 4), otherPhones: 0 } satisfies PhoneStoppedProps;
