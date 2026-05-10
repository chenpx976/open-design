import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const composeFile = path.join(repoRoot, 'deploy', 'docker-compose.yml');

async function readRepoFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...segments), 'utf8');
}

async function commandOk(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { cwd: repoRoot, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  return commandOk('docker', ['image', 'inspect', image]);
}

function composeArgs(projectName: string, ...args: string[]): string[] {
  return ['compose', '-p', projectName, '-f', composeFile, '--profile', 'worker', ...args];
}

async function dockerCompose(projectName: string, args: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync('docker', composeArgs(projectName, ...args), {
    cwd: repoRoot,
    env,
    timeout: 15 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`compose service did not become healthy: ${last}`);
}

async function createProjectAndRun(baseUrl: string, projectId: string, message = 'Create a deterministic Pi compose cluster smoke artifact'): Promise<string> {
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: 'Compose cluster smoke',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    }),
  });
  expect(created.ok).toBe(true);
  const { conversationId } = await created.json() as { conversationId: string };
  const started = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-od-client': 'web' },
    body: JSON.stringify({
      agentId: 'pi',
      projectId,
      conversationId,
      assistantMessageId: `assistant-${projectId}`,
      clientRequestId: `compose-${projectId}`,
      skillId: null,
      designSystemId: null,
      model: 'default',
      reasoning: 'default',
      message,
    }),
  });
  expect(started.ok).toBe(true);
  const { runId } = await started.json() as { runId: string };
  return runId;
}

