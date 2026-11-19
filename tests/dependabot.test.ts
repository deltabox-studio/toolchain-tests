import { describe, expect, it } from 'vite-plus/test';

import {
    DEPENDABOT_ECOSYSTEMS,
    DEPENDABOT_FILE,
    dependabotFilePath,
    renderDependabot,
} from '@deltabox/toolchain/changelog';

describe('Dependabot generation', () => {
    it('renders the default config', () => {
        const yaml = renderDependabot();
        expect(DEPENDABOT_FILE).toBe('.github/dependabot.yml');
        expect(DEPENDABOT_ECOSYSTEMS).toEqual(['github-actions', 'npm']);
        expect(yaml).toContain('version: 2');
        expect(yaml).toContain('package-ecosystem: github-actions');
        expect(yaml).toContain('package-ecosystem: npm');
        expect(yaml).toContain('interval: weekly');
    });

    it('renders every directory/ecosystem combination', () => {
        const yaml = renderDependabot({
            directories: ['/', '/packages/a'],
            ecosystems: ['npm'],
        });
        expect(yaml.match(/package-ecosystem: npm/g)).toHaveLength(2);
        expect(yaml).toContain('/packages/a');
    });

    it('deduplicates ecosystems and honours schedule/labels/limit', () => {
        const yaml = renderDependabot({
            schedule: 'monthly',
            ecosystems: ['npm', 'npm', 'github-actions'],
            labels: ['deps', 'ci'],
            openPullRequestsLimit: 3,
        });
        expect(yaml.match(/package-ecosystem: npm/g)).toHaveLength(1);
        expect(yaml).toContain('interval: monthly');
        expect(yaml).toContain('labels:');
        expect(yaml).toContain('open-pull-requests-limit: 3');
    });

    it('renders groups', () => {
        const yaml = renderDependabot({
            groups: {
                'minor-and-patch': {
                    patterns: ['*'],
                    'exclude-patterns': ['vite'],
                    'update-types': ['minor', 'patch'],
                },
            },
        });
        expect(yaml).toContain('minor-and-patch');
        expect(yaml).toContain('update-types:');
        expect(yaml).toContain('exclude-patterns:');
    });

    it('resolves the config path', () => {
        expect(dependabotFilePath()).toBe('.github/dependabot.yml');
        expect(dependabotFilePath({ dir: 'ci/', filename: 'deps.yml' })).toBe('ci/deps.yml');
        expect(dependabotFilePath({ dir: '' })).toBe('dependabot.yml');
        expect(dependabotFilePath({ dir: '/workflows' })).toBe('workflows/dependabot.yml');
    });

    it('rejects paths outside the project', () => {
        expect(() => dependabotFilePath({ dir: '../x' })).toThrow(/inside the project/);
        expect(() => dependabotFilePath({ filename: '../x.yml' })).toThrow(/inside the project/);
        expect(() => dependabotFilePath({ filename: '' })).toThrow(/inside the project/);
        expect(() => dependabotFilePath({ dir: 'C:/x' })).toThrow(/inside the project/);
    });
});
