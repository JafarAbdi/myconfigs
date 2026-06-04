Create a git commit for the **staged changes only** using a concise Conventional Commits-style subject. Do NOT stage additional files.

## Format

`<type>(<scope>): <summary>`

- `type` REQUIRED. Use `feat` for new features, `fix` for bug fixes. Other common types: `docs`, `refactor`, `chore`, `test`, `perf`.
- `scope` OPTIONAL. Short noun in parentheses for the affected area (e.g., `api`, `parser`, `ui`).
- `summary` REQUIRED. Short, imperative, <= 72 chars, no trailing period.

## Notes

- Body is OPTIONAL. If needed, add a blank line after the subject and write short paragraphs.
- Do NOT include breaking-change markers or footers.
- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit; do NOT push.
- Operate on the current staged index. Do NOT run `git add`. If nothing is staged, stop and tell the user.
- Treat any caller-provided arguments as additional commit guidance (influences scope, summary, body).

## Steps

1. Run `git diff --cached` and `git diff --cached --stat` to inspect staged changes.
2. If the staged set is empty, stop and report; do not commit.
3. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
4. Run `git commit -m "<subject>"` (and `-m "<body>"` if needed).
