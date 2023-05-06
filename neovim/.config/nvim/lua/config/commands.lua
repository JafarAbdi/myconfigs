local M = {}
local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

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
    vim.print("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
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
    vim.opt_local.spell = false
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })

vim.api.nvim_create_autocmd("FileType", {
  pattern = {
    "qf",
    "git",
    "gitAnnotate",
    "Outline",
    "diff",
    "help",
  },
  callback = function()
    vim.opt_local.spell = false
  end,
  group = general_group,
})

--------------
-- Commands --
--------------

vim.api.nvim_create_user_command("DapAttach", function()
  -- output format for ps ah
  --    " 107021 pts/4    Ss     0:00 /bin/zsh <args>"
  require("fzy").execute("ps ah", function(selection)
    require("dap").run({
      -- If you get an "Operation not permitted" error using this, try disabling YAMA:
      --  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
      name = "lldb: Attach to process",
      type = "lldb",
      request = "attach",
      pid = tonumber(vim.fn.split(vim.fn.trim(selection), " \\+")[1]),
      args = {},
      -- env = function()
      --   local variables = {}
      --   for k, v in pairs(vim.fn.environ()) do
      --     table.insert(variables, string.format("%s=%s", k, v))
      --   end
      --   return variables
      -- end,
    })
  end)
end, {})

vim.api.nvim_create_user_command("DapLaunchLLDB", function()
  require("dap").run(require("config.dap").launch_lldb_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPython", function()
  require("dap").run(require("config.dap").launch_python_in_terminal)
end, {})

vim.api.nvim_create_user_command("GenerateAllStubs", function()
  require("config.functions").generate_all_python_stubs()
end, {})

vim.api.nvim_create_user_command("GenerateStubs", function(params)
  require("config.functions").generate_python_stubs(params.fargs)
end, { nargs = "*" })

vim.api.nvim_create_user_command("Grep", function(opts)
  local fzy = require("fzy")
  fzy.execute(
    "rg --no-messages --no-heading --trim --line-number --smart-case " .. opts.args,
    fzy.sinks.edit_live_grep
  )
end, { nargs = "*" })

vim.api.nvim_create_user_command("Gh", function(opts)
  local gh = require("config.gh")
  if opts.args == "comments" then
    gh.comments()
  elseif opts.args == "clear" then
    gh.clear()
  end
end, {
  nargs = 1,
  complete = function()
    return { "comments", "clear" }
  end,
})

return M
