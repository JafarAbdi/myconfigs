local root_dirs = require("config.functions").root_dirs

-- For testing inlayHints
local clangd_cmd = {
  vim.env.HOME .. "/.config/clangd-lsp/bin/clangd",
}
-- local clangd_debug_cmd = vim.deepcopy(clangd_cmd)
-- table.insert(clangd_debug_cmd, "-log=verbose")
-- clangd_cmd = vim.deepcopy(clangd_debug_cmd)

-- local cmake_cmd = { "cmake-language-server", "-vv", "--log-file", "/tmp/cmake-lsp.txt" }
local cmake_cmd = { "cmake-language-server" }

local runtime_path = vim.split(package.path, ";")
table.insert(runtime_path, "lua/?.lua")
table.insert(runtime_path, "lua/?/init.lua")

local jedi_init_options = {
  workspace = {
    extraPaths = { vim.env.HOME .. "/.cache/python-stubs" },
    environmentPath = "/usr/bin/python3",
  },
}
-- local jedi_cmd = { "jedi-language-server", "-vv", "--log-file", "/tmp/logging.txt" }
local jedi_cmd = { "micromamba", "run", "-n", "python-lsp", "jedi-language-server" }

return {
  {
    "neovim/nvim-lspconfig",
    lazy = false,
    ---@class PluginLspOpts
    opts = {
      -- options for vim.diagnostic.config()
      diagnostics = {
        underline = false,
        update_in_insert = true,
        virtual_text = { severity = vim.diagnostic.severity.ERROR },
        severity_sort = true,
      },
      -- LSP Server Settings
      servers = {
        tsserver = {},
        clangd = {

          -- local clangd_debug_cmd = vim.deepcopy(clangd_cmd)
          -- table.insert(clangd_debug_cmd, "-log=verbose")
          -- clangd_cmd = vim.deepcopy(clangd_debug_cmd)
          cmd = clangd_cmd,
          init_options = {
            clangdFileStatus = true,
          },
          on_new_config = function(new_config, new_root_dir)
            local Path = require("plenary.path")
            new_config.cmd = vim.deepcopy(clangd_cmd)
            local root = Path:new(root_dirs.cpp(new_root_dir))
            local settings_dir = root:joinpath(".vscode", "settings.json")
            if settings_dir:exists() then
              local settings = vim.json.decode(settings_dir:read())
              vim.list_extend(new_config.cmd, settings["clangd.arguments"])
            end
          end,
          root_dir = root_dirs.cpp,
          single_file_support = true,
        },
        efm = {
          cmd = {
            "efm-langserver",
            "-c",
            vim.env.HOME .. "/.config/nvim/lua/config/efm.yaml",
            -- "-logfile",
            -- "/tmp/efm-logging.txt",
            -- "-loglevel",
            -- "6",
          },
          filetypes = {
            "python",
            "cmake",
            "json",
            "markdown",
            "rst",
            "sh",
            "tex",
            "yaml",
            "lua",
            "dockerfile",
          },
          root_dir = function(dir)
            return require("lspconfig").util.find_git_ancestor(dir) or vim.loop.cwd()
          end,
        },
        lua_ls = {
          cmd = { vim.env.HOME .. "/.config/lua-lsp/bin/lua-language-server" },
          settings = {
            Lua = {
              format = {
                enable = false,
              },
              runtime = {
                -- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
                version = "LuaJIT",
                -- Setup your lua path
                path = runtime_path,
              },
              diagnostics = {
                -- Get the language server to recognize the `vim` global
                globals = { "vim" },
              },
              workspace = {
                -- Make the server aware of Neovim runtime files
                library = vim.api.nvim_get_runtime_file("", true),
                checkThirdParty = false,
              },
              -- Do not send telemetry data containing a randomized but unique identifier
              telemetry = {
                enable = false,
              },
            },
          },
        },
        jsonls = {
          -- ... -- other configuration for setup {}
          cmd = { "micromamba", "run", "-n", "nodejs", "vscode-json-language-server", "--stdio" },
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
        },
        rust_analyzer = {
          cmd = { vim.env.RUST_ANALYZER_BIN },
          root_dir = root_dirs.rust,
          settings = {
            -- to enable rust-analyzer settings visit:
            -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
            ["rust-analyzer"] = {
              -- enable clippy diagnostics on save
              checkOnSave = {
                command = "clippy",
              },
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
        yamlls = {
          cmd = { "micromamba", "run", "-n", "nodejs", "yaml-language-server", "--stdio" },
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
                ["https://json.schemastore.org/github-action.json"] = {
                  "action.yml",
                  "action.yaml",
                },
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
                ["https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json"] = {
                  "docker-compose.yml",
                },
              },
            },
          },
        },
        cmake = {
          cmd = cmake_cmd,
          on_new_config = function(new_config, new_root_dir)
            new_config.cmd = cmake_cmd
            local Path = require("plenary.path")
            local root = Path:new(root_dirs.cmake(new_root_dir))
            local build_dir = nil
            local settings_dir = root:joinpath(".vscode", "settings.json")
            if settings_dir:exists() then
              local ok, settings = pcall(vim.json.decode, settings_dir:read())
              if not ok then
                vim.notify("Error parsing '" .. settings_dir.filename .. "'", vim.log.levels.WARN)
              end
              build_dir = settings["cmake.buildDirectory"]
            end
            new_config.init_options = {
              buildDirectory = build_dir,
            }
          end,
          root_dir = root_dirs.cmake,
          single_file_support = true,
        },
        dockerls = {
          cmd = { "micromamba", "run", "-n", "nodejs", "docker-langserver", "--stdio" },
        },
        jedi_language_server = {
          cmd = jedi_cmd,
          init_options = jedi_init_options,
          on_new_config = function(new_config, new_root_dir)
            local Path = require("plenary.path")
            local root = Path:new(root_dirs.python(new_root_dir))
            local settings_dir = root:joinpath(".vscode", "settings.json")
            if settings_dir:exists() then
              local ok, settings = pcall(vim.json.decode, settings_dir:read())
              if not ok then
                vim.notify("Error parsing '" .. settings_dir.filename .. "'", vim.log.levels.WARN)
              end
              new_config.init_options.workspace.environmentPath = vim.env.HOME
                .. "/micromamba/envs/"
                .. settings["micromamba.env"]
                .. "/bin/python"
            end
          end,
          root_dir = function(startpath)
            local dir = root_dirs.python(startpath)
            return dir or vim.loop.cwd()
          end,
        },
        marksman = {
          -- cmd = { "marksman", "server", "--verbose", "5" },
        },
      },
    },
    ---@param opts PluginLspOpts
    config = function(_, opts)
      vim.diagnostic.config(opts.diagnostics)

      local capabilities =
        require("cmp_nvim_lsp").default_capabilities(vim.lsp.protocol.make_client_capabilities())
      local on_attach = function(_, bufnr)
        require("config.keymaps").lsp(bufnr)
      end
      for server, server_opts in pairs(opts.servers) do
        require("lspconfig")[server].setup(
          vim.tbl_deep_extend(
            "error",
            server_opts,
            { capabilities = capabilities, on_attach = on_attach }
          )
        )
      end
    end,
  },
}
