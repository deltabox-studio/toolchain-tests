import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { biomeSyncTask } from '@deltabox/toolchain/biome';
import { resolveWatchGlobs, resolveWatchInputFiles, runSync, selectSyncTasks } from '@deltabox/toolchain/core';
import { defaultSyncTasks } from '@deltabox/toolchain';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-sync-'));
    dirs.push(dir);
    return dir;
}

function write(dir: string, name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function readJson(file: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function project(): string {
    const cwd = tempDir();
    write(cwd, 'package.json', '{"name":"app","version":"1.0.0"}');
    return cwd;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('sync task selection', () => {
    it('selects tasks by name and rejects unknown names', () => {
        const tasks = defaultSyncTasks();
        expect(tasks.length).toBeGreaterThan(5);
        expect(selectSyncTasks(tasks, ['biome']).map(task => task.name)).toEqual(['biome']);
        expect(() => selectSyncTasks(tasks, ['nope'])).toThrow(/unknown sync task/);
    });
});

describe('sync runner', () => {
    const tasks = () => [biomeSyncTask()];
    const config = { biome: true } as const;

    it('writes managed files and records them in the manifest', async () => {
        const cwd = project();
        write(cwd, '.gitignore', 'node_modules\n');
        const result = await runSync({
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        expect(result.upToDate).toBe(false);
        expect(result.written).toContain('biome.json');
        expect(fs.existsSync(path.join(cwd, 'biome.json'))).toBe(true);
        const manifest = readJson(path.join(cwd, '.dbx', 'toolchain', 'manifest.json'));
        expect(manifest.files).toContain('biome.json');
        expect(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toContain('**/.dbx/*');
    });

    it('reports an up-to-date tree on the next run', async () => {
        const cwd = project();
        const options = {
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project' as const,
            quiet: true,
        };
        await runSync(options);
        const second = await runSync(options);
        expect(second.upToDate).toBe(true);
        expect(second.changed).toEqual([]);
    });

    it('reports drift in check mode without writing', async () => {
        const cwd = project();
        const options = {
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project' as const,
            quiet: true,
        };
        await runSync(options);
        write(cwd, 'biome.json', '{"hand":"edited"}\n');
        const check = await runSync({ ...options, check: true });
        expect(check.upToDate).toBe(false);
        expect(check.changed).toContain('biome.json');
        expect(check.written).toEqual([]);
        expect(fs.readFileSync(path.join(cwd, 'biome.json'), 'utf8')).toBe('{"hand":"edited"}\n');
    });

    it('regenerates when the config changes', async () => {
        const cwd = project();
        await runSync({
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        const check = await runSync({
            tasks: tasks(),
            cwd,
            config: { biome: { overrides: { formatter: { indentWidth: 2 } } } },
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
            check: true,
        });
        expect(check.changed).toContain('biome.json');
    });

    it('does nothing when the toolchain is disabled', async () => {
        const cwd = project();
        const result = await runSync({
            tasks: tasks(),
            cwd,
            config: { enabled: false },
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        expect(result.upToDate).toBe(true);
        expect(fs.existsSync(path.join(cwd, 'biome.json'))).toBe(false);
    });

    it('prunes files that are no longer generated', async () => {
        const cwd = project();
        await runSync({
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        const pruned = await runSync({
            tasks: [],
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        expect(pruned.removed).toContain('biome.json');
        expect(fs.existsSync(path.join(cwd, 'biome.json'))).toBe(false);
        expect(pruned.removedFiles[0]?.content).toContain('"formatter"');
    });

    it('supports custom tasks and their watch inputs', async () => {
        const cwd = project();
        const task = {
            name: 'custom',
            enabled: () => true,
            run: () => [{ path: 'custom.txt', content: 'hello\n' }],
            watch: () => ['custom.txt', 'input.json'],
        };
        const result = await runSync({
            tasks: [task],
            cwd,
            config: {},
            tokens: {},
            projectType: 'project',
            quiet: true,
        });
        expect(result.written).toEqual(['custom.txt']);
        expect(fs.readFileSync(path.join(cwd, 'custom.txt'), 'utf8')).toBe('hello\n');
        expect(resolveWatchGlobs([task], {}, 'project')).toEqual(['custom.txt', 'input.json']);
    });

    it('does not prune when only a subset runs', async () => {
        const cwd = project();
        await runSync({
            tasks: tasks(),
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        const subset = await runSync({
            tasks: tasks(),
            only: ['biome'],
            cwd,
            config,
            tokens: { name: 'app' },
            projectType: 'project',
            quiet: true,
        });
        expect(subset.removed).toEqual([]);
        expect(fs.existsSync(path.join(cwd, 'biome.json'))).toBe(true);
    });
});

describe('watch inputs', () => {
    it('filters disabled tasks and other project types', () => {
        const tasks = [
            { name: 'on', enabled: () => true, run: () => [], watch: ['a.txt'] },
            { name: 'off', enabled: () => false, run: () => [], watch: ['b.txt'] },
            {
                name: 'scoped',
                enabled: () => true,
                projectTypes: ['monorepo-root' as const],
                run: () => [],
                watch: ['c.txt'],
            },
        ];
        expect(resolveWatchGlobs(tasks, {}, 'project')).toEqual(['a.txt']);
        expect(resolveWatchGlobs(tasks, {}, 'monorepo-root')).toEqual(['a.txt', 'c.txt']);
    });

    it('honours explicit user globs and rejects unsafe ones', async () => {
        const cwd = project();
        const resolved = await resolveWatchInputFiles({
            cwd,
            config: {},
            userGlobs: ['src/*.ts', '../outside', '/abs/path', 'C:/windows', 'a/../b'],
        });
        expect(resolved.globs).toEqual(['src/*.ts', 'a/../b'].filter(glob => glob === 'src/*.ts'));
    });

    it('resolves concrete config and tsconfig inputs from the project', async () => {
        const cwd = project();
        write(cwd, 'dbx.config.ts', 'export default {};\n');
        write(cwd, 'tsconfig.workspaces.json', '{}');
        const resolved = await resolveWatchInputFiles({
            cwd,
            config: { tsconfig: true },
            projectType: 'project',
            tasks: [biomeSyncTask()],
        });
        expect(resolved.globs).toContain('dbx.config.ts');
        expect(resolved.globs).toContain('tsconfig.workspaces.json');
        expect(resolved.configs).toContain('dbx.config.ts');
    });

    it('returns the configured tsconfig file names', async () => {
        const cwd = project();
        const resolved = await resolveWatchInputFiles({
            cwd,
            config: {
                tsconfig: {
                    defaultFile: 'tsconfig.lib.json',
                    buildFile: 'tsconfig.release.json',
                },
            },
            projectType: 'project',
        });
        expect(resolved.tsconfig.defaultFile).toBe('tsconfig.lib.json');
        expect(resolved.tsconfig.buildFile).toBe('tsconfig.release.json');
    });
});
