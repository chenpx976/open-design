import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function readRepoFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...segments), 'utf8');
}

describe('cluster deployment configuration', () => {
  it('keeps API, worker, Postgres, and Redis knobs wired through Compose and docs', async () => {
    const [compose, envExample, deployReadme, clusterDoc] = await Promise.all([
      readRepoFile('deploy', 'docker-compose.yml'),
      readRepoFile('deploy', '.env.example'),
      readRepoFile('deploy', 'README.md'),
      readRepoFile('docs', 'cluster-deployment.md'),
    ]);

    expect(compose).toContain('agent-worker:');
    expect(compose).toContain('redis:');
    expect(compose).toContain('postgres:');
    expect(compose).toContain('OD_AGENT_RUN_STORE');
    expect(compose).toContain('OD_AGENT_POSTGRES_URL');
    expect(compose).toContain('OD_AGENT_JOB_QUEUE');
    expect(compose).toContain('OD_AGENT_REDIS_URL');
    expect(compose).toContain('OD_AGENT_WORKER_LEASE_MS');
    expect(compose).toContain('OD_AGENT_WORKER_HEARTBEAT_MS');
    expect(compose).toContain('OD_AGENT_WORKER_MAX_JOB_MS');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_RUN_STORE=sqlite');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_POSTGRES_URL=postgres://open_design:open_design@postgres:5432/open_design');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_JOB_QUEUE=sqlite');
    expect(envExample).toContain('OPEN_DESIGN_AGENT_REDIS_URL=redis://redis:6379/0');
    expect(deployReadme).toContain('OPEN_DESIGN_AGENT_RUN_STORE=postgres');
    expect(deployReadme).toContain('OPEN_DESIGN_AGENT_JOB_QUEUE=redis');
    expect(deployReadme).toContain('--scale agent-worker=2');
    expect(clusterDoc).toContain('OD_AGENT_RUN_STORE=postgres');
    expect(clusterDoc).toContain('OD_AGENT_JOB_QUEUE=redis');
    expect(clusterDoc).toContain('OD_AGENT_WORKER_MAX_ATTEMPTS');
  });
});
