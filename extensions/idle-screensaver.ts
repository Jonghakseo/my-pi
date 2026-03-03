import {
  ExtensionContext,
  ExtensionEvent,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "child_process";
import { listBlueprints } from "./intent/blueprint";
import { Blueprint } from "./intent/types";

/**
 * Idle screensaver extension
 * Shows a full-screen overlay after 30 min of inactivity.
 * Dismissed by any keypress.
 * If a blueprint is active (running/confirmed), shows its progress.
 */

const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const EDITOR_POLL_INTERVAL_MS = 300;
const PURPOSE_ENTRY_TYPE = "purpose:set";

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let editorPollTimer: ReturnType<typeof setInterval> | null = null;
let agentRunning = false;
let overlayActive = false;
let askUserQuestionActive = false;
let latestCtx: ExtensionContext | null = null;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleTimer() {
  clearIdleTimer();
  if (agentRunning || overlayActive || askUserQuestionActive) return;
  idleTimer = setTimeout(() => {
    showScreensaver();
  }, IDLE_MS);
}

function stopEditorPoller() {
  if (editorPollTimer) {
    clearInterval(editorPollTimer);
    editorPollTimer = null;
  }
}

function startEditorPoller() {
  stopEditorPoller();
  let lastText = latestCtx?.editor?.text ?? "";
  editorPollTimer = setInterval(() => {
    const currentText = latestCtx?.editor?.text ?? "";
    if (currentText !== lastText) {
      lastText = currentText;
      scheduleIdleTimer();
    }
  }, EDITOR_POLL_INTERVAL_MS);
}

const STATUS_ICON: Record<string, string> = {
  pending:   "○",
  running:   "●",
  completed: "✓",
  failed:    "✗",
  skipped:   "–",
};

function elapsedStr(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function buildBlueprintLines(blueprint: Blueprint, maxWidth: number): string[] {
  const lines: string[] = [];

  const total = blueprint.nodes.length;
  const done = blueprint.nodes.filter(
    (n) => n.status === "completed" || n.status === "skipped"
  ).length;
  const failed = blueprint.nodes.filter((n) => n.status === "failed").length;
  const badge =
    failed > 0
      ? `❌ [${done}/${total}]`
      : blueprint.status === "completed"
      ? `✅ [${done}/${total}]`
      : `▶ [${done}/${total}]`;

  lines.push(truncateToWidth(`📋 ${blueprint.title}  ${badge}`, maxWidth));

  for (const node of blueprint.nodes) {
    const icon = STATUS_ICON[node.status] ?? " ";
    const isRunning = node.status === "running";
    const timeStr = node.startedAt ? ` (${elapsedStr(node.startedAt, node.completedAt)})` : "";
    const agentStr = (node as any).agent ? ` → ${(node as any).agent}` : "";
    const idW = 12;
    const nodeIdPadded = node.id.padEnd(idW).slice(0, idW);
    const meta = `${node.purpose}/${node.difficulty}${agentStr}${timeStr}`;
    const metaW = 32;
    const metaTrunc = truncateToWidth(meta, metaW);
    const taskW = Math.max(0, maxWidth - 2 - idW - 2 - metaW - 2);
    const taskStr = truncateToWidth(node.task, taskW);
    const rowIcon = isRunning ? "●" : icon;
    lines.push(
      truncateToWidth(
        `  ${rowIcon} ${nodeIdPadded}  ${metaTrunc.padEnd(metaW)}  ${taskStr}`,
        maxWidth
      )
    );
  }

  return lines;
}

async function showScreensaver() {
  if (!latestCtx || !latestCtx.ui) return;

  overlayActive = true;
  clearIdleTimer();

  const history = latestCtx.session?.history ?? [];
  const purposeEntry = [...history]
    .reverse()
    .find((e) => e.type === PURPOSE_ENTRY_TYPE);

  let title: string;
  if (purposeEntry?.content) {
    title = purposeEntry.content as string;
  } else {
    // Fallback: folder/branch or session name
    const folder = latestCtx.session?.folder ?? "";
    const sessionName = latestCtx.session?.name ?? "Pi";
    let branch = "";
    try {
      branch = execSync("git branch --show-current", {
        cwd: folder,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {}
    title = branch ? `${folder.split("/").pop()}/${branch}` : sessionName;
  }

  // Find active blueprint (running or confirmed = not yet started)
  let activeBlueprint: Blueprint | null = null;
  try {
    const blueprints = listBlueprints();
    activeBlueprint =
      blueprints.find((b) => b.status === "running" || b.status === "confirmed") ?? null;
  } catch {}

  await latestCtx.ui.custom?.((width, height) =>
    renderScreensaver(width, height, title, activeBlueprint)
  );

  overlayActive = false;
  scheduleIdleTimer();
}

function renderScreensaver(
  width: number,
  height: number,
  title: string,
  blueprint?: Blueprint | null
): string {
  const lines: string[] = [];

  const border = new DynamicBorder(width, height, {
    title: " Pi ",
    titlePosition: "right",
    style: "single",
  });

  const borderLines = border.getLines();
  const innerWidth = border.innerWidth;
  const innerHeight = border.innerHeight;

  // ── helpers ──────────────────────────────────────────────────
  const emptyBorderLine = () => borderLines[lines.length];

  const placeLine = (chars: string) => {
    const idx = lines.length;
    const left = borderLines[idx].slice(0, 1);
    const right = borderLines[idx].slice(-1);
    const vw = visibleWidth(chars);
    return left + chars + " ".repeat(Math.max(0, innerWidth - vw)) + right;
  };

  const centerLine = (text: string) => {
    const tw = visibleWidth(text);
    const pad = Math.max(0, Math.floor((innerWidth - tw) / 2));
    return placeLine(" ".repeat(pad) + text);
  };

  // ── title box dimensions ─────────────────────────────────────
  const compact = title.trim();
  const spread = compact.length <= 24
    ? compact.split("").join(" ")
    : compact;

  const doubleBoxW = Math.min(innerWidth - 4, Math.max(visibleWidth(spread) + 8, 40));
  const dblLeft = Math.floor((innerWidth - doubleBoxW) / 2);

  const titleInBox = visibleWidth(spread) <= doubleBoxW - 4
    ? spread.padStart(Math.floor((doubleBoxW - 2 + spread.length) / 2)).padEnd(doubleBoxW - 2)
    : spread.slice(0, doubleBoxW - 4);

  const placeBoxLine = (chars: string) => {
    const idx = lines.length;
    const left = borderLines[idx].slice(0, 1);
    const right = borderLines[idx].slice(-1);
    const pad = " ".repeat(dblLeft);
    return (
      left +
      pad +
      chars +
      " ".repeat(Math.max(0, innerWidth - dblLeft - visibleWidth(chars))) +
      right
    );
  };

  const topDoubleBar = "╔" + "═".repeat(doubleBoxW - 2) + "╗";
  const midDoubleBar = "║" + " ".repeat(doubleBoxW - 2) + "║";
  const botDoubleBar = "╚" + "═".repeat(doubleBoxW - 2) + "╝";

  // ── blueprint widget lines (pre-compute) ─────────────────────
  const bpRawLines = blueprint ? buildBlueprintLines(blueprint, innerWidth - 4) : [];

  // ── layout: top padding ──────────────────────────────────────
  const TITLE_BOX_H = 4; // top + title + empty + bottom
  const FOOTER_H = 1;
  const BP_SPACING = bpRawLines.length > 0 ? 1 : 0;

  // Reserve at most (innerHeight - titleBox - footer - spacing - 2) lines for blueprint
  const maxBpH = Math.max(0, innerHeight - TITLE_BOX_H - FOOTER_H - BP_SPACING - 2);
  const bpLines = bpRawLines.slice(0, maxBpH);

  const contentH = TITLE_BOX_H + BP_SPACING + bpLines.length + FOOTER_H;
  const topPad = Math.max(0, Math.floor((innerHeight - contentH) / 2) - 1);

  // ── render ───────────────────────────────────────────────────
  // 1. Top border
  lines.push(borderLines[0]);

  // 2. Top padding
  for (let i = 0; i < topPad; i++) lines.push(emptyBorderLine());

  // 3. Title double-box
  lines.push(placeBoxLine(topDoubleBar));
  lines.push(placeBoxLine(midDoubleBar.slice(0, 1) + " " + titleInBox + " " + midDoubleBar.slice(-1)));
  lines.push(placeBoxLine(midDoubleBar));
  lines.push(placeBoxLine(botDoubleBar));

  // 4. Blueprint widget (if active)
  if (bpLines.length > 0) {
    lines.push(emptyBorderLine()); // spacing
    for (const bl of bpLines) {
      if (lines.length >= height - 2) break;
      lines.push(placeLine("  " + bl));
    }
  }

  // 5. Fill remaining rows until footer
  while (lines.length < height - 2) lines.push(emptyBorderLine());

  // 6. Footer
  if (lines.length === height - 2) {
    lines.push(centerLine("Press any key to dismiss"));
  }

  // 7. Bottom border
  while (lines.length < height - 1) lines.push(emptyBorderLine());
  lines.push(borderLines[height - 1]);

  return lines.join("\n");
}

export default function idleScreensaver(ctx: ExtensionContext) {
  latestCtx = ctx;

  ctx.events.on("input", (event: ExtensionEvent) => {
    if (event.source !== "extension") {
      scheduleIdleTimer();
    }
  });

  ctx.events.on("agent_start", () => {
    agentRunning = true;
    clearIdleTimer();
  });

  ctx.events.on("agent_end", () => {
    agentRunning = false;
    scheduleIdleTimer();
  });

  ctx.events.on("tool_execution_start", (event: ExtensionEvent) => {
    if (event.toolName === "AskUserQuestion") {
      askUserQuestionActive = true;
      clearIdleTimer();
    }
    latestCtx = ctx;
  });

  ctx.events.on("tool_execution_end", (event: ExtensionEvent) => {
    if (event.toolName === "AskUserQuestion") {
      askUserQuestionActive = false;
    }
    latestCtx = ctx;
  });

  ctx.events.on("session_start", () => {
    latestCtx = ctx;
    scheduleIdleTimer();
    startEditorPoller();
  });

  ctx.events.on("session_switch", () => {
    latestCtx = ctx;
    clearIdleTimer();
    stopEditorPoller();
    overlayActive = false;
    scheduleIdleTimer();
    startEditorPoller();
  });

  ctx.events.on("session_shutdown", () => {
    clearIdleTimer();
    stopEditorPoller();
  });

  scheduleIdleTimer();
  startEditorPoller();
}
