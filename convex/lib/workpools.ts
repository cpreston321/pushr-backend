import { Workpool } from '@convex-dev/workpool';
import { components } from '../_generated/api';

/**
 * Pool for Expo Push deliveries. Retry 3× since the Expo push API
 * occasionally 502s and we don't want one flake to drop notifications.
 */
export const pushPool = new Workpool(components.pushPool, {
  maxParallelism: 10,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    maxAttempts: 3,
    initialBackoffMs: 500,
    base: 2
  }
});
