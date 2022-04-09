local handlers = require("configs.lsp.handlers")
local lspconfig = require("lspconfig")
-- local cmd = { "cmake-language-server", "-vv", "--log-file", "/tmp/cmake-lsp.txt" }
local cmd = { "cmake-language-server" }
lspconfig.cmake.setup({
  cmd = cmd,
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  on_new_config = function(new_config, new_root_dir)
    local Path = require("plenary.path")
    local p = Path:new(new_root_dir, ".clangd_config")
    new_config.cmd = cmd
    new_config.init_options = {
      buildDirectory = vim.trim(p:read()),
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
