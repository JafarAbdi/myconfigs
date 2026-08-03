# JURUC C3 Contract

## Objective

Run one strict Questions → Research → Specification → Plan → Implementation workflow with fresh, bounded sessions, validated authoritative artifacts, phase-declared verification, and extension-owned local commits.

## Lifecycle

- Stages are exactly `questions`, `research`, `specification`, `plan`, `implementation`, and `done`.
- Transitions move forward only: confirmed Questions starts Research; persisted research starts Specification; confirmed Specification starts Plan; accepted Plan starts Implementation; each checkpoint advances the phase; the final checkpoint currently reaches `done`.
- Failed verification leaves the active implementation phase open and resumable. There is no blocked lifecycle, backtracking, replanning, renewed research, or plan extension.
- `/juruc` creates or resumes the single authoritative next action.

## Artifacts

- `task.json` version 3 is authoritative and strictly validated. There is no compatibility parser.
- Questions records confirmed shared understanding, unique decisions, accepted assumptions, and factual research targets.
- Research always runs. Exact UTF-8 synthesis bytes are atomically saved to the fixed task-directory `research.md`. Specification requires that regular file and accepts its current contents as authoritative.
- Specification records implementation-neutral summary, requirements, non-goals, constraints, acceptance criteria, and decisions.
- The explicitly accepted Plan is immutable and contains only ordered final-shape phases: unique kebab-case ID, title, goal, safe repository-relative file scopes, instructions, and verification commands.
- Completed phases are stored once in the top-level append-only `checkpoints` list. Every checkpoint exactly copies its accepted phase and adds all-zero ordered verification evidence, resolution, and commit OID.
- Session history is one append-only typed `sessions` list with globally unique absolute paths and unique logical scopes.

## Information Diets

- Questions receives only the original request and read-only source repository access. It asks one unresolved material choice per turn, recommends an answer, investigates repository facts, and calls `juruc_set_questions` only after explicit confirmation.
- Research receives only the request, confirmed Questions result and targets, and source repository. Its coordinator may only delegate to the approved research agents.
- Specification receives only the request, confirmed Questions result, and current research text. It has no repository tools.
- Plan receives only the validated Specification and read-only source repository access. It calls `juruc_set_plan` only after explicit human acceptance.
- Each Implementation phase receives only the validated Specification, authoritative current phase, and relevant checkpoint facts. It cannot commit.
- Session transcripts are never authoritative artifacts and are not passed as task context.

## Tools and Ownership

- Model workflow tools are exactly `juruc_set_questions`, `juruc_set_specification`, `juruc_set_plan`, `juruc_run_verification`, and `juruc_finish_phase`.
- Every workflow tool must be the sole tool call and is accepted only from the active task-owned typed session run in the correct working directory. A synthesizer delegate must likewise be the sole call.
- Every declared stage tool must be registered. Stale task-owned sessions have no active tools and block every attempted tool call with `/juruc` resume guidance; sessions not owned by a task retain their normal tools.
- Questions and Plan are read-only; Specification has only its completion tool; Research is delegate-only. Implementation has repository editing tools, `juruc_run_verification`, and `juruc_finish_phase`, but no unrestricted shell. The verifier runs only exact commands from the human-accepted active phase in the managed worktree with bounded time and output.
- JURUC owns task persistence, transitions, scope enforcement, staging, checkpoint commits, and automatic fresh-session advancement. It never pushes or publishes.

## Workspace Boundary

- Through C3, task creation still creates the branch and managed worktree early. Questions, Research, and Plan run from `sourceRoot`; Specification runs from the task directory with no repository tools; Implementation runs from the existing managed worktree.
- Checkpoint C4 will defer worktree creation until accepted Plan and copy the approved fixed local-file set. Do not claim that behavior before C4.

## Persistence and Safety

- Persisted objects reject unknown fields, malformed values, duplicate normalized list entries, unsafe file scopes, duplicate phase IDs, duplicate session paths/scopes, checkpoint drift, and inconsistent stages.
- Save `task.json` and `research.md` by atomic replacement.
- Use ordinary Git object IDs and commands. A changed candidate with exact all-zero declared evidence is required for every checkpoint commit, and every staged path must match the active phase's Git pathspec scopes.
- Before implementation resumes, descendant commits absent from `task.json` are reset mixed to the latest recorded task head so their file changes remain candidates. Divergent history fails; recorded checkpoint commits are immutable.
- One experienced operator owns a task and does not mutate its runtime state concurrently.

## Deferred Work

- Advisory deviation/correctness reviewers, authoritative review rounds, browser integration, human feedback corrections, explicit final acceptance, and the final picker/review TUI are future checkpoints.
- No PR creation, push, deployment, publication, remote review, accounts, telemetry, or collaboration features.
