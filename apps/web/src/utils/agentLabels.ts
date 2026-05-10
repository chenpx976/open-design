const AGENT_LABELS: Record<string, string> = {
  pi: 'Pi',
  'pi-sdk': 'Pi',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
  'azure-openai-api': 'Azure OpenAI',
  'google-gemini-api': 'Google Gemini',
};

const AGENT_ALIASES: Record<string, string> = {
  'pi sdk': 'pi',
  'node:pi-sdk': 'pi',
};

export function agentDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
): string | null {
  for (const raw of [agentId, fallbackName]) {
    const known = knownAgentLabel(raw);
    if (known) return known;
  }
  for (const raw of [fallbackName, agentId]) {
    const fallback = safeFallbackLabel(raw);
    if (fallback) return fallback;
  }
  return null;
}

export function exactAgentDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  return AGENT_LABELS[alias] ?? null;
}

export function agentModelDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
  model?: string | null,
): string | undefined {
  const label = agentDisplayName(agentId, fallbackName) ?? undefined;
  const modelId = displayableModelId(model);
  if (!modelId) return label;
  return label ? `${label} · ${modelId}` : modelId;
}

function knownAgentLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  const direct = AGENT_LABELS[alias];
  if (direct) return direct;
  if (key.includes('pi-sdk')) return 'Pi';
  for (const [agentId, label] of Object.entries(AGENT_LABELS)) {
    if (key.includes(agentId)) return label;
  }
  return null;
}

function safeFallbackLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function displayableModelId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

function normalizeKey(raw: string): string {
  const basename = raw.trim().split(/[\\/]/).pop() ?? raw.trim();
  return basename
    .replace(/\.(cmd|exe|bat)$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
