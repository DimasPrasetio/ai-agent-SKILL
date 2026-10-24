#!/usr/bin/env node
// Detects drift between references/*.md (documentation Claude reads) and the templates
// scaffold.mjs actually emits. Both describe the same files twice by design — this catches
// the moment one of the two copies changes without the other. No shared-template refactor
// (that would add complexity this standard argues against); just automated comparison.
//
// Checks 1-7 cover duplicated CODE and CONFIG; check 11 asserts the deploy artifacts keep the
// elcodelabs VPS rules. Checks 8-10 cover duplicated PROSE — the
// generated knowledge base — because that is where a standard with a "one home per fact"
// rule actually leaks: a sentence gets helpfully repeated into a second file, both copies
// then look authoritative, and months later they disagree with nothing to flag it.
//
// Usage: node scripts/check-drift.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCAFFOLD = join(REPO_ROOT, "scripts", "scaffold.mjs");
// Repo-local scratch dir — see the comment in smoke-test.mjs for why this isn't os.tmpdir().
const SCRATCH_ROOT = join(REPO_ROOT, ".smoke-tmp");
mkdirSync(SCRATCH_ROOT, { recursive: true });

let failures = 0;
function ok(label) { process.stdout.write(`  ✓ ${label}\n`); }
function bad(label, detail) {
  process.stdout.write(`  ✗ ${label}\n`);
  if (detail) process.stdout.write(detail.split("\n").map((l) => "      " + l).join("\n") + "\n");
  failures++;
}

function readRef(file) {
  return readFileSync(join(REPO_ROOT, "references", file), "utf8");
}

function extractAfter(markdown, marker, fenceLang) {
  const idx = markdown.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found in reference: ${JSON.stringify(marker)}`);
  // Bound the search to before the next heading, so an unrelated same-language example
  // inserted between this marker and its real fence can't get silently misattributed to it.
  const nextHeading = markdown.indexOf("\n## ", idx + marker.length);
  const searchEnd = nextHeading === -1 ? markdown.length : nextHeading;
  const fenceTag = "```" + fenceLang;
  const fenceStart = markdown.indexOf(fenceTag, idx);
  if (fenceStart === -1 || fenceStart > searchEnd) {
    throw new Error(`no \`\`\`${fenceLang} fence between marker and the next heading: ${JSON.stringify(marker)}`);
  }
  const contentStart = markdown.indexOf("\n", fenceStart) + 1;
  const fenceEnd = markdown.indexOf("\n```", contentStart);
  if (fenceEnd === -1) throw new Error(`unterminated fence after marker: ${JSON.stringify(marker)}`);
  return markdown.slice(contentStart, fenceEnd);
}

function sortedJson(v) {
  return JSON.stringify(v, Object.keys(v ?? {}).sort());
}

function deepEqual(a, b) {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortDeep(v[k]); return acc; }, {});
  }
  return v;
}

