# Go Backend Standard

Read this together with [backend-modular-monolith.md](backend-modular-monolith.md) — the module boundary rules apply unchanged.

## Locked stack

```txt
Watcher          = Air                      (never `go run main.go`)
Migration        = golang-migrate
Database access  = sqlc
Driver           = database/sql + MySQL driver
ORM default      = NOT GORM
```

The generated `apps/api/cmd/server/main.go` loads `.env` via `github.com/joho/godotenv`
(`../../.env` first, since the API runs from `apps/api` while `.env` lives at the repo root;
then a local `.env` as fallback — errors from both are ignored, since in a container env comes
from `env_file`). Run `go mod tidy` once after scaffolding to resolve `go.sum`.

`migrate:up`/`migrate:down` run through `scripts/migrate.mjs`, a dependency-free Node wrapper
around the `migrate` CLI. This is deliberate: npm runs scripts through `cmd.exe` on Windows,
which does not expand `$DATABASE_URL`, so a literal `-database "$DATABASE_URL"` argument
fails there. The wrapper reads `DB_DSN` from `.env` itself and passes it through explicitly,
working the same in PowerShell, cmd, and sh.

Rules:

- Use `golang-migrate` for migrations.
- Use `sqlc` for type-safe DB access, generated **per module**: `sqlc.yaml` has one `sql:` block per module, reading from `internal/modules/<module>/infrastructure/queries` and writing to `internal/modules/<module>/infrastructure/sqlc`. A single project-wide `sqlc` package would let any module import any other module's generated queries, breaking the module boundary. **Every new module must add its own `sql:` block** — otherwise its queries never get generated.
- Use `database/sql` with the MySQL driver for the connection.
- Do not use GORM by default. GORM may be used only when the user explicitly asks.
- Do not use GORM AutoMigrate or ORM-based schema generation.
- Do not create cross-module ORM relations, preloads, associations, or foreign keys.

## Root commands (Go)

```json
{
  "scripts": {
    "dev:web": "npm run dev -w apps/web",
    "dev:api": "cd apps/api && air",
    "build:web": "npm run build -w apps/web",
    "build:api": "cd apps/api && go build -o ../../dist/api ./cmd/server",
    "migrate:up": "node scripts/migrate.mjs up",
    "migrate:down": "node scripts/migrate.mjs down 1",
    "migrate:create": "cd apps/api && migrate create -ext sql -dir migrations",
    "sqlc:generate": "node scripts/sqlc.mjs"
  }
}
```

## Watcher: `apps/api/.air.toml`

`npm run dev:api` must run `cd apps/api && air`. Install air from its current module path
(the old `cosmtrek/air` path is deprecated) and keep it recent — since v1.6x air stops the
running binary before rebuilding on Windows, which otherwise locks the `.exe` and fails the
rebuild:

```bash
go install github.com/air-verse/air@latest   # lands in $(go env GOPATH)/bin — put that on PATH
```

Always create `.air.toml`:

```toml
root = "."
tmp_dir = "tmp"

[build]
# Always ".exe", on every OS. Windows only runs files with an executable extension: a plain
# "tmp/main" builds fine but air cannot start it, so dev:api stops. macOS/Linux run
# "main.exe" just the same, so one committed config works for the whole team.
cmd = "go build -o ./tmp/main.exe ./cmd/server"
bin = "./tmp/main.exe"
include_ext = ["go", "tpl", "tmpl", "html"]
exclude_dir = ["tmp", "vendor", "node_modules", "migrations"]

[log]
time = true

[misc]
clean_on_exit = true
```

Never drop the `.exe` from `cmd`/`bin` to make it "look Unix": air applies its Windows
`.exe` handling only to `full_bin`, not to `bin`, so on Windows a suffix-less binary is built
and then never runs — `npm run dev:api` just exits.

## Go structure

```txt
apps/api/
├── cmd/
│   └── server/
│       └── main.go            # assembles config → logger → database → kernel.Deps → server
├── internal/
│   ├── config/                # config.Load(), Get, Require
│   ├── database/              # Open (pool, parseTime), Ping
│   ├── kernel/                # Deps + Version — the contract modules build against
│   ├── server/                # health, /readyz, JSON 404, SPA, middleware
│   ├── shared/
│   │   ├── apperror/          # the client-facing error type
│   │   ├── logger/            # slog setup + request-scoped logger
│   │   ├── pagination/        # ?page=&limit= → Params, Meta
│   │   ├── request/           # DecodeJSON, PathInt64
│   │   ├── response/          # OK, Created, Paginated, Fail, Error — the envelope
│   │   └── validator/         # field-by-field input errors
│   └── modules/
│       ├── registry.go        # composition root: builds + mounts modules (elco:* markers)
│       ├── adapter_order_productcatalog.go   # connects one port to a provider
│       └── order/             # example module
│           ├── contracts/
│           ├── ports/
│           ├── application/
│           ├── domain/
│           │   └── events/
│           ├── infrastructure/
│           │   ├── queries/
│           │   │   └── order.sql
│           │   ├── sqlc/
│           │   └── repository.go
│           ├── presentation/
│           └── order.module.go
├── migrations/
│   ├── 20261024093000_baseline.up.sql
│   ├── 20261024093000_baseline.down.sql
│   ├── 20261102101500_create_orders_table.up.sql
│   └── 20261102101500_create_orders_table.down.sql
├── sqlc.yaml
├── .air.toml
├── go.mod
└── go.sum
```

