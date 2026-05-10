import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeLiveInstructionPrompt,
  resolveGrantedCodexImagegenOverride,
  resolveCodexGeneratedImagesDir,
  resolveChatExtraAllowedDirs,
  resolveResearchCommandContract,
  validateCodexGeneratedImagesDir,
} from '../src/server.js';
import { renderCodexImagegenOverride } from '../src/prompts/system.js';

function symlinkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('chat prompt helpers', () => {
  it('appends the validated Codex override after the client system prompt and removes earlier duplicates', () => {
    const override = renderCodexImagegenOverride('codex', {
      kind: 'image',
      imageModel: 'gpt-image-2',
      imageAspect: '1:1',
    });
    const clientMediaContract =
      '## Media generation contract\nclient contract wins unless a later override says otherwise';

    const prompt = composeLiveInstructionPrompt({
      daemonSystemPrompt: `daemon prompt\n${override}`,
      runtimeToolPrompt: 'runtime tools',
      clientSystemPrompt: clientMediaContract,
      finalPromptOverride: override,
    });

    const clientIdx = prompt.indexOf(clientMediaContract);
    const overrideIdx = prompt.indexOf('## Codex built-in imagegen override');
    expect(clientIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(clientIdx);
    expect(prompt.match(/## Codex built-in imagegen override/g)).toHaveLength(1);
  });

  it('defaults enabled research without an explicit query to the current message', () => {
    const prompt = resolveResearchCommandContract(
      { enabled: true },
      'EV market 2025 trends',
    );

    expect(prompt).toContain('Canonical query for this run:');
    expect(prompt).toContain('EV market 2025 trends');
    expect(prompt).toContain('the first tool action must be the research command');
  });

  it('resolves only the narrow Codex generated_images allowlist for known gpt-image image projects', () => {
    expect(
      resolveCodexGeneratedImagesDir(
        'codex',
        { kind: 'image', imageModel: 'gpt-image-2' },
        { CODEX_HOME: '/tmp/custom-codex-home' },
        '/home/tester',
      ),
    ).toBe(resolve('/tmp/custom-codex-home/generated_images'));

    expect(
      resolveCodexGeneratedImagesDir(
        'codex',
        { kind: 'image', imageModel: 'gpt-image-2-preview' },
        { CODEX_HOME: '/tmp/custom-codex-home' },
        '/home/tester',
      ),
    ).toBeNull();

    expect(
      resolveCodexGeneratedImagesDir(
        'claude',
        { kind: 'image', imageModel: 'gpt-image-2' },
        { CODEX_HOME: '/tmp/custom-codex-home' },
        '/home/tester',
      ),
    ).toBeNull();
  });

  it('rejects a generated_images final-component symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'od-codex-generated-symlink-'));
    try {
      const codexHome = join(root, 'codex-home');
      const symlinkTarget = join(root, 'actual-generated-images');
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(symlinkTarget, { recursive: true });
      symlinkDir(symlinkTarget, join(codexHome, 'generated_images'));

      const generatedImagesDir = resolveCodexGeneratedImagesDir(
        'codex',
        { kind: 'image', imageModel: 'gpt-image-2' },
        { CODEX_HOME: codexHome },
        '/home/tester',
      );

      expect(
        validateCodexGeneratedImagesDir(generatedImagesDir, {
          warn: () => undefined,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a generated_images dir whose canonical path is inside a protected root', () => {
    const root = mkdtempSync(join(tmpdir(), 'od-codex-generated-protected-'));
    try {
      const protectedRoot = join(root, 'skills');
      const protectedGeneratedImages = join(protectedRoot, 'generated_images');
      mkdirSync(protectedGeneratedImages, { recursive: true });
      const codexHome = join(root, 'codex-home');
      symlinkDir(protectedRoot, codexHome);

      const generatedImagesDir = resolveCodexGeneratedImagesDir(
        'codex',
        { kind: 'image', imageModel: 'gpt-image-2' },
        { CODEX_HOME: codexHome },
        '/home/tester',
      );

      expect(
        validateCodexGeneratedImagesDir(generatedImagesDir, {
          protectedDirs: [protectedRoot],
          warn: () => undefined,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grants Codex the canonical validated generated_images dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'od-codex-generated-canonical-'));
    try {
      const actualCodexHome = join(root, 'actual-codex-home');
      const symlinkCodexHome = join(root, 'codex-home-link');
      mkdirSync(actualCodexHome, { recursive: true });
      symlinkDir(actualCodexHome, symlinkCodexHome);

      const generatedImagesDir = resolveCodexGeneratedImagesDir(
        'codex',
        { kind: 'image', imageModel: 'gpt-image-2' },
        { CODEX_HOME: symlinkCodexHome },
        '/home/tester',
      );
      const validatedDir = validateCodexGeneratedImagesDir(
        generatedImagesDir,
        { warn: () => undefined },
      );
      const canonicalGeneratedImagesDir = join(
        realpathSync.native(actualCodexHome),
        'generated_images',
      );
      const extraAllowedDirs = resolveChatExtraAllowedDirs({
        agentId: 'codex',
        skillsDir: '/repo/skills',
        designSystemsDir: '/repo/design-systems',
        linkedDirs: ['/linked/reference'],
        codexGeneratedImagesDir: validatedDir,
        existsSync: () => true,
      });
      expect(generatedImagesDir).not.toBe(canonicalGeneratedImagesDir);
      expect(validatedDir).toBe(canonicalGeneratedImagesDir);
      expect(extraAllowedDirs).toEqual([canonicalGeneratedImagesDir]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('limits Codex extra allowed dirs to the generated_images output dir', () => {
    const generatedImagesDir = '/home/tester/.codex/generated_images';
    const dirs = resolveChatExtraAllowedDirs({
      agentId: '  CoDeX  ',
      skillsDir: '/repo/skills',
      designSystemsDir: '/repo/design-systems',
      linkedDirs: ['/linked/reference'],
      codexGeneratedImagesDir: generatedImagesDir,
      existsSync: () => true,
    });

    expect(dirs).toEqual([generatedImagesDir]);

  });

  it('keeps resource and linked dirs for non-Codex agents without the Codex output dir', () => {
    const existingDirs = new Set([
      '/repo/skills',
      '/repo/design-systems',
      '/linked/reference',
      '/home/tester/.codex/generated_images',
    ]);
    const dirs = resolveChatExtraAllowedDirs({
      agentId: 'claude',
      skillsDir: '/repo/skills',
      designSystemsDir: '/repo/design-systems',
      linkedDirs: ['/linked/reference'],
      codexGeneratedImagesDir: '/home/tester/.codex/generated_images',
      existsSync: (dir: string) => existingDirs.has(dir),
    });

    expect(dirs).toEqual([
      '/repo/skills',
      '/repo/design-systems',
      '/linked/reference',
    ]);
  });

  it('does not add resource dirs for Codex when imagegen is not whitelisted', () => {
    const dirs = resolveChatExtraAllowedDirs({
      agentId: 'codex',
      skillsDir: '/repo/skills',
      designSystemsDir: '/repo/design-systems',
      linkedDirs: ['/linked/reference'],
      codexGeneratedImagesDir: null,
      existsSync: () => true,
    });

    expect(dirs).toEqual([]);
  });

  it('omits the Codex override when validation fails or the dir is not granted', () => {
    const metadata = { kind: 'image', imageModel: 'gpt-image-2' };
    const root = mkdtempSync(join(tmpdir(), 'od-codex-generated-prompt-'));
    try {
      const codexHome = join(root, 'codex-home');
      const symlinkTarget = join(root, 'actual-generated-images');
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(symlinkTarget, { recursive: true });
      symlinkDir(symlinkTarget, join(codexHome, 'generated_images'));

      const generatedImagesDir = resolveCodexGeneratedImagesDir(
        'codex',
        metadata,
        { CODEX_HOME: codexHome },
        '/home/tester',
      );
      const validatedDir = validateCodexGeneratedImagesDir(
        generatedImagesDir,
        { warn: () => undefined },
      );
      const extraAllowedDirs = resolveChatExtraAllowedDirs({
        agentId: 'codex',
        skillsDir: '/repo/skills',
        designSystemsDir: '/repo/design-systems',
        linkedDirs: ['/linked/reference'],
        codexGeneratedImagesDir: validatedDir,
        existsSync: () => true,
      });
      const validationFailedOverride = resolveGrantedCodexImagegenOverride({
        agentId: 'codex',
        metadata,
        codexGeneratedImagesDir: validatedDir,
        extraAllowedDirs,
      });
      const validationFailedPrompt = composeLiveInstructionPrompt({
        daemonSystemPrompt: 'daemon prompt',
        runtimeToolPrompt: 'runtime tools',
        clientSystemPrompt: 'client media contract',
        finalPromptOverride: validationFailedOverride,
      });

      expect(validatedDir).toBeNull();
      expect(extraAllowedDirs).toEqual([]);
      expect(validationFailedOverride).toBeNull();
      expect(validationFailedPrompt).not.toContain(
        '## Codex built-in imagegen override',
      );

      const validDir = join(root, 'safe-codex-home', 'generated_images');
      mkdirSync(validDir, { recursive: true });
      const notGrantedOverride = resolveGrantedCodexImagegenOverride({
        agentId: 'codex',
        metadata,
        codexGeneratedImagesDir: validDir,
        extraAllowedDirs: [],
      });

      expect(notGrantedOverride).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