// scaffold each backend once into its own temp dir, reused across checks
const scaffolded = {};
function scaffoldOnce(backend) {
  if (scaffolded[backend]) return scaffolded[backend];
  const dir = mkdtempSync(join(SCRATCH_ROOT, `${backend}-`));
  const r = spawnSync(process.execPath, [SCAFFOLD, "--name", "drift-check", "--backend", backend, "--dir", dir, "--force"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scaffold --backend ${backend} failed: ${r.stderr}`);
  scaffolded[backend] = dir;
  return dir;
}

function readGenerated(backend, rel) {
  return readFileSync(join(scaffoldOnce(backend), rel), "utf8");
}

// 1. backend-go.md -> apps/api/.air.toml
try {
  const ref = extractAfter(readRef("backend-go.md"), "Always create `.air.toml`", "toml").trim();
  const gen = readGenerated("go", "apps/api/.air.toml").trim();
  if (ref === gen) ok("backend-go.md .air.toml == apps/api/.air.toml");
  else bad("backend-go.md .air.toml != apps/api/.air.toml", `--- reference ---\n${ref}\n--- generated ---\n${gen}`);
} catch (err) { bad("backend-go.md .air.toml", err.message); }

// 2. backend-go.md -> root package.json scripts
try {
  const ref = JSON.parse(extractAfter(readRef("backend-go.md"), "## Root commands (Go)", "json")).scripts;
  const gen = JSON.parse(readGenerated("go", "package.json")).scripts;
  if (deepEqual(ref, gen)) ok("backend-go.md root scripts == package.json scripts (go)");
  else bad("backend-go.md root scripts != package.json scripts (go)", `reference: ${sortedJson(ref)}\ngenerated: ${sortedJson(gen)}`);
} catch (err) { bad("backend-go.md root scripts", err.message); }

// 3. backend-nestjs.md -> root package.json scripts
try {
  const ref = JSON.parse(extractAfter(readRef("backend-nestjs.md"), "## Root commands (NestJS)", "json")).scripts;
  const gen = JSON.parse(readGenerated("nestjs", "package.json")).scripts;
  if (deepEqual(ref, gen)) ok("backend-nestjs.md root scripts == package.json scripts (nestjs)");
  else bad("backend-nestjs.md root scripts != package.json scripts (nestjs)", `reference: ${sortedJson(ref)}\ngenerated: ${sortedJson(gen)}`);
} catch (err) { bad("backend-nestjs.md root scripts", err.message); }

// 3b. backend-nestjs.md -> apps/api/package.json scripts (subset: every documented script
// must exist with an identical value in the generated file)
try {
  const ref = JSON.parse(extractAfter(readRef("backend-nestjs.md"), "## `apps/api/package.json` scripts", "json")).scripts;
  const gen = JSON.parse(readGenerated("nestjs", "apps/api/package.json")).scripts;
  const mismatches = Object.entries(ref).filter(([k, v]) => gen[k] !== v);
  if (mismatches.length === 0) ok("backend-nestjs.md apps/api scripts ⊆ apps/api/package.json scripts (nestjs)");
  else bad("backend-nestjs.md apps/api scripts drifted", mismatches.map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(gen[k])}`).join("\n"));
} catch (err) { bad("backend-nestjs.md apps/api scripts", err.message); }

// 4. backend-express.md -> root package.json scripts
try {
  const ref = JSON.parse(extractAfter(readRef("backend-express.md"), "## Root commands (Express)", "json")).scripts;
  const gen = JSON.parse(readGenerated("express", "package.json")).scripts;
  if (deepEqual(ref, gen)) ok("backend-express.md root scripts == package.json scripts (express)");
  else bad("backend-express.md root scripts != package.json scripts (express)", `reference: ${sortedJson(ref)}\ngenerated: ${sortedJson(gen)}`);
} catch (err) { bad("backend-express.md root scripts", err.message); }

// 4b. backend-express.md -> apps/api/package.json scripts + nodemon.json
try {
  const refPkg = JSON.parse(extractAfter(readRef("backend-express.md"), "so the entrypoint has one home:", "json")).scripts;
  const genPkg = JSON.parse(readGenerated("express", "apps/api/package.json")).scripts;
  const pkgMismatches = Object.entries(refPkg).filter(([k, v]) => genPkg[k] !== v);
  const refNodemon = JSON.parse(extractAfter(readRef("backend-express.md"), "`apps/api/nodemon.json` owns the actual entrypoint:", "json"));
  const genNodemon = JSON.parse(readGenerated("express", "apps/api/nodemon.json"));
  if (pkgMismatches.length === 0 && deepEqual(refNodemon, genNodemon)) {
    ok("backend-express.md apps/api scripts + nodemon.json == generated (express)");
  } else {
    bad(
      "backend-express.md apps/api scripts/nodemon.json drifted",
      [
        ...pkgMismatches.map(([k, v]) => `package.json ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(genPkg[k])}`),
        !deepEqual(refNodemon, genNodemon) ? `nodemon.json: reference ${sortedJson(refNodemon)} != generated ${sortedJson(genNodemon)}` : null,
      ].filter(Boolean).join("\n")
    );
  }
} catch (err) { bad("backend-express.md apps/api scripts + nodemon.json", err.message); }