The scaffold creates everything above except the example module: a Go project starts with no
domain modules, and each one is built or installed from the module library through the
registry. The kernel files are copied from this skill's `scripts/templates/go/` — read them
there for the full code.

## The kernel

`internal/config`, `database`, `kernel`, `server`, and `shared/` are the **kernel**: the stable
surface every module — hand-written or from the module library — is built against.

- **`kernel.Deps`** (`Config`, `DB`, `Log`, `Auth`, `Authz`) is what a module's `New` receives.
  A module keeps what it needs and never reaches for globals.
- **`Deps.Auth`** is the one kernel-level port: authentication. A module guards a handler with
  `d.Auth.Require(h)` and reads the signed-in user with `d.Auth.UserID(r.Context())`; the
  composition root fills the slot with `d.Auth.Provide(...)` from whichever module does auth.
  It lives in the kernel rather than in each module's `ports/` because nearly every module needs
  it — and `users` (guarded by auth) is also what `auth` needs, so per-module ports would make
  the two depend on each other. Until a provider is set, guarded routes answer 401.
- **`Deps.Authz`** is authorization, the second kernel-level port. A module **declares** the
  permissions it guards with in `New` — `d.Authz.Declare(kernel.Permission{Name: "users.manage",
  Module: "users", Description: "…"})`, named `<module>.<action>` — and guards with
  `d.Authz.Require("users.manage", h)` (401 without a session, 403 without the permission) or
  checks `d.Authz.Can(ctx, …)`. Guarding with an undeclared permission panics at startup. Without
  a provider the policy is "signed in = allowed", so a module works alone; an authorization
  module (the library's `rbac`) fills the slot with `d.Authz.Provide(...)` and reads the catalog
  from `d.Authz.Permissions()`. Permissions come from code; who holds them is data.
- **`kernel.Version`** is the contract version. A library module states the version it needs
  (`requires_kernel` in its `module.yaml`). Bump it only for a change that would break an
  existing module; adding something is not one.
- **Settings**: `config.Config` holds only what the kernel needs (`APP_ENV`, `APP_PORT`,
  `APP_NAME`, `DB_DSN`, `PUBLIC_DIR`). A module reads its own settings with `config.Get` or
  `config.Require` in its `New`, so a missing required value stops the API at startup.
- **Database**: `database.Open` sets `parseTime` (sqlc scans DATETIME into `time.Time`) without
  putting it in `DB_DSN`, which golang-migrate also reads. It does not dial — the API starts
  while MySQL is down, and `/readyz` answers 503 until it is reachable. That is what the image
  HEALTHCHECK and `deploy.sh` wait on.
- **Responses** go through `shared/response` only: `OK`, `Created`, `Paginated`, `Fail`, and
  `Error(w, r, err)`. A handler returns client errors as `*apperror.Error` (`BadRequest`,
  `NotFound`, `Validation`, …); any other error becomes a logged, generic 500, so internals
  never leak.
- **Input**: `request.DecodeJSON` (1 MiB cap, unknown fields rejected), `request.PathInt64`,
  `pagination.FromRequest`, and `validator.Validator`, which collects every field error into
  one 422.
- **Server**: `http.ServeMux` (Go 1.22+ method patterns such as `"GET /api/v1/orders/{id}"`),
  an unknown `/api/` path answers a JSON 404 instead of the SPA, and every request gets an
  `X-Request-ID` plus a logger carrying it (`logger.From(r.Context())`). Panics become a 500
  envelope. `SIGTERM` (`docker stop`) drains in-flight requests before exit.
- `shared/apperror` is not named `errors` so it never shadows the standard library package.

### Kernel versions

`kernel.Version` (and `apps/web/src/shared/kernel.ts`) is the contract number a library module's
`requires_kernel` is checked against — as a minimum. Bump it when the kernel gains something
modules may rely on; record what in the comment above `Version`.

| Version | Adds |
|---|---|
| 1 | `Deps` (`Config`, `DB`, `Log`, `Auth`), `shared/`, the module registries |
| 2 | `Deps.Authz` (`authz.go`); web: `shared/access.tsx` (`useCan`), `shared/app-events.ts`, `FrontendModule.provider`, `NavItem.permission`, `shared/kernel.ts` |
| 3 | web: `shared/lib/field-classes.ts` (`FIELD`), the Bingkai Navy primitives (`button` with `loading`, `input`, `card`, `dialog`), the `--animate-loader-slide` token in `theme.css`; Indonesian default messages in the kernel and starter pages |

A project scaffolded on an older kernel moves up by copying the new kernel files from this
skill's `scripts/templates/` (for 2: `internal/kernel/authz.go`, the `Authz` field in `Deps`,
its construction in `main.go`, and the web files above; for 3: `web/field-classes.ts`, the
`web/primitives/*`, and the `@theme` block of `web/theme.css`), then raising both version numbers.

