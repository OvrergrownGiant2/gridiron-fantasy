import '../src/loadEnv';
import { createNodeApp } from '../src/node';
import { seedDemo, DEMO_USERS } from '../src/services/seed';

const { app, clock } = await createNodeApp();
if (!clock) { console.error('Seeding requires NFL_PROVIDER=demo (simulated) or NFL_PROVIDER=snapshot (real nflverse snapshot).'); process.exit(1); }
const r = await seedDemo(app, clock, (m, p) => console.log(`${String(p).padStart(3)}% ${m}`));
console.log(r.skipped ? 'Database already has users; seed skipped.' : `Seeded. Sign in as ${DEMO_USERS.map((u) => `${u.username}/${u.password}`).join(' or ')}.`);
await app.db.close?.();
