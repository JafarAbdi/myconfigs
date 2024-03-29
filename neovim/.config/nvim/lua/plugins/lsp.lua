local function read_file(path)
  local fd = assert(vim.uv.fs_open(path, "r", 438))
  local stat = assert(vim.uv.fs_fstat(fd))
  local data = assert(vim.uv.fs_read(fd, stat.size, 0))
  assert(vim.uv.fs_close(fd))
  return data
end

local root_dirs = require("config.functions").root_dirs

return {
  {
    "neovim/nvim-lspconfig",
    lazy = false,
    opts = {
      diagnostics = {
        underline = false,
        update_in_insert = true,
        virtual_text = { severity = vim.diagnostic.severity.ERROR },
        severity_sort = true,
        signs = false,
      },
      servers = {
        tsserver = {},
        clangd = {
          cmd = {
            vim.env.HOME .. "/.config/clangd-lsp/bin/clangd",
            "--completion-style=detailed",
            -- "-log=verbose"
          },
          init_options = {
            clangdFileStatus = true,
          },
          root_dir = root_dirs.cpp,
          single_file_support = true,
        },
        efm = {
          init_options = {
            documentFormatting = true,
            documentRangeFormatting = true,
            hover = false,
            documentSymbol = true,
            codeAction = true,
            completion = false,
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
            return require("lspconfig").util.find_git_ancestor(dir) or vim.uv.cwd()
          end,
          settings = {
            languages = {
              python = {
                {
                  lintCommand = "micromamba run -n linters mypy --show-column-numbers --install-types --non-interactive --hide-error-codes --hide-error-context --no-color-output --no-error-summary --no-pretty",
                  lintFormats = {
                    "%f:%l:%c: error: %m",
                    "%f:%l:%c: %tarning: %m",
                    "%f:%l:%c: %tote: %m",
                  },
                  lintSeverity = vim.diagnostic.severity.WARN,
                },
                {
                  formatCommand = "micromamba run -n linters black --quiet -",
                  formatStdin = true,
                },
                {
                  lintCommand = "micromamba run -n linters ruff --quiet ${INPUT}",
                  lintStdin = true,
                  lintFormats = {
                    "%f:%l:%c: %m",
                  },
                  lintSeverity = vim.diagnostic.severity.WARN,
                },
              },
              cmake = {
                {
                  lintCommand = "cmake-lint",
                  lintFormats = {
                    "%f:%l,%c: %m",
                  },
                  lintSeverity = vim.diagnostic.severity.WARN,
                },
                {
                  formatCommand = "cmake-format -",
                  formatStdin = true,
                },
              },
              json = {
                {
                  lintCommand = "python3 -m json.tool",
                  lintStdin = true,
                  lintFormats = {
                    "%m: line %l column %c (char %r)",
                  },
                },
                {
                  formatCommand = "python3 -m json.tool",
                  formatStdin = true,
                },
              },
              markdown = {
                {
                  formatCommand = "pandoc -f markdown -t gfm -sp --tab-stop=2",
                  formatStdin = true,
                },
              },
              rst = {
                {
                  formatCommand = "pandoc -f rst -t rst -s --columns=79",
                  formatStdin = true,
                },
                {
                  lintCommand = "rstcheck -",
                  lintStdin = true,
                  lintFormats = {
                    "%f:%l: (%tNFO/1) %m",
                    "%f:%l: (%tARNING/2) %m",
                    "%f:%l: (%tRROR/3) %m",
                    "%f:%l: (%tEVERE/4) %m",
                  },
                },
              },
              sh = {
                {
                  lintCommand = "shellcheck -f gcc -x -",
                  lintStdin = true,
                  lintFormats = {
                    "%f:%l:%c: %trror: %m",
                    "%f:%l:%c: %tarning: %m",
                    "%f:%l:%c: %tote: %m",
                  },
                },
              },
              tex = {
                {
                  lintCommand = "chktex -v0 -q",
                  lintStdin = true,
                  lintFormats = {
                    "%f:%l:%c:%m",
                  },
                },
              },
              yaml = {
                {
                  lintCommand = "yamllint -f parsable -",
                  lintStdin = true,
                },
                {
                  prefix = "actionlint",
                  lintCommand = "bash -c \"[[ '${INPUT}' =~ \\\\.github/workflows/ ]]\" && actionlint -oneline -no-color -",
                  lintStdin = true,
                  lintFormats = {
                    "%f:%l:%c: %m",
                  },
                  rootMarkers = { ".github" },
                },
              },
              lua = {
                {
                  formatCommand = "stylua --search-parent-directories -",
                  formatStdin = true,
                },
              },
              dockerfile = {
                {
                  lintCommand = "hadolint --no-color",
                  lintFormats = {
                    "%f:%l %m",
                  },
                  lintSeverity = vim.diagnostic.severity.WARN,
                },
              },
            },
          },
        },
        lua_ls = {
          cmd = { vim.env.HOME .. "/.config/lua-lsp/bin/lua-language-server" },
          settings = {
            Lua = {
              hint = {
                enable = true,
              },
              format = {
                enable = false,
              },
              runtime = {
                version = "LuaJIT",
              },
              diagnostics = {
                globals = { "vim" },
              },
              workspace = {
                library = vim.api.nvim_get_runtime_file("", true),
                checkThirdParty = false,
              },
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
          cmd = {
            vim.env.HOME .. "/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rust-analyzer",
          },
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
          cmd = { "micromamba", "run", "-n", "cmake-lsp", "cmake-language-server" }, -- "-vv", "--log-file", "/tmp/cmake-lsp.txt"
          on_new_config = function(new_config, new_root_dir)
            local root = root_dirs.cmake(new_root_dir)
            local build_dir = nil
            local settings_dir = vim.fs.joinpath(root, ".vscode", "settings.json")
            if vim.uv.fs_state(settings_dir) then
              local ok, settings = pcall(vim.json.decode, read_file(settings_dir))
              if not ok then
                vim.notify("Error parsing '" .. settings_dir.filename .. "'", vim.log.levels.WARN)
              end
              local ros_distro = vim.env.ROS_DISTRO
              if ros_distro then
                build_dir = settings["cmake.buildDirectory." .. ros_distro]
              else
                build_dir = settings["cmake.buildDirectory"]
              end
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
          cmd = { "micromamba", "run", "-n", "python-lsp", "jedi-language-server" }, -- "-vv", "--log-file", "/tmp/logging.txt"
          init_options = {
            workspace = {
              extraPaths = { vim.env.HOME .. "/.cache/python-stubs" },
              environmentPath = "/usr/bin/python3",
            },
          },
          on_new_config = function(new_config, _)
            if vim.env.CONDA_PREFIX then
              new_config.init_options.workspace.environmentPath = vim.env.CONDA_PREFIX
                .. "/bin/python"
            end
            local pixi = vim.fs.find(".pixi", {
              upward = true,
              stop = vim.uv.os_homedir(),
              path = vim.fs.dirname(vim.api.nvim_buf_get_name(0)),
              type = "directory",
            })
            if #pixi > 0 then
              -- TODO: Deprecated path to pixi. Remove in next major version
              if vim.fn.isdirectory(vim.fs.joinpath(pixi[1], "env")) == 1 then
                new_config.init_options.workspace.environmentPath = pixi[1] .. "/env/bin/python"
              elseif vim.fn.isdirectory(vim.fs.joinpath(pixi[1], "envs", "default")) == 1 then
                new_config.init_options.workspace.environmentPath = pixi[1]
                  .. "/envs/default/bin/python"
              end
            end
          end,
          root_dir = function(startpath)
            local dir = root_dirs.python(startpath)
            return dir or vim.uv.cwd()
          end,
        },
        marksman = {
          -- cmd = { "marksman", "server", "--verbose", "5" },
        },
        lemminx = {},
        zls = {},
      },
    },
    config = function(_, opts)
      vim.diagnostic.config(opts.diagnostics)

      local capabilities = vim.tbl_deep_extend(
        "force",
        require("cmp_nvim_lsp").default_capabilities(vim.lsp.protocol.make_client_capabilities()),
        {
          offsetEncoding = { "utf-16" },
        }
      )
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
