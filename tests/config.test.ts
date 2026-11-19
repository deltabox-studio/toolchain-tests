import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import {
    ConfigParseError,
    collectDefinitions,
    createConfigFile,
    loadConfig,
    loadConfigAsync,
    loadConfigSync,
    parseCliConfig,
    parseConfig,
    parseEnvConfig,
} from '@deltabox/toolchain/config';

const schema = z.object({
    base: z.object({
        host: z.string().default('localhost').meta({ envName: 'APP_HOST' }),
        port: z.number().default(8080).meta({ envName: 'APP_PORT' }),
        debug: z.boolean().default(false).meta({ envName: 'APP_DEBUG' }),
        tags: z.array(z.string()).default([]).meta({ envName: 'APP_TAGS' }),
        token: z.string().optional().meta({ envName: 'APP_TOKEN', secret: true }),
    }),
});

const cliSchema = z.object({
    base: z.object({
        host: z.string().meta({ envName: 'APP_HOST', cliFlag: '--host' }),
        port: z.number().meta({ envName: 'APP_PORT', cliFlag: '--port' }),
        debug: z.boolean().meta({ envName: 'APP_DEBUG', cliFlag: '--debug' }),
        tags: z.array(z.string()).default([]).meta({ envName: 'APP_TAGS', cliFlag: '--tag' }),
    }),
});

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-harness-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('config consumer flow', () => {
    it('loads, validates and parses a real config file', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'dbx.config.json'), '{"base":{"port":3000}}');
        const scaffolded = createConfigFile({ cwd, name: 'scaffold.ts' });
        expect(fs.existsSync(scaffolded)).toBe(true);
        const loaded = await loadConfig<{ base: { port: number } }>({
            cwd,
            names: ['dbx.config.json'],
        });
        expect(loaded?.source).toBe('file');
        const parsed = parseConfig(
            z.object({ base: z.object({ port: z.number() }) }),
            loaded?.config as Record<string, any>
        );
        expect(parsed.base.port).toBe(3000);
    });

    it('builds an env config with coercion, lists and defaults', () => {
        const config = parseEnvConfig(schema, {
            APP_PORT: '3000',
            APP_DEBUG: 'yes',
            APP_TAGS: 'x, y',
        });
        expect(config.base).toEqual({
            host: 'localhost',
            port: 3000,
            debug: true,
            tags: ['x', 'y'],
            token: undefined,
        });
    });

    it('parses CLI flags in every supported form', () => {
        expect(
            parseCliConfig(cliSchema, [
                '--host',
                'example.com',
                '--port=4000',
                '--debug',
                '--tag',
                'a',
                '--tag',
                'b',
            ]).base
        ).toEqual({ host: 'example.com', port: 4000, debug: true, tags: ['a', 'b'] });
    });
});

describe('variations', () => {
    it('honours a custom env prefix', () => {
        const prefixed = z.object({
            base: z.object({
                host: z.string().meta({ envName: 'MYAPP_HOST', envPath: 'base.host' }),
            }),
        });
        const config = parseEnvConfig(prefixed, { MYAPP_HOST: 'prefixed' }, {
            envPrefix: 'MYAPP_',
        });
        expect(config.base.host).toBe('prefixed');
    });

    it('supports a null env prefix (unprefixed vars)', () => {
        const config = parseEnvConfig(schema, { APP_HOST: 'bare' }, { envPrefix: null });
        expect(config.base.host).toBe('bare');
    });

    it('reads a package.json key', async () => {
        const cwd = tempDir();
        fs.writeFileSync(
            path.join(cwd, 'package.json'),
            JSON.stringify({ toolchain: { base: { host: 'pkg' } } })
        );
        const loaded = await loadConfig<{ base: { host: string } }>({
            cwd,
            names: [],
            packageJsonKeys: ['toolchain'],
        });
        expect(loaded?.source).toBe('package.json');
        expect(loaded?.config.base.host).toBe('pkg');
    });

    it('uses a custom loader for unsupported extensions', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'dbx.config.yaml'), 'ignored: true');
        const loaded = await loadConfigAsync({
            cwd,
            names: ['dbx.config.yaml'],
            loader: () => ({ from: 'yaml' }),
        });
        expect(loaded?.config).toEqual({ from: 'yaml' });
    });

    it('limits collection with maxDepth and filters', () => {
        expect(collectDefinitions(schema, { maxDepth: 1 })).toEqual([]);
        const filtered = collectDefinitions(schema, {
            include: 'base.host',
            exclude: def => def.path.endsWith('tags'),
        });
        expect(filtered.map(def => def.path)).toEqual(['base.host']);
    });
});

describe('edge cases', () => {
    it('returns undefined for a missing optional config', async () => {
        await expect(loadConfig({ cwd: tempDir() })).resolves.toBeUndefined();
    });

    it('throws for a missing required config', async () => {
        await expect(loadConfig({ cwd: tempDir(), required: true })).rejects.toThrow(
            /No config file found/
        );
    });

    it('ignores a malformed package.json', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'package.json'), '{ nope');
        await expect(
            loadConfig({ cwd, names: [], packageJsonKeys: ['toolchain'] })
        ).resolves.toBeUndefined();
    });

    it('rejects a synchronous TypeScript config', () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'dbx.config.ts'), 'export default {};');
        expect(() => loadConfigSync({ cwd })).toThrow(/TypeScript config synchronously/);
    });

    it('fails schema validation with a ConfigParseError', () => {
        expect(() => parseConfig(z.object({ port: z.number() }), { port: 'x' })).toThrow(
            ConfigParseError
        );
        try {
            parseConfig(z.object({ port: z.number() }), {});
        } catch (error) {
            expect((error as ConfigParseError).issues).toHaveLength(1);
        }
    });

    it('does not overwrite an existing scaffolded config', () => {
        const cwd = tempDir();
        createConfigFile({ cwd, name: 'custom.ts' });
        expect(() => createConfigFile({ cwd, name: 'custom.ts' })).toThrow(/already exists/);
        expect(() => createConfigFile({ cwd, name: 'custom.ts', overwrite: true })).not.toThrow();
    });

    it('keeps secret defaults out of parsed env configs', () => {
        const config = parseEnvConfig(schema, {});
        expect(config.base.token).toBeUndefined();
    });

    it('rejects an env value that fails coercion', () => {
        expect(() => parseEnvConfig(schema, { APP_PORT: 'nope' })).toThrow(ConfigParseError);
    });
});
