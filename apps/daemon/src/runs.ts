// @ts-nocheck
import { randomUUID } from 'node:crypto';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  store = null,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
  shutdownGraceMs = 3_000,
}) {
  const runs = new Map();
  const logPersistenceError = (err) => {
    console.warn('[runs] persistence write failed:', err instanceof Error ? err.message : String(err));
  };
  const persist = (operation, run = null) => {
    const execute = async () => {
      try {
        await operation?.();
      } catch (err) {
        logPersistenceError(err);
      }
    };
    if (run) {
      const previous = run.persistQueue ?? Promise.resolve();
      run.persistQueue = previous.then(execute, execute);
      return run.persistQueue;
    }
    try {
      void execute();
    } catch (err) {
      logPersistenceError(err);
    }
    return Promise.resolve();
  };

  const create = (meta = {}) => {
    const now = Date.now();
    const run = {
      id: randomUUID(),
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
      persistQueue: Promise.resolve(),
    };
    runs.set(run.id, run);
    persist(() => store?.createRun?.(run), run);
    return run;
  };

  const hydrate = (id) => {
    const persisted = store?.getRun?.(id);
    if (persisted && typeof persisted.then === 'function') return null;
    if (!persisted) return null;
    const persistedEvents = store?.listRunEventsAfter?.(id, 0) ?? [];
    if (persistedEvents && typeof persistedEvents.then === 'function') return null;
    return hydrateFromPersisted(persisted, persistedEvents);
  };

  const hydrateFromPersisted = (persisted, persistedEvents = []) => {
    const maxEventId = persistedEvents.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0);
    const run = {
      id: persisted.id,
      projectId: persisted.projectId ?? null,
      conversationId: persisted.conversationId ?? null,
      assistantMessageId: persisted.assistantMessageId ?? null,
      clientRequestId: persisted.clientRequestId ?? null,
      agentId: persisted.agentId ?? null,
      status: persisted.status,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      events: persistedEvents.map((record) => ({
        id: record.id,
        event: record.event,
        data: record.data,
        timestamp: record.timestamp,
      })),
      nextEventId: maxEventId + 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: persisted.exitCode ?? null,
      signal: persisted.signal ?? null,
      cancelRequested: false,
      persistedOnly: true,
      persistQueue: Promise.resolve(),
    };
    runs.set(run.id, run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) scheduleCleanup(run);
    return run;
  };

  const hydrateAsync = async (id) => {
    const persisted = await store?.getRun?.(id);
    if (!persisted) return null;
    const persistedEvents = await store?.listRunEventsAfter?.(id, 0) ?? [];
    return hydrateFromPersisted(persisted, persistedEvents);
  };

  const get = (id) => runs.get(id) ?? hydrate(id);
  const getAsync = async (id) => runs.get(id) ?? await hydrateAsync(id);

  const scheduleCleanup = (run) => {
    setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) runs.delete(run.id);
    }, ttlMs).unref?.();
  };

  const emit = (run, event, data) => {
    const id = run.nextEventId++;
    const record = { id, event, data, timestamp: Date.now() };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    persist(async () => {
      await store?.appendEvent?.(run, record);
      await store?.updateRun?.(run);
    }, run);
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const deliver = (run, event, data, sourceId = null) => {
    const id = sourceId ?? run.nextEventId++;
    if (sourceId != null && sourceId >= run.nextEventId) run.nextEventId = sourceId + 1;
    const record = { id, event, data, timestamp: Date.now() };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    signal: run.signal,
  });

  const finish = (run, status, code = null, signal = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    persist(() => store?.updateRun?.(run), run);
    emit(run, 'end', { code, signal, status });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const streamAsync = async (id, req, res) => {
    const run = await getAsync(id);
    if (!run) return null;
    stream(run, req, res);
    return run;
  };

  const list = ({ projectId, conversationId, status } = {}) => Array.from(runs.values()).filter((run) => {
    if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
    if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
    if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
    if (typeof status === 'string' && status) return run.status === status;
    return true;
  });

  const waitForChildExit = (child, timeoutMs) => {
    if (!child) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('close', onClose);
        child.off?.('exit', onClose);
        resolve(exited);
      };
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      child.once?.('close', onClose);
      child.once?.('exit', onClose);
    });
  };

  const killChild = (run, signal) => {
    if (!run.child || run.child.exitCode !== null || run.child.signalCode !== null) return false;
    try {
      return run.child.kill(signal);
    } catch {
      return false;
    }
  };

  const cancel = (run) => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      // Prefer RPC-level abort for agents that support it (pi, ACP adapters).
      // abort() sends the graceful shutdown signal; cancel() owns the
      // SIGTERM fallback so that a misbehaving session can't leave the
      // child alive indefinitely.
      if (run.acpSession?.abort) {
        run.acpSession.abort();
        const graceMs = Number(process.env.PI_ABORT_GRACE_MS) || 3000;
        setTimeout(() => {
          if (run.child && !run.child.killed) run.child.kill('SIGTERM');
        }, graceMs).unref();
      } else if (run.child && !run.child.killed) {
        run.child.kill('SIGTERM');
      } else {
        finish(run, 'canceled', null, 'SIGTERM');
      }
    }
  };

  const shutdownActive = async ({ graceMs = shutdownGraceMs } = {}) => {
    const activeRuns = Array.from(runs.values()).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    await Promise.all(activeRuns.map(async (run) => {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      if (run.acpSession?.abort) {
        try {
          run.acpSession.abort();
        } catch {
          // Process signals below are the shutdown fallback.
        }
      }
      killChild(run, 'SIGTERM');
      finish(run, 'canceled', null, 'SIGTERM');
      if (run.child && !(await waitForChildExit(run.child, graceMs))) {
        killChild(run, 'SIGKILL');
        await waitForChildExit(run.child, 500);
      }
    }));
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  return {
    create,
    start,
    get,
    getAsync,
    list,
    stream,
    streamAsync,
    cancel,
    shutdownActive,
    wait,
    emit,
    deliver,
    finish,
    fail,
    flush(run) {
      return run?.persistQueue ?? Promise.resolve();
    },
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
  };
}
