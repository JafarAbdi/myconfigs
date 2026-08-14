# Final Plan: Audit Synthesis and Fix Resolution

## Outcome

Keep the four reviewers independent, add one final pass that publishes only strong non-duplicate findings, and give `/review fix` one temporary tool for resolving comments it actually fixes. Wiff remains the only durable review state.

## Decisions

- Reviewers continue to inspect only the exact candidate through their existing lenses. They do not receive Wiff comments.
- One fresh `claude-sonnet-5` structured pass owns verification, confidence scoring, and duplicate removal for the complete finding set.
- The synthesizer may select existing candidate IDs; it may not write or rewrite findings.
- Findings scoring below 80 do not publish.
- On a repeated audit of the same private Wiff review, current unresolved, non-deleted, top-level comments are duplicate targets. Equivalent findings do not publish again.
- Resolved comments, deleted comments, and replies do not suppress findings. Audit never reopens comments.
- Independent Pi sessions remain independent reviews and do not share duplicate state.
- `/review fix` receives one narrow `wiff_resolve` tool. There is no general Wiff tool.

## Implementation

### 1. Expose only the structured Wiff fields synthesis needs

Extend schema-6 parsing in `review-wiff.ts` so each comment includes:

- durable ID and displayed number;
- body;
- target kind and target fields;
- resolved and deleted state;
- author.

Continue tolerating unknown JSON fields. Never parse Wiff Markdown or read Wiff journals. Derive the synthesis comparison set by selecting only unresolved, non-deleted comments whose target is not another comment.

### 2. Add one bounded synthesis pass

Add a small synthesis module beside `audit.ts`.

Its input is:

- the exact captured patch and immutable candidate boundary;
- every reviewer finding with a stable ID assigned in roster/result order;
- the filtered open Wiff comments, or an empty list for a first audit.

Its prompt requires the model to:

- recheck each candidate against the exact patch;
- score confidence from 0 through 100 using the Claude Code review rubric;
- form same-defect groups and choose one existing candidate ID from each group;
- suppress a whole group when an open Wiff comment already describes that same defect, not merely because it is nearby or related;
- return only the chosen candidate IDs and confidence scores.

Host validation rejects malformed output, unknown or repeated IDs, invalid scores, and oversized output. The host drops scores below 80 and restores original roster/result order rather than trusting model output order. The synthesizer cannot create text, locations, verdicts, replies, or Wiff mutations.

Run this as one fresh structured Sonnet child after all four reviewers succeed. Do not launch per-finding validators.

### 3. Reconcile once before publication

After reviewers finish:

1. Discover the private Wiff review under a visible synthesis loader.
2. If it exists, schema-check and pin it, require source `stdin`, and collect its current open top-level comments.
3. Run synthesis over the candidates and that comparison set.
4. Revalidate the exact Git candidate after synthesis.
5. Create or refresh Wiff exactly as today.
6. Publish only selected findings in original deterministic order.

Any reviewer, synthesis, validation, cancellation, or freshness failure occurs before Wiff mutation. Existing publication cleanup and partial-publication reporting remain unchanged.

### 4. Add the temporary fix tool

Register `wiff_resolve` in the parent review extension but keep it inactive normally.

Parameters:

- `comment`: displayed number or durable ID;
- `reply`: optional concise explanation.

For the generated `/review fix` turn only:

1. Pin the private data directory, repository root, session, project, and fixed agent author inside the extension.
2. Mark the exact generated fix prompt as pending, then activate `wiff_resolve` only when `before_agent_start` receives that prompt.
3. Validate on every call that the current invocation is still that generated fix run and that the named comment exists and is live and unresolved.
4. If a reply is present, add it first with `--agent` and stdin.
5. Resolve the comment with `--agent`.
6. Re-read Wiff and return the remaining open-comment count.
7. Before any different prompt starts, remove the tool and clear the fix invocation. Also clear it when the agent settles and on cancellation, error, reload, and shutdown.

The fix prompt tells the agent to edit and test first, then call `wiff_resolve` once for each completely addressed comment. It leaves partly fixed or unclear comments open. It contains no Wiff command recipe. `/review discuss`, audit reviewers, synthesis children, queued follow-ups, and ordinary turns never receive or may execute the tool.

Tool activation adds and removes only `wiff_resolve`; it must not overwrite tool changes made by other extensions.

### 5. Tests

Add focused tests for:

- same-defect findings from multiple reviewers producing one publication;
- distinct defects at the same location remaining distinct;
- confidence 79 being dropped and 80 being retained;
- an equivalent open Wiff comment suppressing publication;
- resolved, deleted, and reply comments not suppressing publication;
- stable publication order regardless of synthesis output order;
- malformed output, unknown IDs, synthesis failure, and cancellation publishing nothing;
- candidate freshness being checked after synthesis;
- `wiff_resolve` being inactive outside the generated fix turn;
- exact activation for the generated fix prompt and cleanup before another prompt, on settle, cancellation, reload, and shutdown;
- exact pinned reply/resolve arguments, stdin, agent attribution, and operation order;
- rejection of unknown, deleted, or already-resolved comments;
- final open-comment count and visible mutation failures.

Run the complete review test suite and `git diff --check`. Do not modify Wiff, `fish/config.fish`, or unrelated extensions; do not commit or push.
