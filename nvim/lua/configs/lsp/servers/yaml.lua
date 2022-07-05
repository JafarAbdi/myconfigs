-- Patterns from https://github.com/b0o/SchemaStore.nvim/blob/main/lua/schemastore/catalog.lua
local handlers = require("configs.lsp.handlers")
require("lspconfig").yamlls.setup({
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  settings = {
    yaml = {
      schemas = {
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-ee.json"] = {
          "**/execution-environment.yml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-meta.json"] = {
          "**/meta/main.yml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-meta-runtime.json"] = {
          "**/meta/runtime.yml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-requirements.json"] = {
          "requirements.yml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-vars.json"] = {
          "**/vars/*.yml",
          "**/vars/*.yaml",
          "**/defaults/*.yml",
          "**/defaults/*.yaml",
          "**/host_vars/*.yml",
          "**/host_vars/*.yaml",
          "**/group_vars/*.yml",
          "**/group_vars/*.yaml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible.json#/$defs/tasks"] = {
          "**/tasks/*.yml",
          "**/tasks/*.yaml",
          "**/handlers/*.yml",
          "**/handlers/*.yaml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible.json#/$defs/playbook"] = {
          "playbook.yml",
          "playbook.yaml",
          "site.yml",
          "site.yaml",
          "**/playbooks/*.yml",
          "**/playbooks/*.yaml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-inventory.json"] = {
          "inventory.yml",
          "inventory.yaml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-galaxy.json"] = {
          "galaxy.yml",
        },
        ["https://raw.githubusercontent.com/ansible-community/schemas/main/f/ansible-lint.json"] = {
          ".ansible-lint",
          ".config/ansible-lint.yml",
        },
        ["https://raw.githubusercontent.com/ansible/ansible-navigator/main/src/ansible_navigator/data/ansible-navigator.json"] = {
          ".ansible-navigator.json",
          ".ansible-navigator.yaml",
          ".ansible-navigator.yml",
          "ansible-navigator.json",
          "ansible-navigator.yaml",
          "ansible-navigator.yml",
        },
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
