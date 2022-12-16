local handlers = require("configs.lsp.handlers")
local lspconfig = require("lspconfig")
-- local cmd = { "cmake-language-server", "-vv", "--log-file", "/tmp/cmake-lsp.txt" }
local cmd = { "cmake-language-server" }
lspconfig.cmake.setup({
  cmd = cmd,
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  on_new_config = function(new_config, new_root_dir)
    new_config.cmd = cmd
    new_config.init_options = {
      buildDirectory = require("configs.functions").load_clangd_config(new_root_dir),
    }
  end,
  root_dir = require("configs.functions").clangd_root_dir,
  single_file_support = true,
})
