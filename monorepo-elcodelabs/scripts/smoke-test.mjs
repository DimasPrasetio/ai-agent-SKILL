#!/usr/bin/env node
// Smoke test — locks Gerbang 1 ("the generated project must be alive").
//
// For every backend (go, nestjs, express), using a deliberately dirty project name
// ("Kasir App", exercising P0-05's sanitization):
//   1. Scaffold to a temp dir.
//   2. npm install — must exit 0.
//   3. Type-check: build:web, and build:api for Node stacks.
//   4. Start dev:api, poll GET /api/v1/health, expect success:true, check GET /readyz, stop it.
//   5. Start dev:web, confirm Vite responds and the /api proxy reaches the API.
//   6. Clean up the temp dir.
//
// Steps that need a Go-only tool (air) are skipped — explicitly reported, never silently —
// when that tool isn't on PATH. A silent skip would read as a pass.
//
// Usage: node scripts/smoke-test.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCAFFOLD = join(REPO_ROOT, "scripts", "scaffold.mjs");
// A repo-local scratch dir, not os.tmpdir(): on Windows, a home directory with a space
// (e.g. "C:\Users\Jane Doe") makes %TEMP% resolve through its 8.3 short-name alias, and
// some file watchers (chokidar under `nest start --watch`) crash on that short/long path
// mismatch ("Assertion failed: !_wcsnicmp(...)" in libuv's fs-event.c). The repo path has
// no such alias.
const SCRATCH_ROOT = join(REPO_ROOT, ".smoke-tmp");
mkdirSync(SCRATCH_ROOT, { recursive: true });
const DIRTY_NAME = "Kasir App";
const STACKS = ["go", "nestjs", "express"];

let failures = 0;
const skipped = [];

function log(msg) {
  process.stdout.write(msg + "\n");
}
function pass(msg) {
  log(`  ✓ ${msg}`);
}
function fail(msg) {
  log(`  ✗ ${msg}`);
  failures++;
}
function skip(msg) {
  log(`  ⚠ SKIPPED: ${msg}`);
  skipped.push(msg);
}

function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { stdio: "ignore", shell: true });
  return r.status === 0;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { shell: true, encoding: "utf8", ...opts });
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

// Backstop for killTree: watchers like `air`/`nest start --watch` can fork a grandchild
// server process that escapes the process tree taskkill/-pid sees, leaking a listener
// across stacks. Kill whatever is actually bound to the port, by PID, not by tree.
function killPort(port) {
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", shell: true });
    const pids = new Set();
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    // -sTCP:LISTEN: only the server bound to the port. Without it lsof also lists clients —
    // including this very process right after it fetched the port — and kill -9 hits ourselves.
    const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", shell: true });
    for (const pid of (r.stdout || "").split(/\s+/).filter(Boolean)) {
      spawnSync("kill", ["-9", pid], { stdio: "ignore", shell: true });
    }
  }
}

function readEnvVar(dir, key) {
  const p = join(dir, ".env");
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

class ProcessExitedEarlyError extends Error {
  constructor(code) {
    super(`process exited early (code ${code}) before the health check ever succeeded`);
    this.code = code;
  }
}

async function pollHealth(port, timeoutMs = 25000, proc = null) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new ProcessExitedEarlyError(proc.exitCode);
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/health`);
      const body = await res.json();
      if (body && body.success === true) return body;
      lastErr = new Error(`unexpected body: ${JSON.stringify(body)}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr ?? new Error("timed out");
}

async function pollUrlOk(url, timeoutMs = 20000, proc = null) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new ProcessExitedEarlyError(proc.exitCode);
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr ?? new Error("timed out");
}

