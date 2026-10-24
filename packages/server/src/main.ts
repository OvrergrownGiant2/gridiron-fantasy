import './loadEnv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './http';
import { createNodeApp } from './node';
import { startJobs } from './services/jobs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { app, env } = await createNodeApp();
  const webDist = env.webDist ?? path.resolve(here, '../../web/dist');
  const server = createHttpServer(app, { webDist, trustProxy: env.trustProxy });
  const jobs = env.jobsEnabled ? startJobs(app) : null;
  const http = server.listen(env.port, () => {
    app.log(`listening on http://localhost:${env.port} (mode=${env.config.mode}, provider=${app.provider.id}${app.provider.isDemo ? ' — SIMULATED DEMO DATA' : ''}, jobs=${Boolean(jobs)})`);
  });
  const shutdown = async () => { jobs?.stop(); http.close(); await app.db.close?.(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
