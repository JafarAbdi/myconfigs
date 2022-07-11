local handlers = require("configs.lsp.handlers")
local lspconfig = require("lspconfig")

lspconfig.jedi_language_server.setup({
  -- cmd = {"jedi-language-server", "-vv", "--log-file", "/tmp/logging.txt"},
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
})
