#!/usr/bin/env node

/**
 * sync-agents.mjs
 *
 * Copies agent definition files (*.md) from this repo's agents/ directory
 * into ~/.pi/agent/agents/.
 *
 * Default behavior: run at most once per package version by writing a stamp
 * file under ~/.pi/agent/state/. Use --force to bypass the stamp and overwrite
 * existing files.
 *
 * Usage:
 *   node scripts/sync-agents.mjs          # normal run (once per version)
 *   node scripts/sync-agents.mjs --force  # overwrite existing files
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "agents");
const agentRootDir = path.join(os.homedir(), ".pi", "agent");
const targetDir = path.join(agentRootDir, "agents");
const stateDir = path.join(agentRootDir, "state");
const stampFile = path.join(stateDir, "sync-agents.json");
const packageJsonPath = path.join(repoRoot, "package.json");
const forceOverwrite = process.argv.includes("--force");

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = readPackageVersion();

function readStamp() {
  if (!fs.existsSync(stampFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {
    return null;
  }
}

function shouldSkipByStamp() {
  if (forceOverwrite) return false;
  const stamp = readStamp();
  return stamp?.version === packageVersion;
}

function writeStamp() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stampFile,
    JSON.stringify(
      {
        version: packageVersion,
        syncedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

function main() {
  // Bail out gracefully if source dir doesn't exist (e.g. partial clone)
  if (!fs.existsSync(sourceDir)) {
    console.log(`[sync-agents] Source directory not found: ${sourceDir}`);
    console.log("[sync-agents] Skipping agent sync.");
    return;
  }

  if (shouldSkipByStamp()) {
    console.log(
      `[sync-agents] Already synced for version ${packageVersion}. Skipping (use --force to override).`
    );
    return;
  }

  const mdFiles = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."));

  if (mdFiles.length === 0) {
    console.log("[sync-agents] No agent .md files found in source. Skipping.");
    return;
  }

  // Ensure target directory exists
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const file of mdFiles) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    const existedBefore = fs.existsSync(dst);

    if (existedBefore && !forceOverwrite) {
      console.log(`  skipped  ${file}  (already exists)`);
      skipped++;
    } else {
      fs.copyFileSync(src, dst);
      const label = existedBefore ? "overwrote " : "copied    ";
      console.log(`  ${label}${file}`);
      copied++;
    }
  }

  writeStamp();

  console.log(
    `[sync-agents] Done — ${copied} copied, ${skipped} skipped (target: ${targetDir}, version: ${packageVersion})`
  );
}

main();
