// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { createLocalProjectFs } from './project-fs.js';

const MAX_IMAGE_COUNT = 10;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function mimeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function loadPiImages(imagePaths = [], uploadRoot) {
  const images = [];
  let total = 0;
  for (const raw of imagePaths.slice(0, MAX_IMAGE_COUNT)) {
    if (typeof raw !== 'string') continue;
    const resolved = path.resolve(raw);
    if (uploadRoot) {
      const root = path.resolve(uploadRoot);
      if (!(resolved === root || resolved.startsWith(root + path.sep))) continue;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) continue;
    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile() || total + stat.size > MAX_TOTAL_IMAGE_BYTES) continue;
    const data = await fs.promises.readFile(resolved, 'base64');
    total += stat.size;
    images.push({
      type: 'image',
      source: {
        type: 'base64',
        mediaType: mimeForImage(resolved),
        data,
      },
    });
  }
  return images;
}

async function resolveModel(modelRegistry, modelId) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId === 'default') {
    return undefined;
  }
  const raw = modelId.trim();
  const [provider, id] = raw.includes('/')
    ? raw.split(/\/(.+)/, 2)
    : [undefined, raw];
  if (provider && id && typeof modelRegistry.find === 'function') {
    const found = modelRegistry.find(provider, id);
    if (found) return found;
  }
  if (typeof modelRegistry.find === 'function') {
    const found = modelRegistry.find(raw);
    if (found) return found;
  }
  try {
    const { getModel } = await import('@earendil-works/pi-ai');
    if (provider && id) return getModel(provider, id) ?? undefined;
  } catch {
    // Fall through to Pi's default model resolution.
  }
  return undefined;
}

function realPathToJustBashPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target || resolvedRoot);
  if (resolvedTarget === resolvedRoot) return '/';
  if (resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return `/${path.relative(resolvedRoot, resolvedTarget).split(path.sep).join('/')}`;
  }
  return '/';
}

function envForJustBash(env, sandboxCwd) {
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === 'string') next[key] = value;
  }
  next.PWD = sandboxCwd;
  next.OLDPWD = sandboxCwd;
  next.HOME = '/';
  next.OD_PROJECT_DIR = '/';
  return next;
}

class ProjectToolPathError extends Error {
  constructor() {
    super('Path is outside this Open Design project. Use project-relative paths such as `index.html`, `assets/file.png`, or `.od-skills/<skill>/...`.');
    this.name = 'ProjectToolPathError';
  }
}

function displayProjectPath(projectFs, absPath) {
  const resolved = path.resolve(String(absPath || projectFs.root));
  if (resolved === projectFs.root) return '.';
  if (resolved.startsWith(projectFs.root + path.sep)) {
    return path.relative(projectFs.root, resolved).split(path.sep).join('/');
  }
  return '(outside project)';
}

function resolveProjectToolPath(projectFs, cwd, absolutePath) {
  const raw = typeof absolutePath === 'string' && absolutePath.trim()
    ? absolutePath.trim()
    : cwd || projectFs.root;
  const skillAlias = normalizeSkillAliasPath(raw);
  if (skillAlias) return projectFs.resolvePath(skillAlias);
  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    if (projectFs.contains(resolved)) return resolved;
    throw new ProjectToolPathError();
  }
  return projectFs.resolvePath(raw);
}

function normalizeSkillAliasPath(raw) {
  const normalized = String(raw || '').replace(/\\/g, '/');
  const skillsMatch = /(?:^|\/)skills\/([^/]+)(\/.*)?$/.exec(normalized);
  if (skillsMatch) {
    return `.od-skills/${skillsMatch[1]}${skillsMatch[2] || ''}`;
  }
  const parentSkillMatch = /(?:^|\/)\.\.\/([^/]+)(\/.*)?$/.exec(normalized);
  if (parentSkillMatch && parentSkillMatch[2]?.startsWith('/SKILL.md')) {
    return `.od-skills/${parentSkillMatch[1]}${parentSkillMatch[2]}`;
  }
  if (parentSkillMatch && parentSkillMatch[2]?.startsWith('/references/')) {
    return `.od-skills/${parentSkillMatch[1]}${parentSkillMatch[2]}`;
  }
  if (parentSkillMatch && parentSkillMatch[2]?.startsWith('/assets/')) {
    return `.od-skills/${parentSkillMatch[1]}${parentSkillMatch[2]}`;
  }
  if (parentSkillMatch && parentSkillMatch[2]?.startsWith('/templates/')) {
    return `.od-skills/${parentSkillMatch[1]}${parentSkillMatch[2]}`;
  }
  return null;
}

