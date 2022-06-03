local Path = require("plenary.path")

-- local function get_current_package_name(path)
--     path = path or vim.fn.expand("%:p")
--     local pkg_name = vim.fn.system("grep -oP '(?<=<name>).*?(?=</name>)' "..path)
--     -- clean up output
--     pkg_name, _ = string.gsub(pkg_name, "\r", "")
--     pkg_name, _ = string.gsub(pkg_name, "\n", "")
--     return pkg_name
-- end

-- local get_build_dir = function ()
--   local config_filename = ".cmake_config.json"
--   local config_path = require('lspconfig.util').root_pattern(config_filename)(vim.fn.expand('%:p:h'))
--   local json = vim.fn.json_decode(Path:new(config_path, config_filename):read())
--   local package_xml_path = require('lspconfig.util').root_pattern("package.xml")(vim.fn.expand('%:p:h'))
--   vim.api.nvim_command(string.format("cd %s", package_xml_path))
--   local package_name = get_current_package_name(package_xml_path.."/package.xml")
--   return Path:new(json[package_name])
-- end
local get_build_dir = function()
  local file_path = require("lspconfig.util").root_pattern(".clangd_config")(vim.fn.expand("%:p:h"))
  local p = Path:new(file_path, ".clangd_config")
  return Path:new(vim.trim(p:read()))
end

require("cmake").setup({
  cmake_executable = "cmake",
  parameters_file = ".neovim.json",
  build_dir = get_build_dir,
  -- samples_path = tostring(script_path:parent():parent():parent() / 'samples'), -- Folder with samples. `samples` folder from the plugin directory is used by default.
  default_projects_path = tostring(Path:new(vim.loop.os_homedir(), "workspaces")),
  configure_args = {
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=1",
    "-DCMAKE_TOOLCHAIN_FILE=~/workspaces/vcpkg/scripts/buildsystems/vcpkg.cmake",
  },
  quickfix_only_on_error = true,
  build_args = {}, -- Default arguments that will be always passed at cmake build step.
  -- quickfix_height = 10, -- Height of the opened quickfix.
  copy_compile_commands = false,
  dap_configuration = {
    type = "lldb",
    request = "launch",
    stopOnEntry = true,
    cwd = "${workspaceFolder}",
  },
  dap_open_command = require("dapui").open, -- Command to run after starting DAP session. You can set it to `false` if you don't want to open anything or `require('dapui').open` if you are using https://github.com/rcarriga/nvim-dap-ui
})
