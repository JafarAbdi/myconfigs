local enrich_config = function(config, on_config)
  -- TODO: Handle when the virtual environment is not activated and .vscode/settings.json exists
  local venv_path = os.getenv("CONDA_PREFIX")
  if venv_path then
    config.pythonPath = venv_path .. "/bin/python"
  end
  config.console = "integratedTerminal"
  on_config(config)
end

return {
  {
    "mfussenegger/nvim-dap",
    event = "VeryLazy",
    config = function()
      require("config.keymaps").dap()
      local dap = require("dap")
      -- dap.defaults.fallback.exception_breakpoints = { "userUnhandled" }
      dap.defaults.fallback.switchbuf = "usetab,uselast"
      dap.defaults.fallback.terminal_win_cmd = "tabnew"
      dap.defaults.fallback.external_terminal = {
        command = "wezterm",
        args = { "--skip-config" },
      }

      ------------------------
      -- CPP/C/Rust configs --
      ------------------------
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
        require("config.dap").launch_lldb_in_terminal,
      }
      dap.configurations.c = configs
      dap.configurations.cpp = configs
      dap.configurations.rust = configs

      ----------------------
      --- Python configs ---
      ----------------------
      dap.adapters.python = function(cb, config)
        if config.request == "attach" then
          local port = (config.connect or config).port
          local host = (config.connect or config).host or "127.0.0.1"
          cb({
            type = "server",
            port = assert(port, "`connect.port` is required for a python `attach` configuration"),
            host = host,
            enrich_config = enrich_config,
            options = {
              source_filetype = "python",
            },
          })
        else
          cb({
            type = "executable",
            command = "python3",
            args = { "-m", "debugpy.adapter" },
            enrich_config = enrich_config,
            options = {
              source_filetype = "python",
            },
          })
        end
      end

      dap.configurations.python = {
        {
          type = "python",
          request = "launch",
          name = "Launch file",
          program = "${file}",
        },
        require("config.dap").launch_python_in_terminal,
        {
          type = "python",
          request = "attach",
          name = "Attach remote",
          connect = function()
            local host = vim.fn.input("Host [127.0.0.1]: ")
            host = host ~= "" and host or "127.0.0.1"
            local port = tonumber(vim.fn.input("Port [5678]: ")) or 5678
            return { host = host, port = port }
          end,
        },
        {
          type = "python",
          request = "launch",
          name = "Run doctests in file",
          module = "doctest",
          args = { "${file}" },
          noDebug = true,
        },
      }

      ----------------------
      ------- CMake --------
      ----------------------
      dap.adapters.cmake = {
        type = "pipe",
        pipe = "${pipe}",
        executable = {
          command = "cmake",
          args = { "--debugger", "--debugger-pipe", "${pipe}" },
        },
      }
      dap.configurations.cmake = {
        {
          name = "Build",
          type = "cmake",
          request = "launch",
        },
      }
    end,
  },
}
