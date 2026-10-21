#!/usr/bin/env node
// Dimas Monorepo Standard — scaffolder
// Zero dependencies. Generates the standard-compliant skeleton (tree, config,
// knowledge gateway, .claude/rules, docs, frontend base, backend base per stack).
// Claude fills in project-specific code, modules, and knowledge/ content afterward.
//
// Usage:
//   node scripts/scaffold.mjs --name my-app --backend go --dir ./my-app
//
// Options:
//   --name <name>        project name (required)
//   --backend <stack>    go | nestjs | express (required)
//   --dir <path>         target directory (default: ./<name>)
//   --force              write into a non-empty directory
//   --help               show this help

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const BACKENDS = new Set(["go", "nestjs", "express"]);

function parseArgs(argv) {
  const out = { force: false };
  const takeValue = (flag, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${flag} requires a value`);
      out.bad = true;
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--force") out.force = true;
    else if (a === "--name") out.name = takeValue(a, ++i);
    else if (a === "--backend") out.backend = takeValue(a, ++i);
    else if (a === "--dir") out.dir = takeValue(a, ++i);
    else if (a === "--slug") out.slug = takeValue(a, ++i);
    else if (a === "--port") out.port = takeValue(a, ++i);
    else if (a === "--ghcr-owner") out.ghcrOwner = takeValue(a, ++i);
    else if (a === "--repo") out.repo = takeValue(a, ++i);
    else if (a === "--domain") out.domain = takeValue(a, ++i);
    else {
      console.error(`Unknown argument: ${a}`);
      out.bad = true;
    }
  }
  return out;
}

const HELP = `Dimas Monorepo Standard — scaffolder

Usage:
  node scripts/scaffold.mjs --name <name> --backend <go|nestjs|express> [--dir <path>] [--force]
    [--slug <app>] [--port <n>] [--ghcr-owner <owner>] [--repo <repo>] [--domain <domain>]

Options:
  --name <name>          project name (required)
  --backend <stack>      go | nestjs | express (required)
  --dir <path>           target directory (default: ./<name>)
  --force                write into a non-empty directory
  --help                 show this help

Deploy target: elcodelabs VPS (see references/docker-deployment.md). Omitted values are
written as __PLACEHOLDER__ markers that infra/elcodelabs/deploy.sh refuses to run with.
  --slug <app>           server app name: ~/<app>, <app>-app, <app>_db, <app>_user
                         (default: --name lowercased, letters/digits only)
  --port <n>             unique 127.0.0.1 port on the VPS — next free one in the playbook
                         registry, confirmed with \`ssh elcodelabs 'sudo ss -tlnp'\`
  --ghcr-owner <owner>   GitHub owner of the repo; image = ghcr.io/<owner>/<repo>
  --repo <repo>          GitHub repo name (default: npm-safe --name)
  --domain <domain>      public domain for the host nginx site (default: <domain>)
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { process.stdout.write(HELP); process.exit(0); }
if (args.bad) { process.stderr.write("\n" + HELP); process.exit(1); }

const errors = [];
if (!args.name) errors.push("--name is required");
if (!args.backend) errors.push("--backend is required");
else if (!BACKENDS.has(args.backend)) errors.push(`--backend must be one of: ${[...BACKENDS].join(", ")}`);
// Deploy identity (elcodelabs VPS). The slug feeds MySQL names: <slug>_user must fit
// MySQL's 32-char user limit, and folder/container/database names must stay predictable.
const slug = args.slug ?? (args.name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
if (args.name && !/^[a-z][a-z0-9]{1,23}$/.test(slug)) {
  errors.push(`--slug must be 2-24 chars, lowercase letters/digits, starting with a letter (got ${JSON.stringify(slug)})`);
}
if (args.port !== undefined && !(/^\d+$/.test(args.port) && +args.port >= 1024 && +args.port <= 65535)) {
  errors.push(`--port must be a number between 1024 and 65535 (got ${JSON.stringify(args.port)})`);
}
if (args.ghcrOwner !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(args.ghcrOwner)) {
  errors.push(`--ghcr-owner must be a GitHub user/org name (got ${JSON.stringify(args.ghcrOwner)})`);
}
if (errors.length) {
  process.stderr.write("Error:\n  - " + errors.join("\n  - ") + "\n\n" + HELP);
  process.exit(1);
}

const name = args.name;
const backend = args.backend;
const rawDir = args.dir || `./${name}`;
// ~ isn't expanded by the OS for a literal argument string (only an interactive shell does
// that, and PowerShell doesn't even do that), so expand it ourselves for convenience.
const expandedDir = rawDir === "~" || rawDir.startsWith("~/") || rawDir.startsWith("~\\")
  ? join(homedir(), rawDir.slice(1))
  : rawDir;
const targetDir = resolve(expandedDir);

if (existsSync(targetDir)) {
  if (!statSync(targetDir).isDirectory()) {
    process.stderr.write(`Error: --dir points to an existing file, not a directory: ${targetDir}\n`);
    process.exit(1);
  }
  if (readdirSync(targetDir).length > 0 && !args.force) {
    process.stderr.write(`Error: target directory is not empty: ${targetDir}\nUse --force to write anyway.\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------
const files = {};   // relativePath -> content
const keepDirs = []; // directories to create with a .gitkeep
const file = (p, content) => { files[p] = content; };
const keep = (...dirs) => keepDirs.push(...dirs);

const goModule = name.replace(/[^a-zA-Z0-9._/-]/g, "-").toLowerCase();
// npm package names have their own rules: lowercase, no spaces.
const npmName = name
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^[-_.]+|[-_.]+$/g, "") || "app";
const isNodeBackend = backend === "nestjs" || backend === "express";

// Values missing at scaffold time become loud markers rather than guesses: a wrong port
// collides with another app on the shared VPS, a wrong owner pulls the wrong image.
const vpsPort = args.port ?? "__VPS_PORT__";
const ghcrOwner = args.ghcrOwner ? args.ghcrOwner.toLowerCase() : "__GHCR_OWNER__";
const repoName = (args.repo ?? npmName).toLowerCase();
const image = `ghcr.io/${ghcrOwner}/${repoName}`;
const domain = args.domain ?? "<domain>";
const missingDeploy = [
  !args.port && "--port",
  !args.ghcrOwner && "--ghcr-owner",
  !args.domain && "--domain",
].filter(Boolean);
const workspaces = isNodeBackend
  ? ["apps/web", "apps/api", "packages/*"]
  : ["apps/web", "packages/*"];

// ---------------------------------------------------------------------------
// Root files
// ---------------------------------------------------------------------------
const rootScripts = {
  go: {
    "dev:web": "npm run dev -w apps/web",
    "dev:api": "cd apps/api && air",
    "build:web": "npm run build -w apps/web",
    "build:api": "cd apps/api && go build -o ../../dist/api ./cmd/server",
    "migrate:up": "node scripts/migrate.mjs up",
    "migrate:down": "node scripts/migrate.mjs down 1",
    "migrate:create": "cd apps/api && migrate create -ext sql -dir migrations -seq",
    "sqlc:generate": "cd apps/api && sqlc generate",
  },
  nestjs: {
    "dev:web": "npm run dev -w apps/web",
    "dev:api": "npm run start:dev -w apps/api",
    "build:web": "npm run build -w apps/web",
    "build:api": "npm run build -w apps/api",
    "migrate:up": "npm run prisma:migrate -w apps/api",
    "migrate:deploy": "npm run prisma:deploy -w apps/api",
    "migrate:reset": "npm run prisma:reset -w apps/api",
  },
  express: {
    "dev:web": "npm run dev -w apps/web",
    "dev:api": "npm run dev -w apps/api",
    "build:web": "npm run build -w apps/web",
    "build:api": "npm run build -w apps/api",
  },
}[backend];

file("package.json", JSON.stringify({
  name: npmName,
  private: true,
  version: "0.1.0",
  description: `${name} — monorepo (Dimas standard)`,
  workspaces,
  scripts: rootScripts,
}, null, 2) + "\n");

file(".gitignore", `node_modules/
dist/
build/
tmp/
.env
*.local
.DS_Store
coverage/
# Go
/dist/api
apps/api/tmp/
# Prisma
apps/api/prisma/*.db
`);

file(".dockerignore", `node_modules
**/node_modules
dist
build
tmp
.git
.github
.claude
knowledge
analysis
infra/elcodelabs
.env
.env.*
*.md
`);

const dbName = `${slug}_db`;

const dbUrlLine = backend === "go"
  ? `# Go DSN (database/sql + MySQL driver) — no scheme prefix\nDB_DSN=root:@tcp(localhost:3306)/${dbName}`
  : `# Prisma URI\nDATABASE_URL=mysql://root:password@localhost:3306/${dbName}`;

file(".env.example", `APP_ENV=development
APP_PORT=8080
APP_NAME=${name}

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=${dbName}
${dbUrlLine}

JWT_SECRET=change-me
JWT_EXPIRES_IN=24h

# Production build directory of the frontend, served by the container.
# Left empty in dev — the frontend is served by Vite instead.
PUBLIC_DIR=

# Left empty so the frontend uses the same origin (see the Vite proxy in vite.config.ts).
# Only set this when web and api are actually deployed separately.
VITE_API_BASE_URL=
`);

file("docker-compose.yml", `# LOCAL ONLY — builds from source for a quick check on your own machine.
# Production never builds: see infra/elcodelabs/docker-compose.prod.yml (image-only).
services:
  app:
    build:
      context: .
      dockerfile: infra/docker/Dockerfile
    ports:
      - "8080:8080"
    # Copy .env.example to .env before running compose.
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
`);

file("README.md", `# ${name}

Monorepo generated to Dimas' standard (modular-monolith backend + React 19 frontend).

## Development

Run frontend and backend separately from the project root:

\`\`\`bash
npm run dev:web
npm run dev:api
\`\`\`

## Structure

- \`apps/web\` — React 19 + Tailwind 4 frontend
- \`apps/api\` — ${backend} modular-monolith backend
- \`packages/\` — shared code and API contract
- \`knowledge/\` — the project's one knowledge base; read the relevant file before editing,
  starting at \`knowledge/INDEX.md\`
- \`.claude/rules/\` — path-scoped technical rules
- \`analysis/\` — per-requirement analysis artifacts (see \`analysis/README.md\`)
- \`infra/\` — Docker image, host nginx site, and the elcodelabs VPS deploy files
- \`.github/workflows/\` — \`ci\` (checks) and \`release-image\` (builds the image to GHCR)

## Deployment

One image, one container on the elcodelabs VPS: built in CI, pulled by the server, database on
the host — see \`knowledge/DEPLOYMENT.md\`.
`);

// ---------------------------------------------------------------------------
// CLAUDE.md gateway
// ---------------------------------------------------------------------------
file("CLAUDE.md", `# ${name} — Claude Code Gateway

Project: ${name}. Backend: ${backend} (modular monolith). Frontend: React 19 + Tailwind 4.

## Commands (run from root)

\`\`\`bash
npm run dev:web   # start frontend
npm run dev:api   # start backend
\`\`\`

## Critical architecture rules

These few invariants are restated here on purpose: this file is always loaded and
\`.claude/rules/\` is not. \`.claude/rules/\` holds the authoritative, path-scoped version — if
the two ever disagree, the rules file wins and the drift is a finding to report.

- Backend is a **modular monolith**. A module exposes only \`contracts/\` to other modules.
  No cross-module service/repository/domain imports, no cross-module DB joins or foreign keys.
- Cross-module relations are stored as primitive IDs and resolved via module clients.
- Frontend uses the \`@/*\` alias, lazy routes, Zustand, Zod, Axios. Theme color is centralized.
- Deploy = one image, one container on the elcodelabs VPS, built in CI and only pulled by the
  server; the database is the host's shared MySQL. Rules: \`.claude/rules/deployment.md\`.

## Before changing code

Read the relevant file in \`knowledge/\` first (start at \`knowledge/INDEX.md\`), and follow
the path-scoped rules in \`.claude/rules/\`. Beyond the invariants above, do not copy their
content into this file — route to it. This is a gateway, not a documentation dump.

If two sources of truth disagree, follow \`knowledge/SOURCE_PRIORITY.md\` — and report the
conflict, don't silently pick one.
`);

// ---------------------------------------------------------------------------
// knowledge/ — the project's single knowledge rack (see R-01: docs/ no longer exists;
// every fact has exactly one home, and knowledge/SOURCE_PRIORITY.md resolves conflicts).
// ---------------------------------------------------------------------------
const kStub = (title, purpose) => `# ${title}\n\n> ${purpose}\n\n_TODO: fill in for ${name}._\n`;
// Four knowledge files pair 1:1 by topic with a file in .claude/rules/. That pairing is the
// standard's biggest redundancy risk once the TODOs get filled, so each such stub carries an
// explicit delta-only instruction naming the rule that stays authoritative.
const kDelta = (title, purpose, rule) =>
  `# ${title}\n\n> ${purpose}\n\n_TODO: fill in for ${name}._\n\nProject-specific detail only — the standing rule lives in\n\`.claude/rules/${rule}\` and stays authoritative. Do not restate it here.\n`;
file("knowledge/INDEX.md", `# Knowledge Index — ${name}

Routing only. Open the file that matches your task before editing code — each file states its
own scope in its header, so the labels below stay short on purpose.

- [SOURCE_PRIORITY.md](SOURCE_PRIORITY.md) — conflict resolution
- [PROJECT.md](PROJECT.md) — brief, scope, user stories
- [ARCHITECTURE.md](ARCHITECTURE.md) — apps, modules, data flow
- [MODULE_MAP.md](MODULE_MAP.md) — per-module responsibility & contract
- [GLOSSARY.md](GLOSSARY.md) — terminology
- [API.md](API.md) — endpoints
- [DATABASE.md](DATABASE.md) — schema & table ownership
- [FRONTEND.md](FRONTEND.md) — frontend conventions
- [BACKEND.md](BACKEND.md) — backend conventions
- [DEPLOYMENT.md](DEPLOYMENT.md) — run, build, deploy, env
- [decisions/](decisions/) — ADRs
`);
file("knowledge/SOURCE_PRIORITY.md", `# Source Priority

When two sources disagree, the higher one wins — but never resolve a real conflict silently.
Raise it as a finding instead.

1. \`knowledge/decisions/ADR-*\` — ratified decisions
2. This monorepo standard + \`.claude/rules/\`
3. Code, config, active migrations
4. \`knowledge/*\`
5. AI observations & hypotheses

Code shows what **actually happens**, not what **should**.
If (3) and (4) disagree, that's a conflict to report — not a choice to make on your own.
`);
file("knowledge/PROJECT.md", kStub("Project Brief", "What this project is and why it exists; features, scope, and user stories."));
file("knowledge/ARCHITECTURE.md", kStub("Architecture", "Apps, modules, data flow, and boundaries."));
file("knowledge/MODULE_MAP.md", `# Module Map

> Each module's responsibility, public contract, owned tables, and external integrations.

| Module | Responsibility | Public contract | Owned tables | External integrations |
|---|---|---|---|---|
| auth | _TODO_ | _TODO_ | _TODO_ | _TODO_ |
| users | _TODO_ | _TODO_ | _TODO_ | _TODO_ |
| order | _TODO_ | _TODO_ | _TODO_ | _TODO_ |

_TODO: fill in for ${name}. Fill all five columns — "Owned tables" and "External integrations"
are what let a later analysis catch a cross-module join, or a secondary integration a
requirement implies but never states._

"Owned tables" is a **name-only index**; \`DATABASE.md\` stays authoritative for schema detail.
Keep the two in sync — if they disagree, report the conflict, don't pick one.
`);
file("knowledge/GLOSSARY.md", kStub("Glossary", "Shared terminology used across the project."));
file("knowledge/API.md", kDelta("API", "Endpoints this project exposes.", "api-standard.md"));
file("knowledge/DATABASE.md", kDelta("Database", "Tables, fields, and which module owns each.", "database.md"));
file("knowledge/FRONTEND.md", kDelta("Frontend", "Frontend structure and screens specific to this project.", "frontend-react.md"));
file("knowledge/BACKEND.md", kDelta("Backend", "Backend structure and modules specific to this project.", "backend-modular-monolith.md"));
file("knowledge/DEPLOYMENT.md", `# Deployment — ${name}

Owns this project's concrete deploy facts and procedure. The rules every deploy file must keep
are in \`.claude/rules/deployment.md\`; the server's own convention is the canonical
\`/opt/elcodelabs/SERVER_PLAYBOOK.md\` on the VPS (\`ssh elcodelabs\`) — re-read it before any
server change, it is updated as apps are added.

## Local
The dev commands live in \`CLAUDE.md\` (agents) and \`README.md\` (humans) — not repeated here.

\`docker compose up --build\` (root \`docker-compose.yml\`) builds the image from source on
your own machine for a quick check — never on the VPS. Set the DB env in \`.env\` first.

## Target: elcodelabs VPS

| Fact | Value |
|---|---|
| App name (slug) | \`${slug}\` |
| Server folder | \`~/${slug}\` (\`docker-compose.prod.yml\`, \`deploy.sh\`, \`.env\`, \`backups/\`) |
| Container | \`${slug}-app\` |
| Port | \`127.0.0.1:${vpsPort}\` on the host → \`8080\` in the container |
| Database / user | \`${dbName}\` / \`${slug}_user@'172.%'\` (\`mysql_native_password\`) |
| Image | \`${image}:<git-sha>\` (\`:latest\` is also pushed but never deployed) |
| Domain | \`${domain}\` |

One image serves the static frontend and the API on port 8080. The container reaches the
host MySQL via \`host.docker.internal\` (\`extra_hosts: host-gateway\`). Users are created
with \`mysql_native_password\` because the app connects over the internal docker bridge
without TLS, which MySQL 8's default \`caching_sha2_password\` rejects (ERROR 2061).

## Release flow

merge to \`main\` → \`ci\` green → \`release-image\` pushes \`${image}:<git-sha>\` →
on the VPS: \`cd ~/${slug} && ./deploy.sh <git-sha>\`
(preflight → pull → DB backup → migrate → up → wait for \`/readyz\`).

Rollback = \`./deploy.sh <older-git-sha>\`. Migrations are forward-only: a rollback across a
schema change needs a forward fix, not a down-migration on production.

## First-time server setup (once)

Every step below changes the shared server — do it only with the owner's go-ahead.

1. **Port** — take the next free port from the App registry in the playbook and confirm it
   with \`ssh elcodelabs 'sudo ss -tlnp'\`.
2. **Database + dedicated user** on the host MySQL (password: \`openssl rand -hex 24\`):
   \`\`\`sql
   CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER '${slug}_user'@'172.%' IDENTIFIED WITH mysql_native_password BY '<random-hex>';
   GRANT ALL PRIVILEGES ON ${dbName}.* TO '${slug}_user'@'172.%';
   FLUSH PRIVILEGES;
   \`\`\`
3. **Server folder** — \`mkdir -p ~/${slug}\`; copy \`infra/elcodelabs/docker-compose.prod.yml\`
   and \`infra/elcodelabs/deploy.sh\` into it, and \`infra/elcodelabs/.env.production.example\`
   as \`.env\`; fill in real values; \`chmod 600 .env\`.
4. **Registry access** — new GHCR packages are private: either \`docker login ghcr.io\` on the
   VPS with a read-only (\`read:packages\`) token, or set the package to Public.
5. **First deploy** (database still empty): \`SKIP_BACKUP=1 ./deploy.sh <git-sha>\`.
6. **nginx + TLS** — copy \`infra/nginx/nginx.conf\` to \`/etc/nginx/sites-available/${slug}\`,
   \`sudo ln -s /etc/nginx/sites-available/${slug} /etc/nginx/sites-enabled/\`,
   \`sudo nginx -t && sudo systemctl reload nginx\`, then \`sudo certbot --nginx -d ${domain}\`
   (point the domain's DNS A record at the VPS first).
7. **Registry entry** — add this app's row to the playbook's App registry.
`);
file("knowledge/decisions/ADR-0001-monorepo-structure.md", `# ADR-0001: Monorepo structure

## Status
Accepted

## Context
${name} uses a single repository for the frontend (\`apps/web\`) and backend (\`apps/api\`)
plus shared packages.

## Decision
Adopt the Dimas monorepo standard: apps/, packages/, knowledge/, .claude/rules/, analysis/, infra/.
\`knowledge/\` is the single knowledge rack — there is no separate \`docs/\` for stakeholders.
Enforced while editing by \`.claude/rules/monorepo.md\`.

## Consequences
Consistent structure and one home per fact. The cost is discipline: a new document has to
claim an existing owner's job or justify a new one, rather than being added alongside.
`);
file("knowledge/decisions/ADR-0002-modular-monolith.md", `# ADR-0002: Modular monolith backend

## Status
Accepted

## Context
We want clean module boundaries without the operational cost of microservices.

## Decision
Backend is a modular monolith with contracts-only module boundaries. The enforceable form of
this decision — what exactly is forbidden — is authoritative in
\`.claude/rules/backend-modular-monolith.md\`; this ADR records only why it was chosen.

## Consequences
Modules stay decoupled and could be extracted later if ever needed. The price paid on purpose:
cross-module reads go through a client instead of a join, so some reads cost an extra hop.
`);
file("knowledge/decisions/ADR-0003-frontend-standard.md", `# ADR-0003: Frontend standard

## Status
Accepted

## Context
We want a consistent, simple frontend stack.

## Decision
Adopt the standard React 19 + Tailwind 4 stack. The stack list and its conventions are
authoritative in \`.claude/rules/frontend-react.md\`; this ADR records only why it was chosen:
one obvious way to do routing, state, validation, and HTTP, with nothing added speculatively.

## Consequences
Predictable structure and simple data patterns. No server-cache layer (e.g. TanStack Query)
until a real need proves one — revisit this ADR rather than adding it silently.
`);

file("knowledge/decisions/ADR-0004-deploy-elcodelabs.md", `# ADR-0004: Deploy to the elcodelabs VPS — image from CI, server only pulls

## Status
Accepted

## Context
${name} runs on the shared elcodelabs VPS beside other apps. The box is small (2 GB RAM) and
follows one fixed convention for every app, so any of them can be deployed, debugged, or rolled
back the same way.

## Decision
Follow that convention as-is: one image and one container for the whole monorepo, built in CI
and pushed to GHCR, pulled and run by the server, on the host's shared MySQL. The enforceable
form is authoritative in \`.claude/rules/deployment.md\`; this project's concrete server facts
and procedure live in \`knowledge/DEPLOYMENT.md\`. This ADR records only why.

## Consequences
Builds never compete with running apps for the server's memory, and every release is an
immutable image that can be redeployed to roll back. The price paid on purpose: a release needs
a green CI run and a registry pull — there is no "quick fix directly on the server".
`);

// ---------------------------------------------------------------------------
// .claude/rules/
// ---------------------------------------------------------------------------
file(".claude/rules/monorepo.md", `# Rule: Monorepo

Applies to: whole repository.

- Frontend and backend start separately (the commands live in \`CLAUDE.md\`). Do not introduce a
  combined \`npm run dev\` or \`concurrently\` unless explicitly requested.
- \`CLAUDE.md\` carries only the always-loaded invariants; detail belongs in \`knowledge/\`.
- \`knowledge/\` is the project's only knowledge rack. There is no parallel \`docs/\`.
- Every fact has one owner. Before writing a fact into a second file, check whether the file
  that already owns it should be updated instead — and if a summary really is needed, name the
  authoritative file next to it.
- Do not use by default unless explicitly requested: Microservices, Kubernetes, Turborepo complexity, Nx, Redis, Memcache, TanStack libraries, multiple frontend containers, separate backend/frontend production containers, Dockerized database, cross-module foreign keys, cross-module joins, GORM (or GORM AutoMigrate) for Go.
`);
file(".claude/rules/backend-modular-monolith.md", `# Rule: Backend modular monolith

Applies to: \`apps/api/**\`.

- Each module is a boundary. Only \`contracts/\` is public to other modules.
- Forbidden: importing another module's application/infrastructure/domain internals.
- Forbidden: cross-module DB joins and cross-module foreign keys.
- Cross-module relations are primitive IDs; resolve via module clients.
- Transactions are scoped inside a single module; orchestrate cross-module flows via app services.
- \`shared/\` holds only technical utilities (errors, response, logger, validator, pagination, utils) — never domain logic.
`);
file(".claude/rules/frontend-react.md", `# Rule: Frontend (React)

Applies to: \`apps/web/**\`.

- React 19 + Tailwind 4, react-router-dom with lazy-loaded routes/pages.
- State: Zustand (global in \`shared/stores\`, module state in \`modules/<m>/stores\`).
- Validation: Zod schemas in \`modules/<m>/schemas\`. Prefer \`z.infer\` over manual form types.
- HTTP: all requests go through \`shared/services/http-client.ts\` (one Axios instance).
- Use the \`@/*\` import alias. Centralize theme color in \`src/theme/\`.
- Shared UI components must be domain-agnostic. Use the \`frontend-design\` skill for UI; if it isn't installed, install it first from https://github.com/anthropics/skills/tree/main/skills/frontend-design (do not skip it).
`);
file(".claude/rules/database.md", `# Rule: Database

Applies to: \`apps/api/**\`.

- A repository accesses only the tables its own module owns.
- Cross-module boundary rules (no joins, no foreign keys, relations as primitive IDs) are
  authoritative in \`backend-modular-monolith.md\` — not restated here.
${backend === "go" ? "- Go: golang-migrate for migrations, sqlc for access, database/sql + MySQL driver. Not GORM.\n" : ""}${backend === "nestjs" ? "- NestJS: Prisma migrations (not TypeORM unless explicitly requested).\n" : ""}${backend === "express" ? "- Express: migration tool is not locked — confirm the choice before implementing migrations.\n" : ""}`);
file(".claude/rules/deployment.md", `# Rule: Deployment (elcodelabs VPS)

Applies to: \`infra/**\`, \`.github/workflows/**\`, \`docker-compose.yml\`, \`.dockerignore\`.

- One application = one image = one container. The monorepo ships web + api together; never
  split it across containers and never co-host another app in it.
- The VPS never builds. \`.github/workflows/release-image.yml\` builds the image and pushes it to
  GHCR; the server only pulls. No \`build:\` in \`infra/elcodelabs/docker-compose.prod.yml\`.
- Deploy an immutable \`<git-sha>\` tag, never \`latest\`; \`IMAGE_TAG\` stays required in the
  prod compose.
- MySQL is the host's shared install: one database + one dedicated user for this app, granted
  on its own database only. Never add a database container or service; never publish 3306.
- The container publishes to \`127.0.0.1:<port>\` only; public traffic enters through the host
  nginx + certbot. The nginx site never claims \`default_server\`.
- Secrets live only in \`~/<app>/.env\` on the server (chmod 600). Commit only \`*.example\`
  env files; never bake secrets into the image.
- The image runs as a non-root user with a HEALTHCHECK on \`/readyz\`, and uses ENTRYPOINT
  (not CMD). The container stays \`read_only\`; anything writable is an explicit volume.
- Every deploy runs \`infra/elcodelabs/deploy.sh <git-sha>\`: DB backup before migrate,
  migrations forward-only.
- Concrete values (port, names, image, domain) are owned by \`knowledge/DEPLOYMENT.md\`. Any
  change on the VPS itself needs the owner's explicit go-ahead.
`);
file(".claude/rules/api-standard.md", `# Rule: API standard

Applies to: \`apps/api/**\`.

- Version endpoints under \`/api/v1\`.
- Success: \`{ success: true, message, data }\`. Error: \`{ success: false, message, errors }\`.
- Paginated: include \`meta: { page, limit, total, total_pages }\`.
`);

// ---------------------------------------------------------------------------
// analysis/ — per-requirement analysis artifacts (used by the monorepo-analyze skill).
// Committed on purpose: it's the record of why something was built a given way, for
// future-you and for the next Claude session. Never edited after being written — a
// changed understanding gets a new analysis folder, not a rewrite of the old one.
// ---------------------------------------------------------------------------
file("analysis/README.md", `# Analysis

Per-requirement analysis artifacts, one folder per requirement:
\`analysis/<NNN>-<slug>/\` or \`analysis/<ISSUE-ID>-<slug>/\` if there's an issue tracker.

Each folder contains: \`analysis.md\`, \`flow.mmd\`, \`sequence.mmd\`, and optionally \`erd.mmd\`.

This folder is committed on purpose — it's the record of why something was built the way it
was, for future-you and for the next Claude session. Do not gitignore it.

Artifacts here are never edited after being written. If understanding changes, write a new
analysis — don't rewrite the old one.
`);

// ---------------------------------------------------------------------------
// infra/
// ---------------------------------------------------------------------------
// Deploy target: the elcodelabs VPS. Its convention (canonical copy on the server at
// /opt/elcodelabs/SERVER_PLAYBOOK.md) is what every file below encodes:
//   1 app = 1 image = 1 container · images built in CI → GHCR, the VPS only pulls ·
//   host-level shared MySQL (1 DB + 1 user per app) · 127.0.0.1:<port> behind host nginx ·
//   secrets only in ~/<app>/.env. See references/docker-deployment.md.

// Host nginx site (installed under /etc/nginx/sites-available on the VPS — not a compose service).
file("infra/nginx/nginx.conf", `# Host nginx site for ${slug} on the elcodelabs VPS (NOT a compose service).
# Install steps: knowledge/DEPLOYMENT.md. TLS is added afterwards by \`certbot --nginx\`.
#
# Do NOT add \`default_server\`: only one is allowed per :80 and another app already holds it
# (\`nginx -t\` fails with "duplicate default_server").
server {
  listen 80;
  server_name ${domain};

  client_max_body_size 10m;

  location / {
    proxy_pass http://127.0.0.1:${vpsPort};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
  }

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Frame-Options DENY always;
  # Enable HSTS only after certbot has installed TLS (certbot does not add it):
  # add_header Strict-Transport-Security "max-age=31536000" always;
}
`);

const dockerHeader = `# One image = the whole app (static frontend + API). Built ONLY in CI
# (.github/workflows/release-image.yml); the elcodelabs VPS never builds — it pulls
# ${image}:<git-sha>.
# - Commit package-lock.json: with it the build uses \`npm ci\` (reproducible).
# - Runs as non-root uid 10001 with a HEALTHCHECK on /readyz.
# - ENTRYPOINT, not CMD: \`docker run <image> <args>\` passes args to the app instead of
#   replacing it (a CMD here once broke a one-off \`migrate\` run on this server).
`;
const npmInstall = `RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi`;
const healthcheck = `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \\
  CMD wget -qO- http://127.0.0.1:8080/readyz >/dev/null || exit 1`;

if (backend === "go") {
  file("infra/docker/Dockerfile", `${dockerHeader}# - go.sum must be committed (run \`go mod tidy\` once after scaffolding).
# - golang-migrate ships inside the image so the VPS can migrate without a Go toolchain.

FROM node:22-alpine AS web
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/web ./apps/web
${npmInstall}
RUN npm run build -w apps/web

FROM golang:1.22-alpine AS api
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false
WORKDIR /src/apps/api
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api ./
RUN go build -trimpath -ldflags "-s -w" -o /out/api ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget \\
 && addgroup -S app && adduser -S -G app -u 10001 app
WORKDIR /app
COPY --from=api /out/api ./api
COPY --from=migrate/migrate:v4.18.1 /usr/local/bin/migrate /usr/local/bin/migrate
COPY apps/api/migrations ./migrations
COPY --from=web /repo/apps/web/dist ./public
ENV APP_ENV=production APP_PORT=8080 PUBLIC_DIR=/app/public
USER app
EXPOSE 8080
${healthcheck}
ENTRYPOINT ["./api"]
`);
} else {
  const entry = backend === "nestjs" ? "apps/api/dist/main.js" : "apps/api/dist/index.js";
  const prisma = backend === "nestjs";
  file("infra/docker/Dockerfile", `${dockerHeader}${prisma ? "# - Prisma CLI + engines stay in node_modules so the VPS runs `prisma migrate deploy` from\n#   this same image (openssl is required by the Prisma engines on Alpine).\n" : ""}
FROM node:22-alpine AS build
${prisma ? "RUN apk add --no-cache openssl\n" : ""}WORKDIR /repo
COPY . .
${npmInstall}
${prisma ? "RUN npx prisma generate --schema apps/api/prisma/schema.prisma\n" : ""}RUN npm run build -w apps/web && npm run build -w apps/api \\
 && mkdir -p apps/api/node_modules

FROM node:22-alpine
RUN apk add --no-cache ${prisma ? "openssl " : ""}tzdata \\
 && addgroup -S app && adduser -S -G app -u 10001 app
WORKDIR /app
COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
${prisma ? "COPY --from=build /repo/apps/api/prisma ./apps/api/prisma\n" : ""}COPY --from=build /repo/apps/web/dist ./public
ENV NODE_ENV=production APP_ENV=production APP_PORT=8080 PUBLIC_DIR=/app/public
USER app
EXPOSE 8080
${healthcheck}
ENTRYPOINT ["node", "${entry}"]
`);
}

// One-off migration runner, same image as the app (profile "ops" keeps it out of `up`).
const migrateService = {
  go: `
  # One-off: \`docker compose -f docker-compose.prod.yml --profile ops run --rm migrate\`
  # (deploy.sh runs it BEFORE the new container starts). Same image, golang-migrate entrypoint;
  # DB_DSN is read from .env.
  migrate:
    image: ${image}:\${IMAGE_TAG:?IMAGE_TAG is not set — run ./deploy.sh <git-sha>}
    profiles: ["ops"]
    entrypoint: ["migrate", "-path", "/app/migrations", "-database", "mysql://\${DB_DSN}"]
    command: ["up"]
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
`,
  nestjs: `
  # One-off: \`docker compose -f docker-compose.prod.yml --profile ops run --rm migrate\`
  # (deploy.sh runs it BEFORE the new container starts). Same image, Prisma entrypoint;
  # DATABASE_URL is read from .env.
  migrate:
    image: ${image}:\${IMAGE_TAG:?IMAGE_TAG is not set — run ./deploy.sh <git-sha>}
    profiles: ["ops"]
    entrypoint: ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
`,
  express: `
  # No migrate service yet: the Express migration tool is not locked (apps/api/MIGRATION.md).
  # Once chosen, add a profile-"ops" migrate service here (same image) and wire it in deploy.sh.
`,
}[backend];

file("infra/elcodelabs/docker-compose.prod.yml", `# PRODUCTION on the elcodelabs VPS — copied to ~/${slug}/docker-compose.prod.yml, next to
# ~/${slug}/.env (chmod 600) and ~/${slug}/deploy.sh. Deploy: \`cd ~/${slug} && ./deploy.sh <git-sha>\`.
#
# IMAGE-ONLY — no \`build:\`. The 2 GB VPS only pulls images built by
# .github/workflows/release-image.yml. Never build on the server.
#
# IMAGE_TAG is REQUIRED (no \`latest\` fallback): deploy.sh writes it into .env, so a manual
# \`docker compose up\` stays on the version last deployed instead of a stale local \`latest\`.
services:
  app:
    image: ${image}:\${IMAGE_TAG:?IMAGE_TAG is not set — run ./deploy.sh <git-sha>}
    container_name: ${slug}-app
    restart: unless-stopped
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway" # MySQL runs on the host, never in a container
    ports:
      - "127.0.0.1:${vpsPort}:8080" # loopback only; host nginx + TLS sits in front
    # Anything the app writes needs an explicit volume owned by uid 10001, e.g.
    #   volumes: ["./data/storage:/data/storage"]
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - "no-new-privileges:true"
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          memory: 512M # shared 2 GB box — raise only with a measured reason
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/readyz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging: # cap logs so the disk never fills
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
${migrateService}`);

const migrateStep = backend === "express"
  ? `if [ "\${SKIP_MIGRATE:-0}" = "1" ]; then
  echo "  (SKIP_MIGRATE=1 — skipped)"
else
  echo "  ✗ no migration tool chosen yet (apps/api/MIGRATION.md). Add a migrate service to"
  echo "    docker-compose.prod.yml and call it here, or rerun with SKIP_MIGRATE=1."
  exit 1
fi`
  : `$COMPOSE --profile ops run --rm migrate`;

file("infra/elcodelabs/deploy.sh", `#!/usr/bin/env bash
# ${name} — deploy on the elcodelabs VPS (procedure: knowledge/DEPLOYMENT.md).
# The VPS NEVER builds: CI (release-image.yml) builds & pushes to GHCR; this script only does
#   preflight -> pull -> DB backup -> migrate -> up -> wait for /readyz.
#
# Usage (on the VPS, from ~/${slug}):
#   ./deploy.sh <git-sha>         deploy that exact, immutable image
#   ./deploy.sh <older-git-sha>   rollback (migrations are forward-only)
#
# Optional env:
#   SKIP_BACKUP=1     skip the DB dump (FIRST deploy only, while the database is still empty)
#   SKIP_PULL=1       use an image already on the machine (production always pulls)
#   MYSQLDUMP="..."   dump command (default: sudo -n mysqldump — MySQL root via auth_socket)
set -euo pipefail
cd "$(dirname "$0")"

APP=${slug}
PORT=${vpsPort}
IMAGE_REPO=${image}
COMPOSE="docker compose -f docker-compose.prod.yml"
MYSQLDUMP="\${MYSQLDUMP:-sudo -n mysqldump}"

TAG="\${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: ./deploy.sh <git-sha>   (tag shown in GitHub Actions » release-image)" >&2
  exit 2
fi
if [ "$TAG" = "latest" ]; then
  echo "refused: 'latest' cannot be rolled back to — use the full <git-sha>." >&2
  exit 2
fi

envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }

echo "▶ [0/5] preflight"
if grep -qE '__[A-Z_]+__' "$0" docker-compose.prod.yml; then
  echo "  ✗ deploy facts still unset (placeholder markers left in deploy.sh / docker-compose.prod.yml)."
  echo "    Fill in the port and GHCR owner from knowledge/DEPLOYMENT.md first."
  exit 1
fi
[ -f .env ] || { echo "  ✗ .env missing (copy .env.production.example from the repo, fill real values)"; exit 1; }
perm="$(stat -c %a .env 2>/dev/null || stat -f %Lp .env)"
[ "$perm" = "600" ] || { echo "  ✗ .env must be chmod 600 (is $perm)"; exit 1; }
[ "$(envval APP_ENV)" = "production" ] || { echo "  ✗ APP_ENV in .env must be production"; exit 1; }
DB_NAME="$(envval DB_NAME)"
[ -n "$DB_NAME" ] || { echo "  ✗ DB_NAME is empty in .env"; exit 1; }
[ "$DB_NAME" = "\${APP}_db" ] || echo "  ! DB_NAME is $DB_NAME, convention is \${APP}_db"
mkdir -p backups
PREV_TAG="$(envval IMAGE_TAG || true)"
echo "  ✓ .env 600, APP_ENV=production, DB_NAME=\${DB_NAME}; previous version: \${PREV_TAG:-(none)}"

export IMAGE_TAG="$TAG"
IMAGE="\${IMAGE_REPO}:\${TAG}"

echo "▶ [1/5] pull \${IMAGE}"
if [ "\${SKIP_PULL:-0}" = "1" ]; then
  docker image inspect "$IMAGE" >/dev/null || { echo "  ✗ SKIP_PULL=1 but the image is not on this machine"; exit 1; }
  echo "  (SKIP_PULL=1 — using the local image)"
else
  $COMPOSE pull app
fi

echo "▶ [2/5] back up \${DB_NAME} before migrating"
if [ "\${SKIP_BACKUP:-0}" = "1" ]; then
  echo "  (SKIP_BACKUP=1 — skipped; first deploy on an empty database only)"
else
  out="backups/pre-deploy-$(date +%Y%m%d-%H%M%S)-\${TAG:0:12}.sql.gz"
  # pipefail: a failed dump fails the deploy (never migrate without a backup).
  $MYSQLDUMP --single-transaction --routines --triggers --events --hex-blob \\
    --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces "$DB_NAME" | gzip -9 > "$out"
  chmod 600 "$out"
  echo "  ✓ \${out} ($(du -h "$out" | cut -f1))"
fi

echo "▶ [3/5] migrate"
${migrateStep}

echo "▶ [4/5] start app"
$COMPOSE up -d app
# Record the running version so a manual \`docker compose up\` stays on it.
if grep -qE '^IMAGE_TAG=' .env; then
  sed -i.bak -E "s|^IMAGE_TAG=.*|IMAGE_TAG=\${TAG}|" .env && rm -f .env.bak
else
  printf '\\n# managed by deploy.sh — image version currently running\\nIMAGE_TAG=%s\\n' "$TAG" >> .env
fi
chmod 600 .env

echo "▶ [5/5] wait for /readyz (max 120 s)"
for _ in $(seq 1 24); do
  if curl -fsS "http://127.0.0.1:\${PORT}/readyz" >/dev/null 2>&1; then
    docker image prune -f >/dev/null 2>&1 || true
    echo "✓ done. \${APP} is running \${IMAGE}"
    exit 0
  fi
  sleep 5
done
echo "  ✗ /readyz never became healthy — last log lines:"
docker logs --tail 60 "\${APP}-app" || true
if [ -n "$PREV_TAG" ]; then
  echo "  Rollback: ./deploy.sh \${PREV_TAG}   (migrations are forward-only)"
fi
exit 1
`);

const prodDbUrl = backend === "go"
  ? `# Go DSN (no scheme). Used by the app AND by migrate (compose -> "mysql://\${DB_DSN}").
DB_DSN=${slug}_user:<random-hex>@tcp(host.docker.internal:3306)/${dbName}`
  : `# Prisma URI${backend === "nestjs" ? " — used by the app AND by the migrate service" : ""}.
DATABASE_URL=mysql://${slug}_user:<random-hex>@host.docker.internal:3306/${dbName}`;

file("infra/elcodelabs/.env.production.example", `# PRODUCTION .env — elcodelabs VPS. Copy to ~/${slug}/.env on the server, fill in real values,
# then \`chmod 600 .env\`. This file is SAFE to commit: it holds no secrets.
# Never commit a filled-in .env and never bake secrets into the image.
APP_ENV=production
APP_PORT=8080
APP_NAME=${name}

# --- Database: the host's shared MySQL, ONE database + ONE user for this app only ------
# Create both once on the host — the SQL is in knowledge/DEPLOYMENT.md.
# Password: \`openssl rand -hex 24\` (hex stays URL-safe inside the DSN).
DB_HOST=host.docker.internal
DB_PORT=3306
DB_USER=${slug}_user
DB_PASSWORD=<random-hex>
DB_NAME=${dbName}
${prodDbUrl}

# --- App secrets (\`openssl rand -hex 32\`) ----------------------------------------------
JWT_SECRET=<random-hex>
JWT_EXPIRES_IN=24h

# --- HTTP behind the host nginx ---------------------------------------------------------
# Explicit public origin(s), comma-separated — never '*'.
CORS_ALLOWED_ORIGINS=https://${domain}
# nginx reaches the container from the docker bridge (172.16.0.0/12). Trust it for
# X-Forwarded-For, or every user looks like one IP to rate limiters.
TRUSTED_PROXIES=172.16.0.0/12,127.0.0.1/32

# Served from the image; leave as is.
PUBLIC_DIR=/app/public

# IMAGE_TAG is written here by deploy.sh — do not set it by hand.
`);

// CI: verify every push/PR; release-image builds the deployable image only after ci is green.
const ciApiJob = backend === "go"
  ? `  api:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: apps/api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: apps/api/go.mod
      - run: go build ./...
      - run: go vet ./...
      - run: go test ./...
`
  : "";
file(".github/workflows/ci.yml", `name: ci

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
${ciApiJob}  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: install
        run: if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - run: npm run build:web
${isNodeBackend ? "      - run: npm run build:api\n" : ""}`);

file(".github/workflows/release-image.yml", `# Build & push the app image to GHCR — the elcodelabs VPS only pulls it, never builds.
# Runs ONLY after the \`ci\` workflow passed for a push to main, on that exact commit
# (head_sha), so a published image is always one whose checks were green. Can also be
# triggered manually for a given ref.
name: release-image

on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      ref:
        description: "Ref/commit to build (default: main)"
        required: false
        default: main

permissions:
  contents: read
  packages: write

concurrency:
  group: release-image
  cancel-in-progress: false

jobs:
  image:
    if: github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.workflow_run.head_sha || inputs.ref }}

      - name: image name & tag
        id: meta
        run: |
          image="ghcr.io/$(echo "\${GITHUB_REPOSITORY}" | tr '[:upper:]' '[:lower:]')"
          sha="$(git rev-parse HEAD)"
          echo "image=\${image}" >> "$GITHUB_OUTPUT"
          echo "sha=\${sha}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: build & push (linux/amd64 — the VPS architecture)
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile
          platforms: linux/amd64
          push: true
          tags: |
            \${{ steps.meta.outputs.image }}:\${{ steps.meta.outputs.sha }}
            \${{ steps.meta.outputs.image }}:latest
          labels: |
            org.opencontainers.image.source=https://github.com/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ steps.meta.outputs.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: summary
        run: |
          {
            echo "### Image published"
            echo ""
            echo "\\\`\${{ steps.meta.outputs.image }}:\${{ steps.meta.outputs.sha }}\\\`"
            echo ""
            echo "Deploy on the elcodelabs VPS: \\\`cd ~/${slug} && ./deploy.sh \${{ steps.meta.outputs.sha }}\\\`"
          } >> "$GITHUB_STEP_SUMMARY"
`);

// ---------------------------------------------------------------------------
// packages/
// ---------------------------------------------------------------------------
file("packages/shared/package.json", JSON.stringify({
  // No "main" yet: index.ts is raw TypeScript with no build step. Set it once this
  // package is actually consumed and has a real entry point to point to.
  name: `@${npmName}/shared`, version: "0.1.0", private: true,
}, null, 2) + "\n");
file("packages/shared/index.ts", "// Truly reusable cross-app code only. No premature packages.\nexport {};\n");
file("packages/api-contract/package.json", JSON.stringify({
  name: `@${npmName}/api-contract`, version: "0.1.0", private: true,
}, null, 2) + "\n");
file("packages/api-contract/README.md", `# API Contract\n\nOpenAPI / schema / API contract documentation for ${name}.\n`);

// ---------------------------------------------------------------------------
// apps/web — React 19 + Tailwind 4 base
// ---------------------------------------------------------------------------
file("apps/web/package.json", JSON.stringify({
  name: "web", private: true, version: "0.1.0", type: "module",
  scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
  dependencies: {
    react: "^19.0.0", "react-dom": "^19.0.0", "react-router-dom": "^7.0.0",
    zustand: "^5.0.0", zod: "^3.23.0", axios: "^1.7.0",
  },
  devDependencies: {
    "@vitejs/plugin-react": "^4.3.0", vite: "^6.0.0", typescript: "^5.6.0",
    tailwindcss: "^4.0.0", "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0",
  },
}, null, 2) + "\n");

file("apps/web/index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);

file("apps/web/vite.config.ts", `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    // Same origin in dev, same as the single-container production model.
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
`);

file("apps/web/tsconfig.json", JSON.stringify({
  compilerOptions: {
    target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx",
    strict: true, noUnusedLocals: true, noUnusedParameters: true,
    skipLibCheck: true, noEmit: true, isolatedModules: true,
    baseUrl: ".", paths: { "@/*": ["src/*"] },
  },
  include: ["src"],
}, null, 2) + "\n");

file("apps/web/eslint.config.js", `// Configure ESLint for the frontend as needed.\nexport default [];\n`);
file("apps/web/src/vite-env.d.ts", `/// <reference types="vite/client" />\n`);

file("apps/web/src/main.tsx", `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/app/App";
import "@/styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`);

file("apps/web/src/app/App.tsx", `import { AppProvider } from "@/app/providers/AppProvider";
import { RouterProvider } from "@/app/providers/RouterProvider";

export default function App() {
  return (
    <AppProvider>
      <RouterProvider />
    </AppProvider>
  );
}
`);

file("apps/web/src/app/providers/AppProvider.tsx", `import type { ReactNode } from "react";

export function AppProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
`);

file("apps/web/src/app/providers/RouterProvider.tsx", `import { Suspense } from "react";
import { RouterProvider as ReactRouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { LoadingState } from "@/shared/components/feedback/LoadingState";

export function RouterProvider() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ReactRouterProvider router={router} />
    </Suspense>
  );
}
`);

file("apps/web/src/app/routes/route-paths.ts", `export const ROUTE_PATHS = {
  home: "/",
  login: "/login",
  dashboard: "/dashboard",
} as const;
`);

file("apps/web/src/app/routes/public.routes.tsx", `import { lazy } from "react";
import { ROUTE_PATHS } from "@/app/routes/route-paths";

const LoginPage = lazy(() => import("@/modules/auth/pages/LoginPage"));

export const publicRoutes = [
  { path: ROUTE_PATHS.home, element: <LoginPage /> },
  { path: ROUTE_PATHS.login, element: <LoginPage /> },
];
`);

file("apps/web/src/app/routes/protected.routes.tsx", `import { lazy } from "react";
import { ROUTE_PATHS } from "@/app/routes/route-paths";

const DashboardPage = lazy(() => import("@/modules/dashboard/pages/DashboardPage"));

export const protectedRoutes = [
  { path: ROUTE_PATHS.dashboard, element: <DashboardPage /> },
];
`);

file("apps/web/src/app/routes/index.tsx", `import { createBrowserRouter } from "react-router-dom";
import { publicRoutes } from "@/app/routes/public.routes";
import { protectedRoutes } from "@/app/routes/protected.routes";

export const router = createBrowserRouter([...publicRoutes, ...protectedRoutes]);
`);

file("apps/web/src/shared/components/feedback/LoadingState.tsx", `export function LoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
      Loading…
    </div>
  );
}
`);

file("apps/web/src/modules/auth/schemas/login.schema.ts", `import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type LoginFormValues = z.infer<typeof loginSchema>;
`);

file("apps/web/src/modules/auth/pages/LoginPage.tsx", `import { useState } from "react";
import type { FormEvent } from "react";
import { loginSchema } from "@/modules/auth/schemas/login.schema";

export default function LoginPage() {
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const result = loginSchema.safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
    });
    if (!result.success) {
      setErrors(result.error.issues.map((issue) => issue.message));
      return;
    }
    setErrors([]);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-[var(--radius-lg)] bg-[var(--color-surface)] p-8 shadow"
      >
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Sign in</h1>
        <input
          name="email"
          type="email"
          placeholder="Email"
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-2"
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-2"
        />
        {errors.map((err) => (
          <p key={err} className="text-sm text-red-600">{err}</p>
        ))}
        <button
          type="submit"
          className="w-full rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-2 text-white hover:bg-[var(--color-primary-hover)]"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
`);

file("apps/web/src/modules/dashboard/services/health.service.ts", `import { httpClient } from "@/shared/services/http-client";

export interface HealthResponse {
  success: boolean;
  message: string;
  data: unknown;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await httpClient.get<HealthResponse>("/api/v1/health");
  return data;
}
`);

file("apps/web/src/modules/dashboard/stores/health.store.ts", `import { create } from "zustand";
import { fetchHealth } from "@/modules/dashboard/services/health.service";
import type { HealthResponse } from "@/modules/dashboard/services/health.service";

interface HealthState {
  status: "idle" | "loading" | "success" | "error";
  result: HealthResponse | null;
  error: string | null;
  check: () => Promise<void>;
}

export const useHealthStore = create<HealthState>((set) => ({
  status: "idle",
  result: null,
  error: null,
  check: async () => {
    set({ status: "loading", error: null });
    try {
      const result = await fetchHealth();
      set({ status: "success", result });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : "Unknown error" });
    }
  },
}));
`);

file("apps/web/src/modules/dashboard/pages/DashboardPage.tsx", `import { useEffect } from "react";
import { useHealthStore } from "@/modules/dashboard/stores/health.store";

export default function DashboardPage() {
  const { status, result, error, check } = useHealthStore();

  useEffect(() => {
    check();
  }, [check]);

  return (
    <div className="min-h-screen bg-[var(--color-background)] p-8">
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">Dashboard</h1>
      <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="text-sm text-[var(--color-muted)]">API health check (/api/v1/health)</p>
        {status === "loading" && <p>Checking…</p>}
        {status === "error" && <p className="text-red-600">{error}</p>}
        {status === "success" && (
          <pre className="mt-2 text-sm">{JSON.stringify(result, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
`);

file("apps/web/src/shared/services/http-client.ts", `import axios from "axios";

export const httpClient = axios.create({
  // Empty = same origin. Proxied by Vite in dev, served by the same container in
  // production. Only set VITE_API_BASE_URL when web and api are deployed separately.
  baseURL: import.meta.env.VITE_API_BASE_URL || "",
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});
`);

file("apps/web/src/shared/services/api-endpoints.ts", `export const API = {
  base: "/api/v1",
} as const;
`);

file("apps/web/src/theme/theme.css", `:root {
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-soft: #dbeafe;

  --color-secondary: #64748b;
  --color-background: #f8fafc;
  --color-surface: #ffffff;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-muted: #64748b;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
`);

file("apps/web/src/theme/colors.ts", `export const colors = {
  primary: "var(--color-primary)",
  primaryHover: "var(--color-primary-hover)",
  primarySoft: "var(--color-primary-soft)",
  secondary: "var(--color-secondary)",
  background: "var(--color-background)",
  surface: "var(--color-surface)",
  border: "var(--color-border)",
  text: "var(--color-text)",
  muted: "var(--color-muted)",
} as const;
`);
file("apps/web/src/theme/index.ts", `export * from "./colors";\n`);

file("apps/web/src/styles/globals.css", `@import "tailwindcss";
@import "../theme/theme.css";
`);

// Frontend empty dirs (structure scaffold) — modules with real content still get the
// remaining stub subfolders so every module has the full seven-folder shape (P2-15).
function scaffoldWebModuleKeep(mod) {
  keep(
    `apps/web/src/modules/${mod}/pages`,
    `apps/web/src/modules/${mod}/components`,
    `apps/web/src/modules/${mod}/services`,
    `apps/web/src/modules/${mod}/schemas`,
    `apps/web/src/modules/${mod}/stores`,
    `apps/web/src/modules/${mod}/hooks`,
    `apps/web/src/modules/${mod}/types`,
  );
}
["auth", "dashboard", "users"].forEach(scaffoldWebModuleKeep);

keep(
  "apps/web/public",
  "apps/web/src/shared/components/ui", "apps/web/src/shared/components/feedback",
  "apps/web/src/shared/layouts", "apps/web/src/shared/stores", "apps/web/src/shared/hooks",
  "apps/web/src/shared/lib", "apps/web/src/shared/types", "apps/web/src/shared/constants",
);

// ---------------------------------------------------------------------------
// apps/api — backend base per stack
// ---------------------------------------------------------------------------
function scaffoldModuleKeep(base, mod) {
  keep(
    `${base}/${mod}/contracts`,
    `${base}/${mod}/application`,
    `${base}/${mod}/domain/events`,
    `${base}/${mod}/infrastructure`,
    `${base}/${mod}/presentation`,
  );
}

if (backend === "go") {
  file("apps/api/go.mod", `module ${goModule}\n\ngo 1.22\n\nrequire github.com/joho/godotenv v1.5.1\n`);
  file("apps/api/.air.toml", `root = "."
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
`);
  const sqlcModules = ["auth", "users", "order"];
  const sqlcBlocks = sqlcModules.map((m) => `  - engine: "mysql"
    schema: "migrations"
    queries: "internal/modules/${m}/infrastructure/queries"
    gen:
      go:
        package: "sqlc"
        out: "internal/modules/${m}/infrastructure/sqlc"`).join("\n");
  file("apps/api/sqlc.yaml", `version: "2"\nsql:\n${sqlcBlocks}\n`);
  file("apps/api/cmd/server/main.go", `package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

// staticHandler serves publicDir, falling back to index.html for SPA client-side routes.
func staticHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}

func main() {
	// .env lives at the repo root; the API runs from apps/api. Errors are ignored:
	// in the container, env is injected via env_file.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load(".env")

	port := os.Getenv("APP_PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(\`{"success":true,"message":"ok","data":null}\`))
	})
	// Readiness probe for the image HEALTHCHECK and deploy.sh. Once the database is wired,
	// ping it here and answer 503 while it is unreachable.
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(\`{"success":true,"message":"ready","data":null}\`))
	})

	// http.ServeMux matches the longest pattern, so /api/v1/... still wins over /.
	if publicDir := os.Getenv("PUBLIC_DIR"); publicDir != "" {
		if _, err := os.Stat(publicDir); err == nil {
			mux.Handle("/", staticHandler(publicDir))
		}
	}

	log.Printf("api listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`);
  file("apps/api/migrations/000001_create_users_table.up.sql", `CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
`);
  file("apps/api/migrations/000001_create_users_table.down.sql", `DROP TABLE IF EXISTS users;\n`);
  file("scripts/migrate.mjs", `#!/usr/bin/env node
// golang-migrate wrapper that works the same in PowerShell, cmd, and sh.
// npm runs scripts through cmd.exe on Windows, which does not expand $VAR — so the DB
// connection is read here from .env and passed as a literal argument instead.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\\r?\\n/)) {
    const m = line.match(/^\\s*([A-Z0-9_]+)\\s*=\\s*(.*)\\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const dsn = process.env.DB_DSN;
if (!dsn) {
  console.error("DB_DSN not found. Copy .env.example to .env and fill in DB_DSN.");
  process.exit(1);
}

const r = spawnSync(
  "migrate",
  ["-path", "migrations", "-database", \`mysql://\${dsn}\`, ...process.argv.slice(2)],
  { cwd: "apps/api", stdio: "inherit", shell: true }
);
process.exit(r.status ?? 1);
`);
  for (const m of sqlcModules) {
    file(`apps/api/internal/modules/${m}/${m}.module.go`, `package ${m}\n\n// Module wiring/bootstrap for the ${m} module.\n// Only contracts/ is importable by other modules.\n`);
  }
  keep(
    "apps/api/internal/config",
    "apps/api/internal/database",
    "apps/api/internal/router",
    "apps/api/internal/server",
    "apps/api/internal/shared",
  );
  scaffoldModuleKeep("apps/api/internal/modules", "auth");
  scaffoldModuleKeep("apps/api/internal/modules", "users");
  scaffoldModuleKeep("apps/api/internal/modules", "order");
  for (const m of sqlcModules) {
    keep(`apps/api/internal/modules/${m}/infrastructure/queries`, `apps/api/internal/modules/${m}/infrastructure/sqlc`);
  }
}

if (backend === "nestjs") {
  file("apps/api/package.json", JSON.stringify({
    name: "api", private: true, version: "0.1.0",
    scripts: {
      "start": "node dist/main.js",
      "start:dev": "nest start --watch",
      "build": "nest build",
      "prisma:migrate": "prisma migrate dev",
      "prisma:deploy": "prisma migrate deploy",
      "prisma:reset": "prisma migrate reset",
      "prisma:generate": "prisma generate",
    },
    dependencies: {
      "@nestjs/common": "^10.0.0", "@nestjs/core": "^10.0.0",
      "@nestjs/config": "^3.0.0", "@nestjs/serve-static": "^4.0.0",
      "@nestjs/platform-express": "^10.0.0", "@prisma/client": "^5.0.0",
      "reflect-metadata": "^0.2.0", "rxjs": "^7.8.0",
    },
    devDependencies: {
      "@nestjs/cli": "^10.0.0", "@nestjs/schematics": "^10.0.0",
      prisma: "^5.0.0", typescript: "^5.6.0",
      "@types/node": "^20.0.0",
    },
  }, null, 2) + "\n");
  file("apps/api/nest-cli.json", JSON.stringify({
    $schema: "https://json.schemastore.org/nest-cli",
    collection: "@nestjs/schematics",
    sourceRoot: "src",
    entryFile: "main",
    compilerOptions: { deleteOutDir: true },
  }, null, 2) + "\n");
  file("apps/api/prisma/schema.prisma", `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  password  String
  createdAt DateTime @default(now())
}
`);
  file("apps/api/src/main.ts", `import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // /readyz stays outside the prefix: it is the image HEALTHCHECK / deploy.sh probe.
  app.setGlobalPrefix("api/v1", { exclude: ["readyz"] });
  await app.listen(process.env.APP_PORT ?? 8080);
}
bootstrap();
`);
  file("apps/api/src/app.controller.ts", `import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("health")
  health() {
    return { success: true, message: "ok", data: null };
  }
  // Readiness probe (unprefixed). Once the database is wired, check it here and throw a
  // ServiceUnavailableException while it is unreachable.
  @Get("readyz")
  readyz() {
    return { success: true, message: "ready", data: null };
  }
}
`);
  file("apps/api/src/app.module.ts", `import { existsSync } from "node:fs";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ServeStaticModule } from "@nestjs/serve-static";
import { AppController } from "./app.controller";

// Skipped without error when PUBLIC_DIR is empty or the directory doesn't exist —
// that's the normal case in dev, where the frontend is served by Vite instead.
const publicDir = process.env.PUBLIC_DIR;
// NOTE: exclude patterns are matched with the path-to-regexp version @nestjs/serve-static
// bundles (0.2.5 as of this writing), where a bare trailing "*" is a literal character, not
// a wildcard — "/api/v1*" never matches anything and silently lets the SPA fallback shadow
// every /api/v1 route. "(.*)" is the wildcard syntax that version actually supports.
const serveStatic = publicDir && existsSync(publicDir)
  ? [ServeStaticModule.forRoot({ rootPath: publicDir, exclude: ["/api/v1", "/api/v1/(.*)", "/readyz"] })]
  : [];

@Module({
  // .env lives at the repo root; the API runs from apps/api, hence "../../.env".
  // A local .env is also checked as a fallback. Missing files are ignored — in
  // the container, env is injected via env_file.
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ["../../.env", ".env"] }),
    ...serveStatic,
  ],
  controllers: [AppController],
})
export class AppModule {}
`);
  file("apps/api/tsconfig.json", JSON.stringify({
    compilerOptions: {
      module: "commonjs", target: "ES2021", experimentalDecorators: true,
      emitDecoratorMetadata: true, outDir: "./dist", baseUrl: "./", strict: true,
      strictPropertyInitialization: false, esModuleInterop: true, skipLibCheck: true,
    },
  }, null, 2) + "\n");
  keep("apps/api/src/shared");
  scaffoldModuleKeep("apps/api/src/modules", "auth");
  scaffoldModuleKeep("apps/api/src/modules", "users");
  scaffoldModuleKeep("apps/api/src/modules", "order");
}

if (backend === "express") {
  file("apps/api/package.json", JSON.stringify({
    name: "api", private: true, version: "0.1.0",
    scripts: {
      "start": "node dist/index.js",
      "dev": "nodemon",
      "build": "tsc -p tsconfig.json",
    },
    dependencies: { express: "^4.19.0", dotenv: "^16.4.0" },
    devDependencies: {
      nodemon: "^3.1.0", typescript: "^5.6.0", "ts-node": "^10.9.0",
      "@types/express": "^4.17.0", "@types/node": "^20.0.0",
    },
  }, null, 2) + "\n");
  file("apps/api/nodemon.json", JSON.stringify({
    watch: ["src"], ext: "ts", exec: "ts-node src/index.ts",
  }, null, 2) + "\n");
  file("apps/api/tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "CommonJS", moduleResolution: "node",
      outDir: "./dist", rootDir: "./src", strict: true, esModuleInterop: true, skipLibCheck: true,
    },
    include: ["src"],
  }, null, 2) + "\n");
  file("apps/api/src/index.ts", `import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import express from "express";

// .env lives at the repo root; the API runs from apps/api. Errors are ignored:
// in the container, env is injected via env_file.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const app = express();
app.use(express.json());

app.get("/api/v1/health", (_req, res) => {
  res.json({ success: true, message: "ok", data: null });
});
// Readiness probe for the image HEALTHCHECK and deploy.sh. Once the database is wired,
// check it here and answer 503 while it is unreachable.
app.get("/readyz", (_req, res) => {
  res.json({ success: true, message: "ready", data: null });
});

const publicDir = process.env.PUBLIC_DIR;
if (publicDir && fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
}

const port = process.env.APP_PORT ?? 8080;
app.listen(port, () => console.log(\`api listening on :\${port}\`));
`);
  file("apps/api/MIGRATION.md", `# Migration tool: TBD

The Express migration tool is **not locked** by the Dimas standard.
Decide on a tool (e.g. Knex, Drizzle, Prisma, node-pg-migrate) and document it here
before implementing migrations.
`);
  keep("apps/api/src/shared");
  scaffoldModuleKeep("apps/api/src/modules", "auth");
  scaffoldModuleKeep("apps/api/src/modules", "users");
  scaffoldModuleKeep("apps/api/src/modules", "order");
}

