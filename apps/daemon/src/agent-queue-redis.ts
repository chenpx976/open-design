// @ts-nocheck
import { randomUUID } from 'node:crypto';

function requireRedisUrl(env = process.env) {
  const url = env.OD_AGENT_REDIS_URL || env.REDIS_URL;
  if (!url) {
    throw new Error('OD_AGENT_JOB_QUEUE=redis requires OD_AGENT_REDIS_URL or REDIS_URL');
  }
  return url;
}

async function createRedisClient(env = process.env) {
  let mod;
  try {
    mod = await import('ioredis');
  } catch (err) {
    throw new Error(
      'OD_AGENT_JOB_QUEUE=redis requires the optional ioredis dependency to be installed',
      { cause: err },
    );
  }
  const Redis = mod.default ?? mod.Redis ?? mod;
  return new Redis(requireRedisUrl(env), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

function keys(namespace) {
  const prefix = namespace || 'open-design';
  return {
    queued: `${prefix}:agent-jobs:queued`,
    running: `${prefix}:agent-jobs:running`,
    job: (id) => `${prefix}:agent-jobs:job:${id}`,
  };
}

function parseJob(id, record) {
  if (!record || Object.keys(record).length === 0) return null;
  return {
    id,
    runId: record.runId,
    attempts: Number(record.attempts) || 0,
    payload: JSON.parse(record.payloadJson || 'null'),
  };
}

export async function createRedisAgentJobQueue({
  env = process.env,
  namespace = env.OD_AGENT_QUEUE_NAMESPACE || env.OD_NAMESPACE || 'open-design',
  client = null,
} = {}) {
  const redis = client ?? await createRedisClient(env);
  const k = keys(namespace);

  async function requeueStaleJobs({ staleAfterMs = 0, maxAttempts = 3 } = {}) {
    if (!staleAfterMs) return;
    const now = Date.now();
    const staleBefore = now - staleAfterMs;
    const staleIds = await redis.zrangebyscore(k.running, 0, staleBefore, 'LIMIT', 0, 100);
    for (const id of staleIds) {
      const jobKey = k.job(id);
      const record = await redis.hgetall(jobKey);
      if (!record || record.status !== 'running') {
        await redis.zrem(k.running, id);
        continue;
      }
      const attempts = Number(record.attempts) || 0;
      if (attempts >= maxAttempts) {
        await redis
          .multi()
          .zrem(k.running, id)
          .hset(jobKey, {
            status: 'failed',
            error: record.error || 'worker lease expired after max attempts',
            updatedAt: String(now),
          })
          .exec();
      } else {
        await redis
          .multi()
          .zrem(k.running, id)
          .hset(jobKey, {
            status: 'queued',
            lockedAt: '',
            lockedBy: '',
            updatedAt: String(now),
          })
          .rpush(k.queued, id)
          .exec();
      }
    }
  }

  return {
    async enqueueJob(runId, payload) {
      const id = randomUUID();
      const now = Date.now();
      await redis
        .multi()
        .hset(k.job(id), {
          id,
          runId,
          status: 'queued',
          payloadJson: JSON.stringify(payload ?? null),
          attempts: '0',
          createdAt: String(now),
          updatedAt: String(now),
        })
        .rpush(k.queued, id)
        .exec();
      return { id, runId };
    },
    async claimNextJob(workerId, options = {}) {
      const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
      await requeueStaleJobs({ ...options, maxAttempts });
      while (true) {
        const id = await redis.lpop(k.queued);
        if (!id) return null;
        const jobKey = k.job(id);
        const record = await redis.hgetall(jobKey);
        if (!record || Object.keys(record).length === 0 || record.status !== 'queued') continue;
        const attempts = Number(record.attempts) || 0;
        if (attempts >= maxAttempts) {
          await redis.hset(jobKey, {
            status: 'failed',
            error: record.error || 'max attempts exceeded before claim',
            updatedAt: String(Date.now()),
          });
          continue;
        }
        const now = Date.now();
        const nextAttempts = attempts + 1;
        await redis
          .multi()
          .hset(jobKey, {
            status: 'running',
            attempts: String(nextAttempts),
            lockedAt: String(now),
            lockedBy: workerId,
            updatedAt: String(now),
          })
          .zadd(k.running, now, id)
          .exec();
        return parseJob(id, { ...record, attempts: String(nextAttempts) });
      }
    },
    async heartbeatJob(jobId, workerId) {
      const jobKey = k.job(jobId);
      const record = await redis.hgetall(jobKey);
      if (!record || record.status !== 'running' || record.lockedBy !== workerId) return;
      const now = Date.now();
      await redis
        .multi()
        .hset(jobKey, { lockedAt: String(now), updatedAt: String(now) })
        .zadd(k.running, now, jobId)
        .exec();
    },
    async completeJob(jobId) {
      await redis
        .multi()
        .zrem(k.running, jobId)
        .hset(k.job(jobId), {
          status: 'succeeded',
          error: '',
          updatedAt: String(Date.now()),
        })
        .exec();
    },
    async failJob(jobId, error, options = {}) {
      const jobKey = k.job(jobId);
      const record = await redis.hgetall(jobKey);
      const attempts = Number(record?.attempts) || 0;
      const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
      const retryable = options.retryable === true && attempts < maxAttempts;
      const now = Date.now();
      if (retryable) {
        await redis
          .multi()
          .zrem(k.running, jobId)
          .hset(jobKey, {
            status: 'queued',
            error: String(error ?? ''),
            lockedAt: '',
            lockedBy: '',
            updatedAt: String(now),
          })
          .rpush(k.queued, jobId)
          .exec();
        return;
      }
      await redis
        .multi()
        .zrem(k.running, jobId)
        .hset(jobKey, {
          status: 'failed',
          error: String(error ?? ''),
          updatedAt: String(now),
        })
        .exec();
    },
  };
}
