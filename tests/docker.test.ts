import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
    dockerFiles,
    dockerImageName,
    DOCKER_COMPOSE_FILE,
    renderCompose,
    renderDockerfile,
    renderDockerignore,
    resolveDockerPlan,
    writeDockerFiles,
} from '@deltabox/toolchain/docker';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-docker-'));
    dirs.push(dir);
    return dir;
}

function project(pkg: Record<string, unknown>): string {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 4)}\n`);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Docker plan resolution', () => {
    it('plans a Node server with only the sources that exist', () => {
        const cwd = project({
            name: '@acme/API Server',
            scripts: { build: 'vp build', start: 'node dist/index.js' },
            engines: { node: '>=22.10' },
        });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.runtime).toBe('node');
        expect(plan.packageManager).toBe('yarn');
        expect(plan.nodeVersion).toBe('22');
        expect(plan.port).toBe(3000);
        expect(plan.image).toBe('api-server');
        expect(plan.installSources).toEqual(['package.json']);
        expect(plan.hasBuildScript).toBe(true);
        expect(plan.vitePlus).toBe(false);
    });

    it('uses the declared package manager for both COPY and install', () => {
        const cwd = project({
            name: 'bun-app',
            packageManager: 'yarn@4.17.1',
            scripts: { build: 'bun build', start: 'bun dist/index.js' },
        });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.runtime).toBe('bun');
        expect(plan.packageManager).toBe('yarn');
        expect(plan.baseImage).toBe('oven/bun:1');
        const file = renderDockerfile(plan);
        // A declared manager keeps its Node deps stage; Bun only builds.
        expect(file).toContain('FROM node:22-bookworm-slim AS deps');
        expect(file).toContain('corepack enable && yarn install');
        expect(file).toContain('RUN bun run build');
        expect(file).not.toContain('bun install');
    });

    it('defaults a Bun runtime with no manager to Bun', () => {
        const cwd = project({
            name: 'bun-app',
            scripts: { build: 'bun build', start: 'bun dist/index.js' },
        });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.packageManager).toBe('bun');
        expect(plan.installSources).toEqual(['package.json']);
        expect(renderDockerfile(plan)).toContain('bun install');
        expect(renderDockerfile(plan)).not.toContain('yarn.lock');
    });

    it('plans a static VitePress site on the unprivileged nginx image', () => {
        const cwd = project({
            name: 'docs',
            scripts: { build: 'vitepress build docs' },
        });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.runtime).toBe('static');
        expect(plan.port).toBe(8080);
        expect(plan.output).toBe('docs/.vitepress/dist');
        expect(plan.runtimeImage).toBe('nginxinc/nginx-unprivileged:alpine');
        const file = renderDockerfile(plan);
        expect(file).toContain('COPY --from=build /app/docs/.vitepress/dist /usr/share/nginx/html');
        expect(file).toContain('EXPOSE 8080');
    });

    it('honours every explicit option', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        const plan = resolveDockerPlan({
            cwd,
            image: 'ghcr.io/acme/app',
            tag: '1.2.3',
            port: 4000,
            nodeVersion: '24.1',
            dockerfile: 'docker/app.Dockerfile',
            compose: true,
            dockerignore: false,
            healthcheck: false,
            user: 'app',
            runtime: 'node',
        });
        expect(plan.image).toBe('ghcr.io/acme/app');
        expect(plan.tag).toBe('1.2.3');
        expect(plan.port).toBe(4000);
        expect(plan.baseImage).toBe('node:24-bookworm-slim');
        expect(plan.dockerfile).toBe('docker/app.Dockerfile');
        expect(plan.user).toBe('app');
        const file = renderDockerfile(plan);
        expect(file).toContain('USER app');
        expect(file).toContain('EXPOSE 4000');
        expect(file).not.toContain('HEALTHCHECK');
    });

    it('detects lockfiles, Yarn PnP and workspace files', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        fs.writeFileSync(path.join(cwd, 'yarn.lock'), '');
        fs.writeFileSync(path.join(cwd, '.yarnrc.yml'), 'nodeLinker: pnp\n');
        fs.writeFileSync(path.join(cwd, '.pnp.cjs'), '');
        fs.mkdirSync(path.join(cwd, '.yarn', 'patches'), { recursive: true });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.installSources).toContain('yarn.lock');
        expect(plan.installSources).toContain('.yarnrc.yml');
        expect(plan.installSources).toContain('.yarn/patches');
        expect(plan.pnp).toEqual({
            entry: '.pnp.cjs',
            files: ['.pnp.cjs', '.yarn'],
        });
        const file = renderDockerfile(plan);
        expect(file).toContain('--require", "./.pnp.cjs');
        expect(file).toContain('COPY --from=build /app/.pnp.cjs ./.pnp.cjs');
    });

    it('sanitizes image names and falls back to `app`', () => {
        expect(dockerImageName('@acme/My App!')).toBe('my-app');
        expect(dockerImageName('---')).toBe('app');
    });
});

describe('Docker artifacts', () => {
    it('renders the Dockerfile, dockerignore and compose files', () => {
        const cwd = project({
            name: 'app',
            scripts: { start: 'node dist/index.js' },
        });
        const files = dockerFiles({ cwd, compose: true });
        expect(files.map(file => file.path)).toEqual([
            'Dockerfile',
            '.dockerignore',
            DOCKER_COMPOSE_FILE,
        ]);
        const ignore = files[1]!.content;
        expect(ignore).toContain('**/node_modules');
        expect(ignore).toContain('**/.dbx');
        expect(ignore).toContain('!**/.env.example');
        const compose = files[2]!.content;
        expect(compose).toContain('image: app:latest');
        expect(compose).toContain('"3000:3000"');
    });

    it('renders a start command and healthcheck for a server', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        const plan = resolveDockerPlan({ cwd, entry: 'dist/server.js', healthcheckPath: '/health' });
        const file = renderDockerfile(plan);
        expect(file).toContain('CMD ["node", "dist/server.js"]');
        expect(file).toContain('http://127.0.0.1:3000/health');
    });

    it('writes artifacts, skipping existing files unless forced', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        const first = writeDockerFiles({ cwd });
        expect(first).toHaveLength(2);
        const dockerfile = path.join(cwd, 'Dockerfile');
        fs.writeFileSync(dockerfile, '# hand edited\n');
        expect(writeDockerFiles({ cwd })).toHaveLength(0);
        expect(fs.readFileSync(dockerfile, 'utf8')).toBe('# hand edited\n');
        expect(writeDockerFiles({ cwd, force: true })).toHaveLength(2);
        expect(fs.readFileSync(dockerfile, 'utf8')).toContain('# syntax=docker/dockerfile:1');
    });

    it('always marks the generated files as editable', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        const plan = resolveDockerPlan({ cwd });
        for (const content of [
            renderDockerfile(plan),
            renderDockerignore(plan),
            renderCompose(plan),
        ]) {
            expect(content).toContain('Generated by @deltabox/toolchain');
        }
    });

    it('keeps a lockfile-free install unbounded by --frozen-lockfile', () => {
        const cwd = project({ name: 'app', scripts: { start: 'node dist/index.js' } });
        const plan = resolveDockerPlan({ cwd });
        expect(plan.installSources).not.toContain('yarn.lock');
        const file = renderDockerfile(plan);
        expect(file).toContain('yarn install');
        expect(file).not.toContain('--immutable');
    });
});