// scripts/ at repo root (kept for project scripts)
keep("scripts");

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------
let written = 0;
for (const [rel, content] of Object.entries(files)) {
  const abs = join(targetDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  written++;
}
for (const dir of keepDirs) {
  const abs = join(targetDir, dir, ".gitkeep");
  mkdirSync(join(targetDir, dir), { recursive: true });
  writeFileSync(abs, "");
  written++;
}

process.stdout.write(
  `\n✓ Scaffolded "${name}" (${backend}) into ${targetDir}\n` +
  `  ${written} files written.\n\n` +
  `Next steps:\n` +
  `  1. Read the matching reference(s) in the skill and fill in modules + knowledge/.\n` +
  `  2. cp .env.example .env  and adjust.\n` +
  `  3. npm install\n` +
  `  4. npm run dev:web   /   npm run dev:api\n` +
  (backend === "go" ? `  5. cd apps/api && go mod tidy   (commit go.sum — the image build needs it)\n` : "") +
  `\nDeploy target: elcodelabs VPS as "${slug}" — facts in knowledge/DEPLOYMENT.md.\n` +
  (missingDeploy.length
    ? `  ⚠ Not set yet: ${missingDeploy.join(", ")}. Placeholders were written; deploy.sh refuses to\n` +
      `    run until they are filled. Get the next free port from the playbook on the VPS.\n`
    : "")
);
