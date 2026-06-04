---
description: Review a refactoring plan
argument-hint: "<plan-file>"
---
Review the plan in $1, and cross-reference it against the actual codebase. First, grill me on this plan — ask tough questions about edge cases, potential failure modes, and design decisions. Point out any steps that seem like quick fixes rather than proper solutions, hidden assumptions, or places where the plan glosses over complexity. Critically, check the code for things the plan misses: callers that would break, related modules that need changes, existing patterns the plan ignores or contradicts, tests that would need updating, dependencies the plan doesn't account for, and edge cases visible in the code but absent from the plan.
Then, prove the plan is sound by walking through concrete scenarios — show me how specific cases would play out under the proposed approach, including the awkward ones (migration paths, backward compatibility, error states, performance under load, whatever's relevant). Ground these in real code paths, not hypotheticals.
Once you've thoroughly analyzed everything and I've answered your questions, if you find the plan is mediocre, hacky, or incomplete, scrap it and propose the most elegant approach knowing everything you now know about the codebase and requirements.
Don't start implementation until we've gone through this process and the plan is something we're both confident in.
