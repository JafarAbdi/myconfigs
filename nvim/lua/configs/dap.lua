require("dapui").setup()
local dapui = require("dapui")
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

-- TODO: Add tagfunc support for dapui buffers
-- local function add_tagfunc(widget)
--   local orig_new_buf = widget.new_buf
--   widget.new_buf = function(...)
--     local bufnr = orig_new_buf(...)
--     api.nvim_buf_set_option(bufnr, "tagfunc", "v:lua.require'configs.lsp.ext'.symbol_tagfunc")
--     return bufnr
--   end
-- end

-- local function setup_widgets()
--   local widgets = require("dap.ui.widgets")
--   M.sidebar = widgets.sidebar(widgets.scopes)
--   add_tagfunc(widgets.expression)
--   add_tagfunc(widgets.scopes)
-- end

M.command_pid = nil

function M.setup()
  -- setup_widgets()
  dap.listeners.after.event_initialized["dapui_config"] = function()
    dapui.open()
  end
  dap.listeners.before.event_terminated["dapui_config"] = function()
    dapui.close()
  end
  dap.listeners.before.event_exited["dapui_config"] = function()
    dapui.close()
  end
  dap.defaults.fallback.terminal_win_cmd = "tabnew"
  dap.defaults.fallback.external_terminal = {
    command = "/usr/local/bin/st",
    args = { "-e" },
  }
  dap.adapters.cppdbg = {
    id = "cppdbg",
    type = "executable",
    command = vim.env.HOME .. "/.config/vscode-cpptools/extension/debugAdapters/bin/OpenDebugAD7",
  }
  dap.configurations.cpp = {
    {
      name = "Launch file",
      type = "cppdbg",
      request = "launch",
      MIMode = "gdb",
      MIDebuggerPath = "/usr/bin/gdb",
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
      MIDebuggerServerAddress = "localhost:1234",
      MIDebuggerPath = "/usr/bin/gdb",
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
        M.command_pid = vim.fn.input("Process PID: ")
        return M.command_pid
      end, -- require("dap.utils").pick_process,
      program = function()
        local output = vim.fn.system("ps -p " .. M.command_pid .. " -o args --no-headers")
        local command = vim.split(output, " ")
        -- return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
        return command[1]
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
  -- require("dap.ext.vscode").load_launchjs()
end

M.setup()
return M
