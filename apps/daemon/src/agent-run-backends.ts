// @ts-nocheck
import { createSqliteAgentJobQueue, createSqliteAgentRunPersistence } from './agent-run-store.js';
import { createRedisAgentJobQueue } from './agent-queue-redis.js';
import { createPostgresAgentRunPersistence } from './agent-run-postgres.js';

export async function createAgentRunPersistenceFromEnv(env, { db }) {
  const kind = String(env.OD_AGENT_RUN_STORE || 'sqlite').trim().toLowerCase();
  if (kind === 'sqlite' || kind === '') return createSqliteAgentRunPersistence(db);
  if (kind === 'postgres' || kind === 'postgresql') {
    return createPostgresAgentRunPersistence({ env });
  }
  throw new Error(`Unsupported OD_AGENT_RUN_STORE: ${kind}`);
}

export async function createAgentJobQueueFromEnv(env, { db }) {
  const kind = String(env.OD_AGENT_JOB_QUEUE || '').trim().toLowerCase();
  if (!kind || kind === 'sqlite') return createSqliteAgentJobQueue(db);
  if (kind === 'redis') return createRedisAgentJobQueue({ env });
  throw new Error(`Unsupported OD_AGENT_JOB_QUEUE: ${kind}`);
}

export async function createAgentRunBackendsFromEnv(env, { db }) {
  const runStore = await createAgentRunPersistenceFromEnv(env, { db });
  const jobQueue = await createAgentJobQueueFromEnv(env, { db });
  return { runStore, jobQueue };
}
