local Path = require("plenary.path")
local cmake = require("cmake")

local status = {
  spinner = 1,
  spinner_frames = { "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷" },
  command = "",
}

local get_cmake_configs = function(file_path)
  return {
    parameters_file = ".neovim.json",
    build_dir = function()
      return require("configs.functions").load_clangd_config(file_path)
    end,
    default_projects_path = tostring(Path:new(vim.loop.os_homedir(), "workspaces")),
    configure_args = {
      "-DCMAKE_EXPORT_COMPILE_COMMANDS=1",
    },
    quickfix = {
      only_on_error = true, -- Open quickfix window only if target build failed.
    },
    on_build_output = function(lines)
      status.spinner = status.spinner + 1
      status.command = "CMake running"
      -- Get only last line
      local match = string.match(lines[#lines], "Exited with code %d+")
      if match then
        status.spinner = 1
        status.command = ""
      end
    end,
    build_args = {}, -- Default arguments that will be always passed at cmake build step.
    copy_compile_commands = false,
    dap_configuration = {
      type = "lldb",
      request = "launch",
      stopOnEntry = false,
      cwd = "${workspaceFolder}",
    },
    dap_open_command = require("dapui").open, -- Command to run after starting DAP session. You can set it to `false` if you don't want to open anything or `require('dapui').open` if you are using https://github.com/rcarriga/nvim-dap-ui
  }
end

local M = {}

M.cmake_project = function(file_path)
  return cmake.setup(get_cmake_configs(file_path))
end

M.status = function()
  if status.command == "" then
    return status.command
  end
  return status.command
    .. ": "
    .. status.spinner_frames[(status.spinner % #status.spinner_frames) + 1]
end

return M
