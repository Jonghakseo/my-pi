# Harness refine target-selection regression cases

Use these cases when changing scope, promotion, solution-fit, target, or memory-upgrade rules. The expected result is about decision quality, not exact wording.

## E1. Repo root test command falls through to the system command

### Signal
- In one monorepo, several sessions run `pnpm test <app-path>` from the repository root.
- The root does not own a test runner, so the shell produces a cryptic error.
- The owning app command succeeds.
- One session also starts setup asynchronously and runs a test before setup completes.

### Expected
- Separate the two lessons instead of creating one broad validation framework.
- Root test behavior may become a `repo-local` Candidate when a root package script can refuse with actionable guidance.
- Setup-to-test ordering does not justify a generic dependency engine. Existing `&&`, one combined async job, or explicit procedure is the native mechanism.
- Do not add monorepo paths or setup semantics to a global Pi extension.

## E2. Generic async prerequisite proposal

### Signal
- One async job happens to be a prerequisite for a later command.
- Other async jobs in the same session are independent.
- Dependency can only be known from task meaning.

### Expected
- `Semantic determinism: context-dependent`.
- Reject automatic dependency inference.
- Prefer caller-declared shell/workflow composition. Hold only if multiple workflows demonstrate demand for an explicit generic dependency contract.

## E3. One campaign has inconsistent currency and translated benefit wording

### Signal
- A user corrects one locale's currency display and one campaign term across a landing page and spot translations.
- No durable policy source or independent recurrence is identified.

### Expected
- `Evidence breadth: same-feature`, even with multiple corrections and languages.
- Do not propose a new cross-surface lint command as a Candidate.
- Hold until a canonical policy source and independent recurrence exist, or reject as campaign-specific.

## E4. GitHub default view hits one deprecated field

### Signal
- One `gh issue view` call fails.
- Adding selected JSON fields succeeds.
- The CLI error is actionable and no recurrence is shown.

### Expected
- Usually Rejected signal or small Held idea.
- A memory update requires recurrence or an explicit user-wide preference.
- Do not add a wrapper or global command guard.

## E5. Worktree cleanup recheck catches an unsafe candidate

### Signal
- A cleanup skill initially misclassifies a directory, but its required pre-delete recheck finds a nested registered worktree before deletion.
- A branch delete is refused safely by Git.
- No data loss occurs.

### Expected
- Treat the successful safety gate as evidence that existing protection worked.
- A deterministic helper improvement may be Held, but it is not automatically a Candidate from one prevented incident.
- Promote only when recurrence, high residual risk, or a clearly smaller native helper change makes proportionality acceptable.

## E6. The same context-free command hazard appears in independent repositories

### Signal
- Two unrelated repositories exhibit the same shell command hazard.
- The bad state is decidable from explicit command arguments and cwd.
- Repo-local scripts cannot cover the shared execution path.

### Expected
- `Evidence breadth: cross-project` and `Semantic determinism: deterministic`.
- A global tool Candidate is eligible only after native alternatives and false-positive cases are documented.
- The implementation must not hardcode either repository's path, package names, or domain states.

## Review checklist

For every result, verify:

- Scope was selected before target.
- Promotion basis was not mistaken for evidence breadth.
- Existing native mechanism and smaller alternative were named.
- Semantic dependency was not inferred by a tool.
- `Proportionality: excessive` ideas were held or rejected.
- Memory retirement did not create a new mechanism solely to delete memory.
