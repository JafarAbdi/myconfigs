# Project Contract

## Objective

One `/review` extension manages one Pi-session-private Wiff review: it can pull a branch pull request, audit an exact local Git candidate, open, discuss, fix, publish, or remove the review.

## Interface

- `/review` shows the action picker.
- `/review pull` imports the checked-out branch's pull request and opens Wiff.
- `/review audit [scope]` runs the four-agent local audit, opens Wiff, then starts a read-only discussion turn if the review still exists.
- `/review open`, `discuss`, `fix`, `push`, and `remove` act on the existing private review.
- An unknown first word preserves backward compatibility and is treated as the complete audit scope.
- Non-audit actions accept no trailing arguments.
- Autocomplete is a static action list and performs no external work.

## Requirements

- R1: A non-empty, safe full Pi session ID deterministically names one private Wiff data directory, `join(getAgentDir(), "wiff", <full-id>)`. Every Wiff child receives that absolute path through its own `WIFF_DATA_DIR`; Review never mutates the parent environment.
- R2: Review runs Wiff from the resolved repository root. It ignores ordinary Wiff storage and adds no Pi workflow entry, sidecar, session picker, or second review-state model.
- R3: One Pi session owns at most one Wiff review in its private data directory. `wiff session list --all` is used only to distinguish exact `No sessions.` from an existing review; rows are never parsed or selected. Switching between a pulled review and a local audit requires removal or a new Pi session.
- R4: After discovery, Review reads schema-checked `wiff render --format json`, pins its full session ID and project, and passes both to every Wiff action that supports them. Wiff Markdown is used verbatim and never parsed.
- R5: Every bounded audit request goes with changed-path inventories to one fresh structured Luna resolver. It chooses staged, unstaged, untracked, or overall and returns the whole view or exact inventory paths. Review host-validates the result, displays the scope, rejects empty or larger-than-8-MiB candidates, and never mutates Git.
- R6: Every audit runs the contract, correctness, tests, and simplicity reviewers concurrently. Each reviewer sees the exact candidate but no Wiff feedback. Each concrete finding is one plain sentence of at most 240 characters. A reviewer failure publishes nothing.
- R7: After the reviewers, one fresh structured Sonnet pass sees the exact candidate, every candidate finding under a stable ID, and the current unresolved, non-deleted, top-level comments from this private Wiff review. It verifies candidates, scores confidence from 0 through 100, merges same-defect candidates, suppresses candidates equivalent to an open Wiff comment, and selects existing candidate IDs rather than rewriting findings. Only selections scoring at least 80 publish. Synthesis failure publishes nothing. Resolved comments, deleted comments, and replies do not participate, and audit never reopens a comment.
- R8: Review revalidates repository root, HEAD, view, ordered paths, and exact patch bytes after synthesis. A mismatch fails before Wiff creation, refresh, or publication.
- R9: A first local audit pipes the exact patch to `wiff new --no-tui --agent --author pi-review --description <text>`. A repeated audit requires the existing Wiff source to be exactly `stdin`, then pipes the patch to an exact `wiff refresh --session <id> --project <project>`. It never uses `--if-needed` for stdin snapshots.
- R10: Selected audit findings publish in their original deterministic roster/result order with `wiff comment add --agent --author review/<category> --session <id> --project <project>`, exact file and line, optional deletion side, and body on stdin. Findings never set verdicts. Every subprocess exit is checked.
- R11: `/review pull` refuses when the private review already exists, resolves the checked-out branch pull request and GitHub token only after invocation, then hands the terminal to existing `wiff forge pull <number>`. It restores Pi's TUI on every exit path. Wiff's `Ctrl-R` owns later forge synchronization.
- R12: `/review open` hands the terminal to exact `wiff resume --session <id> --project <project>` and always restores Pi's TUI.
- R13: `/review discuss` reads exact Wiff Markdown into one ordinary read-only Pi turn and changes neither code nor Wiff. A successful `/review audit` starts the same discussion automatically after Wiff closes, unless Wiff removed the review.
- R14: `/review fix` reads exact Wiff Markdown into one ordinary implementation turn. Only that exact generated run can use the narrow `wiff_resolve` tool, which accepts one comment and an optional reply, pins the private data directory, repository, session, project, and agent author internally, optionally replies, then resolves the still-open live comment. The tool is activated when that generated prompt starts, checks the invocation on every call, and is deactivated before any different prompt starts as well as on settle or shutdown. The fixing agent calls it only after completely addressing a comment and running relevant checks; partly addressed, unclear, resolved, deleted, or unknown comments stay unchanged. Review exposes no general Wiff tool.
- R15: `/review push` shows authors found in Wiff state, confirms the exact author and kind, obtains a GitHub token only after confirmation, and runs `wiff forge push --session <id> --author <name>` with `--agent` for agent authors. It publishes review feedback, not Git commits.
- R16: `/review remove` shows the exact review and open-comment count, confirms, then runs `wiff session rm <id> --project <project>`. Nothing removes a review automatically.
- R17: External work is visible. Review uses cancellable bordered loaders for work it owns, including synthesis, keeps the existing live audit widget, announces terminal handoff, and reports success or failure honestly. Autocomplete is the only silent path because it performs no work.
- R18: Review uses argument arrays and stdin, never shell command strings. GitHub and Wiff credentials exist only in the child environment. No token enters notifications, Pi messages, or persistent state.
- R19: Review uses no timer APIs (`setTimeout`, intervals, or timer-based polling). Subprocess lifetime and cancellation are governed only by `AbortSignal` and process events.

## Invariants

- I1: Wiff is the sole owner of sessions, comments, replies, anchors, rebasing, verdicts, and durable review history.
- I2: One audit invocation's resolved view plus ordered exact path selection is its candidate boundary; changes outside selected paths do not make it stale.
- I3: Findings are advisory and bounded. No finding automatically authorizes implementation.
- I4: A pulled review and a local stdin audit are alternative sources for the private review; Review never claims they are the same diff.
- I5: Review never commits, pushes Git commits, deploys, or reads/writes Wiff journals directly.
- I6: Existing managed worktrees, ordinary Wiff data, and unrelated Pi data remain untouched.
- I7: Cross-audit duplicate suppression is confined to repeated audits of the same Pi-session-private Wiff review. Independent Pi sessions remain independent reviews.

## Failure Rules

- F1: Cancellation aborts child work where supported and never reports success.
- F2: Reviewer or synthesis failure stops before Wiff creation, refresh, or publication. Publication failure stops immediately. A newly created audit session may be removed best-effort; an existing refreshed session and already-published comments are retained and reported.
- F3: If Wiff removed its session in the TUI, Review reports that and does not recreate it.
- F4: Unsupported or malformed Wiff JSON fails visibly.
- F5: A non-stdin existing review blocks local audit; an existing review blocks pull. The error suggests `/review open`, `/review remove`, or a new Pi session as appropriate.

## Non-Goals

- No Wiff source changes, HTTP server, browser, custom diff renderer, session browser, GitHub autocomplete, persistent Pi workflow state, or parsing of Wiff's journal or Markdown.
- No automatic approval, removal, publishing, implementation, retry, comment reopening, cross-Pi-session deduplication, or rollback.
- No support for multiple independent reviews in one Pi session; use another Pi session.
