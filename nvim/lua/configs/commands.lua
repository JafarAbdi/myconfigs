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
end
