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
    "migrate:create": "cd apps/api && migrate create -ext sql -dir migrations -seq",
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

## Recommended Go structure

```txt
apps/api/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   ├── database/
│   │   ├── db.go
│   │   └── sqlc.go
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   └── order/
│   │       ├── contracts/
│   │       ├── application/
│   │       ├── domain/
│   │       │   └── events/
│   │       ├── infrastructure/
│   │       │   ├── queries/
│   │       │   │   └── order.sql
│   │       │   ├── sqlc/
│   │       │   └── repository.go
│   │       ├── presentation/
│   │       └── order.module.go
│   ├── router/
│   ├── server/
│   └── shared/
├── migrations/
│   ├── 000001_create_users_table.up.sql
│   └── 000001_create_users_table.down.sql
├── sqlc.yaml
├── .air.toml
├── go.mod
└── go.sum
```
