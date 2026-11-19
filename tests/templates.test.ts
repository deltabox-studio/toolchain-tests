import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
    addTemplateSource,
    BUILTIN_TEMPLATES,
    isTemplateDir,
    loadLocalTemplates,
    loadTemplates,
    readTemplateDir,
    readTemplateManifest,
    readTemplateRegistry,
    REGISTRY_DIR,
    REGISTRY_FILE,
    removeTemplateSource,
    scaffoldTemplate,
} from '@deltabox/toolchain/template';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-template-'));
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

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('template catalog', () => {
    it('ships the offline builtin templates', () => {
        const ids = BUILTIN_TEMPLATES.map(template => template.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                'project',
                'application',
                'monorepo',
                'monorepo-example',
                'workspace',
                'vitepress',
                'express',
                'bun',
                'fastify',
                'orpc',
            ])
        );
        for (const template of BUILTIN_TEMPLATES) {
            expect(template.source.type).not.toBe('local');
            expect(template.kind).toBeDefined();
        }
    });

    it('loads builtins plus project-local sources without network access', async () => {
        const cwd = tempDir();
        const tpl = path.join(cwd, 'templates', 'hello');
        write(tpl, 'template.json', JSON.stringify({ name: 'Hello', tags: ['demo'] }));
        write(tpl, 'src/index.ts', 'export const hello = true;\n');
        addTemplateSource(cwd, { type: 'local', locate: './templates/hello' });

        const templates = await loadTemplates({ cwd });
        expect(templates.some(template => template.id === 'project')).toBe(true);
        const hello = templates.find(template => template.name === 'Hello');
        expect(hello).toMatchObject({ name: 'Hello', tags: ['demo'] });
    });

    it('reads a local template manifest and its defaults', () => {
        const dir = tempDir();
        write(dir, 'template.json', '\uFEFF{"name":"Demo","kind":"application"}');
        expect(isTemplateDir(dir)).toBe(true);
        expect(readTemplateManifest(dir)).toMatchObject({ name: 'Demo', kind: 'application' });
        expect(readTemplateDir(dir, 'demo')).toMatchObject({
            id: 'demo',
            name: 'Demo',
            kind: 'application',
            dir,
            source: { type: 'local', locate: dir },
        });
        expect(readTemplateDir(tempDir())).toBeUndefined();
    });

    it('loads the templates under a directory, skipping hidden dirs', () => {
        const root = tempDir();
        write(root, 'a/template.json', '{"name":"A"}');
        write(root, 'b/template.json', '{"name":"B"}');
        write(root, '.hidden/template.json', '{"name":"Hidden"}');
        write(root, 'plain/README.md', '# no manifest');
        const ids = loadLocalTemplates(root).map(template => template.id);
        expect(ids.sort()).toEqual(['a', 'b']);
    });
});

describe('builtin scaffolding', () => {
    it('scaffolds a project with tokens and a plugin config', async () => {
        const cwd = tempDir();
        const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'project')!;
        const result = await scaffoldTemplate(template, {
            cwd,
            tokens: { name: 'demo', scope: '@acme', packageManager: 'yarn' },
        });
        expect(result.written.length).toBeGreaterThan(3);
        const pkg = readJson(path.join(cwd, 'package.json'));
        expect(pkg.name).toBe('@acme/demo');
        expect(pkg.devDependencies['@deltabox/toolchain']).toBeDefined();
        expect(fs.existsSync(path.join(cwd, 'vite.config.ts'))).toBe(true);
        expect(fs.existsSync(path.join(cwd, 'tsconfig.json'))).toBe(true);
        expect(fs.readFileSync(path.join(cwd, 'vite.config.ts'), 'utf8')).toContain("name: 'demo'");
    });

    it('scaffolds a folder without touching package.json', async () => {
        const cwd = tempDir();
        const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'folder');
        expect(template).toBeDefined();
        const result = await scaffoldTemplate(template!, { cwd, tokens: { name: 'notes' } });
        expect(result.written).toEqual([path.join(cwd, 'README.md')]);
        expect(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8')).toBe('# notes\n');
        expect(fs.existsSync(path.join(cwd, 'package.json'))).toBe(false);
    });

    it('never overwrites files without force', async () => {
        const cwd = tempDir();
        const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'project')!;
        write(cwd, 'README.md', 'user readme\n');
        await expect(
            scaffoldTemplate(template, { cwd, tokens: { name: 'demo' } })
        ).rejects.toThrow(/refusing to overwrite/);
        expect(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8')).toBe('user readme\n');

        await scaffoldTemplate(template, { cwd, tokens: { name: 'demo' }, force: true });
        expect(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8')).toBe('# demo\n');
    });

    it('scaffolds a workspace under packages/ and wires the root tsconfig', async () => {
        const cwd = tempDir();
        write(cwd, 'package.json', '{"name":"root","private":true}');
        write(cwd, 'tsconfig.workspaces.json', '{"extends":"./tsconfig.base.json"}\n');
        const template = BUILTIN_TEMPLATES.find(candidate => candidate.id === 'workspace')!;
        const result = await scaffoldTemplate(template, {
            cwd,
            tokens: { name: 'core', scope: '@acme', packageManager: 'yarn' },
        });
        expect(fs.existsSync(path.join(cwd, 'packages', 'core', 'package.json'))).toBe(true);
        expect(result.written.some(file => file.includes(path.join('packages', 'core')))).toBe(true);
        const workspace = readJson(path.join(cwd, 'tsconfig.workspaces.json'));
        expect(JSON.stringify(workspace)).toContain('packages/core');
    });
});

