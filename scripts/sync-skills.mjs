#!/usr/bin/env node

/**
 * sync-skills.mjs
 *
 * Copies skill directories from this repo's skills/ directory
 * into ~/.agents/skills/. Only copies skills that don't already exist
 * at the target — never overwrites user customizations.
 *
 * Usage:
 *   node scripts/sync-skills.mjs          # normal run
 *   node scripts/sync-skills.mjs --force  # overwrite existing files
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "skills");
const targetDir = path.join(os.homedir(), ".agents", "skills");
const forceOverwrite = process.argv.includes("--force");

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    console.log(`[sync-skills] Source directory not found: ${sourceDir}`);
    console.log("[sync-skills] Skipping skill sync.");
    return;
  }

  const skillDirs = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."));

  if (skillDirs.length === 0) {
    console.log("[sync-skills] No skill directories found in source. Skipping.");
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const dir of skillDirs) {
    const src = path.join(sourceDir, dir.name);
    const dst = path.join(targetDir, dir.name);
    const existedBefore = fs.existsSync(dst);

    if (existedBefore && !forceOverwrite) {
      console.log(`  skipped  ${dir.name}/  (already exists)`);
      skipped++;
    } else {
      copyDirRecursive(src, dst);
      const label = existedBefore ? "overwrote" : "copied  ";
      console.log(`  ${label}${dir.name}/`);
      copied++;
    }
  }

  console.log(
    `[sync-skills] Done — ${copied} copied, ${skipped} skipped (target: ${targetDir})`
  );
}

main();
