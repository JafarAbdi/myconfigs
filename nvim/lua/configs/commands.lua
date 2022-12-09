local M = {}
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
  vim.api.nvim_set_hl(0, "SignColumn", { link = "LineNr" })

  -------------------
  -- Auto-commands --
  -------------------

  vim.api.nvim_create_autocmd("FileType", {
    pattern = { "cpp", "c" },
    group = general_group,
    callback = function()
      -- This fixes an issue with nvim-cmp -- see https://github.com/hrsh7th/nvim-cmp/issues/1035#issuecomment-1195456419
      vim.opt_local.cindent = false
    end,
  })
  -- A terrible way to handle symlinks
  vim.api.nvim_create_autocmd("BufWinEnter", {
    callback = function(params)
      local fname = params.file
      local resolved_fname = vim.fn.resolve(fname)
      if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
        return
      end
      P("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
      vim.schedule(function()
        local cursor = vim.api.nvim_win_get_cursor(0)
        require("bufdelete").bufwipeout(params.buf, true)
        vim.api.nvim_command("edit " .. resolved_fname)
        vim.api.nvim_win_set_cursor(0, cursor)
      end)
    end,
    group = general_group,
  })

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
    pattern = vim.env.HOME .. "/myconfigs/nvim/lua/**.lua",
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

  vim.api.nvim_create_user_command("GenerateAllStubs", function()
    require("configs.functions").generate_all_python_stubs()
  end, {})

  vim.api.nvim_create_user_command("GenerateStubs", function(params)
    require("configs.functions").generate_python_stubs(params.fargs)
  end, { nargs = "*" })
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

return M
