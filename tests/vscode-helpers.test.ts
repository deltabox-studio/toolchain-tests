import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { resolveEnabledState, toggleLabel } from '../../toolchain/packages/vscode/src/enabled.js';
import {
    collectManagedFiles,
    deepestProjectDir,
    isInsideDir,
    ManagedFileIndex,
} from '../../toolchain/packages/vscode/src/managed-files.js';
import { MANIFEST, readJson, readManifest } from '../../toolchain/packages/vscode/src/manifest.js';
import { SyncScheduler } from '../../toolchain/packages/vscode/src/sync-scheduler.js';
import {
    defaultWatchInputs,
    isSafeRelativeGlob,
    parseWatchInputs,
    planWatchTargets,
} from '../../toolchain/packages/vscode/src/watch-inputs.js';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-vscode-'));
    dirs.push(dir);
    return dir;
}

function writeManifest(dir: string, files: string[], extra?: Record<string, unknown>): void {
    const file = path.join(dir, MANIFEST);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ files, ...extra }, null, 4));
}

afterEach(() => {
    vi.useRealTimers();
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('manifest helpers', () => {
    it('reads a project manifest and tolerates a BOM', () => {
        const dir = tempDir();
        writeManifest(dir, ['biome.json', 'tsconfig.json']);
        expect(readManifest(dir)).toEqual({ files: ['biome.json', 'tsconfig.json'] });

        fs.writeFileSync(
            path.join(dir, MANIFEST),
            `\uFEFF${JSON.stringify({ files: ['a.json'], workflowConflicts: { '.github/ci.yml': 'ci' } })}`
        );
        expect(readManifest(dir)).toEqual({
            files: ['a.json'],
            workflowConflicts: { '.github/ci.yml': 'ci' },
        });
    });

    it('returns an empty manifest for a missing, malformed or non-object file', () => {
        const dir = tempDir();
        expect(readManifest(dir)).toEqual({ files: [] });
        fs.mkdirSync(path.dirname(path.join(dir, MANIFEST)), { recursive: true });
        fs.writeFileSync(path.join(dir, MANIFEST), 'not json');
        expect(readManifest(dir)).toEqual({ files: [] });
        fs.writeFileSync(path.join(dir, MANIFEST), '{"files":"nope"}');
        expect(readManifest(dir)).toEqual({ files: [] });
    });

    it('prefers the separate timestamps file over the legacy inline value', () => {
        const dir = tempDir();
        writeManifest(dir, ['a.json'], { syncedAt: '2020-01-01T00:00:00.000Z' });
        expect(readManifest(dir).syncedAt).toBe('2020-01-01T00:00:00.000Z');
        const timestamps = path.join(dir, '.dbx', 'toolchain', 'timestamps.json');
        fs.writeFileSync(timestamps, JSON.stringify({ syncedAt: '2026-02-02T00:00:00.000Z' }));
        expect(readManifest(dir).syncedAt).toBe('2026-02-02T00:00:00.000Z');
    });

    it('exposes a safe JSON reader', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'x.json'), '\uFEFF{"a":1}');
        expect(readJson(path.join(dir, 'x.json'))).toEqual({ a: 1 });
        expect(readJson(path.join(dir, 'missing.json'))).toBeUndefined();
    });
});

