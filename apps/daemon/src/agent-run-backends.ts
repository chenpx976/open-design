// @ts-nocheck
import { createSqliteAgentJobQueue, createSqliteAgentRunPersistence } from './agent-run-store.js';
import { createRedisAgentJobQueue } from './agent-queue-redis.js';
import { createPostgresAgentRunPersistence } from './agent-run-postgres.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryConfig(env) {
  return {
    attempts: Math.max(1, Number(env.OD_AGENT_BACKEND_CONNECT_ATTEMPTS) || 12),
    delayMs: Math.max(50, Number(env.OD_AGENT_BACKEND_CONNECT_DELAY_MS) || 500),
  };
}

function isTransientBackendError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || error?.cause?.code || '');
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'Connection terminated',
    'Connection is closed',
    'the database system is starting up',
    'Ready check failed',
  ].some((needle) => code === needle || message.includes(needle));
}

async function withBackendRetry(label, env, factory) {
  const { attempts, delayMs } = retryConfig(env);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await factory();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isTransientBackendError(err)) throw err;
      const waitMs = delayMs * attempt;
      console.warn(`[agent-runtime] ${label} unavailable, retrying in ${waitMs}ms (${attempt}/${attempts}): ${err instanceof Error ? err.message : String(err)}`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

export async function createAgentRunPersistenceFromEnv(env, { db }) {
  const kind = String(env.OD_AGENT_RUN_STORE || 'sqlite').trim().toLowerCase();
  if (kind === 'sqlite' || kind === '') return createSqliteAgentRunPersistence(db);
  if (kind === 'postgres' || kind === 'postgresql') {
    return withBackendRetry('postgres run store', env, () => createPostgresAgentRunPersistence({ env }));
  }
  throw new Error(`Unsupported OD_AGENT_RUN_STORE: ${kind}`);
}

export async function createAgentJobQueueFromEnv(env, { db }) {
  const kind = String(env.OD_AGENT_JOB_QUEUE || '').trim().toLowerCase();
  if (!kind || kind === 'sqlite') return createSqliteAgentJobQueue(db);
  if (kind === 'redis') return withBackendRetry('redis job queue', env, () => createRedisAgentJobQueue({ env }));
  throw new Error(`Unsupported OD_AGENT_JOB_QUEUE: ${kind}`);
}

export async function createAgentRunBackendsFromEnv(env, { db }) {
  const runStore = await createAgentRunPersistenceFromEnv(env, { db });
  const jobQueue = await createAgentJobQueueFromEnv(env, { db });
  return { runStore, jobQueue };
}
