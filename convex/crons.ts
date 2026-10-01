import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Daily at 03:10 UTC — low-traffic window. Each sweep paginates via the
// scheduler so a large backlog doesn't blow the transaction budget.
crons.cron('cleanup stale data', '10 3 * * *', internal.cleanup.runAll, {});

// Weekly orphan sweep on Sundays at 04:00 UTC. Walks the full deliveries /
// actionEvents tables doing one db.get per row to find children whose parent
// notification was deleted without cascading. Only runs weekly because the
// cascade paths in notifications.ts / sourceApps.ts mean new orphans should
// be rare; this is a safety net + cleanup for the historical backlog.
crons.cron('orphan cleanup', '0 4 * * 0', internal.cleanup.runOrphanSweeps, {});

export default crons;
