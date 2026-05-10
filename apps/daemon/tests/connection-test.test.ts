// Coverage for the /api/test/connection route. Hits status mapping for provider protocols
// and the daemon-hosted Pi agent probe.

import type http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAgentSink,
  isSmokeOkReply,
  redactSecrets,
  testAgentConnection,
  testProviderConnection,
} from '../src/connectionTest.js';
import { listProviderModels } from '../src/providerModels.js';
import { startServer } from '../src/server.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface StartedServer {
  url: string;
  server: http.Server;
}

const realFetch = globalThis.fetch;
let baseUrl: string;
let server: http.Server;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/plain', ...(init?.headers ?? {}) },
  });
}

function passThroughOrUpstream(handler: (url: string, init?: FetchInit) => Response | Promise<Response>) {
  return vi.fn((input: FetchInput, init?: FetchInit) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    return Promise.resolve(handler(url, init));
  });
}

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
  baseUrl = started.url;
  server = started.server;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('POST /api/provider/models', () => {
  it('lists OpenAI-compatible models from /models', async () => {
    const fetchMock = passThroughOrUpstream((url, init) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer sk-openai',
      );
      return jsonResponse({
        data: [
          { id: 'gpt-4o-mini', object: 'model' },
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-4o', object: 'model' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/provider/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      kind: 'success',
      models: [
        { id: 'gpt-4o', label: 'gpt-4o' },
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      ],
    });
  });

  it('lists Anthropic models with display names and a high page limit', async () => {
    const fetchMock = passThroughOrUpstream((url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe(
        'sk-ant',
      );
      expect((init?.headers as Record<string, string>)['anthropic-version']).toBe(
        '2023-06-01',
      );
      return jsonResponse({
        data: [
          {
            id: 'claude-sonnet-4-5',
            display_name: 'Claude Sonnet 4.5',
            type: 'model',
          },
          {
            id: 'claude-haiku-4-5',
            display_name: 'Claude Haiku 4.5',
            type: 'model',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/provider/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant',
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      models: [
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      ],
    });
  });

  it('lists only Gemini models that support generateContent', async () => {
    const fetchMock = passThroughOrUpstream((url) => {
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models?key=goog-key',
      );
      return jsonResponse({
        models: [
          {
            name: 'models/gemini-custom',
            displayName: 'Gemini Custom',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
          {
            name: 'models/gemini-2.0-flash-001',
            baseModelId: 'gemini-2.0-flash',
            displayName: 'Gemini 2.0 Flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/provider/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'goog-key',
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      models: [
        { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
        { id: 'gemini-custom', label: 'Gemini Custom' },
      ],
    });
  });

  it('lets unsupported contract protocols return a classified provider-models result', async () => {
    const fetchMock = passThroughOrUpstream(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/provider/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'ollama',
        baseUrl: 'https://ollama.com',
        apiKey: 'ollama-key',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      kind: 'unsupported_protocol',
    });
    expect(
      fetchMock.mock.calls.some(
        ([input]) => !String(input).startsWith(baseUrl),
      ),
    ).toBe(false);
  });

  it('maps upstream listing failures to categorized results and redacts keys', async () => {
    for (const [status, kind, response] of [
      [
        401,
        'auth_failed',
        (apiKey: string) => jsonResponse(
          { error: { message: `bad key ${apiKey}` } },
          { status: 401 },
        ),
      ],
      [
        429,
        'rate_limited',
        (apiKey: string) => textResponse(`rate limit for ${apiKey}`, { status: 429 }),
      ],
      [
        503,
        'upstream_unavailable',
        (apiKey: string) => textResponse(
          `<html>temporary outage for ${apiKey}</html>`,
          { status: 503, headers: { 'content-type': 'text/html' } },
        ),
      ],
    ] as const) {
      const apiKey = `sk-secret-models-${status}`;
      vi.stubGlobal(
        'fetch',
        passThroughOrUpstream(() => response(apiKey)),
      );

      const res = await realFetch(`${baseUrl}/api/provider/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, kind, status });
      expect(String(body.detail)).not.toContain(apiKey);
      vi.unstubAllGlobals();
    }
  });

  it('rejects private-network base URLs without calling upstream fetch', async () => {
    const fetchMock = passThroughOrUpstream(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/provider/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'openai',
        baseUrl: 'http://192.168.1.5:8080/v1',
        apiKey: 'sk-good',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(
      fetchMock.mock.calls.some(
        ([input]) => !String(input).startsWith(baseUrl),
      ),
    ).toBe(false);
  });

  it('reports timeout when model listing is aborted by the probe timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: FetchInput, init?: FetchInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      ),
    );

    const pending = listProviderModels({
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-timeout',
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
    });
  });
});

describe('POST /api/test/connection provider mode', () => {
  it('reports success and returns the model sample for an Anthropic 200', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({
          content: [{ type: 'text', text: 'ok' }],
        }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('success');
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.sample).toBe('ok');
  });

  it('redacts submitted keys from success samples', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({
          content: [{ type: 'text', text: 'debug echo sk-success-secret' }],
        }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-success-secret',
        model: 'claude-sonnet-4-5',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sample).toBe('debug echo [REDACTED]');
    expect(body.sample).not.toContain('sk-success-secret');
  });

  it('maps a 401 to auth_failed', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({ error: { message: 'invalid x-api-key' } }, { status: 401 }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-bad',
        model: 'gpt-4o',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('auth_failed');
    expect(body.status).toBe(401);
  });

  it('does not add a duplicate version segment for versioned OpenAI-compatible subpaths', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'm' }] }));
      }
      return Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'ok' } }],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        apiKey: 'sk-good',
        model: 'm',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepinfra.com/v1/openai/chat/completions',
      expect.anything(),
    );
  });

  it('maps a 404 to not_found_model', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({ error: { message: 'model not found' } }, { status: 404 }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-good',
        model: 'gpt-does-not-exist',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('not_found_model');
    expect(body.status).toBe(404);
  });

  it('maps an ambiguous 404 to invalid_base_url', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() => new Response('', { status: 404 })),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v2',
        apiKey: 'ark-key',
        model: 'doubao-1-5-lite-32k-250115',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('invalid_base_url');
    expect(body.status).toBe(404);
    expect(body.detail).toContain('HTTP 404');
  });

  it('maps a 429 to rate_limited', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({ error: { message: 'too many requests' } }, { status: 429 }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-good',
        model: 'gpt-4o',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('rate_limited');
  });

  it('maps a 500 to upstream_unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({ error: { message: 'oops' } }, { status: 503 }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-good',
        model: 'gpt-4o',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('upstream_unavailable');
    expect(body.status).toBe(503);
  });

  it('does not treat a 200 response without assistant text as success', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({
          error: {
            message:
              'Unexpected endpoint or method. (POST /v2/chat/completions). Returning 200 anyway',
          },
        }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'http://localhost:1234/v2',
        apiKey: 'lm-studio',
        model: 'google/gemma-4-e4b',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('unknown');
    expect(body.status).toBe(200);
    expect(body.detail).toContain('Unexpected endpoint or method');
  });

  it('does not treat model-error assistant text as provider success', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream(() =>
        jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  "There's an issue with the selected model (abcde). It may not exist.",
              },
            },
          ],
        }),
      ),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-good',
        model: 'abcde',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('not_found_model');
    expect(body.model).toBe('abcde');
    expect(body.detail).toContain('Expected smoke test reply "ok"');
  });

  it('treats a structured local reasoning completion with empty content as connected', async () => {
    vi.stubGlobal(
      'fetch',
      passThroughOrUpstream((url) => {
        if (url === 'http://localhost:1234/v1/models') {
          return jsonResponse({
            data: [{ id: 'google/gemma-4-e4b', object: 'model' }],
          });
        }
        return jsonResponse({
          id: 'chatcmpl-reasoning',
          object: 'chat.completion',
          model: 'google/gemma-4-e4b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: '\nThe user wants me to reply with only ok',
              },
              finish_reason: 'length',
            },
          ],
        });
      }),
    );

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'lm-studio',
        model: 'google/gemma-4-e4b',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('success');
    expect(body.model).toBe('google/gemma-4-e4b');
    expect(body.sample).toBe('valid completion (length)');
  });

  it('rejects an unloaded local OpenAI-compatible model before completion', async () => {
    const fetchMock = passThroughOrUpstream((url) => {
      if (url === 'http://localhost:1234/v1/models') {
        return jsonResponse({
          data: [{ id: 'google/gemma-4-e4b', object: 'model' }],
        });
      }
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'http://localhost:1234/v1',
        apiKey: 'lm-studio',
        model: 'helo',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('not_found_model');
    expect(body.model).toBe('helo');
    expect(body.detail).toContain('helo');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/chat/completions'),
      ),
    ).toBe(false);
  });

  it('reports forbidden for an internal-IP base URL without calling fetch', async () => {
    const fetchMock = passThroughOrUpstream(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'openai',
        baseUrl: 'http://192.168.1.5:8080/v1',
        apiKey: 'sk-good',
        model: 'gpt-4o',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('forbidden');
    // Internal-IP guard fires before any outbound fetch.
    expect(
      fetchMock.mock.calls.some(
        ([input]) => !String(input).startsWith(baseUrl),
      ),
    ).toBe(false);
  });

  it('allows IPv6 loopback base URLs for local OpenAI-compatible providers', async () => {
    for (const loopbackBaseUrl of [
      'http://[::1]:1234/v1',
      'http://[::ffff:127.0.0.1]:1234/v1',
    ]) {
      const fetchMock = passThroughOrUpstream((url) => {
        if (url.endsWith('/models')) {
          return jsonResponse({
            data: [{ id: 'local-model', object: 'model' }],
          });
        }
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await realFetch(`${baseUrl}/api/test/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'provider',
          protocol: 'openai',
          baseUrl: loopbackBaseUrl,
          apiKey: 'lm-studio',
          model: 'local-model',
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.kind).toBe('success');
      vi.unstubAllGlobals();
    }
  });

  it('reports forbidden for internal IPv6 base URLs without calling fetch', async () => {
    for (const blockedBaseUrl of [
      'http://[fd00::1]:1234/v1',
      'http://[fe80::1]:1234/v1',
      'http://[::ffff:192.168.1.5]:1234/v1',
    ]) {
      const fetchMock = passThroughOrUpstream(() => jsonResponse({}));
      vi.stubGlobal('fetch', fetchMock);

      const res = await realFetch(`${baseUrl}/api/test/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'provider',
          protocol: 'openai',
          baseUrl: blockedBaseUrl,
          apiKey: 'sk-good',
          model: 'gpt-4o',
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.kind).toBe('forbidden');
      expect(
        fetchMock.mock.calls.some(
          ([input]) => !String(input).startsWith(baseUrl),
        ),
      ).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('routes Azure tests to the deployments endpoint with api-key auth', async () => {
    const fetchMock = passThroughOrUpstream(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'azure',
        baseUrl: 'https://my-azure.openai.azure.com',
        apiKey: 'azure-key',
        model: 'deployment-1',
        apiVersion: '2024-10-21',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sample).toBe('ok');
    const upstream = fetchMock.mock.calls.find(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(upstream).toBeDefined();
    const [upstreamUrl, upstreamInit] = upstream!;
    expect(String(upstreamUrl)).toBe(
      'https://my-azure.openai.azure.com/openai/deployments/deployment-1/chat/completions?api-version=2024-10-21',
    );
    expect((upstreamInit?.headers as Record<string, string>)['api-key']).toBe(
      'azure-key',
    );
  });

  it('keeps the default Azure api-version in connection tests when the field is blank', async () => {
    const fetchMock = passThroughOrUpstream(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'azure',
        baseUrl: 'https://my-azure.openai.azure.com',
        apiKey: 'azure-key',
        model: 'deployment-1',
        apiVersion: '',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const upstream = fetchMock.mock.calls.find(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(upstream).toBeDefined();
    const [upstreamUrl] = upstream!;
    expect(String(upstreamUrl)).toBe(
      'https://my-azure.openai.azure.com/openai/deployments/deployment-1/chat/completions?api-version=2024-10-21',
    );
  });

  it('omits Azure api-version in connection tests for OpenAI-compatible v1 paths when blank', async () => {
    const fetchMock = passThroughOrUpstream(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'azure',
        baseUrl: 'https://my-resource.services.ai.azure.com/api/projects/project/openai/v1',
        apiKey: 'azure-key',
        model: 'deployment-1',
        apiVersion: '',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const upstream = fetchMock.mock.calls.find(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(upstream).toBeDefined();
    const [upstreamUrl, upstreamInit] = upstream!;
    expect(String(upstreamUrl)).toBe(
      'https://my-resource.services.ai.azure.com/api/projects/project/openai/v1/chat/completions',
    );
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      model: 'deployment-1',
    });
  });

  it('removes copied Azure api-version query params in connection tests for OpenAI-compatible v1 paths when blank', async () => {
    const fetchMock = passThroughOrUpstream(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'azure',
        baseUrl:
          'https://my-resource.services.ai.azure.com/api/projects/project/openai/v1?api-version=2024-10-21',
        apiKey: 'azure-key',
        model: 'deployment-1',
        apiVersion: '',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const upstream = fetchMock.mock.calls.find(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(upstream).toBeDefined();
    const [upstreamUrl] = upstream!;
    expect(String(upstreamUrl)).toBe(
      'https://my-resource.services.ai.azure.com/api/projects/project/openai/v1/chat/completions',
    );
  });

  it('uses the non-streaming Gemini endpoint and extracts text from candidates', async () => {
    const fetchMock = passThroughOrUpstream(() =>
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: 'ok' }] } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'provider',
        protocol: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'goog-key',
        model: 'gemini-2.0-flash',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sample).toBe('ok');
    const upstream = fetchMock.mock.calls.find(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(String(upstream![0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
  });

  it('rejects malformed bodies with HTTP 400 (not the test envelope)', async () => {
    const res = await realFetch(`${baseUrl}/api/test/connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'provider', protocol: 'openai' }),
    });
    expect(res.status).toBe(400);
  });

  it('cancels provider probes when the caller aborts', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: FetchInput, init?: FetchInit) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      ),
    );

    const pending = testProviderConnection({
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-good',
      model: 'gpt-4o',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
    });
  });
});

describe('connection test helpers', () => {
  it('redacts the exact submitted provider key when it appears in body text', () => {
    const detail = redactSecrets(
      'Incorrect API key provided: sk-test-raw-secret.',
      ['sk-test-raw-secret'],
    );

    expect(detail).toBe('Incorrect API key provided: [REDACTED].');
    expect(detail).not.toContain('sk-test-raw-secret');
  });

  it('does not resolve the agent smoke test from thinking deltas', async () => {
    vi.useFakeTimers();
    const sink = createAgentSink();
    sink.send('agent', { type: 'thinking_delta', delta: 'thinking first' });
    let settled = false;
    sink.result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    sink.send('agent', { type: 'text_delta', delta: 'ok' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(sink.result).resolves.toEqual({ kind: 'text', text: 'ok' });
  });

  it('rejects the agent smoke test from structured stream errors', async () => {
    const sink = createAgentSink();
    sink.send('agent', {
      type: 'error',
      message: "The 'gpt-5.5' model requires a newer version of Codex.",
    });

    await expect(sink.result).resolves.toMatchObject({
      kind: 'streamError',
      error: expect.objectContaining({
        message: "The 'gpt-5.5' model requires a newer version of Codex.",
      }),
    });
  });

  it('debounces agent text chunks before resolving', async () => {
    vi.useFakeTimers();
    const sink = createAgentSink();
    sink.send('agent', { type: 'text_delta', delta: 'Error:' });
    await vi.advanceTimersByTimeAsync(499);
    sink.send('agent', { type: 'text_delta', delta: ' model not found' });
    await vi.advanceTimersByTimeAsync(500);

    await expect(sink.result).resolves.toEqual({
      kind: 'text',
      text: 'Error: model not found',
    });
  });

  it('requires the smoke reply to be exactly ok after whitespace and case', () => {
    expect(isSmokeOkReply('ok')).toBe(true);
    expect(isSmokeOkReply(' OK \n')).toBe(true);
    expect(isSmokeOkReply('ok.')).toBe(false);
    expect(
      isSmokeOkReply(
        "There's an issue with the selected model (abcde). It may not exist.",
      ),
    ).toBe(false);
  });
});
