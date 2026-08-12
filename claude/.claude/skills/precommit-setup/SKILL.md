---
name: precommit-setup
description: Use when the user wants to add, generate, or update a .pre-commit-config.yaml for a repo ("set up pre-commit", "add prek config", "generate a pre-commit config for this repo"). Reads the curated multi-language hook reference in references/template.pre-commit-config.yaml and writes a trimmed .pre-commit-config.yaml tailored to the target directory's actual languages/tools. Always uses prek (not pre-commit) as the runner.
---

# Pre-commit / prek config generator

Generates a `.pre-commit-config.yaml` for a specific repo by picking the relevant
sections out of `references/template.pre-commit-config.yaml` — a curated menu of
hooks covering common languages/tools plus upstream references (uv, ruff,
pre-commit-hooks, requests).

Always target **prek** (https://github.com/j178/prek), not `pre-commit` — same
config format, faster, single binary. Tell the user to run `prek install` /
`prek run --all-files`, not the `pre-commit` equivalents.

## Workflow

1. **Read** `references/template.pre-commit-config.yaml` in full — it's the
   source of truth. Never invent a hook, repo URL, or rev that isn't in there;
   if the target repo needs something not covered (a language/tool absent from
   the reference), say so and ask rather than guessing a plausible-looking entry.
   For Python repos, also read `references/ruff.toml` — a good-default
   `[tool.ruff]` config to pair with the ruff pre-commit hook. If the repo has
   no ruff config yet, offer to add one (merged into pyproject.toml or as a
   standalone ruff.toml); if it already has one, don't silently overwrite its
   `select`/`ignore` choices — diff and ask.

2. **Detect the target repo's ecosystem** by inspecting its root (and one level
   into src/ if ambiguous):
   - `Cargo.toml` → Rust section
   - `pyproject.toml` / `setup.py` / `requirements*.txt` → Python section
     - `uv.lock` present → also include the `uv-lock` hook
     - `manage.py` or `INSTALLED_APPS` in a settings file → Django block
     - `*.ipynb` files present → notebook (nb-clean) block
   - `CMakeLists.txt` or `*.cpp`/`*.hpp`/`*.cc` → C++/CMake section
   - `package.json` → JS/TS section: `oxlint` for linting, plus **one** of
     `prettier` / `oxfmt` for formatting. If the repo already pins ESLint or
     Biome, ask before adding oxlint rather than stacking a second linter.
   - `Dockerfile` → Docker section
   - `.github/workflows/*.yml` → GitHub Actions section (actionlint, zizmor)
   - `*.lua` (and it's a Neovim config, not a game engine plugin dir) → Lua section
   - Docs-heavy repo (lots of `*.md`, mkdocs/sphinx config) → Markdown section
   - The GENERAL section (whitespace, merge-conflict markers, typos) always applies.

3. **Ask, don't guess, when detection is ambiguous or the repo mixes several
   ecosystems** — e.g. a C++ project with a thin Python binding layer might
   want both sections, or might want Python excluded if it's just a build
   script. Use your judgment on obvious cases (a `Cargo.toml`-only repo doesn't
   need to be asked about Rust) but check with the user before adding opt-in
   sections that aren't clearly load-bearing (security scanners, license
   headers, type checking) — those are opt-in in the template for a reason.
   The template keeps `ty` and `pyrefly` side by side for type checking, and
   `prettier` and `oxfmt` side by side for JS/TS formatting. Each pair does one
   job — ask which one a repo should get, don't install both.

4. **If duplicate-purpose hooks would both apply** (e.g. the repo already pins
   black instead of ruff, or codespell instead of typos), don't silently
   replace the user's existing choice — ask which one they want.

5. **If the target already has a `.pre-commit-config.yaml`**, read it first.
   Show what would change (added/removed hooks) before overwriting, don't
   clobber unrelated repo-specific local hooks it already has (e.g. a
   project-specific linter) — merge those forward into the new file.

6. **Offer custom lints if the repo has written-down conventions** an
   off-the-shelf linter can't enforce — a `CONVENTIONS.md`/`CLAUDE.md`/style
   guide, or a pattern the user keeps correcting by hand. Don't add these
   unprompted; name the two or three rules you'd write and let the user pick.
   The CUSTOM section at the bottom of the template documents the three shapes
   (`repo: local`, ast-grep YAML, oxlint JS plugin) and when each applies.

   Before writing anything custom, check whether an existing linter already
   covers it — ruff and oxlint both ship hundreds of opt-in rules, and a repo
   whose ruff config only enables the defaults is usually leaving the majority
   of its wanted rules switched off. Enabling those beats hand-rolling.

7. **Write** the trimmed config to `<target>/.pre-commit-config.yaml`, keeping
   the same per-section `# ===== LANGUAGE =====` comment headers from the
   template so it stays legible and easy to prune later by hand.

8. **Tell the user** to run `prek install` and that `rev:` pins should be
   refreshed periodically with `prek autoupdate` — the pins in the template
   are a snapshot, not permanent.

## Notes on template maintenance

If the user asks to add a newly-encountered hook to the shared reference
(not just to one repo), edit `references/template.pre-commit-config.yaml`
directly rather than only writing it into the target repo's config — that
file is meant to accumulate as a living reference across machines/repos.