describe('managed-file index', () => {
    it('collects files from nested project manifests and deduplicates', () => {
        const root = tempDir();
        const child = path.join(root, 'packages', 'a');
        writeManifest(root, ['biome.json', 'packages/a/biome.json']);
        writeManifest(child, ['biome.json', 'tsconfig.json']);
        const files = collectManagedFiles([{ dir: root }, { dir: child }]);
        expect(files.sort()).toEqual(
            [
                path.join(root, 'biome.json'),
                path.join(child, 'biome.json'),
                path.join(child, 'tsconfig.json'),
            ].sort()
        );
    });

    it('refreshes the index and normalizes Windows case', () => {
        const root = tempDir();
        writeManifest(root, ['biome.json']);
        const index = new ManagedFileIndex();
        index.refresh([{ dir: root }]);
        expect(index.size).toBe(1);
        expect(index.has(path.join(root, 'biome.json'))).toBe(true);
        if (process.platform === 'win32') {
            expect(index.has(path.join(root, 'BIOME.JSON'))).toBe(true);
        }
        expect(index.has(path.join(root, 'other.json'))).toBe(false);
    });

    it('finds the deepest owning project', () => {
        const root = tempDir();
        const child = path.join(root, 'packages', 'a');
        const file = path.join(child, 'src', 'index.ts');
        expect(deepestProjectDir(file, [{ dir: root }, { dir: child }])).toBe(child);
        expect(deepestProjectDir(path.join(root, 'x.ts'), [{ dir: root }, { dir: child }])).toBe(
            root
        );
        expect(deepestProjectDir('/elsewhere/x.ts', [{ dir: root }])).toBeUndefined();
    });

    it('matches directory containment without prefix false-positives', () => {
        expect(isInsideDir(path.join('root', 'a', 'x.ts'), path.join('root', 'a'))).toBe(true);
        expect(isInsideDir(path.join('root', 'ab', 'x.ts'), path.join('root', 'a'))).toBe(false);
    });
});

describe('watch inputs', () => {
    it('parses the CLI report and falls back for missing names', () => {
        expect(parseWatchInputs('{"globs":["dbx.config.ts"]}')).toEqual({
            globs: ['dbx.config.ts'],
            tsconfig: {
                baseFile: 'tsconfig.base.json',
                rootFile: 'tsconfig.workspaces.json',
                defaultFile: 'tsconfig.default.json',
                buildFile: 'tsconfig.build.json',
            },
        });
        expect(parseWatchInputs('{"globs":["a"],"tsconfig":{"defaultFile":"tsconfig.lib.json"}}'))
            .toMatchObject({
                tsconfig: { defaultFile: 'tsconfig.lib.json' },
            });
        expect(parseWatchInputs('nope')).toBeUndefined();
        expect(parseWatchInputs('[]')).toBeUndefined();
        expect(parseWatchInputs('{"globs":"nope"}')).toBeUndefined();
    });

    it('returns the default fallback inputs', () => {
        const inputs = defaultWatchInputs();
        expect(inputs.globs).toContain('dbx.config.*');
        expect(inputs.tsconfig.rootFile).toBe('tsconfig.workspaces.json');
    });

    it('rejects absolute and ancestor globs', () => {
        expect(isSafeRelativeGlob('src/index.ts')).toBe(true);
        expect(isSafeRelativeGlob('..\\src')).toBe(false);
        expect(isSafeRelativeGlob('/abs')).toBe(false);
        expect(isSafeRelativeGlob('C:/abs')).toBe(false);
        expect(isSafeRelativeGlob('a/../b')).toBe(false);
    });

    it('plans scoped watchers for concrete nested inputs', () => {
        const root = '/repo';
        const targets = planWatchTargets(undefined, [
            {
                root,
                inputs: {
                    globs: ['dbx.config.ts', 'packages/a/tsconfig.default.json', '**/*.json'],
                    tsconfig: defaultWatchInputs().tsconfig,
                },
            },
        ]);
        expect(targets).toEqual([
            { glob: 'dbx.config.ts', base: root, root },
            {
                glob: 'tsconfig.default.json',
                base: path.join(root, 'packages', 'a'),
                root,
            },
            { glob: '**/*.json', base: root, root },
        ]);
    });

    it('keeps user globs unscoped and deduplicates them', () => {
        const targets = planWatchTargets(['src/*.ts', 'src/*.ts', '../x'], []);
        expect(targets).toEqual([{ glob: 'src/*.ts' }]);
    });

    it('does not collide when the same file exists in different roots', () => {
        const inputs = {
            globs: ['dbx.config.ts'],
            tsconfig: defaultWatchInputs().tsconfig,
        };
        const targets = planWatchTargets(undefined, [
            { root: '/a', inputs },
            { root: '/b', inputs },
        ]);
        expect(targets).toHaveLength(2);
    });
});

