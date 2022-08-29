local Path = require("plenary.path")
local cmake = require("cmake")

local status = {
  spinner = 1,
  spinner_frames = { "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷" },
  command = "",
}

local get_project_root = require("lspconfig.util").root_pattern(".clangd_config")

local get_build_dir = function(project_root)
  local p = Path:new(project_root, ".clangd_config")
  return vim.trim(p:read())
end

local get_cmake_configs = function(file_path)
  return {
    parameters_file = ".neovim.json",
    build_dir = get_build_dir(file_path),
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
  local project_root = get_project_root(file_path)
  vim.cmd(string.format("cd %s", project_root))
  return cmake.setup(get_cmake_configs(project_root))
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
