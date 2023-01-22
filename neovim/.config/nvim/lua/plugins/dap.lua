return {
  {
    "mfussenegger/nvim-dap",
    dependencies = {
      {
        "rcarriga/nvim-dap-ui",
        opts = {
          layouts = {
            {
              elements = {
                -- Elements can be strings or table with id and size keys.
                { id = "scopes", size = 0.25 },
                "breakpoints",
                "stacks",
                "watches",
              },
              size = 40, -- 40 columns
              position = "left",
            },
            {
              elements = {
                "repl",
              },
              size = 0.25, -- 25% of total lines
              position = "bottom",
            },
          },
          expand_lines = false,
          controls = {
            enabled = false,
          },
        },
      },
      "theHamsta/nvim-dap-virtual-text",
      "mfussenegger/nvim-dap-python",
    },
    config = function()
      local dap = require("dap")
      local dapui = require("dapui")
      dap.listeners.after.event_initialized["dapui_config"] = function()
        dapui.open()
      end
      dap.listeners.before.event_terminated["dapui_config"] = function()
        dapui.close()
      end
      dap.listeners.before.event_exited["dapui_config"] = function()
        dapui.close()
      end
      -- Fixes issues with lldb-vscode
      -- When it starts it doesn't report any threads
      -- TODO: This's causing issues with dapui
      -- dap.listeners.after.event_initialized["lldb-vscode"] = function(session)
      --   session:update_threads()
      -- end
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
      local lldb_version = lldb_executables[#lldb_executables]:match("lldb%-vscode%-(%d+)")
      if lldb_version then
        if tonumber(lldb_version) < 11 then
          vim.api.nvim_notify(
            "lldb-vscode version '" .. lldb_version .. "' doesn't support integratedTerminal",
            vim.log.levels.DEBUG,
            {}
          )
        end
      end
      dap.adapters.lldb = {
        id = "lldb",
        type = "executable",
        command = lldb_executables[#lldb_executables],
      }
      local configs = {
        -- M.launch_console,
        require("config.dap").launch_in_terminal,
      }
      dap.configurations.c = configs
      dap.configurations.cpp = configs
      dap.configurations.rust = configs
    end,
  },
}
