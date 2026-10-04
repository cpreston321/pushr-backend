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

// Heartbeats: alert on any whose window has closed since the last run.
crons.interval('heartbeat check', { minutes: 1 }, internal.heartbeats.checkDue, {});
crons.interval('uptime checks', { minutes: 1 }, internal.uptime.dispatchDue, {});
// Status pages show 90 days; incidents older than that go.
crons.cron('monitor incident sweep', '40 3 * * *', internal.statusPages.sweepIncidents, {});


export default crons;
