import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  createAgentSessionCalls: [] as any[],
  subscribers: [] as Array<(event: any) => void>,
  promptCalls: [] as any[],
  readWriteFsRoots: [] as string[],
  bashExecCalls: [] as any[],
  abortCalls: 0,
  promptImpl: null as null | ((prompt: string, options?: unknown) => Promise<void>),
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
        prompt: (prompt: string, options?: unknown) => {
          mockState.promptCalls.push({ prompt, options });
          return mockState.promptImpl ? mockState.promptImpl(prompt, options) : Promise.resolve();
        },
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
      mockState.readWriteFsRoots.push(options.root);
    }
  },
  Bash: class {
    async exec(command: string, options: unknown) {
      mockState.bashExecCalls.push({ command, options });
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
    mockState.promptCalls.length = 0;
    mockState.readWriteFsRoots.length = 0;
    mockState.bashExecCalls.length = 0;
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

  it('maps Pi streaming tool partial results into OD tool_result updates', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');
    const events: any[] = [];
    mockState.promptImpl = async () => {
      const emit = mockState.subscribers[0]!;
      emit({
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        partialResult: {
          content: [{ type: 'text', text: 'line 1\n' }],
        },
      });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
    };

    await runPiSdkAgent({
      cwd,
      prompt: 'stream tool',
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
        content: 'line 1\n',
        isError: false,
      },
    });
  });

  it('does not write escaped absolute targets outside the local ProjectFs root', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');

    await runPiSdkAgent({
      cwd,
      prompt: 'write',
      model: 'default',
      reasoning: 'default',
      signal: undefined,
      send: () => {},
    });

    const call = mockState.createAgentSessionCalls[0];
    const writeTool = call.customTools.find((tool: any) => tool.name === 'write');
    expect(writeTool).toBeTruthy();

    const outsidePath = path.join(path.dirname(cwd), 'outside.txt');
    await rm(outsidePath, { force: true });

    await writeTool.def.operations.writeFile(path.join(cwd, 'inside.txt'), 'ok');
    await expect(writeTool.def.operations.writeFile(outsidePath, 'nope')).rejects.toThrow();
    await expect(access(outsidePath)).rejects.toThrow();
  });

  it('rewrites repo skill paths to staged project skill aliases', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');

    await mkdir(path.join(cwd, '.od-skills', 'html-ppt', 'references'), { recursive: true });
    await writeFile(path.join(cwd, '.od-skills', 'html-ppt', 'SKILL.md'), 'master', 'utf8');
    await writeFile(path.join(cwd, '.od-skills', 'html-ppt', 'references', 'full-decks.md'), 'deck refs', 'utf8');

    await runPiSdkAgent({
      cwd,
      prompt: 'read skill',
      model: 'default',
      reasoning: 'default',
      signal: undefined,
      send: () => {},
    });

    const call = mockState.createAgentSessionCalls[0];
    const readTool = call.customTools.find((tool: any) => tool.name === 'read');
    expect(readTool).toBeTruthy();

    await expect(readTool.def.operations.readFile('/repo/skills/html-ppt/SKILL.md')).resolves.toEqual(Buffer.from('master'));
    await expect(readTool.def.operations.readFile('../../../skills/html-ppt/references/full-decks.md')).resolves.toEqual(Buffer.from('deck refs'));
  });

  it('binds just-bash to the local ProjectFs root and normalizes escaped cwd', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');

    await runPiSdkAgent({
      cwd,
      prompt: 'bash',
      model: 'default',
      reasoning: 'default',
      signal: undefined,
      send: () => {},
    });

    expect(mockState.readWriteFsRoots).toEqual([cwd]);

    const call = mockState.createAgentSessionCalls[0];
    const bashTool = call.customTools.find((tool: any) => tool.name === 'bash');
    expect(bashTool).toBeTruthy();

    await bashTool.def.operations.exec('pwd', path.join(path.dirname(cwd), 'outside'), {
      env: { USER: 'tester' },
    });

    expect(mockState.bashExecCalls[0]).toMatchObject({
      command: 'pwd',
      options: {
        cwd: '/',
        env: {
          HOME: '/',
          OD_PROJECT_DIR: '/',
          OLDPWD: '/',
          PWD: '/',
          USER: 'tester',
        },
      },
    });
  });

  it('passes only uploadRoot-contained image inputs to Pi', async () => {
    const { runPiSdkAgent } = await import('../src/pi-sdk-agent.js');
    const uploadRoot = await mkdtemp(path.join(tmpdir(), 'od-pi-upload-'));
    const insideImage = path.join(uploadRoot, 'inside.png');
    const outsideImage = path.join(cwd, 'outside.png');
    const textFile = path.join(uploadRoot, 'note.txt');
    await mkdir(uploadRoot, { recursive: true });
    await writeFile(insideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(textFile, 'not an image', 'utf8');

    try {
      await (runPiSdkAgent as any)({
        cwd,
        prompt: 'image',
        model: 'default',
        reasoning: 'default',
        imagePaths: [insideImage, outsideImage, textFile],
        uploadRoot,
        signal: undefined,
        send: () => {},
      });

      const options = mockState.promptCalls[0]?.options as any;
      expect(options?.images).toHaveLength(1);
      expect(options.images[0]).toMatchObject({
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/png',
        },
      });
    } finally {
      await rm(uploadRoot, { recursive: true, force: true });
    }
  });
});
