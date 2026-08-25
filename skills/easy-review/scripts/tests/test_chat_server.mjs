import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEasyReviewServer, createReviewDiffTool, ReviewContext } from "../chat_server.mjs";

const SOURCE_SHA = "a".repeat(64);

function sampleReview() {
  const lines = [
    { id: "D000001", text: "diff --git a/app.py b/app.py", kind: "file_header", file_id: "F001", hunk_id: null, old_line: null, new_line: null },
    { id: "D000002", text: "@@ -1 +1 @@", kind: "hunk_header", file_id: "F001", hunk_id: "H0001", old_line: null, new_line: null },
    { id: "D000003", text: "-value = 1", kind: "deletion", file_id: "F001", hunk_id: "H0001", old_line: 1, new_line: null },
    { id: "D000004", text: "+value = 2", kind: "addition", file_id: "F001", hunk_id: "H0001", old_line: null, new_line: 1 },
  ];
  return {
    source: { source_sha256: SOURCE_SHA, lines },
    coverage: { status: "complete", reviewed_files: 1, total_files: 1 },
    files: [{ id: "F001", path: "app.py" }],
    plan: {
      title: "Value update",
      summary: "Updates the value.",
      overview: ["The value changes."],
      attention: [],
      verification: [],
      sections: [{
        id: "value-update",
        title: "Update value",
        summary: "Changes one assignment.",
        evidence: ["D000004"],
        files: [{
          file_id: "F001",
          view: "detail",
          note: "Changes the assignment.",
          focus: [{ start: "D000003", end: "D000004", reason: "The exact value change." }],
          collapse: [],
        }],
      }],
    },
  };
}

function fakeSdk(state) {
  class FakeLoader {
    constructor(options) { state.loaderOptions = options; }
    async reload() { state.reloaded = true; }
  }
  class FakeSession {
    constructor() {
      this.model = { provider: "fake", id: "review-model" };
      this.listeners = new Set();
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async prompt(prompt) {
      state.prompts.push(prompt);
      for (const listener of this.listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "safe answer" } });
      }
    }
    async abort() { state.aborted += 1; }
    dispose() { state.disposed += 1; }
  }
  return {
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: FakeLoader,
    SessionManager: { inMemory: (cwd) => ({ cwd }) },
    getAgentDir: () => "/fake/agent",
    defineTool: (definition) => definition,
    createAgentSession: async (options) => {
      state.sessionOptions.push(options);
      return { session: new FakeSession() };
    },
  };
}

async function fixture() {
  const bundle = await mkdtemp(join(tmpdir(), "easy-review-sdk-test-"));
  await writeFile(join(bundle, "review.json"), JSON.stringify(sampleReview()));
  await writeFile(join(bundle, "review.html"), "<!doctype html><title>Review</title>");
  await writeFile(join(bundle, "source.diff"), "diff");
  const state = { prompts: [], aborted: 0, disposed: 0, sessionOptions: [], loaderOptions: null, reloaded: false };
  const app = await createEasyReviewServer({ bundle, sdk: fakeSdk(state) });
  return { bundle, state, app };
}

test("review context includes selected bundle evidence", () => {
  const context = new ReviewContext(sampleReview());
  const prompt = context.questionPrompt("What changed?", "value-update", "selected code");
  assert.match(prompt, /selected code/);
  assert.match(prompt, /D000004 old:- new:1 \[addition\] \+value = 2/);
  assert.match(context.systemPrompt(), /exactly one read-only tool named review_diff/);
});

test("review_diff lists the captured file catalog without filters", async () => {
  const context = new ReviewContext(sampleReview());
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const result = await tool.execute("call-1", {});

  assert.match(result.content[0].text, /Captured Easy Review diff files only/);
  assert.match(result.content[0].text, /app\.py \[review=detail\]/);
  assert.equal(result.details.mode, "catalog");
  assert.equal(result.details.totalFiles, 1);
});

