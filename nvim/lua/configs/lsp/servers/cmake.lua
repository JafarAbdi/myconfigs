local lspconfig = require("lspconfig")
lspconfig.cmake.setup({
  cmd = { "cmake-language-server" },
  filetypes = { "cmake" },
  init_options = {
    buildDirectory = "build",
  },
  on_new_config = function(new_config, new_root_dir)
    local Path = require("plenary.path")
    local p = Path:new(new_root_dir):joinpath(".clangd_config")
    -- local compile_commands_database_path = (Path:new(new_root_dir):joinpath(vim.trim(p:read()))):absolute()
    new_config.cmd = { "cmake-language-server" }
    new_config.init_options = {
      buildDirectory = Path:new(new_root_dir):joinpath(vim.trim(p:read())),
    }
  end,
  root_dir = require("lspconfig.util").root_pattern(
    ".clangd_config",
    "compile_commands.json",
    "compile_flags.txt",
    ".git"
  ),
  single_file_support = true,
})
