import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';

export type ProjectFsKind = 'local';

export interface ProjectFs {
  readonly kind: ProjectFsKind;
  readonly root: string;
  resolvePath(relPath?: string | null): string;
  contains(absPath: string): boolean;
  ensureRoot(): Promise<void>;
  exists(relPath?: string | null): Promise<boolean>;
}

export interface LocalProjectFs extends ProjectFs {
  readonly kind: 'local';
}

function normalizeRelativePath(relPath?: string | null): string {
  if (typeof relPath !== 'string') return '';
  const trimmed = relPath.trim();
  if (!trimmed || trimmed === '.' || trimmed === '/') return '';
  return trimmed.replace(/^[/\\]+/, '');
}

export function createLocalProjectFs(root: string): LocalProjectFs {
  const resolvedRoot = path.resolve(root);
  return {
    kind: 'local',
    root: resolvedRoot,
    resolvePath(relPath?: string | null): string {
      const resolved = path.resolve(resolvedRoot, normalizeRelativePath(relPath));
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error('project fs path escapes root');
      }
      return resolved;
    },
    contains(absPath: string): boolean {
      const resolved = path.resolve(absPath);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    },
    async ensureRoot(): Promise<void> {
      await mkdir(resolvedRoot, { recursive: true });
    },
    async exists(relPath?: string | null): Promise<boolean> {
      try {
        await stat(this.resolvePath(relPath));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}

export function describeProjectFsForPrompt(projectFs: ProjectFs): string {
  if (projectFs.kind === 'local') return projectFs.root;
  return projectFs.root;
}
