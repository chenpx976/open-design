// @ts-nocheck
// Node-hosted agent catalog.
//
// Open Design used to discover and spawn a zoo of local coding-agent CLIs.
// The daemon now owns one embedded coding agent runtime, powered by Pi's SDK.
// That matches Flue's "headless programmable harness" shape while keeping OD's
// local-first daemon responsible for project files, tools, SSE, and config.

const DEFAULT_MODEL_OPTION = { id: 'default', label: 'Default (Pi settings)' };

export const PI_AGENT_ID = 'pi';

export const PI_REASONING_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
];

export const PI_FALLBACK_MODELS = [
  DEFAULT_MODEL_OPTION,
  {
    id: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (anthropic)',
  },
  { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (anthropic)' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5 (openai)' },
  { id: 'openai/gpt-5', label: 'GPT-5 (openai)' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (google)' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (google)' },
];

export const PI_AGENT_DEF = {
  id: PI_AGENT_ID,
  name: 'Pi SDK',
  // Kept for the existing web contract. This is intentionally not resolved
  // on PATH and is never spawned as a binary.
  bin: 'node:pi-sdk',
  available: true,
  path: 'embedded',
  version: null,
  models: PI_FALLBACK_MODELS,
  reasoningOptions: PI_REASONING_OPTIONS,
  docsUrl: 'https://github.com/earendil-works/pi',
  installUrl: 'https://pi.dev',
};

export const AGENT_DEFS = [PI_AGENT_DEF];

const liveModelsByAgent = new Map();

function normalizePiModel(model) {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

function optionFromModel(model) {
  if (!model) return null;
  if (typeof model === 'string') return { id: model, label: model };
  const provider = typeof model.provider === 'string' ? model.provider : '';
  const id =
    typeof model.id === 'string'
      ? model.id
      : typeof model.model === 'string'
        ? model.model
        : typeof model.name === 'string'
          ? model.name
          : '';
  if (!id) return null;
  const full = provider && !id.includes('/') ? `${provider}/${id}` : id;
  const label = typeof model.label === 'string' ? model.label : full;
  return { id: full, label };
}

async function listPiModels() {
  try {
    const { AuthStorage, ModelRegistry } = await import(
      '@earendil-works/pi-coding-agent'
    );
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const available =
      typeof registry.getAvailable === 'function'
        ? await registry.getAvailable()
        : [];
    const options = [DEFAULT_MODEL_OPTION];
    const seen = new Set(['default']);
    for (const model of available) {
      const option = optionFromModel(model);
      if (!option || seen.has(option.id)) continue;
      seen.add(option.id);
      options.push(option);
    }
    return options.length > 1 ? options : PI_FALLBACK_MODELS;
  } catch {
    return PI_FALLBACK_MODELS;
  }
}

export async function detectAgents() {
  const models = await listPiModels();
  rememberLiveModels(PI_AGENT_ID, models);
  return [{ ...PI_AGENT_DEF, models }];
}

export function getAgentDef(id) {
  const normalized = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return normalized === PI_AGENT_ID ? PI_AGENT_DEF : null;
}

export function checkPromptArgvBudget() {
  return null;
}

export function checkWindowsCmdShimCommandLineBudget() {
  return null;
}

export function checkWindowsDirectExeCommandLineBudget() {
  return null;
}

export function resolveAgentBin(id) {
  return getAgentDef(id)?.path ?? null;
}

export function spawnEnvForAgent(_agentId, baseEnv, _configuredEnv = {}) {
  return { ...(baseEnv || {}) };
}

export function rememberLiveModels(agentId, models) {
  if (typeof agentId !== 'string' || !Array.isArray(models)) return;
  liveModelsByAgent.set(
    agentId,
    models
      .map((model) => (typeof model?.id === 'string' ? model.id : null))
      .filter(Boolean),
  );
}

export function isKnownModel(defOrAgentId, model) {
  const agentId =
    typeof defOrAgentId === 'string' ? defOrAgentId : defOrAgentId?.id;
  const normalized = normalizePiModel(model);
  if (!normalized) return true;
  const live = liveModelsByAgent.get(agentId);
  if (Array.isArray(live) && live.includes(normalized)) return true;
  return PI_FALLBACK_MODELS.some((option) => option.id === normalized);
}

export function sanitizeCustomModel(model) {
  const normalized = normalizePiModel(model);
  if (!normalized) return null;
  // Pi model patterns are intentionally broad: provider/model and optional
  // :thinking suffixes are valid. Keep only printable non-whitespace tokens.
  return /^[A-Za-z0-9._@:/+~-]{1,160}$/.test(normalized) ? normalized : null;
}
