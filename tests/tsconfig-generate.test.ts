import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
    generateTsconfigs,
} from '@deltabox/toolchain/tsconfig';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-tsconfig-gen-'));
    dirs.push(dir);
    return dir;
}

function write(dir: string, name: string, value: unknown): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 4));
    return file;
}

function readJson(file: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function monorepo(): string {
    const cwd = tempDir();
    write(cwd, 'package.json', '{"name":"root","private":true}');
    write(cwd, 'tsconfig.base.json', '{"compilerOptions":{"target":"ES2022"}}');
    write(cwd, 'tsconfig.workspaces.json', {
        extends: './tsconfig.base.json',
        compilerOptions: {
            declaration: true,
            composite: true,
            paths: {
                '@acme/a': ['./packages/a/src/index.ts'],
                '@acme/b': ['./packages/b/src/index.ts'],
            },
        },
        references: [{ path: './packages/a' }, { path: './packages/b' }],
    });
    write(cwd, 'packages/a/tsconfig.default.json', {
        compilerOptions: { rootDir: 'src' },
        include: ['src'],
    });
    write(cwd, 'packages/b/tsconfig.default.json', {
        compilerOptions: { rootDir: 'src' },
        include: ['src'],
        exclude: ['src/**/*.test.ts'],
    });
    write(cwd, 'packages/a/src/index.ts', 'export const a = 1;\n');
    write(cwd, 'packages/b/src/index.ts', 'export const b = 1;\n');
    return cwd;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('tsconfig generation', () => {
    it('generates every workspace tsconfig with aliases and references', () => {
        const cwd = monorepo();
        const results = generateTsconfigs({
            cwd,
            aliases: true,
            refs: true,
            composite: true,
            log: false,
        });
        expect(results).toHaveLength(2);

        const a = readJson(path.join(cwd, 'packages', 'a', 'tsconfig.json'));
        expect(a.extends).toBe('./tsconfig.default.json');
        expect(a.compilerOptions.composite).toBe(true);
        expect(a.compilerOptions.declaration).toBe(true);
        expect(a.include).toEqual(['src']);
        // A workspace never aliases its own source, only its siblings.
        expect(a.compilerOptions.paths).toEqual({ '@acme/b': ['../b/src/index.ts'] });
        expect(a.references).toEqual([{ path: '../b' }]);

        const b = readJson(path.join(cwd, 'packages', 'b', 'tsconfig.json'));
        expect(b.exclude).toEqual(['src/**/*.test.ts']);
        expect(b.compilerOptions.paths).toEqual({ '@acme/a': ['../a/src/index.ts'] });
    });

    it('writes nothing in a dry run', () => {
        const cwd = monorepo();
        const results = generateTsconfigs({ cwd, write: false, log: false });
        expect(results).toHaveLength(2);
        expect(fs.existsSync(path.join(cwd, 'packages', 'a', 'tsconfig.json'))).toBe(false);
        expect(results[0]?.config.extends).toBe('./tsconfig.default.json');
    });

    it('can omit aliases, references and composite independently', () => {
        const cwd = monorepo();
        generateTsconfigs({ cwd, aliases: false, refs: false, composite: false, log: false });
        const a = readJson(path.join(cwd, 'packages', 'a', 'tsconfig.json'));
        expect(a.compilerOptions.paths).toBeUndefined();
        expect(a.references).toBeUndefined();
        expect(a.compilerOptions.composite).toBe(false);
    });

    it('keeps the workspaces compiler options but never its root fields', () => {
        const cwd = monorepo();
        const root = readJson(path.join(cwd, 'tsconfig.workspaces.json'));
        root.include = ['packages/*/src'];
        write(cwd, 'tsconfig.workspaces.json', root);
        generateTsconfigs({ cwd, refs: true, log: false });
        const a = readJson(path.join(cwd, 'packages', 'a', 'tsconfig.json'));
        expect(a.include).toEqual(['src']);
        expect(a.compilerOptions.declaration).toBe(true);
    });

    it('applies managed overrides over the generated settings', () => {
        const cwd = monorepo();
        generateTsconfigs({
            cwd,
            refs: true,
            log: false,
            overrides: {
                root: { compilerOptions: { target: 'ES2023' } },
                default: { compilerOptions: { strict: true } },
            },
        });
        const a = readJson(path.join(cwd, 'packages', 'a', 'tsconfig.json'));
        // The root override reaches the workspaces compiler options.
        expect(a.compilerOptions.target).toBe('ES2023');
        // The default override is read for inherited fields, not inlined.
        expect(a.compilerOptions.strict).toBeUndefined();
        expect(a.compilerOptions.declaration).toBe(true);
    });

    it('hoists include/exclude inherited from a base config', () => {
        const cwd = tempDir();
        write(cwd, 'tsconfig.workspaces.json', '{}');
        write(cwd, 'packages/a/tsconfig.base.json', {
            include: ['../shared/**/*.ts'],
            exclude: ['dist'],
        });
        write(cwd, 'packages/a/tsconfig.default.json', { extends: './tsconfig.base.json' });
        generateTsconfigs({ cwd, log: false });
        const a = readJson(path.join(cwd, 'packages/a/tsconfig.json'));
        expect(a.include).toEqual(['../shared/**/*.ts']);
        expect(a.exclude).toEqual(['dist']);
    });

    it('fails on a missing or malformed extends chain', () => {
        const cwd = tempDir();
        write(cwd, 'tsconfig.workspaces.json', '{}');
        write(cwd, 'packages/a/tsconfig.default.json', { extends: './missing.json' });
        expect(() => generateTsconfigs({ cwd, log: false })).toThrow(/Cannot resolve tsconfig "extends"/);

        write(cwd, 'packages/a/missing.json', '{ not json');
        expect(() => generateTsconfigs({ cwd, log: false })).toThrow(/Cannot parse tsconfig/);
    });

    it('supports an in-memory workspaces config and explicit overrides', () => {
        const cwd = tempDir();
        write(cwd, 'packages/a/tsconfig.default.json', '{}');
        const results = generateTsconfigs({
            cwd,
            log: false,
            monorepoConfig: {
                compilerOptions: { paths: { '@lib/*': ['./packages/a/src/*'] } },
            },
        });
        expect(results).toHaveLength(1);
        const config = results[0]!.config;
        expect(config.extends).toBe('./tsconfig.default.json');
        expect(config.compilerOptions?.target).toBeUndefined();
        // A workspace never aliases its own source, even from an in-memory root.
        expect(config.compilerOptions?.paths).toBeUndefined();
    });

    it('exposes the single-workspace generator directly', () => {
        const cwd = monorepo();
        const results = generateTsconfigs({
            cwd,
            refs: true,
            composite: true,
            write: false,
            log: false,
        });
        expect(results).toHaveLength(2);
        const a = results.find(result => result.dirnameRelative === 'packages/a')!;
        expect(a.config.references).toEqual([{ path: '../b' }]);
        expect(a.config.compilerOptions?.composite).toBe(true);
    });
});
