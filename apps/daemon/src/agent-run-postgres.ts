// @ts-nocheck

function requirePostgresUrl(env = process.env) {
  const url = env.OD_AGENT_POSTGRES_URL || env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) {
    throw new Error('OD_AGENT_RUN_STORE=postgres requires OD_AGENT_POSTGRES_URL, DATABASE_URL, or POSTGRES_URL');
  }
  return url;
}

async function createPgPool(env = process.env) {
  let mod;
  try {
    mod = await import('pg');
  } catch (err) {
    throw new Error('OD_AGENT_RUN_STORE=postgres requires the pg dependency to be installed', { cause: err });
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new Error('pg Pool export was not found');
  return new Pool({
    connectionString: requirePostgresUrl(env),
    max: Number(env.OD_AGENT_POSTGRES_POOL_SIZE) || 10,
  });
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    conversationId: row.conversation_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    clientRequestId: row.client_request_id ?? null,
    agentId: row.agent_id ?? null,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    signal: row.signal ?? null,
  };
}

function mapEvent(row) {
  return {
    id: Number(row.event_id),
    event: row.event,
    data: row.data_json,
    timestamp: Number(row.timestamp),
  };
}

export async function createPostgresAgentRunPersistence({
  env = process.env,
  pool = null,
} = {}) {
  const pgPool = pool ?? await createPgPool(env);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      conversation_id TEXT,
      assistant_message_id TEXT,
      client_request_id TEXT,
      agent_id TEXT,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      exit_code INTEGER,
      signal TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_project
      ON agent_runs(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
      ON agent_runs(conversation_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_run_events (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      data_json JSONB NOT NULL,
      timestamp BIGINT NOT NULL,
      PRIMARY KEY(run_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run
      ON agent_run_events(run_id, event_id);
  `);

  return {
    async createRun(run) {
      await pgPool.query(
        `INSERT INTO agent_runs (
          id, project_id, conversation_id, assistant_message_id, client_request_id,
          agent_id, status, created_at, updated_at, exit_code, signal
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          project_id = EXCLUDED.project_id,
          conversation_id = EXCLUDED.conversation_id,
          assistant_message_id = EXCLUDED.assistant_message_id,
          client_request_id = EXCLUDED.client_request_id,
          agent_id = EXCLUDED.agent_id,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          exit_code = EXCLUDED.exit_code,
          signal = EXCLUDED.signal`,
        [
          run.id,
          run.projectId,
          run.conversationId,
          run.assistantMessageId,
          run.clientRequestId,
          run.agentId,
          run.status,
          run.createdAt,
          run.updatedAt,
          run.exitCode,
          run.signal,
        ],
      );
    },
    async updateRun(run) {
      await pgPool.query(
        `UPDATE agent_runs
         SET status = $2, updated_at = $3, exit_code = $4, signal = $5
         WHERE id = $1`,
        [run.id, run.status, run.updatedAt, run.exitCode, run.signal],
      );
    },
    async appendEvent(run, record) {
      await pgPool.query(
        `INSERT INTO agent_run_events (run_id, event_id, event, data_json, timestamp)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (run_id, event_id) DO UPDATE SET
           event = EXCLUDED.event,
           data_json = EXCLUDED.data_json,
           timestamp = EXCLUDED.timestamp`,
        [run.id, record.id, record.event, JSON.stringify(record.data ?? null), record.timestamp],
      );
    },
    async appendRunEvent(runId, event, data) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [runId]);
        const next = await client.query(
          'SELECT COALESCE(MAX(event_id), 0) + 1 AS next_id FROM agent_run_events WHERE run_id = $1',
          [runId],
        );
        const eventId = Number(next.rows[0]?.next_id) || 1;
        const timestamp = Date.now();
        await client.query(
          `INSERT INTO agent_run_events (run_id, event_id, event, data_json, timestamp)
           VALUES ($1,$2,$3,$4::jsonb,$5)`,
          [runId, eventId, event, JSON.stringify(data ?? null), timestamp],
        );
        await client.query('COMMIT');
        return { id: eventId, event, data, timestamp };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async listRunEventsAfter(runId, afterEventId = 0) {
      const result = await pgPool.query(
        `SELECT event_id, event, data_json, timestamp
         FROM agent_run_events
         WHERE run_id = $1 AND event_id > $2
         ORDER BY event_id ASC`,
        [runId, afterEventId],
      );
      return result.rows.map(mapEvent);
    },
    async getRun(runId) {
      const result = await pgPool.query(
        `SELECT id, project_id, conversation_id, assistant_message_id,
                client_request_id, agent_id, status, created_at, updated_at,
                exit_code, signal
         FROM agent_runs
         WHERE id = $1`,
        [runId],
      );
      return mapRun(result.rows[0]);
    },
    async updateRunStatus(runId, status, exitCode = null, signal = null) {
      await pgPool.query(
        `UPDATE agent_runs
         SET status = $2, updated_at = $3, exit_code = $4, signal = $5
         WHERE id = $1`,
        [runId, status, Date.now(), exitCode, signal],
      );
    },
    async getRunStats() {
      const [statusRows, failures] = await Promise.all([
        pgPool.query('SELECT status, COUNT(*)::int AS count FROM agent_runs GROUP BY status'),
        pgPool.query(
          'SELECT COUNT(*)::int AS count FROM agent_runs WHERE status = $1 AND updated_at >= $2',
          ['failed', Date.now() - 24 * 60 * 60 * 1000],
        ),
      ]);
      const runsByStatus = {};
      for (const row of statusRows.rows) {
        runsByStatus[row.status] = Number(row.count) || 0;
      }
      return {
        runsByStatus,
        recentFailures: Number(failures.rows[0]?.count) || 0,
      };
    },
    async close() {
      await pgPool.end();
    },
  };
}
