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
    {
      name = "lldb: Launch (console)",
      type = "lldb",
      request = "launch",
      program = function()
        return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
      end,
      cwd = "${workspaceFolder}",
      stopOnEntry = false,
      args = {},
      runInTerminal = false,
    },
    {
      name = "lldb: Launch (integratedTerminal)",
      type = "lldb",
      request = "launch",
      program = function()
        return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
      end,
      cwd = "${workspaceFolder}",
      stopOnEntry = false,
      args = {},
      runInTerminal = true,
    },
    {
      -- If you get an "Operation not permitted" error using this, try disabling YAMA:
      --  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
      name = "lldb: Attach to process",
      type = "lldb",
      request = "attach",
      pid = require("dap.utils").pick_process,
      args = {},
      -- env = function()
      --   local variables = {}
      --   for k, v in pairs(vim.fn.environ()) do
      --     table.insert(variables, string.format("%s=%s", k, v))
      --   end
      --   return variables
      -- end,
    },
  }
end

M.setup()
return M