async function waitForRunStatus(baseUrl: string, runId: string, expected: 'succeeded' | 'failed'): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  let status = '';
  let body: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    expect(response.ok).toBe(true);
    body = await response.json() as Record<string, unknown>;
    status = String(body.status ?? '');
    if (status === expected) return body;
    if (status === 'failed' || status === 'canceled' || status === 'succeeded') {
      throw new Error(`run ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`run did not finish, last status=${status}`);
}

async function findRedisJobForRun(projectName: string, env: NodeJS.ProcessEnv, runId: string): Promise<{ key: string; status: string; error: string }> {
  const redisJobs = await dockerCompose(projectName, [
    'exec',
    '-T',
    'redis',
    'redis-cli',
    'keys',
    'open-design:agent-jobs:job:*',
  ], env);
  const jobKeys = redisJobs.stdout.trim().split(/\s+/).filter(Boolean);
  for (const key of jobKeys) {
    const row = await dockerCompose(projectName, [
      'exec',
      '-T',
      'redis',
      'redis-cli',
      '--raw',
      'hmget',
      key,
      'runId',
      'status',
      'error',
    ], env);
    const [storedRunId, status = '', error = ''] = row.stdout.trimEnd().split('\n');
    if (storedRunId === runId) return { key, status, error };
  }
  throw new Error(`missing Redis job for run ${runId}`);
}

describe('cluster deployment configuration', () => {
  it('keeps API, worker, Postgres, and Redis knobs wired through Compose and docs', async () => {
    const [compose, envExample, deployReadme, clusterDoc] = await Promise.all([
      readRepoFile('deploy', 'docker-compose.yml'),
      readRepoFile('deploy', '.env.example'),
      readRepoFile('deploy', 'README.md'),
      readRepoFile('docs', 'cluster-deployment.md'),
    ]);

    expect(compose).toContain('agent-worker:');
    expect(compose).toContain('redis:');
    expect(compose).toContain('postgres:');
    expect(compose).toContain('OD_AGENT_RUN_STORE');
    expect(compose).toContain('OD_AGENT_POSTGRES_URL');
    expect(compose).toContain('OD_AGENT_JOB_QUEUE');
    expect(compose).toContain('OD_AGENT_REDIS_URL');
    expect(compose).toContain('OD_AGENT_BACKEND_CONNECT_ATTEMPTS');
    expect(compose).toContain('OD_E2E_FAKE_PI_AGENT');
    expect(compose).toContain('agent-worker\", \"--healthcheck');
    expect(compose).toContain('condition: service_healthy');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_RUN_STORE=postgres');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_POSTGRES_URL=postgres://open_design:open_design@postgres:5432/open_design');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_JOB_QUEUE=redis');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_REDIS_URL=redis://redis:6379/0');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_BACKEND_CONNECT_ATTEMPTS=12');
    expect(deployReadme).toContain('docker compose --profile worker up -d --build');
    expect(deployReadme).toContain('OPEN_DESIGN_AGENT_RUN_STORE=postgres');
    expect(deployReadme).toContain('OPEN_DESIGN_AGENT_JOB_QUEUE=redis');
    expect(deployReadme).toContain('--scale agent-worker=2');
    expect(clusterDoc).toContain('OD_AGENT_RUN_STORE=postgres');
    expect(clusterDoc).toContain('OD_AGENT_JOB_QUEUE=redis');
    expect(clusterDoc).toContain('OD_AGENT_WORKER_MAX_ATTEMPTS');
    expect(clusterDoc).toContain('/api/agent-runtime/status');
  });

  it('boots the Compose cluster and completes a deterministic Pi run', async () => {
    if (!(await commandOk('docker', ['compose', 'version']))) {
      console.warn('Skipping Compose cluster smoke because docker compose is not available.');
      return;
    }

    const port = 18_000 + (process.pid % 1_000);
    const projectName = `od-e2e-${process.pid}`;
    const baseUrl = `http://127.0.0.1:${port}`;
    const image = process.env.OPEN_DESIGN_IMAGE ?? 'open-design-e2e:cluster-smoke';
    const env = {
      ...process.env,
      OPEN_DESIGN_PORT: String(port),
      OPEN_DESIGN_IMAGE: image,
      OPEN_DESIGN_AGENT_RUNTIME: 'sqlite-worker',
      OPEN_DESIGN_AGENT_RUN_STORE: 'postgres',
      OPEN_DESIGN_AGENT_JOB_QUEUE: 'redis',
      OPEN_DESIGN_AGENT_WORKER_MAX_ATTEMPTS: '1',
      OD_E2E_FAKE_PI_AGENT: '1',
    };

    try {
      const forceBuild = process.env.OPEN_DESIGN_E2E_FORCE_BUILD === '1';
      const needsBuild = forceBuild || !(await dockerImageExists(image));
      await dockerCompose(projectName, needsBuild ? ['up', '-d', '--build'] : ['up', '-d'], env);
      await waitForHealth(baseUrl);

      const projectId = `compose-cluster-${Date.now()}`;
      const runId = await createProjectAndRun(baseUrl, projectId);
      await waitForRunStatus(baseUrl, runId, 'succeeded');

      const runtimeStatus = await fetch(`${baseUrl}/api/agent-runtime/status`);
      expect(runtimeStatus.ok).toBe(true);
      const runtimeStatusBody = await runtimeStatus.json() as {
        runtime: string;
        executionMode: string;
        queue: { queued: number; running: number; failed: number; succeeded: number };
        runs: { runsByStatus: Record<string, number> };
      };
      expect(runtimeStatusBody.runtime).toBe('pi-sdk:sqlite-worker');
      expect(runtimeStatusBody.executionMode).toBe('worker');
      expect(runtimeStatusBody.queue.queued).toBe(0);
      expect(runtimeStatusBody.queue.running).toBe(0);
      expect(runtimeStatusBody.queue.succeeded).toBeGreaterThanOrEqual(1);
      expect(runtimeStatusBody.runs.runsByStatus.succeeded).toBeGreaterThanOrEqual(1);

      const raw = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/raw/${GENERATED_FILE}`);
      expect(raw.ok).toBe(true);
      await expect(raw.text()).resolves.toContain('Docker Compose Ready');

      const eventCounts = await dockerCompose(projectName, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'open_design',
        '-d',
        'open_design',
        '-tAc',
        `select event || ':' || count(*) from agent_run_events where run_id='${runId}' group by event order by event;`,
      ], env);
      expect(eventCounts.stdout).toContain('agent:');
      expect(eventCounts.stdout).toContain('end:1');
      expect(eventCounts.stdout).toContain('start:1');

      const redisSucceededJob = await findRedisJobForRun(projectName, env, runId);
      expect(redisSucceededJob.status).toBe('succeeded');

      const queueDepth = await dockerCompose(projectName, [
        'exec',
        '-T',
        'redis',
        'redis-cli',
        'llen',
        'open-design:agent-jobs:queued',
      ], env);
      expect(queueDepth.stdout.trim()).toBe('0');

      const runningJobs = await dockerCompose(projectName, [
        'exec',
        '-T',
        'redis',
        'redis-cli',
        'zcard',
        'open-design:agent-jobs:running',
      ], env);
      expect(runningJobs.stdout.trim()).toBe('0');

      const workerLogs = await dockerCompose(projectName, ['logs', '--no-color', 'agent-worker'], env);
      expect(workerLogs.stdout).toContain('[agent-worker]');
      expect(workerLogs.stdout).toMatch(new RegExp(runId));

      const workerHealth = await dockerCompose(projectName, [
        'exec',
        '-T',
        'agent-worker',
        'node',
        'apps/daemon/dist/cli.js',
        'agent-worker',
        '--healthcheck',
      ], env);
      expect(workerHealth.stdout).toContain('"ok":true');

      const failedProjectId = `compose-cluster-failed-${Date.now()}`;
      const failedRunId = await createProjectAndRun(
        baseUrl,
        failedProjectId,
        'Fail deterministic Pi E2E compose cluster smoke',
      );
      const failedStatus = await waitForRunStatus(baseUrl, failedRunId, 'failed') as {
        lastError?: { message?: string; code?: string; retryable?: boolean } | null;
      };
      expect(failedStatus.lastError?.message).toContain('Deterministic fake Pi failure');
      expect(failedStatus.lastError?.code).toBe('AGENT_EXECUTION_FAILED');
      expect(failedStatus.lastError?.retryable).toBe(false);

      const failedEventCounts = await dockerCompose(projectName, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'open_design',
        '-d',
        'open_design',
        '-tAc',
        `select event || ':' || count(*) from agent_run_events where run_id='${failedRunId}' group by event order by event;`,
      ], env);
      expect(failedEventCounts.stdout).toContain('agent:');
      expect(failedEventCounts.stdout).toContain('error:1');
      expect(failedEventCounts.stdout).toContain('end:1');

      const redisFailedJob = await findRedisJobForRun(projectName, env, failedRunId);
      expect(redisFailedJob.status).toBe('failed');
      expect(redisFailedJob.error).toContain('Deterministic fake Pi failure');
    } finally {
      await dockerCompose(projectName, ['down', '-v', '--remove-orphans'], env).catch(() => {});
    }
  }, 20 * 60_000);
});

const GENERATED_FILE = 'index.html';