// 5. frontend.md token contract <-> theme.css. Compared as sets of NAMES, both ways: the file
// itself is a template (scripts/templates/web/theme.css), and its values are the project's to
// change — but a name in the contract that the theme stops defining breaks every component
// built on it, and a name the theme defines outside the contract is one nobody promised.
try {
  const ref = extractAfter(readRef("frontend.md"), "The contract — every one of these", "txt")
    .split(/\s+/).filter((t) => t.startsWith("--")).sort();
  const gen = readGenerated("express", "apps/web/src/theme/theme.css");
  const rootBlock = gen.slice(gen.indexOf(":root {"), gen.indexOf("}", gen.indexOf(":root {")));
  const defined = [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
  const themeInline = gen.slice(gen.indexOf("@theme inline {"));
  for (const t of ["--font-sans", "--font-display", "--font-mono", "--text-2xs"]) {
    if (new RegExp(`^\\s*${t}:`, "m").test(themeInline)) defined.push(t);
  }
  const genNames = [...new Set(defined)].sort();
  const only = (a, b) => a.filter((x) => !b.includes(x));
  const missing = only(ref, genNames);
  const extra = only(genNames, ref);
  // Every :root color token must also be exposed to Tailwind, or its semantic class never exists.
  const isColor = (t) => !/^--(radius|row-py|shadow-|font-|text-)/.test(t);
  const unmapped = defined.filter(isColor)
    .filter((t) => !themeInline.includes(`--color-${t.slice(2)}: var(${t});`));
  if (!missing.length && !extra.length && !unmapped.length) ok(`frontend.md token contract == theme.css tokens (${ref.length})`);
  else bad("frontend.md token contract != theme.css",
    `in contract, not defined: ${missing.join(", ") || "(none)"}\ndefined, not in contract: ${extra.join(", ") || "(none)"}\nnot mapped in @theme inline: ${unmapped.join(", ") || "(none)"}`);
} catch (err) { bad("frontend.md token contract", err.message); }

// 5b. Every primitive the scaffold ships imports cn from the "cn" package — what the shadcn CLI
// writes — and components.json points the CLI at it. A primitive importing a local helper would
// drift from every component `npx shadcn add` produces later.
try {
  const root = scaffoldOnce("express");
  const dir = join(root, "apps/web/src/shared/components/primitives");
  const problems = readdirSync(dir).filter((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    return /\bcn\(/.test(src) && !src.includes('import { cn } from "cn"');
  });
  const cfg = JSON.parse(readFileSync(join(root, "apps/web/components.json"), "utf8"));
  if (cfg.aliases?.utils !== "cn") problems.push(`components.json aliases.utils is ${JSON.stringify(cfg.aliases?.utils)}, not "cn"`);
  if (cfg.tailwind?.css !== "src/theme/theme.css") problems.push("components.json tailwind.css must be src/theme/theme.css");
  if (cfg.aliases?.ui !== "@/shared/components/primitives") problems.push("components.json aliases.ui must be @/shared/components/primitives");
  if (problems.length === 0) ok("primitives import cn from \"cn\"; components.json matches frontend.md");
  else bad("shadcn wiring drifted", problems.join("\n"));
} catch (err) { bad("shadcn wiring", err.message); }

// 5c. backend-go.md registry example must use the markers the generated registry.go carries.
try {
  const gen = readGenerated("go", "apps/api/internal/modules/registry.go");
  const ref = readRef("backend-go.md");
  const markers = ["// elco:imports:begin", "// elco:imports:end", "// elco:modules:begin", "// elco:modules:end"];
  const missingGen = markers.filter((m) => !gen.includes(m));
  const missingRef = markers.filter((m) => !ref.includes(m.replace("// ", "")));
  const sqlc = readGenerated("go", "apps/api/sqlc.yaml");
  if (!sqlc.includes("# elco:sqlc:begin") || !sqlc.includes("# elco:sqlc:end")) missingGen.push("sqlc.yaml elco:sqlc markers");
  if (!gen.includes("func Register(mux *http.ServeMux, d *kernel.Deps)")) missingGen.push("Register signature");
  if (!missingGen.length && !missingRef.length) ok("registry.go + sqlc.yaml markers == backend-go.md");
  else bad("Go registry markers drifted", `missing in generated: ${missingGen.join(", ") || "(none)"}\nmissing in backend-go.md: ${missingRef.join(", ") || "(none)"}`);
} catch (err) { bad("Go registry markers", err.message); }

// 6. frontend.md -> http-client.ts
try {
  const ref = extractAfter(readRef("frontend.md"), "Centralized client in `src/shared/services/http-client.ts`:", "ts").trim();
  const gen = readGenerated("express", "apps/web/src/shared/services/http-client.ts").trim();
  if (ref === gen) ok("frontend.md http-client.ts == apps/web/src/shared/services/http-client.ts");
  else bad("frontend.md http-client.ts != apps/web/src/shared/services/http-client.ts", `--- reference ---\n${ref}\n--- generated ---\n${gen}`);
} catch (err) { bad("frontend.md http-client.ts", err.message); }

// 7. docker-deployment.md -> docker-compose.yml
try {
  const ref = extractAfter(readRef("docker-deployment.md"), "## Default `docker-compose.yml`", "yaml").trim();
  const gen = readGenerated("express", "docker-compose.yml").trim();
  if (ref === gen) ok("docker-deployment.md compose == docker-compose.yml");
  else bad("docker-deployment.md compose != docker-compose.yml", `--- reference ---\n${ref}\n--- generated ---\n${gen}`);
} catch (err) { bad("docker-deployment.md compose", err.message); }

// ---------------------------------------------------------------------------
// Prose checks: the generated knowledge base must keep one owner per fact.
// ---------------------------------------------------------------------------

function walkMd(root, sub = "") {
  const out = [];
  for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      out.push(...walkMd(root, rel));
    } else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// 8. Single-owner facts. Each marker must appear in EXACTLY the generated .md files listed —
// no more (a fact quietly copied into a third file) and no fewer (an owner that stopped
// stating the fact it owns). Where a second home is legitimate it is listed on purpose:
// CLAUDE.md is always loaded and .claude/rules/ is not, so a handful of invariants are
// restated there deliberately — this table is where that intent is recorded as data.
const FACT_OWNERS = {
  "dev:web": ["CLAUDE.md", "README.md"],
  "host.docker.internal": ["knowledge/DEPLOYMENT.md"],
  "8080": ["knowledge/DEPLOYMENT.md"],
  "SOURCE_PRIORITY": ["CLAUDE.md", "knowledge/INDEX.md"],
  "docs/": [".claude/rules/monorepo.md", "knowledge/decisions/ADR-0001-monorepo-structure.md"],
  "Zustand": [".claude/rules/frontend-react.md", "CLAUDE.md"],
  "z.infer": [".claude/rules/frontend-react.md"],
  "frontend-design": [".claude/rules/frontend-react.md"],
  "contracts/": [".claude/rules/backend-modular-monolith.md", "CLAUDE.md"],
  "Forbidden:": [".claude/rules/backend-modular-monolith.md"],
  "/api/v1": [".claude/rules/api-standard.md"],
  "unless explicitly requested:": [".claude/rules/monorepo.md"],
  // Deploy (elcodelabs VPS): the rule owns the prohibitions, DEPLOYMENT.md owns the values.
  "default_server": [".claude/rules/deployment.md"],
  "mysql_native_password": ["knowledge/DEPLOYMENT.md"],
  "SERVER_PLAYBOOK.md": ["knowledge/DEPLOYMENT.md"],
  // Design: the rule owns "research before UI", DESIGN.md owns the researched direction.
  "Research date:": ["knowledge/DESIGN.md"],
  "WCAG 2.2": ["knowledge/DESIGN.md"],
  "older than ~6 months": [".claude/rules/frontend-react.md"],
  // Modules: the rule owns the registry/marker discipline; CLAUDE.md restates the invariant.
  "elco:": ["CLAUDE.md", ".claude/rules/modules.md"],
  "semantic": [".claude/rules/frontend-react.md", "CLAUDE.md"],
};
for (const backend of ["go", "nestjs", "express"]) {
  try {
    const root = scaffoldOnce(backend);
    const files = walkMd(root).filter((f) => !f.startsWith("packages/") && !f.startsWith("apps/"));
    const problems = [];
    for (const [marker, expected] of Object.entries(FACT_OWNERS)) {
      const found = files.filter((f) => readFileSync(join(root, f), "utf8").includes(marker)).sort();
      const want = [...expected].sort();
      if (found.join("|") !== want.join("|")) {
        problems.push(`${JSON.stringify(marker)}\n  expected: ${want.join(", ") || "(none)"}\n  found:    ${found.join(", ") || "(none)"}`);
      }
    }
    if (problems.length === 0) ok(`single-owner facts intact (${backend})`);
    else bad(`single-owner facts drifted (${backend})`, problems.join("\n"));
  } catch (err) { bad(`single-owner facts (${backend})`, err.message); }
}

// 9. The anti-overengineering list is stated twice — in SKILL.md (what Claude reads) and in
// the generated .claude/rules/monorepo.md (what the project enforces). A PARTIAL copy is the
// dangerous failure mode here: the shorter list still reads as complete, so items silently
// stop being forbidden. Compare them as sets.
function antiList(text, label) {
  const marker = "unless explicitly requested:";
  const i = text.indexOf(marker);
  if (i === -1) throw new Error(`marker "unless explicitly requested:" not found in ${label}`);
  const from = i + marker.length;
  const ends = ["\n\n", "\n- "].map((m) => text.indexOf(m, from)).filter((x) => x !== -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(from, end).replace(/\s+/g, " ").trim().replace(/\.$/, "")
    .split(",").map((x) => x.trim()).filter(Boolean).sort();
}
try {
  const ref = antiList(readFileSync(join(REPO_ROOT, "SKILL.md"), "utf8"), "SKILL.md");
  const gen = antiList(readGenerated("go", ".claude/rules/monorepo.md"), ".claude/rules/monorepo.md");
  if (ref.join("|") === gen.join("|")) ok(`SKILL.md anti-overengineering list == .claude/rules/monorepo.md (${ref.length} items)`);
  else {
    const only = (a, b) => a.filter((x) => !b.includes(x));
    bad("SKILL.md anti-overengineering list != .claude/rules/monorepo.md",
      `only in SKILL.md: ${only(ref, gen).join(", ") || "(none)"}\nonly in rule:    ${only(gen, ref).join(", ") || "(none)"}`);
  }
} catch (err) { bad("anti-overengineering list", err.message); }

// 10. The required knowledge/ file list exists in three places: the reference tree, the
// generated directory, and the routing links inside INDEX.md. Adding a file to one and
// forgetting the others is how a knowledge base grows an orphan nobody routes to.
try {
  const tree = extractAfter(readRef("knowledge-gateway.md"), "## `knowledge/`", "txt");
  const refFiles = [...tree.matchAll(/── ([A-Z][A-Z_]*\.md)/g)].map((m) => m[1]).sort();
  const root = scaffoldOnce("go");
  const genFiles = readdirSync(join(root, "knowledge")).filter((f) => f.endsWith(".md")).sort();
  const index = readFileSync(join(root, "knowledge", "INDEX.md"), "utf8");
  const indexFiles = [...index.matchAll(/\[([A-Z][A-Z_]*\.md)\]/g)].map((m) => m[1]).sort();
  const routed = [...new Set([...indexFiles, "INDEX.md"])].sort();
  const only = (a, b) => a.filter((x) => !b.includes(x));
  if (refFiles.join("|") !== genFiles.join("|")) {
    bad("knowledge-gateway.md file list != generated knowledge/",
      `only in reference: ${only(refFiles, genFiles).join(", ") || "(none)"}\nonly in generated: ${only(genFiles, refFiles).join(", ") || "(none)"}`);
  } else if (routed.join("|") !== genFiles.join("|")) {
    bad("knowledge/INDEX.md does not route every knowledge file",
      `not routed by INDEX.md: ${only(genFiles, routed).join(", ") || "(none)"}\nrouted but missing:     ${only(routed, genFiles).join(", ") || "(none)"}`);
  } else ok(`knowledge/ file list == reference == INDEX.md routing (${genFiles.length} files)`);
} catch (err) { bad("knowledge/ file list", err.message); }

// 11. Deploy artifacts must keep the elcodelabs VPS golden rules (references/docker-deployment.md).
// Asserted structurally rather than as a byte copy: these files carry per-project values.
// Scaffolded twice per stack — once with every deploy flag, once with none — so both the
// filled-in path and the "placeholders, deploy.sh refuses" path stay honest.
const DEPLOY_FLAGS = ["--port", "8099", "--ghcr-owner", "Drift-Owner", "--domain", "drift.example.com"];
for (const backend of ["go", "nestjs", "express"]) {
  try {
    const dir = mkdtempSync(join(SCRATCH_ROOT, `${backend}-deploy-`));
    const r = spawnSync(process.execPath, [SCAFFOLD, "--name", "drift-check", "--backend", backend, "--dir", dir, "--force", ...DEPLOY_FLAGS], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`scaffold with deploy flags failed: ${r.stderr}`);
    scaffolded[`${backend}-deploy`] = dir;
    const read = (rel) => readFileSync(join(dir, rel), "utf8");
    const problems = [];
    const need = (cond, msg) => { if (!cond) problems.push(msg); };

    const prod = read("infra/elcodelabs/docker-compose.prod.yml");
    need(!/^\s*build:/m.test(prod), "prod compose must not contain build: (the VPS never builds)");
    need(prod.includes("image: ghcr.io/drift-owner/drift-check:${IMAGE_TAG:?"), "prod compose image must be ghcr.io/<owner>/<repo>:${IMAGE_TAG:?…} (required tag, lowercase owner)");
    need(prod.includes('"127.0.0.1:8099:8080"'), "prod compose must publish 127.0.0.1:<port>:8080 only");
    need(prod.includes("container_name: driftcheck-app"), "prod compose container_name must be <slug>-app");
    need(prod.includes("restart: unless-stopped"), "prod compose needs restart: unless-stopped");
    need(prod.includes("host.docker.internal:host-gateway"), "prod compose needs extra_hosts host-gateway");
    need(prod.includes("read_only: true") && prod.includes("no-new-privileges:true"), "prod compose lost its hardening");
    need(prod.includes("/readyz"), "prod compose healthcheck must probe /readyz");
    need(!/image:\s*(mysql|mariadb|postgres)/i.test(prod), "prod compose must not run a database container");
    need(backend === "express" || prod.includes('profiles: ["ops"]'), "prod compose needs a profile-ops migrate service");

    const df = read("infra/docker/Dockerfile");
    need(/^ENTRYPOINT \[/m.test(df) && !/^CMD /m.test(df), "Dockerfile must use ENTRYPOINT, not CMD");
    need(df.includes("-u 10001") && /^USER app$/m.test(df), "Dockerfile must run as non-root uid 10001");
    need(df.includes("/readyz"), "Dockerfile HEALTHCHECK must probe /readyz");

    const deploy = read("infra/elcodelabs/deploy.sh");
    const syntax = spawnSync("bash", ["-n", join(dir, "infra/elcodelabs/deploy.sh")], { encoding: "utf8" });
    need(syntax.status === 0, `deploy.sh has a bash syntax error: ${syntax.stderr}`);
    for (const step of ["mysqldump", "pull app", "up -d app", "/readyz", "IMAGE_TAG"]) need(deploy.includes(step), `deploy.sh lost step: ${step}`);
    need(!/__[A-Z_]+__/.test(deploy) && !/__[A-Z_]+__/.test(prod), "placeholder left although every deploy flag was passed");

    const nginx = read("infra/nginx/nginx.conf");
    need(nginx.includes("proxy_pass http://127.0.0.1:8099;") && nginx.includes("server_name drift.example.com;"), "nginx site must proxy server_name <domain> to 127.0.0.1:<port>");
    need(!/^\s*listen[^;]*default_server/m.test(nginx), "nginx site must not claim default_server");

    const release = read(".github/workflows/release-image.yml");
    need(release.includes("workflows: [ci]") && release.includes("linux/amd64") && release.includes("head_sha"), "release-image must build linux/amd64 from the green ci head_sha");
    need(read(".github/workflows/ci.yml").startsWith("name: ci\n"), "ci workflow must be named ci (release-image depends on it)");
    need(read(".dockerignore").split("\n").includes(".env"), ".dockerignore must exclude .env");

    // Without flags the markers must be there, and deploy.sh must refuse them.
    const bare = scaffoldOnce(backend);
    const bareDeploy = readFileSync(join(bare, "infra/elcodelabs/deploy.sh"), "utf8");
    need(bareDeploy.includes("PORT=__VPS_PORT__") && bareDeploy.includes("__GHCR_OWNER__"), "missing deploy flags must leave __VPS_PORT__/__GHCR_OWNER__ markers");

    if (problems.length === 0) ok(`deploy artifacts keep the elcodelabs VPS rules (${backend})`);
    else bad(`deploy artifacts drifted from the elcodelabs VPS rules (${backend})`, problems.join("\n"));
  } catch (err) { bad(`deploy artifacts (${backend})`, err.message); }
}

// Same Windows caveat as smoke-test.mjs: a file read moments ago can still be held by the
// indexer or an editor. A scratch dir we failed to delete must not turn a green run red —
// .smoke-tmp/ is gitignored and the next run reuses it.
for (const dir of Object.values(scaffolded)) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    process.stdout.write(`  (warning: could not remove temp dir ${dir}: ${err.message})
`);
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} drift check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nNo drift detected.\n");
process.exit(0);
