import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
    detectMigrations,
    findBiomeConfig,
    findMigration,
    listMigrations,
    readJsonc,
    runMigration,
    stripJsonc,
} from '@deltabox/toolchain/migrate';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-migrate-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('JSONC helpers', () => {
    it('strips line and block comments', () => {
        expect(stripJsonc('{\n // x\n "a": 1 /* y */\n}')).toContain('"a": 1');
        expect(stripJsonc('{\n // x\n "a": 1\n}')).not.toContain('// x');
    });

    it('keeps comment-like text inside strings', () => {
        const parsed = JSON.parse(stripJsonc('{"url":"https://example.com//x","b":"/*n*/"}'));
        expect(parsed.url).toBe('https://example.com//x');
        expect(parsed.b).toBe('/*n*/');
    });

    it('removes trailing commas', () => {
        expect(() => JSON.parse(stripJsonc('{"a":1,}'))).not.toThrow();
    });

    it('reads a BOM JSONC file', () => {
        const dir = tempDir();
        const file = path.join(dir, 'biome.jsonc');
        fs.writeFileSync(file, '\uFEFF{\n "a": 1, // x\n}');
        expect(readJsonc(file)).toEqual({ a: 1 });
    });
});

describe('migration registry', () => {
    it('lists and finds migrations', () => {
        const ids = listMigrations(tempDir()).map(info => info.id);
        expect(ids).toContain('biome-to-oxc');
        expect(findMigration('biome')?.id).toBe('biome-to-oxc');
        expect(findMigration('missing')).toBeUndefined();
    });

    it('detects only present source configs', () => {
        const empty = tempDir();
        expect(detectMigrations(empty)).toEqual([]);
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'biome.json'), '{}');
        expect(detectMigrations(dir).map(migration => migration.id)).toContain('biome-to-oxc');
    });

    it('prefers biome.json over biome.jsonc', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'biome.json'), '{}');
        fs.writeFileSync(path.join(dir, 'biome.jsonc'), '{}');
        expect(findBiomeConfig(dir)).toBe(path.join(dir, 'biome.json'));
    });

    it('runs the Biome migration in dry-run mode', async () => {
        const dir = tempDir();
        fs.writeFileSync(
            path.join(dir, 'biome.json'),
            JSON.stringify({
                formatter: { indentStyle: 'space', indentWidth: 2, lineWidth: 90 },
                organizeImports: { enabled: true },
                linter: { enabled: true, rules: { recommended: true } },
            })
        );
        const result = await runMigration('biome', { cwd: dir });
        expect(result.id).toBe('biome-to-oxc');
        expect(result.files?.length).toBeGreaterThan(0);
        expect(result.oxfmt).toBeDefined();
        expect(fs.existsSync(path.join(dir, '.oxfmtrc.json'))).toBe(false);
    });

    it('writes the migrated files when requested', async () => {
        const dir = tempDir();
        fs.writeFileSync(
            path.join(dir, 'biome.json'),
            JSON.stringify({ formatter: { indentWidth: 2 } })
        );
        const result = await runMigration('biome', { cwd: dir, write: true });
        expect(result.written.length).toBeGreaterThan(0);
        for (const file of result.written) expect(fs.existsSync(file)).toBe(true);
    });

    it('rejects an unknown migration', async () => {
        await expect(runMigration('nope', { cwd: tempDir() })).rejects.toThrow(/Unknown migration/);
    });
});