async function testStack(stack) {
  log(`\n=== ${stack} (name: "${DIRTY_NAME}") ===`);
  const dir = mkdtempSync(join(SCRATCH_ROOT, `${stack}-`));
  let apiProc, webProc, apiHealthy = false;

  // Defensive: clear ports before use in case a prior run's watcher left a grandchild
  // server listening (see killPort's comment).
  killPort(5173);

  try {
    // 1. Scaffold (no shell — avoids word-splitting the dirty, space-containing name)
    const scaffoldResult = spawnSync(
      process.execPath,
      [SCAFFOLD, "--name", DIRTY_NAME, "--backend", stack, "--dir", dir, "--force"],
      { encoding: "utf8" }
    );
    if (scaffoldResult.status !== 0) {
      fail(`scaffold exited ${scaffoldResult.status}: ${scaffoldResult.stderr}`);
      return;
    }
    pass("scaffold");

    copyFileSync(join(dir, ".env.example"), join(dir, ".env"));

    // 2. npm install
    const install = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
    if (install.status !== 0) {
      fail(`npm install exited ${install.status}\n${install.stderr}`);
      return;
    }
    pass("npm install");

    // Go needs `go mod tidy` once after scaffolding to resolve go.sum (documented in
    // references/backend-go.md) — not part of npm install, run it explicitly here.
    if (stack === "go") {
      if (commandExists("go")) {
        const tidy = run("go", ["mod", "tidy"], { cwd: join(dir, "apps/api") });
        if (tidy.status !== 0) {
          fail(`go mod tidy exited ${tidy.status}\n${tidy.stderr}`);
        } else {
          pass("go mod tidy");
        }
      } else {
        skip(`${stack}: go mod tidy — 'go' not found on PATH`);
      }
    }

    // 3. Type-check
    const buildWeb = run("npm", ["run", "build:web"], { cwd: dir });
    if (buildWeb.status !== 0) {
      fail(`npm run build:web exited ${buildWeb.status}\n${buildWeb.stderr}`);
    } else {
      pass("build:web (tsc --noEmit + vite build)");
    }

    if (stack !== "go") {
      const buildApi = run("npm", ["run", "build:api"], { cwd: dir });
      if (buildApi.status !== 0) {
        fail(`npm run build:api exited ${buildApi.status}\n${buildApi.stderr}`);
      } else {
        pass("build:api");
      }
    } else if (commandExists("go")) {
      const buildApi = run("npm", ["run", "build:api"], { cwd: dir });
      if (buildApi.status !== 0) {
        fail(`npm run build:api exited ${buildApi.status}\n${buildApi.stderr}`);
      } else {
        pass("build:api (go build)");
      }
    } else {
      skip(`${stack}: build:api — 'go' not found on PATH`);
    }

    // 4. dev:api
    if (stack === "go" && !commandExists("air")) {
      skip(`${stack}: dev:api — 'air' not found on PATH`);
    } else {
      const port = readEnvVar(dir, "APP_PORT") ?? "8080";
      killPort(port);
      apiProc = spawn("npm", ["run", "dev:api"], { cwd: dir, shell: true, detached: process.platform !== "win32" });
      let apiOutput = "";
      apiProc.stdout?.on("data", (d) => { apiOutput += d; });
      apiProc.stderr?.on("data", (d) => { apiOutput += d; });
      try {
        const body = await pollHealth(port, 25000, apiProc);
        if (body.success === true) { apiHealthy = true; pass(`dev:api → GET /api/v1/health → ${JSON.stringify(body)}`); }
        // /readyz is the probe the image HEALTHCHECK and deploy.sh wait on (elcodelabs VPS).
        const ready = await fetch(`http://localhost:${port}/readyz`).catch((e) => ({ ok: false, status: e.message }));
        if (ready.ok) pass("dev:api → GET /readyz → 200");
        else fail(`dev:api GET /readyz did not return 200 (${ready.status})`);
      } catch (err) {
        if (stack === "go" && err instanceof ProcessExitedEarlyError) {
          // A FAILURE, not a skip. This branch used to be reported as "probably an AV/execution
          // policy" — and that hid a real scaffolder bug: .air.toml built tmp/main without
          // .exe, which Windows cannot run, so dev:api always exited. If an execution policy
          // truly blocks air, that still means dev:api does not work on this machine.
          fail(`${stack}: dev:api — 'air' exited immediately (code ${err.code}). Check .air.toml cmd/bin (they must build and run tmp/main.exe) before blaming an execution/AV policy:\n${apiOutput.trim()}`);
        } else {
          fail(`dev:api health check failed: ${err.message}\n${apiOutput.trim()}`);
        }
      }
    }

    // 5. dev:web (+ proxy)
    killPort(5173);
    webProc = spawn("npm", ["run", "dev:web"], { cwd: dir, shell: true, detached: process.platform !== "win32" });
    let webOutput = "";
    webProc.stdout?.on("data", (d) => { webOutput += d; });
    webProc.stderr?.on("data", (d) => { webOutput += d; });
    try {
      await pollUrlOk("http://localhost:5173/", 20000, webProc);
      pass("dev:web → Vite responds on :5173");
    } catch (err) {
      fail(`dev:web did not come up: ${err.message}\n${webOutput.trim()}`);
    }
    if (apiHealthy) {
      try {
        const body = await pollHealth(5173, 15000, webProc);
        if (body.success === true) pass(`dev:web proxy → /api/v1/health → ${JSON.stringify(body)}`);
      } catch (err) {
        fail(`Vite proxy to /api did not work: ${err.message}`);
      }
    } else {
      skip(`${stack}: proxy check — dev:api never came up healthy`);
    }
  } finally {
    killTree(apiProc);
    killTree(webProc);
    killPort(readEnvVar(dir, "APP_PORT") ?? "8080");
    killPort(5173);
    // On Windows, a just-killed child can hold file locks for a moment after taskkill
    // returns — retry cleanup instead of crashing the whole run over a stale handle.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 5) {
          log(`  (warning: could not remove temp dir ${dir}: ${err.message})`);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

for (const stack of STACKS) {
  await testStack(stack);
}

log("\n=== Summary ===");
if (skipped.length) {
  log(`Skipped (${skipped.length}):`);
  for (const s of skipped) log(`  - ${s}`);
}
if (failures > 0) {
  log(`FAILED: ${failures} check(s) did not pass.`);
  process.exit(1);
}
log("All smoke checks passed.");
process.exit(0);