test("review_diff reads only the captured bundle with bounded pagination", async () => {
  const context = new ReviewContext(sampleReview());
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const first = await tool.execute("call-1", { path: "app.py", limit: 2 });

  assert.match(first.content[0].text, /Captured Easy Review diff only/);
  assert.match(first.content[0].text, /FILE app\.py \[review=detail\]/);
  assert.match(first.content[0].text, /D000001/);
  assert.equal(first.details.totalLines, 4);
  assert.equal(first.details.returnedLines, 2);
  assert.equal(first.details.nextOffset, 2);

  const second = await tool.execute("call-2", { path: "app.py", offset: 2, limit: 2 });
  assert.match(second.content[0].text, /D000004 old:- new:1 \[addition\] \+value = 2/);
  assert.equal(second.details.nextOffset, null);
});

test("review_diff searches matching captured hunks and cites anchors", async () => {
  const context = new ReviewContext(sampleReview());
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const result = await tool.execute("call-1", { query: "value = 2" });

  assert.match(result.content[0].text, /D000002/);
  assert.match(result.content[0].text, /D000003 old:1 new:- \[deletion\] -value = 1/);
  assert.match(result.content[0].text, /D000004 old:- new:1 \[addition\] \+value = 2/);
  assert.equal(result.details.totalLines, 3);
});

test("review_diff labels raw diff from unreviewed files", async () => {
  const review = sampleReview();
  review.source.lines.push(
    { id: "D000005", text: "diff --git a/raw.txt b/raw.txt", kind: "file_header", file_id: "F002", hunk_id: null, old_line: null, new_line: null },
    { id: "D000006", text: "+not reviewed", kind: "addition", file_id: "F002", hunk_id: "H0002", old_line: null, new_line: 1 },
  );
  review.files.push({ id: "F002", path: "raw.txt" });
  review.plan.unreviewed_file_ids = ["F002"];
  const context = new ReviewContext(review);
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const result = await tool.execute("call-1", { path: "raw.txt" });

  assert.match(result.content[0].text, /FILE raw\.txt \[review=unreviewed\]/);
  assert.match(result.content[0].text, /\+not reviewed/);
});

test("review_diff never resolves arbitrary filesystem paths", async () => {
  const context = new ReviewContext(sampleReview());
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const result = await tool.execute("call-1", { path: "/etc/passwd" });

  assert.match(result.content[0].text, /No captured diff file matched/);
  assert.equal(result.details.error, "file-not-found");
  assert.doesNotMatch(result.content[0].text, /root:/);
});

test("review_diff enforces line and character bounds defensively", async () => {
  const review = sampleReview();
  review.source.lines[3].text = `+${"x".repeat(40_000)}`;
  const context = new ReviewContext(review);
  const tool = createReviewDiffTool({ defineTool: (definition) => definition }, context);
  const result = await tool.execute("call-1", { anchor: "d000004", limit: 999 });

  assert.ok(result.content[0].text.length <= 32_000);
  assert.equal(result.details.limit, 200);
  assert.equal(result.details.truncatedByChars, true);
});

test("Pi SDK server inherits auth runtime while exposing only review_diff", async (t) => {
  const { bundle, state, app } = await fixture();
  t.after(async () => { await app.close(); await rm(bundle, { recursive: true, force: true }); });
  assert.equal(state.reloaded, true);
  assert.equal(state.loaderOptions.noExtensions, true);
  assert.equal(state.loaderOptions.noSkills, true);
  assert.equal(state.loaderOptions.noPromptTemplates, true);
  assert.equal(state.loaderOptions.noThemes, true);
  assert.equal(state.loaderOptions.noContextFiles, true);
  assert.equal(state.sessionOptions[0].noTools, "builtin");
  assert.deepEqual(state.sessionOptions[0].tools, ["review_diff"]);
  assert.equal(state.sessionOptions[0].customTools.length, 1);
  assert.equal(state.sessionOptions[0].customTools[0].name, "review_diff");

  const query = `?bundle=${SOURCE_SHA}`;
  const health = await fetch(`${app.origin}/api/health${query}`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    connected: true,
    busy: false,
    scope: "review-bundle-only",
    runtime: "pi-sdk",
    model: "fake/review-model",
  });

  const forbidden = await fetch(`${app.origin}/api/chat${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.local" },
    body: JSON.stringify({ message: "question" }),
  });
  assert.equal(forbidden.status, 403);

  const response = await fetch(`${app.origin}/api/chat${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify({ message: "question", sectionId: "value-update", selection: "picked" }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events, [
    { type: "start" },
    { type: "delta", delta: "safe answer" },
    { type: "done" },
  ]);
  assert.match(state.prompts[0], /picked/);
});
