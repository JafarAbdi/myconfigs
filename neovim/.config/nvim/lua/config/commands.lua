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
    "dapui_hover",
    "dapui_scopes",
    "dapui_stacks",
    "dapui_watches",
    "dapui_breakpoints",
    "dapui_console",
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

vim.api.nvim_create_user_command("DapLaunch", function()
  require("dap").run(require("config.dap").launch_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPython", function()
  require("dap").run({
    type = "python",
    request = "launch",
    name = "Launch file with arguments",
    program = function()
      return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
    end,
    args = function()
      local args_string = vim.fn.input("Arguments: ")
      return vim.split(args_string, " +")
    end,
    console = "integratedTerminal",
    pythonPath = nil,
    justMyCode = false,
  })
end, {})

vim.api.nvim_create_user_command("DapBreakpointLogMessage", function(params)
  require("dap").toggle_breakpoint(nil, nil, params.args, true)
end, { nargs = "*" })

vim.api.nvim_create_user_command("DapBreakpointConditional", function(params)
  require("dap").toggle_breakpoint(params.args, nil, nil, true)
end, { nargs = "*" })

vim.api.nvim_create_user_command("DapRerunLast", function()
  require("dap").run_last()
end, {})

vim.api.nvim_create_user_command("GenerateAllStubs", function()
  require("config.functions").generate_all_python_stubs()
end, {})

vim.api.nvim_create_user_command("GenerateStubs", function(params)
  require("config.functions").generate_python_stubs(params.fargs)
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
