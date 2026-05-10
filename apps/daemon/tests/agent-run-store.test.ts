import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDatabase, openDatabase } from '../src/db.js';
import { createSqliteAgentJobQueue, createSqliteAgentRunPersistence } from '../src/agent-run-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-run-store-'));
  tempDirs.push(dir);
  return openDatabase(dir, { dataDir: path.join(dir, '.od') });
}

function seedRun(db: Database.Database, runId = 'run-a') {
  const store = createSqliteAgentRunPersistence(db);
  store.createRun({
    id: runId,
    projectId: null,
    conversationId: null,
    assistantMessageId: null,
    clientRequestId: null,
    agentId: 'pi',
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
    exitCode: null,
    signal: null,
  });
  return store;
}

describe('createSqliteAgentJobQueue', () => {
  it('requeues retryable failures until max attempts', () => {
    const db = createDb();
    seedRun(db);
    const queue = createSqliteAgentJobQueue(db);
    const { id } = queue.enqueueJob('run-a', { prompt: 'hello' });

    const first = queue.claimNextJob('worker-a', { maxAttempts: 2 });
    expect(first).toMatchObject({ id, runId: 'run-a', attempts: 1 });

    queue.failJob(id, 'temporary', { retryable: true, maxAttempts: 2 });
    const second = queue.claimNextJob('worker-b', { maxAttempts: 2 });
    expect(second).toMatchObject({ id, attempts: 2 });

    queue.failJob(id, 'final', { retryable: true, maxAttempts: 2 });
    expect(queue.claimNextJob('worker-c', { maxAttempts: 2 })).toBeNull();
  });

  it('recovers stale running jobs and keeps live leases running', () => {
    const db = createDb();
    seedRun(db);
    const queue = createSqliteAgentJobQueue(db);
    const { id } = queue.enqueueJob('run-a', { prompt: 'hello' });

    expect(queue.claimNextJob('worker-a', { staleAfterMs: 1, maxAttempts: 3 })).toMatchObject({
      id,
      attempts: 1,
    });
    queue.heartbeatJob?.(id, 'worker-a');
    expect(queue.claimNextJob('worker-b', { staleAfterMs: 60_000, maxAttempts: 3 })).toBeNull();

    db.prepare(`
      UPDATE agent_run_jobs
      SET locked_at = @lockedAt
      WHERE id = @id
    `).run({ id, lockedAt: Date.now() - 120_000 });

    expect(queue.claimNextJob('worker-b', { staleAfterMs: 60_000, maxAttempts: 3 })).toMatchObject({
      id,
      attempts: 2,
    });
  });
});
