import { defineConfig } from 'vite-plus';

/**
 * The integration harness. Every `environments/*` workspace has its own `test`
 * task; this root only aggregates them, so a package-manager/linker failure in
 * one environment never hides the others.
 */
export default defineConfig({
    resolve: { tsconfigPaths: true },
    test: {
        include: ['tests/**/*.test.ts', 'environments/**/tests/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        exclude: ['**/node_modules/**', '**/dist/**', '**/.yarn/**'],
    },
});
