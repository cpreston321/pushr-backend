/**
 * The backend's release version, reported by /healthz so the app and support
 * can tell which version a self-hosted server runs. Bumped by
 * `bun scripts/release.ts backend <version>`.
 */
export const BACKEND_VERSION = '1.0.0';

/**
 * What this server can do, for the app to show only what works against it.
 * Add a name in the same change that adds the capability; never remove one a
 * shipped app checks for. Older servers send no list, and the app reads that
 * as none of these.
 */
export const FEATURES = ['labels', 'outages'] as const;

/**
 * The oldest app this server still works with; older apps get an "Update
 * pushr" screen. Raise it only when a change can't stay compatible with them
 * (see contracts/ and appContract.test.ts).
 */
export const MIN_APP_VERSION = '1.0.0';
