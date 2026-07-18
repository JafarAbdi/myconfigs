vim.opt.shell = "bash"
vim.g.loaded_matchparen = 1
vim.g.markdown_fenced_languages = { "ts=typescript" }
vim.g.mapleader = " "
vim.g.maplocalleader = " "

local myconfigs_path = vim.fs.joinpath(vim.env.HOME, "myconfigs")
-----------------
--- Functions ---
-----------------

local clangd_opening_root_dir = nil

local set_clangd_opening_path = function(callback)
  return function()
    local ft = vim.api.nvim_get_option_value("filetype", {})
    if ft == "cpp" or ft == "c" then
      for _, client in pairs(vim.lsp.get_clients({ bufnr = 0 })) do
        if client.name == "clangd" then
          clangd_opening_root_dir = client.config.root_dir
          break
        end
      end
    end
    callback()
  end
end

local wezterm = {
  run = function(cmd, opts)
    opts = opts or {}
    local args = { "wezterm", "cli", "split-pane", "--bottom", "--percent", "25" }
    if opts.cwd then
      table.insert(args, "--cwd")
      table.insert(args, opts.cwd)
    end
    local escaped = table.concat(vim.tbl_map(vim.fn.shellescape, cmd), " ")
    vim.list_extend(args, { "bash", "-c", escaped .. '; read -p "Press Enter to close..."' })
    vim.system(args)
  end,
  spawn = function(cmd, opts)
    opts = opts or {}
    local args = { "wezterm", "cli", "spawn" }
    if opts.new_window then
      table.insert(args, "--new-window")
    end
    if opts.cwd then
      table.insert(args, "--cwd")
      table.insert(args, opts.cwd)
    end
    local escaped = table.concat(vim.tbl_map(vim.fn.shellescape, cmd), " ")
    vim.list_extend(args, { "bash", "-c", escaped .. '; read -p "Press Enter to close..."' })
    vim.system(args)
  end,
  notify = function(title, body)
    local cmd = string.format("\x1b]777;notify;%s;%s\x1b\\", title or "", body or "")
    vim.api.nvim_chan_send(vim.v.stderr, cmd)
  end,
}

local root_dirs = {
  python = function(startpath)
    return vim.fs.root(startpath, {
      {
        ".pixi",
        "pixi.toml",
        ".venv",
      },
      {
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "Pipfile",
      },
    })
  end,
  cmake = function(startpath)
    return vim.fs.root(startpath, { ".vscode" })
  end,
  cpp = function(startpath)
    local search_fn = function(path)
      return vim.fs.root(path, { ".clangd" })
    end
    local fallback_search_fn = function(path)
      return vim.fs.root(path, {
        ".vscode",
        "compile_commands.json",
        "compile_flags.txt",
      })
    end
    -- If root directory not found set it to file's directory
    local search = function(path)
      return vim.F.if_nil(search_fn(path), search_fn(vim.fn.expand("%:p:h")))
        or fallback_search_fn(path)
    end
    local dir = search(startpath)
      or (clangd_opening_root_dir and search(clangd_opening_root_dir))
      or vim.fn.getcwd()
    clangd_opening_root_dir = nil
    return dir
  end,
  rust = function(startpath)
    return vim.fs.root(startpath, { "Cargo.toml", "rust-project.json" })
  end,
  zig = function(startpath)
    return vim.fs.root(startpath, { "build.zig" })
  end,
  dockerfile = function(startpath)
    return vim.fs.root(startpath, { "Dockerfile" })
  end,
  javascript = function(startpath)
    return vim.fs.root(
      startpath,
      { "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock" }
    )
  end,
}
root_dirs.c = root_dirs.cpp
root_dirs.cuda = root_dirs.cpp
root_dirs.tsx = root_dirs.javascript
root_dirs.jsx = root_dirs.javascript
root_dirs.typescript = root_dirs.javascript
root_dirs.typescriptreact = root_dirs.javascript

local run_file = function()
  if not vim.bo.readonly and vim.bo.modified then
    vim.cmd.write()
  end
  wezterm.run({ "runner", vim.fn.expand("%:p") })
end

----------------
--- Commands ---
----------------

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})
local lsp_group = vim.api.nvim_create_augroup("lsp", {})

