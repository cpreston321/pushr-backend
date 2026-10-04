import { SELF_HOSTED } from './deployment';

/**
 * Sign in with Apple is off on self-hosted servers unless the owner sets
 * APPLE_SIGN_IN=enabled. Apple gives every server for the pushr app the same
 * identifier for a person, so signing in to someone's server would link their
 * Apple ID to your cloud account; deletion there can't revoke the Apple
 * sign-in; and Hide My Email addresses can't receive that server's email.
 */
export function appleSignInEnabled(): boolean {
  return !SELF_HOSTED || process.env.APPLE_SIGN_IN === 'enabled';
}
