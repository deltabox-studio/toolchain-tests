import { describe, expect, it } from 'vite-plus/test';

import { resolveToolchainEnabled } from '@deltabox/toolchain';

describe('toolchain harness', () => {
    it('resolves the umbrella API from the source aliases', () => {
        expect(resolveToolchainEnabled({})).toEqual({ enabled: true, scope: 'workspace' });
        expect(resolveToolchainEnabled({ enabled: false })).toEqual({
            enabled: false,
            scope: 'workspace',
        });
    });
});
