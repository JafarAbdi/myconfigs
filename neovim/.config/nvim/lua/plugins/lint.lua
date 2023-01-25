return {
  {
    "mfussenegger/nvim-lint",
    event = "BufReadPre",
    config = function()
      local lint = require("lint")
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
      local lint_group = vim.api.nvim_create_augroup("lint", { clear = true })
      vim.api.nvim_create_autocmd({ "BufWritePost", "BufEnter", "BufLeave" }, {
        group = lint_group,
        callback = function()
          lint.try_lint()
        end,
      })
      vim.api.nvim_create_autocmd({ "BufWritePost", "BufEnter", "BufLeave" }, {
        group = lint_group,
        callback = function()
          -- lint.try_lint({"cspell", "codespell"})
          if vim.bo.filetype ~= "help" then
            lint.try_lint({ "cspell" })
          end
        end,
      })
    end,
  },
}
