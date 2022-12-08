local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})
if not vim.g.vscode then
  ----------------
  -- Highlights --
  ----------------

  vim.api.nvim_set_hl(0, "SpellBad", { fg = "red", undercurl = true })
  vim.api.nvim_set_hl(0, "LspComment", { fg = "#454a54" })
  vim.api.nvim_set_hl(0, "SignColumn", { link = "LineNr" })

  -------------------
  -- Auto-commands --
  -------------------

  vim.api.nvim_create_autocmd("TermOpen", {
    callback = function()
      vim.opt_local.signcolumn = "no"
      vim.opt_local.number = false
      vim.opt_local.relativenumber = false
      vim.opt_local.winbar = "%#lualine_a_terminal#%=%f%="
    end,
    group = general_group,
  })

  vim.api.nvim_create_autocmd("BufWritePost", {
    callback = function()
      -- Deletes all trailing whitespaces in a file if it's not binary nor a diff.
      if not vim.o.binary and vim.o.filetype ~= "diff" then
        require("configs.functions").clean_whitespaces()
      end
    end,
    group = general_group,
  })
  vim.api.nvim_create_autocmd("BufWritePost", {
    callback = function()
      vim.api.nvim_command(":luafile " .. vim.fn.expand("<afile>"))
      vim.api.nvim_command(":PackerCompile")
    end,
    pattern = vim.env.HOME .. "/myconfigs/nvim/lua/**",
    group = general_group,
  })

  vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })

  vim.api.nvim_create_autocmd("FileType", {
    pattern = { "qf", "git", "gitAnnotate", "Outline", "diff", "help" },
    callback = function()
      vim.o.spell = false
    end,
    group = general_group,
  })

  --------------
  -- Commands --
  --------------

  vim.api.nvim_create_user_command("CleanWhitespaces", function()
    require("configs.functions").clean_whitespaces()
  end, {})

  vim.api.nvim_create_user_command("SpellToggle", function()
    if vim.opt.spell:get() then
      vim.opt.spell = false
    else
      vim.opt.spell = true
    end
  end, {})
  vim.api.nvim_create_user_command("CESetup", function(opts)
    local options = {
      autocmd = {
        enable = true,
        hl = "Cursorline",
      },
    }
    pcall(vim.api.nvim_clear_autocmds, { group = "CompilerExplorerLive" })
    if opts.args == "local" then
      local Path = require("plenary.path")

      local user_arguments = ""
      local scratch_path = Path:new(vim.env.CPP_SCREATCHES_DIR, "conanbuildinfo.args")
      if scratch_path:exists() then
        user_arguments = scratch_path:read()
      end
      options = vim.tbl_deep_extend(
        "force",
        options,
        { url = "http://localhost:10240", compiler_flags = user_arguments }
      )
      require("compiler-explorer").setup(options)
    elseif opts.args == "online" then
      options =
        vim.tbl_deep_extend("force", options, { url = "https://godbolt.org", compiler_flags = "" })
      require("compiler-explorer").setup(options)
    end
  end, {
    nargs = 1,
    complete = function()
      return { "local", "online" }
    end,
  })
end
