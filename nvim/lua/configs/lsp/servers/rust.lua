local handlers = require("configs.lsp.handlers")

require("rust-tools").setup({
  server = {
    capabilities = handlers.capabilities,
    on_attach = handlers.on_attach,
    settings = {
      -- to enable rust-analyzer settings visit:
      -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
      ["rust-analyzer"] = {
        -- enable clippy diagnostics on save
        checkOnSave = {
          command = "clippy",
        },
      },
    },
  },
  dap = {
    adapter = require("configs.dap").adapters.lldb,
  },
})
