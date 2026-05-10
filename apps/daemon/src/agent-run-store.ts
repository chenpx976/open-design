// @ts-nocheck
import { randomUUID } from 'node:crypto';

export function createSqliteAgentRunPersistence(db) {
  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO agent_runs (
      id, project_id, conversation_id, assistant_message_id, client_request_id,
      agent_id, status, created_at, updated_at, exit_code, signal
    ) VALUES (
      @id, @projectId, @conversationId, @assistantMessageId, @clientRequestId,
      @agentId, @status, @createdAt, @updatedAt, @exitCode, @signal
    )
  `);
  const updateRun = db.prepare(`
    UPDATE agent_runs
    SET status = @status,
        updated_at = @updatedAt,
        exit_code = @exitCode,
        signal = @signal
    WHERE id = @id
  `);
  const insertEvent = db.prepare(`
    INSERT OR REPLACE INTO agent_run_events (
      run_id, event_id, event, data_json, timestamp
    ) VALUES (
      @runId, @eventId, @event, @dataJson, @timestamp
    )
  `);
  const insertEventByRunId = db.transaction((runId, event, data, timestamp = Date.now()) => {
    const row = db.prepare('SELECT COALESCE(MAX(event_id), 0) + 1 AS nextId FROM agent_run_events WHERE run_id = ?').get(runId);
    const eventId = Number(row?.nextId) || 1;
    insertEvent.run({
      runId,
      eventId,
      event,
      dataJson: JSON.stringify(data ?? null),
      timestamp,
    });
    return { id: eventId, event, data, timestamp };
  });
  const listEventsAfter = db.prepare(`
    SELECT event_id AS id, event, data_json AS dataJson, timestamp
    FROM agent_run_events
    WHERE run_id = ? AND event_id > ?
    ORDER BY event_id ASC
  `);
  const getRun = db.prepare(`
    SELECT
      id,
      project_id AS projectId,
      conversation_id AS conversationId,
      assistant_message_id AS assistantMessageId,
      client_request_id AS clientRequestId,
      agent_id AS agentId,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt,
      exit_code AS exitCode,
      signal
    FROM agent_runs
    WHERE id = ?
  `);
  return {
    createRun(run) {
      insertRun.run({
        id: run.id,
        projectId: run.projectId,
        conversationId: run.conversationId,
        assistantMessageId: run.assistantMessageId,
        clientRequestId: run.clientRequestId,
        agentId: run.agentId,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        exitCode: run.exitCode,
        signal: run.signal,
      });
    },
    updateRun(run) {
      updateRun.run({
        id: run.id,
        status: run.status,
        updatedAt: run.updatedAt,
        exitCode: run.exitCode,
        signal: run.signal,
      });
    },
    appendEvent(run, record) {
      insertEvent.run({
        runId: run.id,
        eventId: record.id,
        event: record.event,
        dataJson: JSON.stringify(record.data ?? null),
        timestamp: record.timestamp,
      });
    },
    appendRunEvent(runId, event, data) {
      return insertEventByRunId(runId, event, data);
    },
    listRunEventsAfter(runId, afterEventId = 0) {
      return listEventsAfter.all(runId, afterEventId).map((row) => ({
        id: row.id,
        event: row.event,
        data: JSON.parse(row.dataJson),
        timestamp: row.timestamp,
      }));
    },
    getRun(runId) {
      return getRun.get(runId) ?? null;
    },
    updateRunStatus(runId, status, exitCode = null, signal = null) {
      const run = getRun.get(runId);
      if (!run) return;
      updateRun.run({
        id: runId,
        status,
        updatedAt: Date.now(),
        exitCode,
        signal,
      });
    },
  };
}

export function createSqliteAgentJobQueue(db) {
  const insertJob = db.prepare(`
    INSERT INTO agent_run_jobs (
      id, run_id, status, payload_json, attempts, created_at, updated_at
    ) VALUES (
      @id, @runId, 'queued', @payloadJson, 0, @now, @now
    )
  `);
  const requeueStaleJobs = db.prepare(`
    UPDATE agent_run_jobs
    SET status = 'queued',
        locked_at = NULL,
        locked_by = NULL,
        updated_at = @now
    WHERE status = 'running'
      AND locked_at IS NOT NULL
      AND locked_at < @staleBefore
      AND attempts < @maxAttempts
  `);
  const failExhaustedStaleJobs = db.prepare(`
    UPDATE agent_run_jobs
    SET status = 'failed',
        error = COALESCE(error, 'worker lease expired after max attempts'),
        updated_at = @now
    WHERE status = 'running'
      AND locked_at IS NOT NULL
      AND locked_at < @staleBefore
      AND attempts >= @maxAttempts
  `);
  const claimQueuedJob = db.transaction((workerId, options = {}) => {
    const now = Date.now();
    const staleAfterMs = Number(options.staleAfterMs) || 0;
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
    if (staleAfterMs > 0) {
      const staleBefore = now - staleAfterMs;
      failExhaustedStaleJobs.run({ staleBefore, maxAttempts, now });
      requeueStaleJobs.run({ staleBefore, maxAttempts, now });
    }
    const job = db.prepare(`
      SELECT id, run_id AS runId, payload_json AS payloadJson, attempts
      FROM agent_run_jobs
      WHERE status = 'queued'
        AND attempts < @maxAttempts
      ORDER BY created_at ASC
      LIMIT 1
    `).get({ maxAttempts });
    if (!job) return null;
    const result = db.prepare(`
      UPDATE agent_run_jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = @now,
          locked_by = @workerId,
          updated_at = @now
      WHERE id = @id AND status = 'queued'
    `).run({ id: job.id, workerId, now });
    if (result.changes !== 1) return null;
    return { ...job, attempts: Number(job.attempts ?? 0) + 1 };
  });
  const updateJobStatus = db.prepare(`
    UPDATE agent_run_jobs
    SET status = @status,
        error = @error,
        updated_at = @now
    WHERE id = @id
  `);
  const heartbeatJob = db.prepare(`
    UPDATE agent_run_jobs
    SET locked_at = @now,
        updated_at = @now
    WHERE id = @id
      AND locked_by = @workerId
      AND status = 'running'
  `);
  const requeueJob = db.prepare(`
    UPDATE agent_run_jobs
    SET status = 'queued',
        error = @error,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = @now
    WHERE id = @id
  `);
  const getJobAttempts = db.prepare(`
    SELECT attempts FROM agent_run_jobs WHERE id = ?
  `);

  return {
    enqueueJob(runId, payload) {
      const id = randomUUID();
      insertJob.run({
        id,
        runId,
        payloadJson: JSON.stringify(payload),
        now: Date.now(),
      });
      return { id, runId };
    },
    claimNextJob(workerId, options) {
      const job = claimQueuedJob(workerId, options);
      if (!job) return null;
      return {
        id: job.id,
        runId: job.runId,
        attempts: job.attempts,
        payload: JSON.parse(job.payloadJson),
      };
    },
    heartbeatJob(jobId, workerId) {
      heartbeatJob.run({ id: jobId, workerId, now: Date.now() });
    },
    completeJob(jobId) {
      updateJobStatus.run({ id: jobId, status: 'succeeded', error: null, now: Date.now() });
    },
    failJob(jobId, error, options = {}) {
      const message = String(error ?? '');
      const retryable = options.retryable === true;
      const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
      const attempts = Number(getJobAttempts.get(jobId)?.attempts ?? 0);
      if (retryable && attempts < maxAttempts) {
        requeueJob.run({ id: jobId, error: message, now: Date.now() });
        return;
      }
      updateJobStatus.run({ id: jobId, status: 'failed', error: message, now: Date.now() });
    },
  };
}

export function createSqliteAgentRunStore(db) {
  return {
    ...createSqliteAgentRunPersistence(db),
    ...createSqliteAgentJobQueue(db),
  };
}
