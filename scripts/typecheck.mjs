/**
 * Typecheck the harness one file at a time.
 *
 * TypeScript 6 instantiates the toolchain's full public type surface for every
 * entry point; checking every suite in one program exceeds the default heap even
 * though each suite is small. Per-file programs keep memory bounded and make the
 * failing suite obvious.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const configFile = path.join(root, 'tsconfig.typecheck.json');
const tempConfig = path.join(root, '.tsconfig.typecheck.json');

function collect(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collect(full));
        else if (entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
}

const files = [
    path.join(root, 'vite.config.ts'),
    ...collect(path.join(root, 'tests')),
    ...collect(path.join(root, 'environments')),
];

let failed = 0;
try {
    for (const file of files) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        fs.writeFileSync(
            tempConfig,
            `${JSON.stringify({ extends: './tsconfig.typecheck.json', include: [relative] }, null, 4)}\n`
        );
        const result = spawnSync(process.execPath, [tsc, '-p', tempConfig, '--noEmit'], {
            cwd: root,
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            failed += 1;
            process.stderr.write(`\n${relative}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
        }
    }
} finally {
    fs.rmSync(tempConfig, { force: true });
}

if (failed > 0) {
    process.stderr.write(`\n${failed} file(s) failed typechecking.\n`);
    process.exit(1);
}
process.stdout.write(`Typechecked ${files.length} file(s).\n`);
