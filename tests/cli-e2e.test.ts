import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const HARNESS = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOOLCHAIN = path.resolve(HARNESS, '..', 'toolchain');
const TSX = path.join(HARNESS, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join(TOOLCHAIN, 'src', 'cli', 'index.ts');
const TSCONFIG = path.join(TOOLCHAIN, 'tsconfig.json');

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-cli-'));
    dirs.push(dir);
    return dir;
}

function write(dir: string, name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function runDbx(
    cwd: string,
    args: string[]
): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [TSX, CLI, ...args, '--no-update-check'], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            TSX_TSCONFIG_PATH: TSCONFIG,
            NO_COLOR: '1',
            CI: '1',
            TERM: 'dumb',
            DBX_NO_GH: '1',
        },
        timeout: 60_000,
    });
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

function json(stdout: string): any {
    const start = Math.min(
        ...['{', '[']
            .map(char => stdout.indexOf(char))
            .filter(index => index >= 0)
    );
    return JSON.parse(stdout.slice(start));
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('dbx CLI end to end', () => {
    it('prints the version and help', () => {
        const cwd = tempDir();
        const version = runDbx(cwd, ['--version']);
        expect(version.code).toBe(0);
        expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

        const help = runDbx(cwd, ['--help']);
        expect(help.code).toBe(0);
        for (const command of ['sync', 'tsconfig', 'changelog', 'mcp:serve', 'template:list']) {
            expect(help.stdout).toContain(command);
        }
    });

    it('discovers a monorepo project graph as JSON', () => {
        const cwd = tempDir();
        write(
            cwd,
            'package.json',
            JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] })
        );
        write(cwd, 'packages/a/package.json', JSON.stringify({ name: '@acme/a' }));
        write(cwd, 'packages/b/package.json', JSON.stringify({ name: '@acme/b' }));
        write(cwd, 'dbx.config.ts', 'export default { toolchain: { project: { type: "monorepo-root" } } };\n');

        const result = runDbx(cwd, ['projects', '--json']);
        expect(result.code).toBe(0);
        const graph = json(result.stdout);
        expect(graph.projects.map((project: { dir: string }) => project.dir)).toEqual(
            expect.arrayContaining(['.', 'packages/a', 'packages/b'])
        );
        expect(graph.order.at(-1)).toBe('.');
    });

    it('rejects an invalid --max-depth without scanning', () => {
        const cwd = tempDir();
        const result = runDbx(cwd, ['projects', '--max-depth', 'abc']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('invalid --max-depth');
    });

    it('resolves tsconfig aliases as JSON', () => {
        const cwd = tempDir();
        write(cwd, 'package.json', JSON.stringify({ name: 'app' }));
        write(
            cwd,
            'tsconfig.json',
            JSON.stringify({
                compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
                references: [{ path: './packages/lib' }],
            })
        );
        const result = runDbx(cwd, ['tsconfig', '--json']);
        expect(result.code).toBe(0);
        const resolved = json(result.stdout);
        expect(resolved.paths['@/*'][0]).toContain('src');
        expect(resolved.references[0].path).toContain('packages');
    });

    it('syncs managed files and reports drift with --check', () => {
        const cwd = tempDir();
        write(cwd, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
        write(
            cwd,
            'dbx.config.json',
            JSON.stringify({ toolchain: { project: { type: 'project' }, biome: true } })
        );

        const sync = runDbx(cwd, ['sync', '--json', '--no-format', '--only', 'biome']);
        expect(sync.code).toBe(0);
        const result = json(sync.stdout);
        expect(result.written).toContain('biome.json');
        expect(fs.existsSync(path.join(cwd, 'biome.json'))).toBe(true);

        const clean = runDbx(cwd, [
            'sync',
            '--check',
            '--json',
            '--no-format',
            '--only',
            'biome',
        ]);
        expect(clean.code).toBe(0);
        expect(json(clean.stdout).upToDate).toBe(true);

        write(cwd, 'biome.json', '{"edited":true}\n');
        const drift = runDbx(cwd, [
            'sync',
            '--check',
            '--json',
            '--no-format',
            '--only',
            'biome',
        ]);
        expect(drift.code).toBe(1);
        expect(json(drift.stdout).changed).toContain('biome.json');
    });

    it('emits a JSON envelope when the config cannot be loaded', () => {
        const cwd = tempDir();
        write(cwd, 'package.json', JSON.stringify({ name: 'app' }));
        write(cwd, 'dbx.config.json', '{ not json');
        const result = runDbx(cwd, ['sync', '--json']);
        expect(result.code).toBe(1);
        const envelope = json(result.stdout);
        expect(envelope).toMatchObject({ results: [], upToDate: false });
        expect(typeof envelope.error).toBe('string');
    });

    it('lists templates and installs an MCP provider', () => {
        const cwd = tempDir();
        write(cwd, 'package.json', JSON.stringify({ name: 'app' }));

        const templates = runDbx(cwd, ['template:list', '--json']);
        expect(templates.code).toBe(0);
        const list = json(templates.stdout);
        const entries = Array.isArray(list) ? list : (list.templates ?? list.sources);
        expect(JSON.stringify(entries)).toContain('project');

        const installed = runDbx(cwd, ['mcp:install', '--provider', 'claude', '--json']);
        expect(installed.code).toBe(0);
        expect(fs.existsSync(path.join(cwd, '.mcp.json'))).toBe(true);
        expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'deltabox', 'SKILL.md'))).toBe(
            true
        );
    });
});
