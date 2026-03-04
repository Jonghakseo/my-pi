#!/usr/bin/env node

/**
 * sync-agents.mjs
 *
 * Copies agent definition files (*.md) from this repo's agents/ directory
 * into ~/.pi/agent/agents/. Only copies files that don't already exist
 * at the target — never overwrites user customizations.
 *
 * Usage:
 *   node scripts/sync-agents.mjs          # normal run
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
const targetDir = path.join(os.homedir(), ".pi", "agent", "agents");
const forceOverwrite = process.argv.includes("--force");

function main() {
  // Bail out gracefully if source dir doesn't exist (e.g. partial clone)
  if (!fs.existsSync(sourceDir)) {
    console.log(`[sync-agents] Source directory not found: ${sourceDir}`);
    console.log("[sync-agents] Skipping agent sync.");
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
      const label = existedBefore ? "overwrote" : "copied  ";
      console.log(`  ${label}${file}`);
      copied++;
    }
  }

  console.log(
    `[sync-agents] Done — ${copied} copied, ${skipped} skipped (target: ${targetDir})`
  );
}

main();
