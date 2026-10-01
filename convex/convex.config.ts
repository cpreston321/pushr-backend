import { defineApp } from 'convex/server';
import betterAuth from '@convex-dev/better-auth/convex.config';
import workpool from '@convex-dev/workpool/convex.config';

const app = defineApp();
app.use(betterAuth);
app.use(workpool, { name: 'pushPool' });

export default app;
