local ok, lint = pcall(require, "lint")
if not ok then
  return
end

lint.linters.cspell.cmd = "micromamba"
lint.linters.cspell.args = {
  "run",
  "-n",
  "nodejs",
  "cspell",
  "lint",
  "--config",
  vim.env.HOME .. "/myconfigs/.cspell.json",
  "--no-color",
  "--no-summary",
  "--no-progress",
  "--",
  "stdin",
}
lint.linters.cspell.ignore_exitcode = true

lint.linters.ruff.cmd = "micromamba"
lint.linters.ruff.args = {
  "run",
  "-n",
  "linters",
  "ruff",
  "--quiet",
  "-",
}
-- lint.linters.cspell.ignore_exitcode = true

lint.linters.mypy.cmd = "micromamba"
lint.linters.mypy.args = {
  "run",
  "-n",
  "linters",
  "mypy",
  "--show-column-numbers",
  "--hide-error-codes",
  "--hide-error-context",
  "--no-color-output",
  "--no-error-summary",
  "--no-pretty",
}

lint.linters_by_ft = {
  -- markdown = {'vale', 'markdownlint'},
  -- rst = {'vale'},
  -- cmake = { "cmakelint" },
  -- tex = { "chktex" },
  python = { "ruff", "mypy" },
  lua = { "luacheck" },
  sh = { "shellcheck" },
  yaml = { "yamllint" },
  dockerfile = { "hadolint" },
}
