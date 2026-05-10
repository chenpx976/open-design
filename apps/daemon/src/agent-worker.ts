// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { createAgentRunBackendsFromEnv } from './agent-run-backends.js';
import { createInlinePiAgentRuntime } from './agent-runtime.js';
import { createLocalProjectFs } from './project-fs.js';

export async function runAgentWorker({
  projectRoot = process.cwd(),
  dataDir = process.env.OD_DATA_DIR,
  pollIntervalMs = Number(process.env.OD_AGENT_WORKER_POLL_MS) || 500,
  leaseMs = Number(process.env.OD_AGENT_WORKER_LEASE_MS) || 120_000,
  heartbeatMs = Number(process.env.OD_AGENT_WORKER_HEARTBEAT_MS) || 30_000,
  maxJobMs = Number(process.env.OD_AGENT_WORKER_MAX_JOB_MS) || 15 * 60_000,
  maxAttempts = Number(process.env.OD_AGENT_WORKER_MAX_ATTEMPTS) || 3,
  idleExitMs = Number(process.env.OD_AGENT_WORKER_IDLE_EXIT_MS) || 0,
  workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
} = {}) {
  const db = openDatabase(projectRoot, { dataDir });
  const { runStore, jobQueue } = await createAgentRunBackendsFromEnv(process.env, { db });
  const runtime = createInlinePiAgentRuntime();
  let idleSince = Date.now();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    const job = await jobQueue.claimNextJob(workerId, {
      staleAfterMs: leaseMs,
      maxAttempts,
    });
    if (!job) {
      if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) return { workerId, idle: true };
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    idleSince = Date.now();
    console.log(`[agent-worker] run=${job.runId} job=${job.id} worker=${workerId} claimed attempt=${job.attempts}`);
    await runJob({ job, runStore, jobQueue, runtime, workerId, heartbeatMs, maxJobMs, maxAttempts });
  }
  return { workerId, stopped: true };
}

async function runJob({ job, runStore, jobQueue, runtime, workerId, heartbeatMs, maxJobMs, maxAttempts }) {
  const payload = job.payload || {};
  const runId = job.runId;
  const abortController = new AbortController();
  const timeout = maxJobMs > 0
    ? setTimeout(() => abortController.abort(), maxJobMs)
    : null;
  timeout?.unref?.();
  const heartbeat = jobQueue.heartbeatJob && heartbeatMs > 0
    ? setInterval(() => {
        void jobQueue.heartbeatJob(job.id, workerId);
      }, heartbeatMs)
    : null;
  heartbeat?.unref?.();
  let eventWrites = Promise.resolve();
  const appendRunEvent = (channel: string, data: unknown) => {
    eventWrites = eventWrites
      .then(() => runStore.appendRunEvent(runId, channel, data))
      .catch((err) => {
        console.warn('[agent-worker] run event write failed:', err instanceof Error ? err.message : String(err));
      });
    return eventWrites;
  };
  try {
    await runStore.updateRunStatus(runId, 'running', null, null);
    const projectFs = createLocalProjectFs(payload.projectFsRoot || payload.cwd);
    const result = await runtime.run({
      cwd: payload.cwd,
      prompt: payload.prompt,
      model: payload.model ?? null,
      reasoning: payload.reasoning ?? null,
      imagePaths: Array.isArray(payload.imagePaths) ? payload.imagePaths : [],
      uploadRoot: payload.uploadRoot ?? null,
      signal: abortController.signal,
      projectFs,
      events: {
        emit: (channel, data) => {
          void appendRunEvent(channel, data);
        },
      },
    });
    if (abortController.signal.aborted) {
      throw new Error(`worker job exceeded ${maxJobMs}ms`);
    }
    if (result?.error) throw result.error;
    await eventWrites;
    await runStore.updateRunStatus(runId, result?.aborted ? 'canceled' : 'succeeded', result?.aborted ? 1 : 0, null);
    await appendRunEvent('end', {
      code: result?.aborted ? 1 : 0,
      signal: null,
      status: result?.aborted ? 'canceled' : 'succeeded',
    });
    await jobQueue.completeJob(job.id);
    console.log(`[agent-worker] run=${runId} job=${job.id} worker=${workerId} status=${result?.aborted ? 'canceled' : 'succeeded'}`);
  } catch (err) {
    await eventWrites;
    const message = err instanceof Error ? err.message : String(err);
    const retryable = job.attempts < maxAttempts;
    await appendRunEvent('error', {
      code: 'AGENT_EXECUTION_FAILED',
      message,
      retryable,
    });
    if (retryable) {
      await runStore.updateRunStatus(runId, 'queued', null, null);
    } else {
      await runStore.updateRunStatus(runId, 'failed', 1, null);
      await appendRunEvent('end', { code: 1, signal: null, status: 'failed' });
    }
    await jobQueue.failJob(job.id, message, { retryable, maxAttempts });
    console.warn(`[agent-worker] run=${runId} job=${job.id} worker=${workerId} status=${retryable ? 'retrying' : 'failed'} error=${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
  }
}