vim.api.nvim_create_autocmd("VimResume", { command = "checktime", group = general_group })
-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  group = general_group,
  pattern = "qf",
  callback = function()
    vim.opt_local.winfixbuf = true
    vim.opt_local.spell = false
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown" },
  group = general_group,
  callback = function()
    vim.opt_local.wrap = true
    vim.opt_local.conceallevel = 3
    vim.opt_local.colorcolumn = "100"
  end,
})
-- A terrible way to handle symlinks
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function(params)
    local fname = params.file
    local resolved_fname = vim.fn.resolve(fname)
    if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
      return
    end
    vim.print("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
    vim.schedule(function()
      local cursor = vim.api.nvim_win_get_cursor(0)
      vim.cmd.bwipeout({ params.buf, bang = true })
      vim.api.nvim_command("edit " .. resolved_fname)
      vim.api.nvim_win_set_cursor(0, cursor)
    end)
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("TermOpen", {
  callback = function()
    vim.opt_local.signcolumn = "no"
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.winfixbuf = true
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local client = assert(vim.lsp.get_client_by_id(args.data.client_id))
    if client:supports_method("textDocument/completion") then
      -- omnifunc starts identifier completion; lsp autotrigger refreshes incomplete results
      -- and handles server trigger characters. buffer words can shadow richer lsp items.
      vim.bo[args.buf].complete = "o,F"
      vim.lsp.completion.enable(true, client.id, args.buf, { autotrigger = true })
      -- ctrl-x suspends autocomplete before requesting omnifunc again at the current cursor.
      vim.keymap.set("i", "<C-Space>", "<C-x><C-o>", {
        buffer = args.buf,
        silent = true,
      })
      vim.keymap.set("i", "<C-S>", function()
        local close_menu = vim.fn.pumvisible() == 1 and "<C-e>" or ""
        return close_menu .. "<Cmd>lua vim.lsp.buf.signature_help()<CR>"
      end, { buffer = args.buf, expr = true, silent = true })
    end
    vim.keymap.set("n", "<C-k>", vim.lsp.buf.signature_help, { buffer = args.buf, silent = true })
    vim.keymap.set(
      "n",
      "gd",
      set_clangd_opening_path(vim.lsp.buf.definition),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set("n", "<leader>f", function()
      vim.lsp.buf.format({ async = true })
    end, { buffer = args.buf, silent = true })
    vim.keymap.set({ "i", "n" }, "<M-i>", function()
      return vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
    end, { buffer = args.buf, silent = true })
    client.server_capabilities.semanticTokensProvider = nil
    -- if client.supports_method("textDocument/documentHighlight") then
    --   local group =
    --     vim.api.nvim_create_augroup(string.format("lsp-%s-%s", args.buf, args.data.client_id), {})
    --   vim.api.nvim_create_autocmd("CursorHold", {
    --     group = group,
    --     buffer = args.buf,
    --     callback = vim.lsp.buf.document_highlight,
    --   })
    --   vim.api.nvim_create_autocmd("CursorMoved", {
    --     group = group,
    --     buffer = args.buf,
    --     callback = function()
    --       pcall(vim.lsp.util.buf_clear_references, args.buf)
    --     end,
    --   })
    -- end
  end,
  group = lsp_group,
})

vim.api.nvim_create_autocmd("LspDetach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)

    if client:supports_method("textDocument/documentHighlight") then
      local group =
        vim.api.nvim_create_augroup(string.format("lsp-%s-%s", args.buf, args.data.client_id), {})
      pcall(vim.api.nvim_del_augroup_by_name, group)
    end
  end,
})

local get_rust_lsp_client = function()
  local clients = vim.lsp.get_clients({ bufnr = 0, name = "rust-langserver" })
  if #clients == 0 then
    return
  end
  assert(#clients == 1, "Multiple rust-analyzer clients attached to this buffer")
  return clients[1]
end
vim.api.nvim_create_user_command("RustReloadWorkspace", function()
  local client = get_rust_lsp_client()
  if not client then
    vim.notify("rust-analyzer is not attached to this buffer", vim.log.levels.WARN)
    return
  end
  local ok = client:request("rust-analyzer/reloadWorkspace", nil, function(err)
    if err then
      vim.notify("Error reloading Cargo workspace: " .. vim.inspect(err), vim.log.levels.WARN)
      return
    end
    vim.notify("Cargo workspace reloaded")
  end, 0)
  if ok then
    vim.notify("Reloading Cargo workspace")
  else
    vim.notify("Failed to request Cargo workspace reload", vim.log.levels.WARN)
  end
end, {})
vim.api.nvim_create_user_command("RustExpandMacro", function()
  local client = get_rust_lsp_client()
  if not client then
    vim.notify("rust-analyzer is not attached to this buffer", vim.log.levels.WARN)
    return
  end
  vim.lsp.buf_request_all(
    0,
    "rust-analyzer/expandMacro",
    vim.lsp.util.make_position_params(0, client.offset_encoding),
    function(result)
      vim.cmd.vsplit()
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_win_set_buf(0, buf)
      if result then
        vim.api.nvim_set_option_value("filetype", "rust", { buf = 0 })
        for _, res in pairs(result) do
          if res and res.result and res.result.expansion then
            vim.api.nvim_buf_set_lines(buf, -1, -1, false, vim.split(res.result.expansion, "\n"))
          else
            vim.api.nvim_buf_set_lines(buf, -1, -1, false, {
              "No expansion available.",
            })
          end
        end
      else
        vim.api.nvim_buf_set_lines(buf, -1, -1, false, {
          "Error: No result returned.",
        })
      end
    end
  )
end, {})

-----------------
--- LSP Setup ---
-----------------

local servers = {
  ts_ls = {
    name = "typescript-language-server",
    cmd = { "bunx", "typescript-language-server", "--stdio" },
    filetypes = {
      "javascript",
      "javascriptreact",
      "javascript.jsx",
      "typescript",
      "typescriptreact",
      "typescript.tsx",
    },
    settings = {
      typescript = { tsserver = { useSyntaxServer = false } },
    },
  },
  yamlls = {
    name = "yamlls",
    cmd = { "bunx", "yaml-language-server", "--stdio" },
    filetypes = { "yaml" },
    settings = {
      yaml = {
        schemas = {
          ["https://json.schemastore.org/pre-commit-config.json"] = {
            ".pre-commit-config.yml",
            ".pre-commit-config.yaml",
          },
          ["https://json.schemastore.org/github-action.json"] = {
            "action.yml",
            "action.yaml",
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
  {
    name = "taplo",
    filetypes = { "toml" },
    cmd = {
      "taplo",
      "lsp",
      "--config",
      vim.fs.joinpath(myconfigs_path, "taplo.toml"),
      "stdio",
    },
  },
  {
    name = "clangd",
    filetypes = { "c", "cpp", "cuda" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "lsps", "bin", "clangd"),
      "--completion-style=detailed",
      -- "-log=verbose"
    },
    init_options = function()
      return {
        clangdFileStatus = true,
      }
    end,
  },
  {
    name = "efm",
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
      "xml",
      "zig",
    },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "lsps", "bin", "efm-langserver"),
      -- "-loglevel=5", "-logfile=/tmp/efm.log"
    },
    init_options = function()
      return {
        documentFormatting = true,
        documentRangeFormatting = true,
        hover = false,
        documentSymbol = true,
        codeAction = true,
        completion = false,
      }
    end,
    settings = {
      languages = {
        zig = {
          {
            formatCommand = "zig fmt --stdin",
            formatStdin = true,
          },
        },
        python = {
          {
            formatCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "black"
            ) .. " --quiet -",
            formatStdin = true,
          },
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "ruff"
            ) .. " check --output-format=concise --quiet ${INPUT}",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c: %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
            lintIgnoreExitCode = true,
          },
        },
        cmake = {
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "cmake-lint"
            ) .. " ${INPUT}",
            lintFormats = {
              "%f:%l: %m",
            },
          },
          {
            formatCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "cmake-format -"
            ),
            formatStdin = true,
          },
        },
        json = {
          {
            formatCommand = "bunx @fsouza/prettierd ${INPUT}",
            formatStdin = true,
            rootMarkers = {
              ".prettierrc",
              ".prettierrc.json",
              ".prettierrc.js",
              ".prettierrc.yml",
              ".prettierrc.yaml",
              ".prettierrc.json5",
              ".prettierrc.mjs",
              ".prettierrc.cjs",
              ".prettierrc.toml",
            },
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
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "yamllint"
            ) .. " -f parsable -",
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
  {
    name = "lua-langserver-server",
    filetypes = { "lua" },
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
  {
    name = "rust-langserver",
    filetypes = { "rust" },
    cmd = {
      vim.env.HOME .. "/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rust-analyzer",
    },
    settings = {
      -- to enable rust-analyzer settings visit:
      -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
      -- https://rust-analyzer.github.io/book/configuration.html
      ["rust-analyzer"] = {
        check = true,
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
  {
    name = "zls",
    filetypes = { "zig" },
    cmd = { "zls" },
  },
  {
    name = "cmake_language_server",
    filetypes = { "cmake" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "cmake-lsp", "bin", "cmake-language-server"),
    },
    init_options = function(file)
      local root_dir = root_dirs.cmake(file)
      if not root_dir then
        return {}
      end
      local cmake_settings_filename = vim.fs.joinpath(root_dir, ".vscode", "settings.json")
      local settings = vim.fn.json_decode(vim.fn.readfile(cmake_settings_filename))
      return {
        buildDirectory = settings["cmake.buildDirectory"],
      }
    end,
  },
  -- {
  --   cmd = { "ty", "server" },
  --   filetypes = { "python" },
  --   root_markers = { "ty.toml", "pyproject.toml", ".git" },
  --     settings = {
  --       -- ty = {
  --       --   diagnosticMode = 'workspace',
  --       -- },
  --     },
  --   -- init_options = function(file)
  --     -- return settings
  --     -- if vim.env.CONDA_PREFIX then
  --     --   return {
  --     --     settings = {
  --     --       environment = {
  --     --         python = vim.env.CONDA_PREFIX,
  --     --       },
  --     --     },
  --     --   }
  --     -- end
  --     -- local pixi = vim.fs.find(".pixi", {
  --     --   upward = true,
  --     --   stop = vim.uv.os_homedir(),
  --     --   path = vim.uv.fs_realpath(file),
  --     --   type = "directory",
  --     -- })
  --     -- if #pixi > 0 then
  --     --   local pixi_python_executable = vim.fs.joinpath(pixi[1], "envs", "default", "bin", "python")
  --     --   if vim.uv.fs_stat(pixi_python_executable) then
  --     --     return {
  --     --       settings = {
  --     --         environment = {
  --     --           python = pixi[1] .. "/envs/default",
  --     --         },
  --     --       },
  --     --     }
  --     --   end
  --     -- end
  --     -- return {}
  --   -- end,
  -- },
  -- {
  --   name = "pyrefly",
  --   filetypes = { "python" },
  --   cmd = {
  --     "pyrefly",
  --     "lsp",
  --   },
  -- },
  {
    name = "zubanls",
    filetypes = { "python" },
    cmd = { "zuban", "server" },
    -- zuban is static (mypy-compatible): it only sees packages shipping
    -- .py/.pyi source. Compiled bindings without stubs (e.g. mujoco MjModel,
    -- which lives in _structs.so) need generated stubs. MYPYPATH points zuban
    -- at the `generate_python_stubs` output (plain <pkg>/ layout). jedi differs
    -- — it imports at runtime, so it needs no stubs.
    cmd_env = { MYPYPATH = vim.env.HOME .. "/.cache/python-stubs/stubs" },
    -- pythonExecutable points zuban at the env interpreter so it can find
    -- installed packages. Same option as `zuban check --python-executable`.
    init_options = function(file)
      local options = {
        pythonExecutable = "/usr/bin/python3",
      }
      if vim.env.CONDA_PREFIX then
        options.pythonExecutable = vim.env.CONDA_PREFIX .. "/bin/python"
      end

      local venv = vim.fs.find(".venv", {
        upward = true,
        stop = vim.uv.os_homedir(),
        path = vim.uv.fs_realpath(file),
        type = "directory",
      })
      if #venv > 0 then
        local venv_python_executable = vim.fs.joinpath(venv[1], "bin", "python")
        if vim.uv.fs_stat(venv_python_executable) then
          options.pythonExecutable = venv_python_executable
          return options
        end
      end

      local pixi = vim.fs.find(".pixi", {
        upward = true,
        stop = vim.uv.os_homedir(),
        path = vim.uv.fs_realpath(file),
        type = "directory",
      })
      if #pixi > 0 then
        local pixi_python_executable = vim.fs.joinpath(pixi[1], "envs", "default", "bin", "python")
        if vim.uv.fs_stat(pixi_python_executable) then
          options.pythonExecutable = pixi_python_executable
        end
      end
      return options
    end,
  },
  -- {
  --   name = "jedi_language_server",
  --   filetypes = { "python" },
  --   cmd = {
  --     vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "python-lsp", "bin", "jedi-language-server"),
  --     -- "-vv",
  --     -- "--log-file",
  --     -- "/tmp/logging.txt",
  --   },
  --   init_options = function(file)
  --     local options = {
  --       workspace = {
  --         extraPaths = {
  --           vim.env.HOME .. "/.cache/python-stubs",
  --         },
  --         environmentPath = "/usr/bin/python3",
  --       },
  --     }
  --     if vim.env.CONDA_PREFIX then
  --       options.workspace.environmentPath = vim.env.CONDA_PREFIX .. "/bin/python"
  --     end
  --
  --     local venv = vim.fs.find(".venv", {
  --       upward = true,
  --       stop = vim.uv.os_homedir(),
  --       path = vim.uv.fs_realpath(file),
  --       type = "directory",
  --     })
  --
  --     if #venv > 0 then
  --       local venv_python_executable = vim.fs.joinpath(venv[1], "bin", "python")
  --       if vim.uv.fs_stat(venv_python_executable) then
  --         options.workspace.environmentPath = venv[1]
  --         return options
  --       end
  --     end
  --
  --     local pixi = vim.fs.find(".pixi", {
  --       upward = true,
  --       stop = vim.uv.os_homedir(),
  --       path = vim.uv.fs_realpath(file),
  --       type = "directory",
  --     })
  --     if #pixi > 0 then
  --       local pixi_python_executable = vim.fs.joinpath(pixi[1], "envs", "default", "bin", "python")
  --       if vim.uv.fs_stat(pixi_python_executable) then
  --         options.workspace.environmentPath = pixi[1] .. "/envs/default"
  --       end
  --     end
  --     return options
  --   end,
  -- },
  {
    name = "marksman",
    filetypes = { "markdown" },
    cmd = { "marksman", "server" },
  },
  {
    name = "lemminx",
    filetypes = { "xml" },
    cmd = { "lemminx" },
  },
  {
    name = "docker-ls",
    cmd = { "bunx", "dockerfile-language-server-nodejs", "--stdio" },
    filetypes = {
      "dockerfile",
    },
  },
}

for _, server in pairs(servers) do
  if vim.fn.executable(server.cmd[1]) == 1 then
    vim.api.nvim_create_autocmd("FileType", {
      pattern = server.filetypes,
      group = lsp_group,
      callback = function(args)
        -- Don't start LSP for floating windows
        if vim.api.nvim_win_get_config(0).relative ~= "" then
          return
        end
        -- Skip URI-scheme buffers (fugitive://, oil://, jdt://, ...):
        -- vim.fs.root in per-server conditions would mangle the URI via cwd
        -- and return wrong results. Producers attach LSP explicitly instead.
        if args.file:match("^%w+:") then
          return
        end
        if server.condition and not server.condition(args.file) then
          return
        end
        local capabilities =
          vim.tbl_deep_extend("force", vim.lsp.protocol.make_client_capabilities(), {
            -- Rust specific capabilities
            experimental = {
              localDocs = true, -- TODO: Support experimental/externalDocs
              hoverActions = true,
            },
            workspace = {
              didChangeWatchedFiles = {
                dynamicRegistration = true,
              },
            },
          })

        local root_dir = server.root_dir or root_dirs[args.match] or function() end
        vim.lsp.start({
          name = server.name,
          cmd = server.cmd,
          cmd_env = server.cmd_env,
          handlers = server.handlers,
          on_attach = function(_, _) end,
          capabilities = capabilities,
          settings = server.settings or vim.empty_dict(),
          init_options = server.init_options and server.init_options(args.file) or vim.empty_dict(),
          root_dir = root_dir(args.file) or vim.fs.root(args.file, { ".git" }),
        })
      end,
    })
  end
end

local c_snippets = {
  {
    trigger = "main",
    description = "Standard main function",
    body = [[
int main (int argc, char *argv[])
{
  $0
  return 0;
}]],
  },
}
local snippets = {
  c = c_snippets,
  cpp = c_snippets,
  cuda = c_snippets,
  cmake = {
    {
      trigger = "print_all_variables",
      description = "Print all cmake variables",
      body = [[
get_cmake_property(_variableNames VARIABLES)
list (SORT _variableNames)
foreach (_variableName \${_variableNames})
  message(STATUS \${_variableName}=\${\${_variableName}})
endforeach()${0}]],
    },
  },
}

_G.complete_snippets = function(findstart, base)
  if findstart == 1 then
    local cursor_col = vim.api.nvim_win_get_cursor(0)[2]
    local line_to_cursor = vim.api.nvim_get_current_line():sub(1, cursor_col)
    return vim.fn.match(line_to_cursor, [[\k*$]])
  end
  if base == "" then
    return {}
  end
  return vim.tbl_map(function(snippet)
    return {
      word = snippet.trigger,
      kind = "S",
      menu = "[Snippet]",
      info = snippet.description,
      user_data = { myconfigs = { snippet = snippet } },
    }
  end, vim.fn.matchfuzzy(snippets[vim.bo.filetype] or {}, base, { key = "trigger" }))
end

vim.api.nvim_create_autocmd("CompleteDone", {
  group = general_group,
  callback = function()
    if vim.v.event.reason ~= "accept" then
      return
    end
    local snippet = vim.tbl_get(vim.v.completed_item, "user_data", "myconfigs", "snippet")
    if not snippet then
      return
    end
    local cursor = vim.api.nvim_win_get_cursor(0)
    local start_col = cursor[2] - #snippet.trigger
    assert(start_col >= 0)
    assert(vim.api.nvim_get_current_line():sub(start_col + 1, cursor[2]) == snippet.trigger)
    vim.api.nvim_buf_set_text(0, cursor[1] - 1, start_col, cursor[1] - 1, cursor[2], { "" })
    vim.snippet.expand(snippet.body)
  end,
})

---------------
--- Plugins ---
---------------

local gh = function(x)
  return "https://github.com/" .. x
end

-- Copilot globals must be set before the plugin loads
vim.g.copilot_node_command = myconfigs_path .. "/.pixi/envs/nodejs/bin/node"
vim.g.copilot_no_tab_map = true
vim.g.copilot_no_maps = true
vim.g.copilot_assume_mapped = true
vim.g.copilot_tab_fallback = ""
vim.g.copilot_filetypes = {
  ["*"] = true,
  gitcommit = false,
}

-- TSUpdate on install/update
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(ev)
    if
      ev.data.spec.name == "nvim-treesitter"
      and (ev.data.kind == "install" or ev.data.kind == "update")
    then
      if not ev.data.active then
        vim.cmd.packadd("nvim-treesitter")
      end
      vim.cmd("TSUpdate")
    end
  end,
})

vim.pack.add({
  gh("mfussenegger/nvim-qwahl"),
  gh("mfussenegger/nvim-fzy"),
  gh("github/copilot.vim"),
  { src = gh("nvim-treesitter/nvim-treesitter"), version = "main" },
  { src = gh("nvim-treesitter/nvim-treesitter-textobjects"), version = "main" },
})

-- Copilot keymaps
vim.keymap.set("i", "<M-e>", function()
  return vim.api.nvim_feedkeys(
    vim.fn["copilot#Accept"](vim.api.nvim_replace_termcodes("<Tab>", true, true, true)),
    "n",
    true
  )
end, { expr = true })
vim.keymap.set("i", "<c-;>", function()
  return vim.fn["copilot#Next"]()
end, { expr = true })
vim.keymap.set("i", "<c-,>", function()
  return vim.fn["copilot#Previous"]()
end, { expr = true })
vim.keymap.set("i", "<c-c>", function()
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
  return vim.fn["copilot#Dismiss"]()
end, { expr = true })
vim.keymap.set("i", "<C-M-l>", function()
  return vim.fn["copilot#AcceptLine"]()
end, { expr = true, silent = true })
vim.keymap.set("i", "<C-M-e>", function()
  return vim.fn["copilot#AcceptWord"]()
end, { expr = true, silent = true })

-- nvim-treesitter
require("nvim-treesitter").install({
  "bash",
  "c",
  "cmake",
  "comment",
  "cpp",
  "dockerfile",
  "fish",
  "html",
  "http",
  "javascript",
  "json",
  "latex",
  "lua",
  "make",
  "markdown",
  "markdown_inline",
  "ninja",
  "proto",
  "python",
  "query",
  "rst",
  "rust",
  "toml",
  "typescript",
  "vim",
  "vimdoc",
  "xml",
  "yaml",
  "zig",
})

-- nvim-treesitter-textobjects
do
  local ts_textobjects = require("nvim-treesitter-textobjects")
  ts_textobjects.setup({
    select = { lookahead = true },
    move = { set_jumps = true },
  })

  local select = require("nvim-treesitter-textobjects.select").select_textobject
  for _, mapping in ipairs({
    { "af", "@function.outer" },
    { "if", "@function.inner" },
    { "ac", "@class.outer" },
    { "ic", "@class.inner" },
    { "ap", "@parameter.outer" },
    { "ip", "@parameter.inner" },
    { "ao", "@conditional.outer" },
    { "io", "@conditional.inner" },
    { "al", "@loop.outer" },
    { "il", "@loop.inner" },
  }) do
    vim.keymap.set({ "x", "o" }, mapping[1], function()
      select(mapping[2], "textobjects")
    end)
  end

  local swap = require("nvim-treesitter-textobjects.swap")
  vim.keymap.set("n", "<leader>a", function()
    swap.swap_next("@parameter.inner")
  end)
  vim.keymap.set("n", "<leader>A", function()
    swap.swap_previous("@parameter.inner")
  end)

  local move = require("nvim-treesitter-textobjects.move")
  for _, mapping in ipairs({
    { "]f", "goto_next_start", "@function.outer" },
    { "]c", "goto_next_start", "@class.outer" },
    { "]F", "goto_next_end", "@function.outer" },
    { "]C", "goto_next_end", "@class.outer" },
    { "[f", "goto_previous_start", "@function.outer" },
    { "[c", "goto_previous_start", "@class.outer" },
    { "[F", "goto_previous_end", "@function.outer" },
    { "[C", "goto_previous_end", "@class.outer" },
  }) do
    vim.keymap.set({ "n", "x", "o" }, mapping[1], function()
      move[mapping[2]](mapping[3], "textobjects")
    end)
  end
end

-- Enable treesitter highlighting for filetypes with an installed parser
vim.api.nvim_create_autocmd("FileType", {
  group = general_group,
  callback = function(args)
    local lang = vim.treesitter.language.get_lang(args.match)
    if lang and pcall(vim.treesitter.language.add, lang) then
      pcall(vim.treesitter.start)
    end
  end,
})

---------------
--- Options ---
---------------

vim.diagnostic.config({
  underline = false,
  update_in_insert = true,
  virtual_text = {
    severity = vim.diagnostic.severity.ERROR,
    source = "if_many",
  },
  severity_sort = true,
  signs = false,
  jump = {
    on_jump = function(_, bufnr)
      vim.diagnostic.open_float({ bufnr = bufnr })
    end,
  },
})
vim.opt.smoothscroll = true
vim.opt.foldenable = false
vim.opt.number = true
vim.opt.mouse = "a"
vim.opt.undofile = true
vim.opt.breakindent = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.updatetime = 250
vim.opt.tabstop = 2
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.autoindent = true
vim.opt.copyindent = true
vim.opt.cursorline = true
vim.opt.termguicolors = true
vim.opt.hlsearch = false
vim.opt.linebreak = true
vim.opt.autowrite = true
vim.opt.inccommand = "nosplit"
vim.opt.wrap = false
vim.opt.showmatch = true
vim.opt.title = true
vim.opt.relativenumber = true
vim.opt.shortmess:append("wIA")
vim.opt.matchtime = 2
vim.opt.matchpairs:append("<:>")
vim.opt.swapfile = false
vim.opt.signcolumn = "number"
vim.opt.laststatus = 3
vim.opt.statusline =
  "%<%f %m%r %{%v:lua.vim.lsp.status()%} %{%v:lua.vim.ui.progress_status()%}%= %{%v:lua.vim.diagnostic.status()%} "
vim.api.nvim_create_autocmd("LspProgress", {
  group = lsp_group,
  callback = function()
    vim.cmd.redrawstatus()
  end,
})
vim.opt.smartindent = false
-- lsp buffers override 'complete'; other buffers use local snippets and bounded word sources.
vim.opt.autocomplete = true
vim.opt.pumheight = 20
vim.opt.completeopt = "menuone,noselect,noinsert,fuzzy,popup"
vim.opt.complete = "F,.^5,w^5,b^5"
vim.opt.completefunc = "v:lua.complete_snippets"
vim.opt.wildmode = "longest:full,full"
vim.opt.wildignore:append({ "*.pyc", ".git", ".idea", "*.o" })
vim.opt.wildoptions = "pum,tagfile,fuzzy"
vim.opt.suffixes:append({ ".pyc", ".tmp" })
vim.opt.spell = true

if vim.fn.executable("rg") == 1 then
  vim.opt.grepprg = "rg --no-messages --vimgrep --no-heading --smart-case"
  vim.opt.grepformat = "%f:%l:%c:%m,%f:%l:%m"
end

if os.getenv("SSH_CLIENT") then
  vim.g.clipboard = "osc52"
end

vim.treesitter.language.register("xml", { "xacro", "urdf", "srdf" })
vim.treesitter.language.register("cpp", { "cuda" })
vim.filetype.add({
  pattern = {
    [".*.bazelrc"] = "bazelrc",
  },
  extension = {
    launch = "xml",
    test = "xml",
    urdf = "xml",
    srdf = "xml",
    xacro = "xml",
    install = "text",
    repos = "yaml",
    jinja = "jinja",
    jinja2 = "jinja",
    j2 = "jinja",
  },
})

vim.cmd.packadd("cfilter")
vim.cmd.packadd("nvim.undotree")

vim.cmd.colorscheme("habamax")
---------------
--- Keymaps ---
---------------

local fzy = require("fzy")
fzy.command = function(opts)
  return string.format(
    'fzf --height %d --prompt "%s" --no-multi --preview=""',
    opts.height,
    vim.F.if_nil(opts.prompt, "")
  )
end

local q = require("qwahl")

vim.keymap.set("i", "<CR>", function()
  return vim.fn.complete_info({ "selected" }).selected >= 0 and "<C-y>" or "<CR>"
end, { expr = true })

-- Incremental treesitter node selection (built-in an/in) with old keymaps
vim.keymap.set("n", "<A-w>", "van", { remap = true, silent = true })
vim.keymap.set("x", "<A-w>", "an", { remap = true, silent = true })
vim.keymap.set("x", "<A-S-w>", "in", { remap = true, silent = true })

vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set({ "i", "s" }, "<ESC>", function()
  if vim.snippet then
    vim.snippet.stop()
  end
  return "<ESC>"
end, { expr = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("n", "<leader>x", function()
  run_file()
end, { silent = true })
vim.keymap.set("n", "<leader>h", q.helptags, { silent = true })
vim.keymap.set("n", "<leader><space>", q.buffers, { silent = true })
vim.keymap.set("n", "<leader>gc", q.buf_lines, { silent = true })
vim.keymap.set("n", "<C-M-s>", function()
  local cword = vim.fn.expand("<cword>")
  if cword ~= "" then
    fzy.execute(
      "rg --no-messages --no-heading --trim --line-number --smart-case --fixed-strings -- "
        .. vim.fn.shellescape(cword),
      fzy.sinks.edit_live_grep
    )
  end
end, { silent = true })
vim.keymap.set("n", "<M-o>", function()
  fzy.execute("fd --hidden --type f --strip-cwd-prefix", fzy.sinks.edit_file)
end, { silent = true })
vim.keymap.set("n", "<leader>j", q.jumplist, { silent = true })

-- Diagnostic keymaps
vim.keymap.set("n", "<leader>q", q.quickfix, { silent = true })
vim.keymap.set("n", "<leader>dq", function()
  q.diagnostic(0)
end, { silent = true })

local win_pre_copen = nil
vim.keymap.set("n", "<leader>c", function()
  local api = vim.api
  for _, win in pairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)
    if api.nvim_get_option_value("buftype", { buf = buf }) == "quickfix" then
      vim.cmd.cclose()
      if win_pre_copen then
        local ok, w = pcall(api.nvim_win_get_number, win_pre_copen)
        if ok and api.nvim_win_is_valid(w) then
          api.nvim_set_current_win(w)
        end
        win_pre_copen = nil
      end
      return
    end
  end

  -- no quickfix buffer found so far, so show it
  win_pre_copen = api.nvim_get_current_win()
  vim.cmd.copen({ mods = { split = "botright" } })
end, { silent = true })

vim.keymap.set({ "n" }, "<leader>m", function()
  local buffer_mark_names = "abcdefghijklmnopqrstuvwxyz"
  local global_mark_names = buffer_mark_names:upper()
  local marks = {}
  for i = 1, #buffer_mark_names do
    local letter = buffer_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_buf_get_mark, 0, letter) -- Returns (0, 0) if not set
    if ok and mark[1] ~= 0 then
      table.insert(marks, { name = letter, value = mark })
    end
  end
  for i = 1, #global_mark_names do
    local letter = global_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_get_mark, letter, {}) -- Returns (0, 0, 0, "") if not set
    if ok and not (mark[1] == 0 and mark[2] == 0 and mark[3] == 0 and mark[4] == "") then
      if vim.uv.fs_stat(vim.fs.normalize(mark[4])) then
        table.insert(marks, { name = letter, value = mark })
      end
    end
  end
  local current_bufnr = vim.api.nvim_get_current_buf()
  fzy.pick_one(marks, "Mark: ", function(item)
    if item == nil then
      return
    end
    if #item.value == 4 then
      return string.format(
        "[%s] %s: %s",
        item.name,
        item.value[4],
        item.value[3] ~= 0
            and vim.api.nvim_buf_get_lines(item.value[3], item.value[1] - 1, item.value[1], true)[1]
          or "Unloaded Buffer"
      )
    end
    return string.format(
      "[%s] %s: %s",
      item.name,
      "Current Buffer",
      vim.api.nvim_buf_get_lines(current_bufnr, item.value[1] - 1, item.value[1], true)[1]
    )
  end, function(item)
    if item ~= nil then
      vim.cmd.normal("`" .. item.name)
    end
  end)
end)
