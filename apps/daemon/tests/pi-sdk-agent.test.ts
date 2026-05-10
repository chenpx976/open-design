import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  createAgentSessionCalls: [] as any[],
  subscribers: [] as Array<(event: any) => void>,
  abortCalls: 0,
  promptImpl: null as null | ((prompt: string) => Promise<void>),
  sessionModel: { provider: 'openai', id: 'gpt-5.5' },
}));

vi.mock('@earendil-works/pi-coding-agent', () => {
  const createTool = (name: string) => (_cwd: string, def: unknown) => ({ name, def });
  return {
    AuthStorage: { create: () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    ModelRegistry: {
      create: () => ({
        find: (provider: string, id?: string) =>
          id ? { provider, id } : { provider: 'mock', id: provider },
      }),
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { create: () => ({}) },
    createAgentSession: async (options: any) => {
      mockState.createAgentSessionCalls.push(options);
      const session = {
        model: mockState.sessionModel,
        subscribe: (fn: (event: any) => void) => {
          mockState.subscribers.push(fn);
          return () => {};
        },
        prompt: (prompt: string) =>
          mockState.promptImpl ? mockState.promptImpl(prompt) : Promise.resolve(),
        abort: async () => {
          mockState.abortCalls += 1;
        },
        dispose: () => {},
      };
      return { session };
    },
    createBashToolDefinition: createTool('bash'),
    createEditToolDefinition: createTool('edit'),
    createReadToolDefinition: createTool('read'),
    createWriteToolDefinition: createTool('write'),
    getAgentDir: () => '/tmp/pi-agent',
  };
});

vi.mock('just-bash', () => ({
  ReadWriteFs: class {
    root: string;
    constructor(options: { root: string }) {
      this.root = options.root;
    }
  },
  Bash: class {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  },
}));

describe('runPiSdkAgent contract', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'od-pi-sdk-test-'));
    mockState.createAgentSessionCalls.length = 0;
    mockState.subscribers.length = 0;
    mockState.abortCalls = 0;
    mockState.promptImpl = null;
    mockState.sessionModel = { provider: 'openai', id: 'gpt-5.5' };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('passes selected model and reasoning through to Pi', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');
    const events: any[] = [];

    const result = await runPiSdkAgent({
      cwd,
      prompt: 'hello',
      model: 'anthropic/claude-sonnet-4-5',
      reasoning: 'high',
      signal: undefined,
      send: (channel: string, payload: unknown) => events.push({ channel, payload }),
    });

    const call = mockState.createAgentSessionCalls[0];
    expect(call.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' });
    expect(call.thinkingLevel).toBe('high');
    expect(result.resolvedModel).toBe('openai/gpt-5.5');
    expect(events).toContainEqual({
      channel: 'agent',
      payload: {
        type: 'status',
        label: 'initializing',
        detail: 'openai/gpt-5.5',
        model: 'openai/gpt-5.5',
      },
    });
  });

  it('aborts the Pi session when the caller aborts', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');
    const controller = new AbortController();
    let releasePrompt!: () => void;
    mockState.promptImpl = () =>
      new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });

    const running = runPiSdkAgent({
      cwd,
      prompt: 'wait',
      model: 'default',
      reasoning: 'default',
      signal: controller.signal,
      send: () => {},
    });

    await vi.waitFor(() => expect(mockState.subscribers.length).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(mockState.abortCalls).toBe(1));
    releasePrompt();

    await expect(running).resolves.toMatchObject({ aborted: true });
  });

  it('maps Pi tool errors into OD tool_result events', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');
    const events: any[] = [];
    mockState.promptImpl = async () => {
      const emit = mockState.subscribers[0]!;
      emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        isError: true,
        result: {
          content: [{ type: 'text', text: 'permission denied' }],
        },
      });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
    };

    await runPiSdkAgent({
      cwd,
      prompt: 'tool error',
      model: 'default',
      reasoning: 'default',
      signal: undefined,
      send: (channel: string, payload: unknown) => events.push({ channel, payload }),
    });

    expect(events).toContainEqual({
      channel: 'agent',
      payload: {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'permission denied',
        isError: true,
      },
    });
  });
});