describe('enabled state', () => {
    it('lets the project config win over the VS Code setting', () => {
        expect(resolveEnabledState({ enabled: false }, { workspaceValue: true })).toEqual({
            enabled: false,
            globalEnabled: true,
            workspaceEnabled: true,
            source: 'config',
        });
        expect(
            resolveEnabledState({ enabled: { scope: 'workspace', disabled: true } }, undefined)
        ).toMatchObject({ enabled: false, source: 'config' });
    });

    it('falls back to the workspace setting and default', () => {
        expect(resolveEnabledState(undefined, { workspaceFolderValue: false })).toMatchObject({
            enabled: false,
            source: 'setting',
        });
        expect(resolveEnabledState(undefined, { workspaceValue: false })).toMatchObject({
            enabled: false,
            source: 'setting',
        });
        expect(resolveEnabledState(undefined, { globalValue: false })).toMatchObject({
            enabled: false,
            globalEnabled: false,
            source: 'setting',
        });
        expect(resolveEnabledState(undefined, {})).toEqual({
            enabled: true,
            globalEnabled: true,
            workspaceEnabled: true,
            source: 'default',
        });
    });

    it('labels the scope menus', () => {
        expect(toggleLabel('global', true)).toBe('Disable (global)');
        expect(toggleLabel('workspace', false)).toBe('Enable (workspace)');
    });
});

describe('sync scheduler', () => {
    it('debounces rapid changes into one run', async () => {
        vi.useFakeTimers();
        let runs = 0;
        const states: string[] = [];
        const scheduler = new SyncScheduler({
            debounceMs: 100,
            run: async () => {
                runs += 1;
            },
            onStateChange: state => states.push(state),
        });
        scheduler.notify();
        scheduler.notify();
        scheduler.notify();
        expect(states).toContain('queued');
        await vi.advanceTimersByTimeAsync(150);
        expect(runs).toBe(1);
        scheduler.dispose();
    });

    it('queues a single follow-up run during an in-flight sync', async () => {
        vi.useFakeTimers();
        let runs = 0;
        let release: (() => void) | undefined;
        const scheduler = new SyncScheduler({
            debounceMs: 10,
            run: async () => {
                runs += 1;
                await new Promise<void>(resolve => {
                    release = resolve;
                });
            },
        });
        scheduler.notify();
        await vi.advanceTimersByTimeAsync(15);
        expect(runs).toBe(1);
        scheduler.notify();
        scheduler.notify();
        release?.();
        await vi.advanceTimersByTimeAsync(200);
        expect(runs).toBe(2);
        scheduler.notify();
        await vi.advanceTimersByTimeAsync(5);
        scheduler.dispose();
    });

    it('suppresses events caused by its own writes', async () => {
        vi.useFakeTimers();
        let runs = 0;
        const states: string[] = [];
        const scheduler = new SyncScheduler({
            debounceMs: 10,
            run: async () => {
                runs += 1;
            },
            onStateChange: state => states.push(state),
        });
        await scheduler.runNow();
        scheduler.notify();
        expect(states.at(-1)).toBe('suppressed');
        await vi.advanceTimersByTimeAsync(100);
        expect(runs).toBe(1);
        scheduler.dispose();
    });

    it('never re-runs after disposal', async () => {
        vi.useFakeTimers();
        let runs = 0;
        const scheduler = new SyncScheduler({
            debounceMs: 10,
            run: async () => {
                runs += 1;
            },
        });
        scheduler.notify();
        scheduler.dispose();
        await vi.advanceTimersByTimeAsync(100);
        scheduler.notify();
        await vi.advanceTimersByTimeAsync(100);
        expect(runs).toBe(0);
    });

    it('swallows run errors', async () => {
        vi.useFakeTimers();
        const scheduler = new SyncScheduler({
            debounceMs: 5,
            run: async () => {
                throw new Error('boom');
            },
        });
        await expect(scheduler.runNow()).resolves.toBeUndefined();
        scheduler.dispose();
    });
});
