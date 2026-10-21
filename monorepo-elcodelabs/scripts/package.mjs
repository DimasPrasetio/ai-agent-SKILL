#!/usr/bin/env node
// Rebuilds dist/monorepo-elcodelabs.skill from source, so the shipped package never drifts
// from SKILL.md / references/ / scripts/. Zero npm dependencies: it shells out to the zip
// tool the platform already has (matches the extraction fallback chain in install.sh).
//
// Usage: node scripts/package.mjs

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SKILL_NAME = "monorepo-elcodelabs";
const OUT = join(REPO_ROOT, "dist", `${SKILL_NAME}.skill`);

// This is the entire contract: only these are installed by install.ps1/install.sh.
// evals/, dist/, install.*, Plan.md, .gitignore, .git/ must never appear in the package.
const PAYLOAD = ["SKILL.md", "README.md", "references", "scripts"];
const FORBIDDEN = ["evals", "dist", "install.ps1", "install.sh", "Plan.md", ".git", ".gitignore"];

const scratchRoot = join(REPO_ROOT, ".smoke-tmp");
mkdirSync(scratchRoot, { recursive: true });
const stageParent = mkdtempSync(join(scratchRoot, "package-"));
const stageRoot = join(stageParent, SKILL_NAME);
mkdirSync(stageRoot, { recursive: true });

try {
  for (const rel of PAYLOAD) {
    const src = join(REPO_ROOT, rel);
    if (!existsSync(src)) throw new Error(`payload entry missing from repo: ${rel}`);
    cpSync(src, join(stageRoot, rel), { recursive: true });
  }

  // Defensive check on what we staged, independent of how the zip tool behaves.
  const staged = readdirSync(stageRoot);
  const stray = staged.filter((name) => FORBIDDEN.includes(name));
  if (stray.length) throw new Error(`staged package contains forbidden entries: ${stray.join(", ")}`);

  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) rmSync(OUT);

  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stageParent}', '${OUT}')`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`PowerShell zip failed: ${r.stderr}`);
  } else if (spawnSync("zip", ["-v"], { stdio: "ignore", shell: true }).status === 0) {
    const r = spawnSync("zip", ["-rq", OUT, SKILL_NAME], { cwd: stageParent, shell: true });
    if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  } else if (spawnSync("python3", ["--version"], { stdio: "ignore", shell: true }).status === 0) {
    const py = `
import zipfile, os
root = ${JSON.stringify(stageParent)}
out = ${JSON.stringify(OUT)}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirs, files in os.walk(root):
        for f in files:
            full = os.path.join(dirpath, f)
            zf.write(full, os.path.relpath(full, root))
`;
    const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python3 zip failed: ${r.stderr}`);
  } else {
    throw new Error("Need PowerShell, 'zip', or 'python3' to build the package.");
  }

  // Verify the produced archive's actual entries, not just what we intended to stage.
  let entries = [];
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ([System.IO.Compression.ZipFile]::OpenRead('${OUT}')).Entries.FullName`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`PowerShell listing failed: ${r.stderr}`);
    entries = r.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean);
  } else if (spawnSync("unzip", ["-v"], { stdio: "ignore", shell: true }).status === 0) {
    const r = spawnSync("unzip", ["-Z1", OUT], { encoding: "utf8", shell: true });
    entries = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  if (entries.length) {
    const badEntries = entries.filter((e) => FORBIDDEN.some((f) => e === `${SKILL_NAME}/${f}` || e.startsWith(`${SKILL_NAME}/${f}/`)));
    if (badEntries.length) throw new Error(`package contains forbidden entries: ${badEntries.join(", ")}`);
    if (!entries.some((e) => e === `${SKILL_NAME}/SKILL.md`)) throw new Error("package is missing SKILL.md");
  }

  const size = statSync(OUT).size;
  console.log(`✓ Built ${OUT} (${size} bytes, ${entries.length || "?"} entries)`);
} finally {
  rmSync(stageParent, { recursive: true, force: true });
}
