import { describe, expect, it } from 'vite-plus/test';

import {
    defaultPackageManagerVersion,
    regenerateEnabled,
    repoSlugFromUrl,
    resolveChangelogBranches,
    resolveCommitlintEnabled,
    resolveFmtTool,
    resolveFmtTools,
    resolveLintTool,
    resolveLintTools,
    resolveTokens,
    resolveToolchainEnabled,
    sectionConfig,
    sectionEnabled,
} from '@deltabox/toolchain';

describe('toolchain enabled', () => {
    it('normalizes every supported value', () => {
        expect(resolveToolchainEnabled(undefined)).toEqual({
            enabled: true,
            scope: 'workspace',
        });
        expect(resolveToolchainEnabled({})).toEqual({ enabled: true, scope: 'workspace' });
        expect(resolveToolchainEnabled({ enabled: false })).toEqual({
            enabled: false,
            scope: 'workspace',
        });
        expect(resolveToolchainEnabled({ enabled: { disabled: true, scope: 'global' } })).toEqual({
            enabled: false,
            scope: 'global',
        });
        expect(resolveToolchainEnabled({ enabled: { scope: 'workspace' } }).enabled).toBe(true);
    });
});

describe('section helpers', () => {
    it('treats sections as opt-in by presence', () => {
        expect(sectionEnabled(undefined)).toBe(false);
        expect(sectionEnabled(false)).toBe(false);
        expect(sectionEnabled(true)).toBe(true);
        expect(sectionEnabled({})).toBe(true);
        expect(sectionEnabled({ enabled: false })).toBe(false);
        expect(sectionConfig({ a: 1 })).toEqual({ a: 1 });
        expect(sectionConfig(true)).toBeUndefined();
        expect(sectionConfig(undefined)).toBeUndefined();
    });

    it('gates regeneration on the enabled flag', () => {
        expect(regenerateEnabled(undefined)).toBe(false);
        expect(regenerateEnabled(true)).toBe(true);
        expect(regenerateEnabled({ regenerate: false })).toBe(false);
        expect(regenerateEnabled({ enabled: false })).toBe(false);
    });
});

describe('token resolution', () => {
    it('renders sensible defaults for a bare config', () => {
        const tokens = resolveTokens({});
        expect(tokens.name).toBe('app');
        expect(tokens.packageManager).toBe('yarn');
        expect(tokens.packageManagerVersion).toBe('4.17.1');
        expect(tokens.mainBranch).toBe('main');
        expect(tokens.devBranch).toBe('main');
        expect(tokens.license).toBe('MIT');
    });

    it('uses the project and branch settings', () => {
        const tokens = resolveTokens({
            project: {
                name: 'acme',
                scope: '@acme',
                repo: 'https://github.com/acme/acme.git',
                packageManager: 'pnpm',
                packageManagerVersion: '10.0.0',
            },
            ci: { changelog: { branches: { main: 'main', dev: 'dev' } } },
        });
        expect(tokens.name).toBe('acme');
        expect(tokens.scope).toBe('@acme');
        expect(tokens.repoSlug).toBe('acme/acme');
        expect(tokens.packageManagerVersion).toBe('10.0.0');
        expect(tokens.mainBranch).toBe('main');
        expect(tokens.devBranch).toBe('dev');
    });

    it('falls back to the branch default and reuses main for dev', () => {
        expect(resolveChangelogBranches()).toEqual({ main: ['main'], dev: ['main'] });
        expect(resolveChangelogBranches({ branches: { dev: ['develop'] } })).toEqual({
            main: ['main'],
            dev: ['develop'],
        });
        expect(resolveChangelogBranches({ branches: { main: ['trunk', 'main'] } })).toEqual({
            main: ['trunk', 'main'],
            dev: ['trunk', 'main'],
        });
    });

    it('resolves the package-manager default version', () => {
        expect(defaultPackageManagerVersion('npm')).toBeDefined();
        expect(defaultPackageManagerVersion('unknown')).toBeUndefined();
    });

    it('derives a GitHub slug and ignores other hosts', () => {
        expect(repoSlugFromUrl('https://github.com/a/b.git')).toBe('a/b');
        expect(repoSlugFromUrl('git@github.com:a/b.git')).toBe('a/b');
        expect(repoSlugFromUrl('https://gitlab.com/a/b')).toBeUndefined();
        expect(repoSlugFromUrl(undefined)).toBeUndefined();
    });
});

describe('tool precedence', () => {
    it('resolves formatters and linters in precedence order', () => {
        expect(resolveFmtTools({})).toEqual([]);
        expect(resolveFmtTools({ fmt: { biome: true, prettier: true } })).toEqual([
            'biome',
            'prettier',
        ]);
        expect(resolveFmtTool({ fmt: { dprint: true, oxc: true } })).toBe('oxc');
        expect(resolveLintTools({ lint: { eslint: true, biome: true } })).toEqual([
            'biome',
            'eslint',
        ]);
        expect(resolveLintTool({ lint: { eslint: true } })).toBe('eslint');
    });

    it('treats the Vite section as Oxc', () => {
        expect(resolveFmtTools({ vite: { fmt: true } })).toEqual(['oxc']);
        expect(resolveLintTools({ vite: { lint: true } })).toEqual(['oxc']);
    });

    it('respects an explicit false', () => {
        expect(resolveFmtTools({ fmt: { oxc: false, biome: true } })).toEqual(['biome']);
        expect(resolveLintTools({ lint: { biome: false } })).toEqual([]);
    });
});

describe('commitlint defaults', () => {
    it('defaults on and respects explicit disables', () => {
        expect(resolveCommitlintEnabled()).toBe(true);
        expect(resolveCommitlintEnabled({})).toBe(true);
        expect(resolveCommitlintEnabled({ commitlint: false })).toBe(false);
        expect(resolveCommitlintEnabled({ commitlint: { enabled: false } })).toBe(false);
        expect(resolveCommitlintEnabled({ commitlint: {} })).toBe(true);
    });
});
