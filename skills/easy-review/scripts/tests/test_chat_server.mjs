import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEasyReviewServer, ReviewContext } from "../chat_server.mjs";

const SOURCE_SHA = "a".repeat(64);

function sampleReview() {
  const lines = [
    { id: "D000001", text: "diff --git a/app.py b/app.py", kind: "file_header", old_line: null, new_line: null },
    { id: "D000002", text: "@@ -1 +1 @@", kind: "hunk_header", old_line: null, new_line: null },
    { id: "D000003", text: "-value = 1", kind: "deletion", old_line: 1, new_line: null },
    { id: "D000004", text: "+value = 2", kind: "addition", old_line: null, new_line: 1 },
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
  assert.match(context.systemPrompt(), /You have no tools/);
});

test("Pi SDK server inherits auth runtime while disabling tools and resources", async (t) => {
  const { bundle, state, app } = await fixture();
  t.after(async () => { await app.close(); await rm(bundle, { recursive: true, force: true }); });
  assert.equal(state.reloaded, true);
  assert.equal(state.loaderOptions.noExtensions, true);
  assert.equal(state.loaderOptions.noSkills, true);
  assert.equal(state.loaderOptions.noContextFiles, true);
  assert.equal(state.sessionOptions[0].noTools, "all");
  assert.deepEqual(state.sessionOptions[0].tools, []);

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
