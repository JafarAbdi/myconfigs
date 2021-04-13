require("dapui").setup()
local dapui = require("dapui")
local dap = require("dap")

dap.listeners.after.event_initialized["dapui_config"] = function()
  dapui.open()
end
dap.listeners.before.event_terminated["dapui_config"] = function()
  dapui.close()
end
dap.listeners.before.event_exited["dapui_config"] = function()
  dapui.close()
end

dap.adapters.cppdbg = {
  id = "cppdbg",
  type = "executable",
  command = vim.env.HOME
    .. "/.config/vimspector-conf/gadgets/linux/download/vscode-cpptools/1.7.1/root/extension/debugAdapters/bin/OpenDebugAD7",
}
dap.configurations.cpp = {
  {
    name = "Launch file",
    type = "cppdbg",
    request = "launch",
    MIMode = "gdb",
    program = function()
      return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
    end,
    cwd = "${workspaceFolder}",
    stopOnEntry = true,
    setupCommands = {
      {
        text = "-enable-pretty-printing",
        description = "enable pretty printing",
        ignoreFailures = false,
      },
    },
  },
  {
    name = "Attach to gdbserver :1234",
    type = "cppdbg",
    request = "launch",
    MIMode = "gdb",
    miDebuggerServerAddress = "localhost:1234",
    miDebuggerPath = "/usr/bin/gdb",
    cwd = "${workspaceFolder}",
    program = function()
      return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
    end,
    setupCommands = {
      {
        text = "-enable-pretty-printing",
        description = "enable pretty printing",
        ignoreFailures = false,
      },
    },
  },
  {
    -- If you get an "Operation not permitted" error using this, try disabling YAMA:
    --  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
    name = "Attach to process",
    type = "cppdbg",
    request = "attach",
    processId = function()
      return vim.fn.input("Process PID: ")
    end, -- require("dap.utils").pick_process,
    program = function()
      return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
    end,
    -- program = "/usr/bin/fish", -- Why we need this??
    args = {},
    setupCommands = {
      {
        text = "-enable-pretty-printing",
        description = "enable pretty printing",
        ignoreFailures = false,
      },
    },
  },
}

-- dap.configurations.c = dap.configurations.cpp
-- dap.configurations.rust = dap.configurations.cpp