## Module contract and the registry

A module never imports another module (rule and rationale:
[backend-modular-monolith.md](backend-modular-monolith.md#ports-contracts-and-the-composition-root)).
It depends only on the kernel and its own packages. What it needs from outside is a port in its
own `ports/`; what it offers is its `contracts/`.

A module's package root (`internal/modules/<name>/<name>.module.go`) exposes:

```go
// New builds the module from kernel.Deps plus one argument per port it needs — all of
// them types from its OWN ports package. An error (e.g. a required setting is missing, read
// with config.Require) stops the API at startup.
func New(d *kernel.Deps, users ports.UserStore) (*Module, error)

// Routes mounts the module's HTTP handlers.
func (m *Module) Routes(mux *http.ServeMux)

// Client returns the module's public contract — only for a module that offers one.
func (m *Module) Client() contracts.UserClient
```

`internal/modules/` (package `modules`) is the **composition root**, the only package that
imports modules. `registry.go` builds each module and mounts its routes; a module that offers
a contract comes before the modules wired to it. Each connection gets a small adapter in its
own file beside the registry, named `adapter_<consumer>_<port>.go`:

```go
// internal/modules/adapter_auth_userstore.go
// authUserStore satisfies auth's UserStore port with the users module's client.
type authUserStore struct{ users userscontracts.UserClient }

func (a authUserStore) FindByEmail(ctx context.Context, email string) (authports.User, error) {
	u, err := a.users.GetByEmail(ctx, email)
	if err != nil {
		return authports.User{}, err
	}
	return authports.User{ID: u.ID, Email: u.Email, PasswordHash: u.PasswordHash}, nil
}
```

```go
// internal/modules/registry.go
func Register(mux *http.ServeMux, d *kernel.Deps) error {
	// elco:modules:begin
	usersModule, err := users.New(d)
	if err != nil {
		return err
	}
	usersModule.Routes(mux)
	authModule, err := auth.New(d, authUserStore{users: usersModule.Client()})
	if err != nil {
		return err
	}
	authModule.Routes(mux)
	d.Auth.Provide(authModule.Authenticator())
	// elco:modules:end
	return nil
}
```

- An adapter only maps fields and forwards the call — no business logic. Logic belongs in a
  module.
- A port can be satisfied by anything: another module's client through an adapter, or code the
  project writes itself (e.g. its own user table) — the consumer never knows which.
- Imports go between `// elco:imports:begin` and `// elco:imports:end`. Keep every `elco:*`
  marker: the module library's installer inserts lines between them, and generates the
  adapter when the provider is a library module it knows.

## Migrations and sqlc per module

- Migrations are **timestamp-versioned** (`npm run migrate:create -- <name>` →
  `<yyyymmddhhmmss>_<name>.up.sql`), so migrations added on two branches never collide. A
  module's migrations create only the tables it owns.
- `npm run migrate:up|down` runs the golang-migrate CLI (same version as in the image):
  `go install -tags mysql github.com/golang-migrate/migrate/v4/cmd/migrate@v4.18.1`. The wrapper
  and the prod compose add `multiStatements=true`, so one migration file may hold several
  statements (a table and its seed rows). Keep `DB_DSN` free of `?params` — the app sets
  `parseTime` in code.
- The scaffold ships a no-op `<timestamp>_baseline` migration: golang-migrate fails `up` on an
  empty directory, which would break the first deploy.
- Each module adds its own `sql:` block to `sqlc.yaml`, between `# elco:sqlc:begin` and
  `# elco:sqlc:end`:

  ```yaml
    - engine: "mysql"
      schema: "migrations"
      queries: "internal/modules/order/infrastructure/queries"
      gen:
        go:
          package: "sqlc"
          out: "internal/modules/order/infrastructure/sqlc"
  ```

  sqlc refuses a config with no block at all ("no packages"), so `npm run sqlc:generate` runs
  through `scripts/sqlc.mjs`, which skips with a message until a module with queries is in.
