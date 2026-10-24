import '../src/loadEnv';
import { createNodeApp } from '../src/node';

const { app } = await createNodeApp();
console.log('migrations up to date');
await app.db.close?.();
