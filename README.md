Integration and edge-case harness for [`@deltabox/toolchain`](../toolchain). It
is intentionally a separate repository so tests can install from npm, use every
package manager/linker, and run destructive scaffolding/sync flows without
touching the toolchain checkout.

The harness is driven by `yarn test:repo` from the toolchain repository. That
script clones this repo next to the checkout (`../toolchain-tests`) and reuses it
on later runs. Pass `--run` to run `yarn test` here after cloning/reusing.

## Layout

- `environments/node-yarn` — Yarn with `nodeLinker: node-modules`.
- `environments/node-yarn-pnpm` — Yarn with `nodeLinker: pnpm`.
- `environments/node-yarn-pnp` — Yarn with `nodeLinker: pnp`.
- `environments/node-pnpm` — pnpm.
- `environments/node-npm` — npm.
- `environments/deno` — Deno runtime.
- `environments/bun` — Bun runtime.
- `environments/docker` — Docker image/build flows.
- `tests/` — cross-environment tests (CLI, config, sync, templates, changelog,
  migrations, MCP, Docker, VS Code helpers, tsconfig generation, release
  pipelines).
- `scripts/typecheck.mjs` — typechecks each suite in its own program: the
  toolchain's public type surface is large enough that a single program can
  exceed the default Node heap.

Each environment declares its manager/linker/runtime in `package.json` under
`deltabox`. The root `vite.config.ts` owns the `vp test run` task and aggregates
every environment's `test` task with `vp run --filter "./environments/*" test`.

## Toolchain access

- Production-style resolution: the root declares
  `"@deltabox/toolchain": "portal:../toolchain"` so package-manager installs and
  CLI runs resolve the local toolchain package.
- Dev-source resolution: `tsconfig.json` aliases
  `@deltabox/toolchain` to `../toolchain/src/index.ts` and
  `@deltabox/toolchain/*` to `../toolchain/src/*`, and the root Vite config
  enables `resolve.tsconfigPaths`.
- Dev CLI: `yarn dbx <args>` runs `tsx --tsconfig ../toolchain/tsconfig.json
  ../toolchain/src/cli/index.ts`, so the toolchain's path aliases resolve from
  any project directory.

Use the same Yarn version (`4.17.1`) and Node minimum (`>=22.5`) as the
toolchain repository.

## Mocked side effects

CI/release/changelog tests must not publish packages, create releases or push
tags. Mock the provider commands (or pass `--dry-run`/`--release-notes`) so the
harness never leaves the machine.
