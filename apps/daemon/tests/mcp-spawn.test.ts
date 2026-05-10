// End-to-end test for the Pi runtime MCP boundary.
//
// External MCP servers are still configured through the same HTTP surface, but
// the daemon-hosted Pi runtime no longer spawns local coding-agent CLIs or
// writes project-cwd `.mcp.json` auto-load files.

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

async function waitForRunStatus(
  baseUrl: string,
  runId: string,
): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const r = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = (await r.json()) as { status: string };
    if (body.status !== 'queued' && body.status !== 'running') return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run did not finish');
}

describe('Pi runtime does not write local CLI MCP config', () => {
  let server: http.Server;
  let baseUrl: string;
  let oldFakePi: string | undefined;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    oldFakePi = process.env.OD_E2E_FAKE_PI_AGENT;
    process.env.OD_E2E_FAKE_PI_AGENT = '1';
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldFakePi === undefined) {
      delete process.env.OD_E2E_FAKE_PI_AGENT;
    } else {
      process.env.OD_E2E_FAKE_PI_AGENT = oldFakePi;
    }
  });

  afterEach(async () => {
    await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [] }),
    }).catch(() => {});
  });

  async function createProject(): Promise<{ id: string; dir: string }> {
    const id = `mcp-pi-${randomUUID()}`;
    const r = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    });
    expect(r.ok).toBe(true);
    projectsToClean.push(id);
    const projectsBase = process.env.OD_DATA_DIR
      ? join(process.env.OD_DATA_DIR, 'projects')
      : join(process.cwd(), '.od', 'projects');
    await fsp.mkdir(join(projectsBase, id), { recursive: true });
    return { id, dir: join(projectsBase, id) };
  }

  it('keeps external MCP config out of the project dir during Pi runs', async () => {
    const putRes = await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        servers: [
          {
            id: 'higgsfield',
            transport: 'sse',
            enabled: true,
            url: 'https://mcp.higgsfield.ai',
          },
        ],
      }),
    });
    expect(putRes.ok).toBe(true);

    const { id, dir } = await createProject();
    const chatRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'pi',
        projectId: id,
        message: 'hello mcp',
      }),
    });
    expect(chatRes.status).toBe(202);
    const { runId } = (await chatRes.json()) as { runId: string };
    await waitForRunStatus(baseUrl, runId);

    const target = join(dir, '.mcp.json');
    expect(existsSync(target)).toBe(false);

    await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers: [] }),
    });

    const chat2 = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'pi',
        projectId: id,
        message: 'second turn',
      }),
    });
    expect(chat2.status).toBe(202);
    const { runId: runId2 } = (await chat2.json()) as { runId: string };
    await waitForRunStatus(baseUrl, runId2);

    expect(existsSync(target)).toBe(false);
  }, 30_000);
});