describe('local template scaffolding', () => {
    it('copies and renders tokens, ignoring scaffold metadata', async () => {
        const cwd = tempDir();
        const tpl = path.join(cwd, 'tpl');
        write(tpl, 'template.json', '{"name":"Local"}');
        write(tpl, 'src/{{name}}.ts', "export const name = '{{name}}';\n");
        write(tpl, 'README.md', '# {{name}}\n');
        write(tpl, 'node_modules/ignored.js', 'nope\n');
        const template = readTemplateDir(tpl, 'local')!;

        const out = path.join(cwd, 'out');
        const result = await scaffoldTemplate(template, {
            cwd: out,
            tokens: { name: 'demo' },
        });
        expect(fs.readFileSync(path.join(out, 'src', 'demo.ts'), 'utf8')).toBe(
            "export const name = 'demo';\n"
        );
        expect(fs.readFileSync(path.join(out, 'README.md'), 'utf8')).toBe('# demo\n');
        expect(fs.existsSync(path.join(out, 'template.json'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'node_modules'))).toBe(false);
        expect(result.written).toHaveLength(2);
    });

    it('supports custom token delimiters and binary files', async () => {
        const cwd = tempDir();
        const tpl = path.join(cwd, 'tpl');
        write(tpl, 'template.json', '{"tokens":{"open":"[[","close":"]]"}}');
        write(tpl, 'name.txt', 'Hello [[name]] ({{name}} stays)\n');
        const binary = Buffer.from([0, 1, 2, 3, 255]);
        fs.writeFileSync(path.join(tpl, 'logo.bin'), binary);
        const template = readTemplateDir(tpl, 'local')!;
        const out = path.join(cwd, 'out');
        await scaffoldTemplate(template, { cwd: out, tokens: { name: 'demo' } });
        expect(fs.readFileSync(path.join(out, 'name.txt'), 'utf8')).toBe(
            'Hello demo ({{name}} stays)\n'
        );
        expect(fs.readFileSync(path.join(out, 'logo.bin'))).toEqual(binary);
    });

    it('skips existing targets unless overwrite is set', async () => {
        const cwd = tempDir();
        const tpl = path.join(cwd, 'tpl');
        write(tpl, 'template.json', '{}');
        write(tpl, 'keep.txt', 'template\n');
        const out = path.join(cwd, 'out');
        write(out, 'keep.txt', 'user\n');
        const template = readTemplateDir(tpl, 'local')!;

        await scaffoldTemplate(template, { cwd: out });
        expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('user\n');

        await scaffoldTemplate(template, { cwd: out, overwrite: true });
        expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('template\n');
    });

    it('refuses to write outside the output directory', async () => {
        const cwd = tempDir();
        const tpl = path.join(cwd, 'tpl');
        write(tpl, 'template.json', '{}');
        write(tpl, '{{name}}.txt', 'x\n');
        const template = readTemplateDir(tpl, 'local')!;
        await expect(
            scaffoldTemplate(template, { cwd: path.join(cwd, 'out'), tokens: { name: '../escape' } })
        ).rejects.toThrow(/outside/);
    });
});

describe('template registry', () => {
    it('adds, deduplicates and removes sources', () => {
        const cwd = tempDir();
        addTemplateSource(cwd, { type: 'local', locate: './a' });
        addTemplateSource(cwd, { type: 'local', locate: './b' });
        addTemplateSource(cwd, { type: 'local', locate: './a', id: 'a2' });
        expect(readTemplateRegistry(cwd).sources).toHaveLength(2);

        const file = path.join(cwd, REGISTRY_DIR, REGISTRY_FILE);
        expect(fs.existsSync(file)).toBe(true);

        const removedByLocate = removeTemplateSource(cwd, 'local:./a');
        expect(removedByLocate.removed).toBe(1);
        expect(removedByLocate.registry.sources).toHaveLength(1);

        addTemplateSource(cwd, { type: 'local', locate: './c', id: 'custom' });
        expect(removeTemplateSource(cwd, 'custom').removed).toBe(1);
    });

    it('reads a BOM registry and tolerates a missing or invalid file', () => {
        const cwd = tempDir();
        expect(readTemplateRegistry(cwd)).toEqual({ sources: [] });
        write(cwd, path.join(REGISTRY_DIR, REGISTRY_FILE), 'not json');
        expect(readTemplateRegistry(cwd)).toEqual({ sources: [] });
        write(
            cwd,
            path.join(REGISTRY_DIR, REGISTRY_FILE),
            `\uFEFF${JSON.stringify({ sources: [{ type: 'local', locate: './x' }] })}`
        );
        expect(readTemplateRegistry(cwd).sources).toHaveLength(1);
    });

    it('ignores a malformed sources value', () => {
        const cwd = tempDir();
        write(cwd, path.join(REGISTRY_DIR, REGISTRY_FILE), '{"sources":"nope"}');
        expect(readTemplateRegistry(cwd)).toEqual({ sources: [] });
    });
});
