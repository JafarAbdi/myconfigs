local M = {}

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
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
      vim.cmd.bwipeout({ params.buf, bang = true })
      vim.api.nvim_command("edit " .. resolved_fname)
      vim.api.nvim_win_set_cursor(0, cursor)
    end)
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("LspProgress", {
  group = general_group,
  command = "redrawstatus",
})

vim.api.nvim_create_autocmd("TermOpen", {
  callback = function()
    vim.opt_local.signcolumn = "no"
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })

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
    })
  end)
end, {})

vim.api.nvim_create_user_command("DapLaunchLLDB", function()
  require("dap").run(require("config.dap").launch_lldb_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPython", function()
  require("dap").run(require("config.dap").launch_python_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPytest", function()
  require("dap").run({
    name = "Pytest: " .. vim.fn.expand("%:p"),
    type = "python",
    request = "launch",
    justMyCode = false,
    module = "pytest",
    args = { "-s", vim.fn.expand("%:p") },
  })
end, {})

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
