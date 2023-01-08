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

lint.linters.ruff.args = {
  "--config",
  vim.env.HOME .. "/myconfigs/linters/ruff.toml",
  "--quiet",
  "-",
}
-- lint.linters.cspell.ignore_exitcode = true

lint.linters_by_ft = {
  -- markdown = {'vale', 'markdownlint'},
  -- rst = {'vale'},
  -- cmake = { "cmakelint" },
  -- tex = { "chktex" },
  python = { "ruff" , "mypy" },
  lua = { "luacheck" },
  sh = { "shellcheck" },
  yaml = { "yamllint" },
  dockerfile = { "hadolint" },
}
