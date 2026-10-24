# Module library — assemble first, build only what is custom

A scaffolded project does not start from zero: the **elcodelabs module library**
(`elcodelabs-modules`) holds ready modules (auth, users, …), UI kits, an app shell, and theme
presets built for exactly this standard. Claude's job on a new project or feature is
**assembly**: find what the library already has, install it, wire it, and write code only for
what is custom or missing. That is faster, cheaper, and more consistent than regenerating the
same features each time.

## Where the library is

Use the first that exists:

1. `$ELCO_MODULES`
2. `~/elcodelabs-modules`
3. `~/Documents/elcodelabs-modules`

If none exists, say so and ask the user where it is (or for its repository to clone). Without
it, build everything per the standard — but never invent a module "from the library" that is
not in its catalog.

Everything below runs `node $LIB/scripts/module.mjs <command>` from the project root, where
`$LIB` is that path.

## The assembly workflow

### 1. Read the catalog — not the code

Read `$LIB/CATALOG.md` (generated: every module's purpose, kind, what it offers, which ports it
needs, when to use it and when not). It costs a few hundred lines however large the library
grows. Open a module's `README.md` / `module.json` (`module.mjs info <id>`) only for the
candidates. Do not read module source to decide.

### 2. Break the requirement into capabilities

List what the app must do as capabilities a module could own: "staff sign in", "manage staff
accounts", "products and stock", "sales orders", "printable invoices", "back-office frame"…

### 3. Decide each one: install, install + adapt, or build

| Decision | When |
|---|---|
| **Install** | A module's `when_to_use` matches and its `when_not_to_use` doesn't. |
| **Install + adapt** | It matches except for project-specific details. Install it, then adapt in new files of its own (see "Changing an installed module"). |
| **Build** | Nothing matches, or a module's `when_not_to_use` describes this case. Build it to the standard as a new module. |

Also decide how each port of an installed module is wired: to another library module that has
a ready-made adapter (`--port UserStore=users`), or to an adapter the project writes
(`--port UserStore=expr:<Go expression>`). The UI kits a module builds on (`ui`) come along.

The theme preset is a design decision: the design brief ([design-research.md](design-research.md))
names it (`Preset: bingkai-navy`) or settles on the project's own values.

### 4. Confirm once with the user

Show one table before installing anything — capability · decision · module (version) · ports
wiring · env to set — and wait for a yes. One confirmation covers the whole assembly. When the
`analysis/` workflow is in use, this table goes into that requirement's `analysis.md`.

### 5. Install in dependency order

Preset → ui kits → modules that offer contracts → modules that consume them:

```bash
node $LIB/scripts/module.mjs preset bingkai-navy
node $LIB/scripts/module.mjs add ui-core app-shell users
node $LIB/scripts/module.mjs add auth --port UserStore=users
```

A module states the minimum kernel it needs (`requires_kernel`); a project on an older kernel
moves up first ([backend-go.md](backend-go.md#kernel-versions)).

`add` copies the module into the project, adds its migrations with fresh timestamp versions,
writes its lines between the `elco:*` markers (Go registry, `sqlc.yaml`, `app/modules.ts`), its
npm dependencies, its env names into `.env.example`, its row into `knowledge/MODULE_MAP.md`, and
records everything in `modules.lock.json`. It refuses — changing nothing — when a required port
is unwired or the kernel is older than the module needs. Missing ui kits a module lists are
added first, automatically (`upgrade` does the same when a new version needs a new kit).

Then, as `add` prints: `npm install` · `cd apps/api && go mod tidy` · `npm run sqlc:generate` ·
set the required env values in `.env` · `npm run migrate:up` · build and run.

### 6. Build what is custom

New modules follow the standard ([backend-modular-monolith.md](backend-modular-monolith.md),
[backend-go.md](backend-go.md), [frontend.md](frontend.md)): own `ports/` for what they need
from installed modules, adapters in the composition root, guarded routes through `d.Auth`,
frontend contributed through `FrontendModule` (routes, `nav`, `slots`), UI from the ui kits and
semantic tokens. A custom module must look like a library module — that is what lets it be
promoted later.

### 7. Record

Commit `modules.lock.json` with the code. Add `MODULE_MAP.md` rows for custom modules (installed
ones were added). Record the preset in `knowledge/DESIGN.md`.

## Changing an installed module

- **Prefer new files of the module's own** (`custom_*.go`, `Custom*.tsx`, an extra route file):
  an upgrade then merges without touching them.
- Editing a shipped file is fine — `status` will list it, and `upgrade` merges library changes
  into it (3-way), marking only real overlaps as conflicts.
- When a module has diverged for good, `module.mjs detach <id>`: the project owns it, and
  `upgrade` leaves it alone.
- Never copy files from the library by hand, and never re-run `add` over an installed module:
  the lockfile would not know, and upgrades would break.

## Upgrading

```bash
node $LIB/scripts/module.mjs status           # installed vs available, files changed here
node $LIB/scripts/module.mjs upgrade <id>     # or: upgrade preset · upgrade --all
```

Exit code 2 means conflicts: resolve the `<<<<<<<` markers, then build and test. New migrations
arrive with fresh versions; applied ones are never rewritten (the tool warns if the library
changed one). Upgrade with the user's go-ahead, one module at a time, and run the tests after.

## Giving back: promote

When a module built for one project turns out reusable, it can join the library — only with the
user's go-ahead, since the library is shared by every project:

```bash
node $LIB/scripts/module.mjs promote invoice --migration <file>... 
```

It copies the module (generated sqlc code excluded), reads contracts, ports, tables, env, routes,
and registry lines from the code into a draft `module.json`, and refuses a module that imports
another (turn that into a port first). Then: finish `module.json` and `README.md`, remove
anything specific to the project, add a testbed scenario in the library, run
`node scripts/catalog.mjs`, and commit there.
