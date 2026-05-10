import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentRuntimeFromEnv,
  createQueuedAgentRuntime,
  createSqliteWorkerAgentRuntime,
  type AgentRuntime,
} from '../src/agent-runtime.js';
import { createLocalProjectFs } from '../src/project-fs.js';

describe('createQueuedAgentRuntime', () => {
  it('runs queued jobs through the delegate with bounded concurrency', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const delegate: AgentRuntime = {
      id: 'delegate',
      executionMode: 'inline',
      async run(input) {
        order.push(`start:${input.prompt}`);
        if (input.prompt === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`end:${input.prompt}`);
        return { resolvedModel: input.prompt };
      },
    };
    const runtime = createQueuedAgentRuntime({ delegate, concurrency: 1 });

    const first = runtime.run(baseInput('first'));
    const second = runtime.run(baseInput('second'));
    await Promise.resolve();

    expect(order).toEqual(['start:first']);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ resolvedModel: 'first' });
    await expect(second).resolves.toMatchObject({ resolvedModel: 'second' });
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('selects queued mode from the deployment env', () => {
    const runtime = createAgentRuntimeFromEnv({ OD_AGENT_RUNTIME: 'queued-inline' });

    expect(runtime.executionMode).toBe('worker');
    expect(runtime.id).toBe('pi-sdk:queued');
  });

  it('enqueues sqlite-worker runs through a job queue boundary', async () => {
    const enqueued: unknown[] = [];
    const runtime = createSqliteWorkerAgentRuntime({
      jobQueue: {
        enqueueJob: (_runId, payload) => {
          enqueued.push(payload);
          return { id: 'job-a', runId: 'run-a' };
        },
      },
      runStore: {
        listRunEventsAfter: () => [],
        getRun: () => ({
          id: 'run-a',
          projectId: null,
          conversationId: null,
          assistantMessageId: null,
          clientRequestId: null,
          agentId: 'pi',
          status: 'succeeded',
          createdAt: 1,
          updatedAt: 2,
          exitCode: 0,
          signal: null,
        }),
      },
      pollIntervalMs: 1,
    });

    await expect(runtime.run({ ...baseInput('hello'), runId: 'run-a' })).resolves.toMatchObject({
      aborted: false,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ prompt: 'hello', cwd: process.cwd() });
  });

  it('can select the deterministic Pi E2E runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'od-fake-pi-runtime-'));
    const events: unknown[] = [];
    try {
      const runtime = createAgentRuntimeFromEnv({ OD_E2E_FAKE_PI_AGENT: '1' });
      await expect(runtime.run({
        ...baseInput('Create a deterministic Pi E2E smoke artifact'),
        cwd: dir,
        projectFs: createLocalProjectFs(dir),
        events: { emit: (_channel, payload) => events.push(payload) },
      })).resolves.toMatchObject({ resolvedModel: 'e2e/fake-pi' });

      await expect(readFile(join(dir, 'index.html'), 'utf8')).resolves.toContain('Pi Agent E2E');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'thinking_delta' }),
        expect.objectContaining({ type: 'tool_use', name: 'Write' }),
        expect.objectContaining({ type: 'tool_result', toolUseId: 'fake-pi-write-index' }),
      ]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function baseInput(prompt: string) {
  return {
    cwd: process.cwd(),
    prompt,
    events: {
      emit: () => {},
    },
  };
}
