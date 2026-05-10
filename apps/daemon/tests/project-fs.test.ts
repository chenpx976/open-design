import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalProjectFs } from '../src/project-fs.js';

describe('createLocalProjectFs', () => {
  it('resolves project-relative paths inside the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-project-fs-'));
    const fs = createLocalProjectFs(root);

    expect(fs.resolvePath('index.html')).toBe(path.join(root, 'index.html'));
    expect(fs.contains(path.join(root, 'nested', 'file.txt'))).toBe(true);
  });

  it('rejects paths that escape the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-project-fs-'));
    const fs = createLocalProjectFs(root);

    expect(() => fs.resolvePath('../outside.txt')).toThrow(/escapes root/);
    expect(fs.contains(path.join(path.dirname(root), 'outside.txt'))).toBe(false);
  });

  it('checks existence through the guarded resolver', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-project-fs-'));
    const fs = createLocalProjectFs(root);
    await fs.ensureRoot();
    await writeFile(path.join(root, 'ready.txt'), 'ok', 'utf8');

    await expect(fs.exists('ready.txt')).resolves.toBe(true);
    await expect(fs.exists('missing.txt')).resolves.toBe(false);
    await expect(fs.exists('../outside.txt')).rejects.toThrow(/escapes root/);
  });
});
