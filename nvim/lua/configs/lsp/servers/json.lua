-- Patterns from https://github.com/b0o/SchemaStore.nvim/blob/main/lua/schemastore/catalog.lua
local handlers = require("configs.lsp.handlers")
require("lspconfig").jsonls.setup({
  -- ... -- other configuration for setup {}
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  settings = {
    json = {
      schemas = {
        {
          description = "JSON schema for ESLint configuration files",
          fileMatch = { ".eslintrc", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml" },
          name = ".eslintrc",
          url = "https://json.schemastore.org/eslintrc.json",
        },
        {
          description = "Schema for code snippet files in visual studio code extensions",
          fileMatch = { "*.code-snippets" },
          name = "VSCode Code Snippets",
          url = "https://raw.githubusercontent.com/Yash-Singh1/vscode-snippets-json-schema/main/schema.json",
        },
        {
          description = "Vercel configuration file",
          fileMatch = { "vercel.json" },
          name = "Vercel",
          url = "https://openapi.vercel.sh/vercel.json",
        },
        {
          description = "Schema for CMake Presets",
          fileMatch = { "CMakePresets.json", "CMakeUserPresets.json" },
          name = "CMake Presets",
          url = "https://raw.githubusercontent.com/Kitware/CMake/master/Help/manual/presets/schema.json",
        },
        {
          description = "",
          fileMatch = {},
          name = "Common types for all schemas",
          url = "https://json.schemastore.org/base.json",
        },
        {
          description = "LLVM compilation database",
          fileMatch = { "compile_commands.json" },
          name = "compile_commands.json",
          url = "https://json.schemastore.org/compile-commands.json",
        },
      },
    },
  },
})
