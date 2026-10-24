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
- Use `sqlc` for type-safe DB access, generated **per module**: `sqlc.yaml` has one `sql:` block per module, reading from `internal/modules/<module>/infrastructure/queries` and writing to `internal/modules/<module>/infrastructure/sqlc`. A single project-wide `sqlc` package would let any module import any other module's generated queries, breaking the contracts-only boundary. **Every new module must add its own `sql:` block** — otherwise its queries never get generated.
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
    "sqlc:generate": "cd apps/api && sqlc generate"
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
│       ├── registry.go        # the one place modules are wired (elco:* markers)
│       └── order/             # example module
│           ├── contracts/
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

- **`kernel.Deps`** (`Config`, `DB`, `Log`) is what a module's `New` receives. A module keeps
  what it needs and never reaches for globals.
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

## Module contract and the registry

A module's package root (`internal/modules/<name>/<name>.module.go`) exposes:

```go
// New builds the module. It takes kernel.Deps plus the contracts of the modules it calls.
func New(d *kernel.Deps, users userscontracts.UserClient) *Module

// Routes mounts the module's HTTP handlers.
func (m *Module) Routes(mux *http.ServeMux)

// Client returns the module's public contract — only for a module other modules call.
func (m *Module) Client() contracts.OrderClient
```

`internal/modules/registry.go` is the one place modules are wired. Each module is built and
mounted in dependency order — a provider before every module whose `New` takes its contract —
so the compiler checks the wiring:

```go
func Register(mux *http.ServeMux, d *kernel.Deps) {
	// elco:modules:begin
	usersModule := users.New(d)
	usersModule.Routes(mux)
	authModule := auth.New(d, usersModule.Client())
	authModule.Routes(mux)
	// elco:modules:end
}
```

The module's import goes between `// elco:imports:begin` and `// elco:imports:end`. Keep every
`elco:*` marker: the module library's installer inserts lines between them.

## Migrations and sqlc per module

- Migrations are **timestamp-versioned** (`npm run migrate:create -- <name>` →
  `<yyyymmddhhmmss>_<name>.up.sql`), so migrations added on two branches never collide. A
  module's migrations create only the tables it owns.
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

  sqlc refuses a config with no block at all ("no packages"), so `npm run sqlc:generate` only
  works once the first module is in.