async function wrapProjectFileOperation(projectFs, target, operation) {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof ProjectToolPathError) throw err;
    const code = err?.code;
    if (code === 'ENOENT') {
      throw new Error(`Project file not found: ${displayProjectPath(projectFs, target)}`);
    }
    throw err;
  }
}

function summarizePiModel(model) {
  if (!isRecord(model)) return null;
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (provider && id) return `${provider}/${id}`;
  return id || null;
}

async function createJustBashToolDefinition(projectFs, cwd, createBashToolDefinition) {
  const { Bash, ReadWriteFs } = await import('just-bash');
  if (!projectFs || projectFs.kind !== 'local') {
    throw new Error('Pi SDK just-bash runtime currently requires a local ProjectFs');
  }
  const sandboxFs = new ReadWriteFs({ root: projectFs.root });
  const bash = new Bash({
    fs: sandboxFs,
    cwd: '/',
    python: true,
  });
  return createBashToolDefinition(cwd, {
    operations: {
      exec: async (command, execCwd, options = {}) => {
        const sandboxCwd = realPathToJustBashPath(projectFs.root, execCwd);
        const result = await bash.exec(command, {
          cwd: sandboxCwd,
          env: envForJustBash(options.env, sandboxCwd),
          signal: options.signal,
          timeout: options.timeout,
        });
        if (result.stdout) options.onData?.(Buffer.from(result.stdout));
        if (result.stderr) options.onData?.(Buffer.from(result.stderr));
        return { exitCode: typeof result.exitCode === 'number' ? result.exitCode : null };
      },
    },
  });
}

function createProjectFileToolDefinitions(
  projectFs,
  cwd,
  {
    createReadToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
  },
) {
  const readFile = async (absolutePath) =>
    wrapProjectFileOperation(projectFs, absolutePath, () =>
      fs.promises.readFile(resolveProjectToolPath(projectFs, cwd, absolutePath)),
    );
  const writeFile = async (absolutePath, content) =>
    wrapProjectFileOperation(projectFs, absolutePath, () =>
      fs.promises.writeFile(resolveProjectToolPath(projectFs, cwd, absolutePath), content, 'utf8'),
    );
  const access = async (absolutePath) => {
    await wrapProjectFileOperation(projectFs, absolutePath, () =>
      fs.promises.access(resolveProjectToolPath(projectFs, cwd, absolutePath)),
    );
  };
  const mkdir = async (dir) => {
    await wrapProjectFileOperation(projectFs, dir, () =>
      fs.promises.mkdir(resolveProjectToolPath(projectFs, cwd, dir), { recursive: true }),
    );
  };
  const detectImageMimeType = async (absolutePath) => {
    const ext = path.extname(resolveProjectToolPath(projectFs, cwd, absolutePath)).toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.has(ext) ? mimeForImage(absolutePath) : null;
  };

  return [
    createReadToolDefinition(cwd, {
      operations: {
        readFile,
        access,
        detectImageMimeType,
      },
    }),
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile,
        mkdir,
      },
    }),
    createEditToolDefinition(cwd, {
      operations: {
        readFile,
        writeFile,
        access,
      },
    }),
  ];
}

