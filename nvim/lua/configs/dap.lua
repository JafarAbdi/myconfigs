local dap = require("dap")

local M = setmetatable({}, {
  __index = function(tbl, key)
    if key == "widgets" then
      local val = require("dap.ui.widgets")
      rawset(tbl, key, val)
      return val
    end
    return dap[key]
  end,
})

M.launch_console = {
  name = "lldb: Launch (console)",
  type = "lldb",
  request = "launch",
  program = function()
    return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
  end,
  cwd = "${workspaceFolder}",
  stopOnEntry = false,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " ")
  end,
  runInTerminal = false,
}

M.launch_in_terminal = {
  name = "lldb: Launch (integratedTerminal)",
  type = "lldb",
  request = "launch",
  program = function()
    return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
  end,
  cwd = "${workspaceFolder}",
  stopOnEntry = false,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " ")
  end,
  runInTerminal = true,
}

function M.setup()
  require("nvim-dap-virtual-text").setup()
  require("dap-python").setup("python3")
  -- Fixes issues with lldb-vscode
  -- When it starts it doesn't report any threads
  dap.listeners.after.event_initialized["lldb-vscode"] = function(session)
    session:update_threads()
  end
  -- After pausing the threads could be wrong
  dap.listeners.after.pause["lldb-vscode"] = function(session)
    session:update_threads()
  end
  -- When we continue it report the allThreadsContinued in a very weird way
  dap.listeners.after.continue["lldb-vscode"] = function(session, _, response)
    if response.allThreadsContinued then
      for _, t in pairs(session.threads) do
        t.stopped = false
      end
    else
      local thread = session.threads[response.threadId]
      if thread and thread.stopped then
        thread.stopped = false
      end
    end
  end
  dap.defaults.fallback.terminal_win_cmd = "tabnew"
  dap.defaults.fallback.external_terminal = {
    command = "/usr/local/bin/st",
    args = { "-e" },
  }
  local lldb_executable_name = "/usr/bin/lldb-vscode"
  local lldb_executables = vim.split(vim.fn.glob(lldb_executable_name .. "*"), "\n")
  if vim.fn.empty(lldb_executables) == 1 then
    vim.api.nvim_notify(
      "No lldb-vscode executable found -- make sure to install it using 'sudo apt install lldb'",
      vim.log.levels.ERROR,
      {}
    )
  end
  dap.adapters.lldb = {
    id = "lldb",
    type = "executable",
    command = lldb_executables[#lldb_executables],
  }
  dap.configurations.cpp = {
    M.launch_console,
    M.launch_in_terminal,
  }
end

return M
