export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface PersistedAgentRun {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  clientRequestId: string | null;
  agentId: string | null;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  signal: string | null;
}

export interface PersistedAgentRunEvent {
  id: number;
  event: string;
  data: unknown;
  timestamp: number;
}

export interface AgentRunPersistence {
  createRun(run: PersistedAgentRun): void | Promise<void>;
  updateRun(run: Pick<PersistedAgentRun, 'id' | 'status' | 'updatedAt' | 'exitCode' | 'signal'>): void | Promise<void>;
  appendEvent(run: { id: string }, record: PersistedAgentRunEvent): void | Promise<void>;
  appendRunEvent(runId: string, event: string, data: unknown): PersistedAgentRunEvent | Promise<PersistedAgentRunEvent>;
  listRunEventsAfter(runId: string, afterEventId?: number): PersistedAgentRunEvent[] | Promise<PersistedAgentRunEvent[]>;
  getRun(runId: string): PersistedAgentRun | null | Promise<PersistedAgentRun | null>;
  updateRunStatus(runId: string, status: AgentRunStatus, exitCode?: number | null, signal?: string | null): void | Promise<void>;
}

export interface AgentJob {
  id: string;
  runId: string;
  attempts: number;
  payload: unknown;
}

export interface AgentJobClaimOptions {
  staleAfterMs?: number;
  maxAttempts?: number;
}

export interface AgentJobFailOptions {
  retryable?: boolean;
  maxAttempts?: number;
}

export interface AgentJobQueue {
  enqueueJob(runId: string, payload: unknown): { id: string; runId: string } | Promise<{ id: string; runId: string }>;
  claimNextJob(workerId: string, options?: AgentJobClaimOptions): AgentJob | null | Promise<AgentJob | null>;
  heartbeatJob?(jobId: string, workerId: string): void | Promise<void>;
  completeJob(jobId: string): void | Promise<void>;
  failJob(jobId: string, error: unknown, options?: AgentJobFailOptions): void | Promise<void>;
}
