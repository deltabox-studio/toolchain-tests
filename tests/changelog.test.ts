import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';

import {
    buildSummary,
    deriveBump,
    formatBody,
    groupItems,
    parseArgsCli,
    parseCcSubject,
    parseExistingChangelog,
    reformatChangelogContent,
    renderChangelogEntry,
    runChangelog,
} from '@deltabox/toolchain/changelog';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-changelog-'));
    dirs.push(dir);
    return dir;
}

function write(dir: string, name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function record(subject: string, body = '', hash = 'abcdef1234567890') {
    return {
        hash,
        subject,
        body,
        author: 'Test Author',
        authorEmail: 'test@example.com',
    };
}

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function initRepo(dir: string, version = '1.0.0'): void {
    write(dir, 'package.json', `${JSON.stringify({ name: 'demo', version }, null, 4)}\n`);
    write(dir, 'CHANGELOG.md', '# Changelog\n');
    git(dir, 'init', '--initial-branch=main');
    git(dir, 'config', 'user.name', 'Test Author');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'chore: init');
}

let previousCwd = process.cwd();
beforeAll(() => {
    previousCwd = process.cwd();
    // Never call `gh`: the harness must stay offline.
    process.env.DBX_NO_GH = '1';
});

afterEach(() => {
    process.chdir(previousCwd);
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('changelog CLI options', () => {
    it('parses every supported flag', () => {
        expect(parseArgsCli(['--dry-run'])).toMatchObject({
            range: 'HEAD',
            rangeExplicit: false,
            dryRun: true,
            formatOnly: false,
            release: false,
            packageChanges: true,
        });
        expect(
            parseArgsCli([
                '--range',
                'v1.0.0..HEAD',
                '--processing-method',
                'all',
                '--release',
                '--no-package-changes-section',
                '--intro',
                'hi',
                '--outro-file',
                'outro.md',
                '--version',
                '2.0.0',
                '--base-version',
                '1.9.0',
                '--release-notes',
                '1.2.3',
            ])
        ).toMatchObject({
            range: 'v1.0.0..HEAD',
            rangeExplicit: true,
            processingMethod: 'all',
            release: true,
            packageChanges: false,
            intro: 'hi',
            outroFile: 'outro.md',
            version: '2.0.0',
            baseVersion: '1.9.0',
            releaseNotes: '1.2.3',
        });
    });

    it('accepts a positional range and the env processing method', () => {
        const previous = process.env.CHANGELOG_PROCESSING_METHOD;
        process.env.CHANGELOG_PROCESSING_METHOD = ' latest ';
        try {
            expect(parseArgsCli(['HEAD~3..HEAD'])).toMatchObject({
                range: 'HEAD~3..HEAD',
                rangeExplicit: true,
                processingMethod: 'latest',
            });
        } finally {
            if (previous === undefined) delete process.env.CHANGELOG_PROCESSING_METHOD;
            else process.env.CHANGELOG_PROCESSING_METHOD = previous;
        }
    });
});

describe('conventional commits + bumping', () => {
    it('parses type, scope, breaking marker and inline description', () => {
        expect(parseCcSubject('feat(core): add `things`')).toEqual({
            type: 'feat',
            scope: 'core',
            breaking: false,
            rest: 'add `things`',
        });
        expect(parseCcSubject('fix!: drop node 18').breaking).toBe(true);
        expect(parseCcSubject('random subject')).toMatchObject({ type: 'chore' });
    });

    it('derives the highest applicable bump', () => {
        expect(deriveBump([record('fix: a')])).toBe('patch');
        expect(deriveBump([record('fix: a'), record('feat(ui): b')])).toBe('minor');
        expect(
            deriveBump([record('feat: a'), record('fix: b', 'BREAKING CHANGE: gone')])
        ).toBe('major');
        expect(deriveBump([record('chore: a')])).toBe('patch');
    });

    it('bumps prerelease cycles without appending the tag twice', () => {
        const dir = tempDir();
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '-m', 'feat: add a feature');
        process.chdir(dir);
        const config = { versioning: { target: 'uniform' as const, prerelease: 'beta' } };
        runChangelog(['--range', 'HEAD'], config);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            '1.1.0-beta.0'
        );

        git(dir, 'commit', '--allow-empty', '-m', 'feat: add another feature');
        runChangelog(['--range', 'HEAD'], config);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            '1.1.0-beta.1'
        );
    });
});

