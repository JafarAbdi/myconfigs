local handlers = require("configs.lsp.handlers")

require("rust-tools").setup({
  server = {
    cmd = { vim.env.RUST_ANALYZER_BIN },
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
        -- TODO: Move all snippets from ../../../../snippets/snippets/rust.code-snippets
        completion = {
          snippets = {
            custom = {
              ["main"] = {
                prefix = "main_result",
                body = {
                  "fn main() -> Result<(), Box<dyn Error>> {",
                  "\t${1:unimplemented!();}",
                  "\tOk(())",
                  "}",
                },
                requires = "std::error::Error",
                description = "main function with Result",
                scope = "item",
              },
            },
          },
        },
      },
    },
  },
  dap = {
    adapter = require("configs.dap").adapters.lldb,
  },
})
