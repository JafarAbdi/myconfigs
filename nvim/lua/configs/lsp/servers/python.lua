local lspconfig = require("lspconfig")

lspconfig.jedi_language_server.setup({
  -- cmd = {"jedi-language-server", "--verbose", "--log-file", "/tmp/logging.txt"},
  on_attach = require("configs.lsp.handlers").on_attach,
})
