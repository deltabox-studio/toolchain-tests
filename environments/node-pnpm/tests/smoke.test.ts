import { describe, expect, it } from 'vite-plus/test';

import { defineConfig, resolveToolchainEnabled } from '@deltabox/toolchain';

describe('node-pnpm environment', () => {
    it('loads the toolchain API through the source aliases', () => {
        expect(defineConfig({})).toEqual({});
        expect(resolveToolchainEnabled({})).toEqual({ enabled: true, scope: 'workspace' });
    });
});