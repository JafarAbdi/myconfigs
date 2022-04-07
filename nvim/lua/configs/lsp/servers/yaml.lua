-- Patterns from https://github.com/b0o/SchemaStore.nvim/blob/main/lua/schemastore/catalog.lua
local handlers = require("configs.lsp.handlers")
require("lspconfig").yamlls.setup({
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  settings = {
    yaml = {
      schemas = {
        ["https://json.schemastore.org/pre-commit-config.json"] = {
          ".pre-commit-config.yml",
          ".pre-commit-config.yaml",
        },
        ["https://json.schemastore.org/github-action.json"] = { "action.yml", "action.yaml" },
        ["https://json.schemastore.org/codecov.json"] = {
          ".codecov.yrml",
          "codecov.yaml",
          ".codecov.yml",
          "codecov.yml",
        },
        ["https://json.schemastore.org/github-workflow.json"] = {
          ".github/workflows/**.yml",
          ".github/workflows/**.yaml",
        },
      },
    },
  },
})
