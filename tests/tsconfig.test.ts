import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { resolveTsconfig, resolveTsconfigConfig } from '@deltabox/toolchain/tsconfig';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-tsconfig-'));
    dirs.push(dir);
    return dir;
}
function write(dir: string, name: string, value: unknown): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('tsconfig resolution', () => {
    it('resolves paths aliases and references', () => {
        const dir = tempDir();
        write(dir, 'tsconfig.json', {
            compilerOptions: { baseUrl: '.', outDir: 'dist', paths: { '@/*': ['src/*'] } },
            references: [{ path: './packages/lib' }],
        });
        const resolved = resolveTsconfig({ cwd: dir });
        expect(resolved.paths['@/*']?.[0]).toBe(path.join(dir, 'src', '*'));
        expect(resolved.references[0]?.path).toBe(path.join(dir, 'packages', 'lib'));
        expect(resolved.alias).toHaveLength(1);
    });

    it('returns relative paths when requested', () => {
        const dir = tempDir();
        write(dir, 'tsconfig.json', {
            compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
            references: [{ path: './lib' }],
        });
        const resolved = resolveTsconfig({ cwd: dir, relativePaths: true });
        expect(resolved.paths['@/*']?.[0]?.startsWith('..')).toBe(false);
        expect(resolved.references[0]?.path).not.toBe(path.join(dir, 'lib'));
    });

    it('follows extends chains and can disable them', () => {
        const dir = tempDir();
        write(dir, 'base.json', {
            compilerOptions: { paths: { '#/*': ['shared/*'] } },
        });
        write(dir, 'tsconfig.json', { extends: './base.json' });
        expect(resolveTsconfig({ cwd: dir }).paths['#/*']).toBeDefined();
        expect(resolveTsconfig({ cwd: dir, extends: false }).paths['#/*']).toBeUndefined();
    });

    it('resolves an explicit tsconfig file', () => {
        const dir = tempDir();
        write(dir, 'configs/custom.json', {
            compilerOptions: { paths: { '~/*': ['app/*'] } },
        });
        const resolved = resolveTsconfig({ cwd: dir, tsconfig: 'configs/custom.json' });
        expect(resolved.paths['~/*']).toBeDefined();
    });

    it('resolves a config object directly', () => {
        const dir = tempDir();
        const resolved = resolveTsconfigConfig(
            { compilerOptions: { paths: { '@/*': ['src/*'] } } },
            dir
        );
        expect(resolved.paths['@/*']?.[0]).toContain('src');
    });

    it('throws for a missing tsconfig', () => {
        expect(() => resolveTsconfig({ cwd: tempDir() })).toThrow();
    });

    it('keeps strict aliases as regex-capable patterns', () => {
        const dir = tempDir();
        write(dir, 'tsconfig.json', {
            compilerOptions: { paths: { '@exact': ['src/exact.ts'] } },
        });
        const resolved = resolveTsconfig({ cwd: dir, strict: false });
        expect(resolved.alias[0]?.find).toBe('@exact');
    });
});