describe('changelog rendering', () => {
    it('groups commits by rule and scope', () => {
        const groups = groupItems([
            {
                parsed: parseCcSubject('feat(core): first'),
                text: 'feat(core): first',
                bodyParagraphs: [],
            },
            {
                parsed: parseCcSubject('fix(core): second'),
                text: 'fix(core): second',
                bodyParagraphs: [],
            },
        ]);
        expect(groups.map(group => group.type)).toEqual(['feat', 'fix']);
        expect(groups[0]?.scopes.get('core')?.[0]?.text).toContain('first');
    });

    it('renders a full summary with scopes and credits', () => {
        const summary = buildSummary([record('feat(core): add api', '', 'a'.repeat(12))], {
            commit: { author: false },
        });
        expect(summary).toContain('New features');
        expect(summary).toContain('Core');
        expect(summary).toContain('#aaaaaaa');
        expect(summary).toContain('/commit/');
    });

    it('keeps bodies as nested paragraphs', () => {
        expect(formatBody('first line\n\nsecond paragraph')).toEqual([
            ['first line'],
            ['second paragraph'],
        ]);
    });

    it('renders release markers, intro and outro', () => {
        const entry = renderChangelogEntry(
            '1.1.0',
            '- thing\n',
            new Date('2026-01-15T00:00:00Z'),
            true,
            '### Package changes\n\n- dep 1.0.0 -> 1.1.0',
            'Intro text',
            'Outro text'
        );
        expect(entry).toContain('## 1.1.0 (January 2026)');
        expect(entry).toContain('<!-- release:start -->');
        expect(entry).toContain('Intro text');
        expect(entry).toContain('Package changes');
        expect(entry).toContain('Outro text');
    });

    it('reformats an old-style changelog entry', () => {
        const parsed = parseExistingChangelog(
            '# Changelog\n\n## 1.0.0\n\n- feat: hello\n- fix: bye\n'
        );
        expect(parsed[0]?.version).toBe('1.0.0');
        const reformatted = reformatChangelogContent(
            '# Changelog\n\n## 1.0.0\n\n- feat: hello\n- fix: bye\n',
            undefined
        );
        expect(reformatted).toContain('<summary>New features</summary>');
        expect(reformatted).toContain('- Hello');
        expect(reformatted).toContain('<summary>Bug fixes</summary>');
    });
});

describe('changelog pipeline end to end', () => {
    it('dry-runs a real git repository and writes CHANGELOG.proposed.md', () => {
        const dir = tempDir();
        initRepo(dir);
        write(dir, 'src/index.ts', 'export const x = 1;\n');
        git(dir, 'add', '-A');
        git(dir, 'commit', '-m', 'feat(core): add x');

        process.chdir(dir);
        runChangelog(['--dry-run', '--range', 'HEAD']);

        const proposed = fs.readFileSync(path.join(dir, 'CHANGELOG.proposed.md'), 'utf8');
        expect(proposed).toContain('## 1.1.0');
        expect(proposed).toContain('New features');
        expect(proposed).toContain('Add x');
        // Nothing is bumped by a dry run.
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            '1.0.0'
        );
    });

    it('bumps versions and writes changelogs for real', () => {
        const dir = tempDir();
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '-m', 'fix(cli): repair a flag');

        process.chdir(dir);
        runChangelog(['--range', 'HEAD']);

        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            '1.0.1'
        );
        const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('## 1.0.1');
        expect(changelog).toContain('Bug fixes');
        expect(changelog).toContain('Repair a flag');
    });

    it('skips commits that were already released', () => {
        const dir = tempDir();
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '-m', 'feat: add a feature');

        process.chdir(dir);
        runChangelog(['--range', 'HEAD']);
        const first = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
        const hash = git(dir, 'rev-parse', '--short=7', 'HEAD');
        expect(first).toContain(`#${hash}`);

        const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
        runChangelog(['--range', 'HEAD']);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            version
        );
        expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(first);
    });

    it('retags an explicit version without touching git history', () => {
        const dir = tempDir();
        initRepo(dir);

        process.chdir(dir);
        runChangelog(['--version', '2.0.0', '--dry-run']);
        expect(
            JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
        ).toBe('1.0.0');

        runChangelog(['--version', '2.0.0']);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(
            '2.0.0'
        );
    });

    it('fails outside a git repository', () => {
        const dir = tempDir();
        process.chdir(dir);
        expect(() => runChangelog(['--range', 'HEAD'])).toThrow(/not a git repository/i);
    });
});
