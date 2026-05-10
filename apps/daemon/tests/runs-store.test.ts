import { describe, expect, it } from 'vitest';
import { createChatRunService as createChatRunServiceUntyped } from '../src/runs.js';

const createChatRunService = createChatRunServiceUntyped as unknown as (options: Record<string, unknown>) => any;

describe('createChatRunService store hooks', () => {
  it('mirrors run lifecycle events to the configured store', async () => {
    const calls: string[] = [];
    const service = createChatRunService({
      createSseResponse: () => ({ send: () => {}, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (_code: string, message: string) => ({ message }),
      store: {
        createRun: (run: { id: string }) => calls.push(`create:${run.id}`),
        updateRun: (run: { status: string }) => calls.push(`update:${run.status}`),
        appendEvent: (_run: unknown, record: { event: string }) => calls.push(`event:${record.event}`),
      },
    });

    const run = service.create({ projectId: 'project-a', agentId: 'pi' });
    service.emit(run, 'agent', { type: 'text_delta', delta: 'ok' });
    service.finish(run, 'succeeded', 0, null);
    await service.flush(run);

    expect(calls[0]).toMatch(/^create:/);
    expect(calls).toContain('event:agent');
    expect(calls).toContain('event:end');
    expect(calls).toContain('update:succeeded');
  });

  it('hydrates terminal runs and events from the configured store', () => {
    const service = createChatRunService({
      createSseResponse: () => ({ send: () => {}, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (_code: string, message: string) => ({ message }),
      store: {
        getRun: (id: string) => ({
          id,
          projectId: 'project-a',
          conversationId: 'conversation-a',
          assistantMessageId: 'message-a',
          clientRequestId: 'client-a',
          agentId: 'pi',
          status: 'succeeded',
          createdAt: 1,
          updatedAt: 2,
          exitCode: 0,
          signal: null,
        }),
        listRunEventsAfter: () => [
          { id: 1, event: 'agent', data: { type: 'text_delta', delta: 'ok' }, timestamp: 1 },
          { id: 2, event: 'end', data: { status: 'succeeded', code: 0 }, timestamp: 2 },
        ],
      },
    });

    const run = service.get('persisted-run');

    expect(service.statusBody(run)).toMatchObject({
      id: 'persisted-run',
      projectId: 'project-a',
      status: 'succeeded',
      exitCode: 0,
    });
    expect(run.events).toHaveLength(2);
    expect(run.nextEventId).toBe(3);
  });

  it('recovers stale persisted active inline runs as failed', async () => {
    const calls: string[] = [];
    const service = createChatRunService({
      createSseResponse: () => ({ send: () => {}, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (code: string, message: string, init: Record<string, unknown>) => ({
        error: { code, message, ...init },
      }),
      stalePersistedActiveMs: 1,
      store: {
        getRun: (id: string) => ({
          id,
          projectId: 'project-a',
          conversationId: 'conversation-a',
          assistantMessageId: 'message-a',
          clientRequestId: 'client-a',
          agentId: 'pi',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
          exitCode: null,
          signal: null,
        }),
        listRunEventsAfter: () => [
          { id: 1, event: 'agent', data: { type: 'status', label: 'working' }, timestamp: 1 },
        ],
        appendEvent: (_run: unknown, record: { event: string }) => calls.push(`event:${record.event}`),
        updateRun: (run: { status: string; signal: string | null }) =>
          calls.push(`update:${run.status}:${run.signal}`),
      },
    });

    const run = service.get('persisted-running');
    await service.flush(run);

    expect(service.statusBody(run)).toMatchObject({
      status: 'failed',
      exitCode: 1,
      signal: 'DAEMON_RESTART',
      lastError: {
        code: 'AGENT_EXECUTION_FAILED',
        retryable: true,
      },
    });
    expect(run.events.map((event: { event: string }) => event.event)).toEqual([
      'agent',
      'error',
      'end',
    ]);
    expect(calls).toContain('event:error');
    expect(calls).toContain('event:end');
    expect(calls).toContain('update:failed:DAEMON_RESTART');
  });

  it('includes the latest persisted error in run status bodies', () => {
    const service = createChatRunService({
      createSseResponse: () => ({ send: () => {}, end: () => {}, cleanup: () => {} }),
      createSseErrorPayload: (code: string, message: string, init: Record<string, unknown>) => ({
        message,
        error: { code, message, ...init },
      }),
    });

    const run = service.create({ projectId: 'project-a', agentId: 'pi' });
    service.fail(run, 'AGENT_EXECUTION_FAILED', 'deterministic failure detail', { retryable: false });

    expect(service.statusBody(run)).toMatchObject({
      status: 'failed',
      lastError: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'deterministic failure detail',
        retryable: false,
      },
    });
  });
});
