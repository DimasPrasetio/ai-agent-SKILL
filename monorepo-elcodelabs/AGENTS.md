# Working on the monorepo-elcodelabs skill

This file is for anyone who changes this skill — a person or an AI agent. The skill is the
**source of truth for the architecture** of every project it scaffolds and of every module in
the module library (`elcodelabs-modules`). The architecture is locked: changes refine it, they
do not redesign it, and they never leave the references, the scaffolder, and the library out of
step.

## What is locked

| Part | Lives in | What a change must not do |
|---|---|---|
| Stack and repo shape | `SKILL.md`, `references/` | Swap a locked tool (React 19 + Tailwind 4 + shadcn/ui, Go modular monolith with sqlc + golang-migrate, MySQL, the elcodelabs VPS deploy) or add a layer the anti-overengineering list forbids. |
| Module boundaries | `backend-modular-monolith.md` | Let a module import another module — not its internals, not its `contracts/`. Ports in the consumer, contracts in the provider, adapters only in the composition root. |
| Go kernel and module contract | `backend-go.md`, `scripts/templates/go/internal/kernel/` | Change `kernel.Deps`, `d.Auth`, `d.Authz`, the `elco:*` markers, `New`/`Routes`/`Client`, or `shared/` without the kernel-version process below. |
| Frontend contract | `frontend.md`, `scripts/templates/web/`, the web files `scaffold.mjs` writes | Change `FrontendModule`, `@/shared/composition`, `@/shared/access`, `@/shared/app-events`, the http client, the token names, `FIELD`, or the primitives without the same process. |
| One home per fact | `references/knowledge-gateway.md` | Restate a fact in a second file. The second copy drifts; `check-drift.mjs` exists to catch it. |

## The module contract

The library installs code that builds on 30 generated files (kernel, config, shared Go
packages, the registries, the web's shared contract, primitives, theme). Their fingerprints are
in `scripts/module-contract.json`, recorded for the current kernel version. When one changes,
`check-drift.mjs` fails until you decide:

- **Compatible** — library modules for this kernel still compile and behave the same (a comment,
  a clearer message, a style refinement every module should get): run
  `node scripts/check-drift.mjs --accept-contract` and commit the updated
  `module-contract.json` with the change.
- **Breaking or additive** — a module could now rely on something new, or an existing module
  would stop working: raise the kernel version in all three places (`const Version` in
  `scripts/templates/go/internal/kernel/kernel.go.tmpl`, `KERNEL_VERSION` in `scaffold.mjs`,
  a new row in `backend-go.md` › Kernel versions with how to upgrade), update the library's
  modules (`requires_kernel`, versions) and run its testbed, then `--accept-contract`.

`check-drift.mjs` also fails when the three kernel version numbers disagree.

## Before you commit

```bash
npm run verify        # check-drift → smoke-test (needs Go, Node, MySQL) → package
```

The pre-commit hook runs the fast part (`check-drift.mjs` and `package.mjs --check`, so
`dist/monorepo-elcodelabs.skill` never lags its sources); CI runs all of it. A change to the
kernel or the frontend contract is also checked against the library:
`node $ELCO_MODULES/scripts/testbed.mjs --skill <this folder>`.

Never bypass the hook (`git commit --no-verify`) to land a failing check. If a check is wrong,
fix the check and say why in the same commit.

## One-time setup in a clone

```bash
git config core.hooksPath .githooks     # run from the repository root
```