function emitPiSdkEvent(event, send, noteActivity) {
  noteActivity?.();
  if (!isRecord(event)) return;

  if (event.type === 'agent_start') {
    send('agent', { type: 'status', label: 'working' });
    return;
  }
  if (event.type === 'turn_start') {
    send('agent', { type: 'status', label: 'thinking' });
    return;
  }
  if (event.type === 'message_update') {
    const ev = event.assistantMessageEvent;
    if (!isRecord(ev)) return;
    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      send('agent', { type: 'text_delta', delta: ev.delta });
      return;
    }
    if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
      send('agent', { type: 'thinking_delta', delta: ev.delta });
      return;
    }
    if (ev.type === 'thinking_start' || ev.type === 'thinking_end') {
      send('agent', { type: ev.type });
      return;
    }
    if (ev.type === 'error') {
      send('agent', {
        type: 'error',
        message:
          typeof ev.reason === 'string'
            ? ev.reason
            : typeof ev.delta === 'string'
              ? ev.delta
              : 'Pi SDK agent error',
        raw: event,
      });
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    send('agent', {
      type: 'tool_use',
      id: event.toolCallId ?? null,
      name: event.toolName ?? null,
      input: event.args ?? null,
    });
    return;
  }
  if (event.type === 'tool_execution_update') {
    send('agent', {
      type: 'tool_result',
      toolUseId: event.toolCallId ?? null,
      content: typeof event.delta === 'string' ? event.delta : '',
      isError: false,
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    const result = isRecord(event.result) ? event.result : {};
    const content = result.content;
    const text = Array.isArray(content)
      ? content
          .map((item) =>
            isRecord(item) && item.type === 'text'
              ? String(item.text ?? '')
              : JSON.stringify(item),
          )
          .join('\n')
      : typeof content === 'string'
        ? content
        : '';
    send('agent', {
      type: 'tool_result',
      toolUseId: event.toolCallId ?? null,
      content: text,
      isError: event.isError === true,
    });
    return;
  }
  if (event.type === 'turn_end') {
    const usage = isRecord(event.message) && isRecord(event.message.usage)
      ? event.message.usage
      : null;
    if (!usage) return;
    send('agent', {
      type: 'usage',
      usage: {
        input_tokens: typeof usage.input === 'number' ? usage.input : undefined,
        output_tokens: typeof usage.output === 'number' ? usage.output : undefined,
        cached_read_tokens: typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined,
        cached_write_tokens: typeof usage.cacheWrite === 'number' ? usage.cacheWrite : undefined,
        total_tokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
      },
      costUsd: isRecord(usage.cost) ? usage.cost.total ?? usage.cost.totalCost ?? null : null,
    });
  }
}

export async function runPiSdkAgent({
  cwd,
  prompt,
  model,
  reasoning,
  imagePaths = [],
  uploadRoot = null,
  projectFs = null,
  send,
  signal,
  noteActivity = null,
}) {
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createBashToolDefinition,
    createEditToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    getAgentDir,
  } = await import('@earendil-works/pi-coding-agent');

  const localProjectFs = projectFs ?? createLocalProjectFs(cwd);
  await localProjectFs.ensureRoot();

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(cwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  const selectedModel = await resolveModel(modelRegistry, model);
  const sessionManager = SessionManager.inMemory(cwd);
  const bashTool = await createJustBashToolDefinition(localProjectFs, cwd, createBashToolDefinition);
  const fileTools = createProjectFileToolDefinitions(localProjectFs, cwd, {
    createReadToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager,
    tools: ['read', 'bash', 'edit', 'write'],
    customTools: [...fileTools, bashTool],
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(typeof reasoning === 'string' && reasoning !== 'default'
      ? { thinkingLevel: reasoning }
      : {}),
  });
  const resolvedModel = summarizePiModel(session.model);
  if (resolvedModel) {
    send('agent', {
      type: 'status',
      label: 'initializing',
      detail: resolvedModel,
      model: resolvedModel,
    });
  }

  let unsubscribe = null;
  let aborted = false;
  const abort = async () => {
    aborted = true;
    try {
      await session.abort();
    } catch {
      // Best-effort; the caller owns terminal status.
    }
  };
  if (signal?.aborted) {
    await abort();
  } else if (signal) {
    signal.addEventListener('abort', abort, { once: true });
  }

  try {
    unsubscribe = session.subscribe((event) =>
      emitPiSdkEvent(event, send, noteActivity),
    );
    const images = await loadPiImages(imagePaths, uploadRoot);
    await session.prompt(prompt, images.length > 0 ? { images } : undefined);
    return { aborted, resolvedModel };
  } catch (err) {
    if (aborted) return { aborted: true, resolvedModel };
    send('agent', {
      type: 'error',
      message: errorMessage(err),
      raw: { source: 'pi-sdk' },
    });
    return { error: err, resolvedModel };
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
    if (unsubscribe) unsubscribe();
    try {
      session.dispose();
    } catch {
      // Nothing useful to surface after the run has ended.
    }
  }
}
