import { runPiSdkAgent } from './pi-sdk-agent.js';
import type { ProjectFs } from './project-fs.js';
import type { AgentJobQueue, AgentRunPersistence } from './agent-run-contracts.js';

export type AgentRuntimeExecutionMode = 'inline' | 'worker';
export type AgentRuntimeEventChannel = 'agent' | string;

export interface AgentRuntimeEventSink {
  emit(channel: AgentRuntimeEventChannel, payload: unknown, sourceEventId?: number): void;
  noteActivity?(): void;
}

export interface AgentRuntimeRunInput {
  runId?: string;
  cwd: string;
  prompt: string;
  model?: string | null;
  reasoning?: string | null;
  imagePaths?: string[];
  uploadRoot?: string | null;
  signal?: AbortSignal;
  projectFs?: ProjectFs | null;
  events: AgentRuntimeEventSink;
}

export interface AgentRuntimeRunResult {
  aborted?: boolean;
  error?: unknown;
  resolvedModel?: string | null;
}

export interface AgentRuntime {
  readonly id: string;
  readonly executionMode: AgentRuntimeExecutionMode;
  run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult>;
}

export interface QueuedAgentRuntimeOptions {
  delegate: AgentRuntime;
  concurrency?: number;
}

export interface SqliteWorkerAgentRuntimeOptions {
  runStore: Pick<AgentRunPersistence, 'listRunEventsAfter' | 'getRun'>;
  jobQueue: Pick<AgentJobQueue, 'enqueueJob'>;
  pollIntervalMs?: number;
}

type QueuedJob = {
  input: AgentRuntimeRunInput;
  resolve: (result: AgentRuntimeRunResult) => void;
  reject: (error: unknown) => void;
};

export function createInlinePiAgentRuntime(): AgentRuntime {
  const runPiSdkAgentImpl = runPiSdkAgent as unknown as (
    input: Omit<AgentRuntimeRunInput, 'events'> & {
      noteActivity?: (() => void) | null;
      send: (channel: string, payload: unknown) => void;
    },
  ) => Promise<AgentRuntimeRunResult>;
  return {
    id: 'pi-sdk',
    executionMode: 'inline',
    run: (input) => {
      const runInput = {
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model ?? null,
        reasoning: input.reasoning ?? null,
        imagePaths: input.imagePaths ?? [],
        uploadRoot: input.uploadRoot ?? null,
        projectFs: input.projectFs ?? null,
        noteActivity: input.events.noteActivity ?? null,
        send: (channel: string, payload: unknown) => input.events.emit(channel, payload),
      };
      return runPiSdkAgentImpl(
        input.signal ? { ...runInput, signal: input.signal } : runInput,
      );
    },
  };
}

export function createQueuedAgentRuntime({
  delegate,
  concurrency = 1,
}: QueuedAgentRuntimeOptions): AgentRuntime {
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const queue: QueuedJob[] = [];
  let active = 0;

  const pump = (): void => {
    while (active < maxConcurrency && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      void delegate.run(job.input)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    id: `${delegate.id}:queued`,
    executionMode: 'worker',
    run(input) {
      if (input.signal?.aborted) return Promise.resolve({ aborted: true });
      return new Promise<AgentRuntimeRunResult>((resolve, reject) => {
        const job: QueuedJob = { input, resolve, reject };
        const abortQueued = (): void => {
          const index = queue.indexOf(job);
          if (index === -1) return;
          queue.splice(index, 1);
          resolve({ aborted: true });
        };
        if (input.signal) {
          input.signal.addEventListener('abort', abortQueued, { once: true });
        }
        queue.push(job);
        pump();
      });
    },
  };
}

export function createSqliteWorkerAgentRuntime({
  runStore,
  jobQueue,
  pollIntervalMs = 500,
}: SqliteWorkerAgentRuntimeOptions): AgentRuntime {
  return {
    id: 'pi-sdk:sqlite-worker',
    executionMode: 'worker',
    async run(input) {
      if (!input.runId) {
        return { error: new Error('sqlite worker runtime requires runId') };
      }
      const runId = input.runId;
      await jobQueue.enqueueJob(runId, {
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model ?? null,
        reasoning: input.reasoning ?? null,
        imagePaths: input.imagePaths ?? [],
        uploadRoot: input.uploadRoot ?? null,
        projectFsRoot: input.projectFs?.root ?? input.cwd,
      });

      let lastEventId = 0;
      while (!input.signal?.aborted) {
        for (const record of await runStore.listRunEventsAfter(runId, lastEventId)) {
          lastEventId = Math.max(lastEventId, record.id);
          if (record.event === 'start' || record.event === 'end') continue;
          if (record.event === 'agent') {
            input.events.emit('agent', record.data, record.id);
          } else {
            input.events.emit(record.event, record.data, record.id);
          }
        }
        const run = await runStore.getRun(runId);
        if (run?.status === 'succeeded') return { aborted: false };
        if (run?.status === 'failed') {
          return { error: new Error('worker run failed') };
        }
        if (run?.status === 'canceled') return { aborted: true };
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      return { aborted: true };
    },
  };
}

export function createAgentRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    runStore?: SqliteWorkerAgentRuntimeOptions['runStore'];
    jobQueue?: SqliteWorkerAgentRuntimeOptions['jobQueue'];
  } = {},
): AgentRuntime {
  const inline = createInlinePiAgentRuntime();
  const mode = String(env.OD_AGENT_RUNTIME ?? '').trim().toLowerCase();
  if (mode === 'sqlite-worker') {
    if (!options.runStore || !options.jobQueue) {
      throw new Error('OD_AGENT_RUNTIME=sqlite-worker requires an agent run store and job queue');
    }
    return createSqliteWorkerAgentRuntime({
      runStore: options.runStore,
      jobQueue: options.jobQueue,
    });
  }
  if (mode === 'queued' || mode === 'queued-inline' || mode === 'worker') {
    return createQueuedAgentRuntime({
      delegate: inline,
      concurrency: Number(env.OD_AGENT_WORKER_CONCURRENCY) || 1,
    });
  }
  return inline;
}
