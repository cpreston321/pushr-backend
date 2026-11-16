import { createAuth } from '../auth';

// Read by `npx auth generate` to write schema.ts; nothing imports it at runtime.
export const auth = createAuth({} as any);
