vim.opt.shell = "bash"

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  -- bootstrap lazy.nvim
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

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
  rust = function(_)
    local search_fn = function(path)
      return vim.fs.root(path, { "Cargo.toml", "rust-project.json", ".vscode" })
    end
    return search_fn(vim.fn.getcwd())
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
      { "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "deno.lock" }
    )
  end,
}
root_dirs.c = root_dirs.cpp
root_dirs.cuda = root_dirs.cpp
root_dirs.tsx = root_dirs.javascript
root_dirs.jsx = root_dirs.javascript
root_dirs.typescript = root_dirs.javascript
root_dirs.typescriptreact = root_dirs.javascript

_G.lsp_status = function()
  local lsp_status = vim.lsp.status()
  if lsp_status == "" then
    return ""
  end
  return " | " .. lsp_status
end

local runners = {
  python = function(file_path, root_dir)
    local python_executable = "python3"
    local pixi_python_executable =
      vim.fs.joinpath(root_dir, ".pixi", "envs", "default", "bin", "python")
    if vim.uv.fs_stat(pixi_python_executable) ~= nil then
      python_executable = pixi_python_executable
    end
    local venv_python_executable = vim.fs.joinpath(root_dir, ".venv", "bin", "python")
    if vim.uv.fs_stat(venv_python_executable) ~= nil then
      python_executable = venv_python_executable
    end
    return {
      python_executable,
      file_path,
    }
  end,
  bash = function(file_path, _)
    return {
      "bash",
      file_path,
    }
  end,
  fish = function(file_path, _)
    return {
      "fish",
      file_path,
    }
  end,
  xml = function(_, _)
    return {
      "curl",
      "-X",
      "POST",
      "http://127.0.0.1:7777/set_reload_request",
    }
  end,
  rust = function(file_path, root_dir)
    if not vim.uv.fs_stat(vim.fs.joinpath(root_dir, "Cargo.toml")) then
      vim.notify(root_dir .. " is not a Cargo project", vim.log.levels.WARN)
    end
    local cmd_output = vim
      .system(
        { "cargo", "metadata", "--format-version=1", "--no-deps", "--offline" },
        { cwd = root_dir, text = true }
      )
      :wait()
    if cmd_output.code ~= 0 then
      vim.notify("Failed with code " .. cmd_output.code, vim.log.levels.WARN)
      return
    end

    local metadata = vim.json.decode(cmd_output.stdout)

    for _, package in ipairs(metadata.packages) do
      for _, target in ipairs(package.targets) do
        -- if target.kind[1] == "lib" and is_test then
        --   return { "cargo", "test", "--lib" }
        -- end
        if file_path == target.src_path then
          if target.kind[1] == "bin" then
            return { "cargo", "run", "--release", "--bin", target.name }
          elseif target.kind[1] == "example" then
            return { "cargo", "run", "--release", "--example", target.name }
          else
            vim.notify("Unsupported target kind " .. vim.inspect(target.kind), vim.log.levels.WARN)
            return
          end
        end
      end
    end
    vim.notify("Can't find a target for " .. file_path, vim.log.levels.WARN)
  end,
  lua = function(file_path, _, _)
    return { "nvim", "-l", file_path }
  end,
}

runners.sh = runners.bash

local run_file = function()
  local filetype = vim.api.nvim_get_option_value("filetype", {})
  if not filetype or filetype == "" then
    return
  end

  local runner = runners[filetype]
  if not runner then
    vim.notify("No runner found for filetype: '" .. filetype .. "'", vim.log.levels.WARN)
    return
  end

  local dirname = vim.fn.expand("%:p:h")
  local root_dir = root_dirs[filetype]
    or function(startpath)
      return vim.fs.root(startpath, { ".git" })
    end
  root_dir = root_dir(dirname) or dirname

  if
    not vim.api.nvim_buf_get_option(0, "readonly") and vim.api.nvim_buf_get_option(0, "modified")
  then
    vim.cmd.write()
  end

  local cmd = runner(vim.fn.expand("%:p"), root_dir)
  if not cmd then
    return
  end
  wezterm.run(cmd, root_dir)
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
  pattern = { "cpp", "c" },
  group = general_group,
  callback = function()
    -- This fixes an issue with nvim-cmp -- see https://github.com/hrsh7th/nvim-cmp/issues/1035#issuecomment-1195456419
    vim.opt_local.cindent = false
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown" },
  group = general_group,
  callback = function()
    vim.opt_local.wrap = true
    vim.opt_local.conceallevel = 3
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

vim.api.nvim_create_autocmd("LspProgress", {
  group = lsp_group,
  command = "redrawstatus",
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
    vim.keymap.set({ "n", "i" }, "<C-k>", function()
      local cmp = require("cmp")
      if cmp.visible() then
        cmp.close()
      end
      vim.lsp.buf.signature_help()
    end, { buffer = args.buf, silent = true })
    vim.keymap.set(
      { "n", "v" },
      "<F3>",
      vim.lsp.buf.code_action,
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gi",
      set_clangd_opening_path(vim.lsp.buf.implementation),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gr",
      set_clangd_opening_path(vim.lsp.buf.references),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gd",
      set_clangd_opening_path(vim.lsp.buf.definition),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set("n", "<F2>", vim.lsp.buf.rename, { buffer = args.buf, silent = true })
    vim.keymap.set("n", "<leader>f", function()
      vim.lsp.buf.format({ async = true })
    end, { buffer = args.buf, silent = true })
    vim.keymap.set({ "i", "n" }, "<M-i>", function()
      return vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
    end, { buffer = args.buf, silent = true })
    local client = vim.lsp.get_client_by_id(args.data.client_id)
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

vim.api.nvim_create_autocmd("BufNewFile", {
  group = vim.api.nvim_create_augroup("templates", { clear = true }),
  desc = "Load template file",
  callback = function(args)
    local fname = vim.fn.fnamemodify(args.file, ":t")
    local ext = vim.fn.fnamemodify(args.file, ":e")
    for _, candidate in ipairs({ fname, ext }) do
      local templates_dir =
        vim.fs.joinpath(myconfigs_path, "neovim", ".config", "nvim", "templates")
      local tpl = vim.fs.joinpath(templates_dir, candidate .. ".tpl")
      local stpl = vim.fs.joinpath(templates_dir, candidate .. ".stpl")
      if vim.uv.fs_stat(tpl) then
        vim.cmd("0r " .. tpl)
        return
      elseif vim.uv.fs_stat(stpl) then
        local f = io.open(stpl, "r")
        if f then
          local content = f:read("*a")
          vim.snippet.expand(content)
          return
        end
      end
    end
  end,
})

vim.api.nvim_create_user_command("Rename", function(kwargs)
  local buf = vim.api.nvim_get_current_buf()
  local from = vim.api.nvim_buf_get_name(buf)
  local to = kwargs.args
  vim.fn.mkdir(vim.fs.dirname(to), "p")
  local changes = {
    files = {
      {
        oldUri = vim.uri_from_fname(from),
        newUri = vim.uri_from_fname(to),
      },
    },
  }

  local clients = (vim.lsp.get_clients or vim.lsp.get_active_clients)()
  for _, client in ipairs(clients) do
    if client.supports_method("workspace/willRenameFiles") then
      local resp = client.request_sync("workspace/willRenameFiles", changes, 1000, 0)
      if resp and resp.result ~= nil then
        vim.lsp.util.apply_workspace_edit(resp.result, client.offset_encoding)
      end
    end
  end

  if vim.fn.rename(from, to) == 0 then
    vim.cmd.edit(to)
    vim.api.nvim_buf_delete(buf, { force = true })
    vim.fn.delete(from)
  end

  for _, client in ipairs(clients) do
    if client.supports_method("workspace/didRenameFiles") then
      client.notify("workspace/didRenameFiles", changes)
    end
  end
end, { complete = "file", nargs = 1 })

vim.api.nvim_create_user_command("LspStop", function(kwargs)
  local name = kwargs.fargs[1]
  for _, client in ipairs(vim.lsp.get_clients({ name = name })) do
    client.stop()
  end
end, {
  nargs = 1,
  complete = function()
    return vim.tbl_map(function(c)
      return c.name
    end, vim.lsp.get_clients())
  end,
})
vim.api.nvim_create_user_command("LspRestart", function(kwargs)
  local name = kwargs.fargs[1]
  for _, client in ipairs(vim.lsp.get_clients({ name = name })) do
    local bufs = vim.lsp.get_buffers_by_client_id(client.id)
    client.stop()
    vim.wait(30000, function()
      return vim.lsp.get_client_by_id(client.id) == nil
    end)
    local client_id = vim.lsp.start_client(client.config)
    if client_id then
      for _, buf in ipairs(bufs) do
        vim.lsp.buf_attach_client(buf, client_id)
      end
    end
  end
end, {
  nargs = 1,
  complete = function()
    return vim.tbl_map(function(c)
      return c.name
    end, vim.lsp.get_clients())
  end,
})

local get_rust_lsp_client = function()
  local clients = vim.lsp.get_clients({ name = "rust-langserver" })
  if #clients == 0 then
    return
  end
  assert(#clients == 1, "Multiple rust-analyzer clients attached to this buffer")
  return clients[1]
end
vim.api.nvim_create_user_command("RustReloadWorkspace", function()
  local client = get_rust_lsp_client()
  vim.notify("Reloading Cargo Workspace")
  client.request("rust-analyzer/reloadWorkspace", nil, function(err)
    if err then
      vim.notify("Error reloading Cargo workspace: " .. vim.inspect(err), vim.log.levels.WARN)
    end
    vim.notify("Cargo workspace reloaded")
  end)
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
        checkOnSave = true,
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
    name = "jedi_language_server",
    filetypes = { "python" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "python-lsp", "bin", "jedi-language-server"),
      -- "-vv",
      -- "--log-file",
      -- "/tmp/logging.txt",
    },
    init_options = function(file)
      local options = {
        workspace = {
          extraPaths = {
            vim.env.HOME .. "/.cache/python-stubs",
          },
          environmentPath = "/usr/bin/python3",
        },
      }
      if vim.env.CONDA_PREFIX then
        options.workspace.environmentPath = vim.env.CONDA_PREFIX .. "/bin/python"
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
          options.workspace.environmentPath = venv[1]
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
          options.workspace.environmentPath = pixi[1] .. "/envs/default"
        end
      end
      return options
    end,
  },
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

        local root_dir = root_dirs[args.match] or function() end
        vim.lsp.start({
          name = server.name,
          cmd = server.cmd,
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

-- TODO: Add https://github.com/JafarAbdi/myconfigs/commit/97ba4ecb55b5972c5bc43ce020241fb353de433f
local snippets = {
  all = {
    {
      trigger = "Current date",
      description = "Insert the current date",
      body = function()
        return os.date("%Y-%m-%d %H:%M:%S%z")
      end,
    },
    {
      trigger = "Current month name",
      description = "Insert the name of the current month",
      body = function()
        return os.date("%B")
      end,
    },
    {
      trigger = "Current filename",
      description = "Insert the current file name",
      body = function()
        return vim.fn.expand("%:t")
      end,
    },
  },
  cpp = {
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
  },
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
snippets.c = snippets.cpp
snippets.cuda = snippets.cpp

local get_buffer_snippets = function(filetype)
  local ft_snippets = {}
  vim.list_extend(ft_snippets, snippets.all)
  if filetype and snippets[filetype] then
    vim.list_extend(ft_snippets, snippets[filetype])
  end
  return ft_snippets
end

require("lazy").setup({
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
  {
    "github/copilot.vim",
    lazy = false, -- Load at startup so VimEnter autocmd fires and copilot#Init() runs
    init = function()
      vim.g.copilot_node_command = myconfigs_path .. "/.pixi/envs/nodejs/bin/node"
      vim.g.copilot_no_tab_map = true
      vim.g.copilot_no_maps = true
      vim.g.copilot_assume_mapped = true
      vim.g.copilot_tab_fallback = ""
      vim.g.copilot_filetypes = {
        ["*"] = true,
        gitcommit = false,
      }
    end,
    config = function()
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
        -- Leave insert mode and cancel completion
        vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
        return vim.fn["copilot#Dismiss"]()
      end, { expr = true })
      vim.keymap.set("i", "<C-M-l>", function()
        return vim.fn["copilot#AcceptLine"]()
      end, { expr = true, silent = true })
      vim.keymap.set("i", "<C-M-e>", function()
        return vim.fn["copilot#AcceptWord"]()
      end, { expr = true, silent = true })
    end,
  },
  {
    "hrsh7th/nvim-cmp",
    event = { "InsertEnter" },
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
    },
    config = function()
      local cmp = require("cmp")
      local compare = require("cmp.config.compare")
      local cache = {}
      local cmp_source = {
        complete = function(_, params, callback)
          local bufnr = vim.api.nvim_get_current_buf()
          if not cache[bufnr] then
            local completion_items = vim.tbl_map(function(snippet)
              ---@type lsp.CompletionItem
              local item = {
                documentation = {
                  kind = cmp.lsp.MarkupKind.PlainText,
                  value = snippet.description or "",
                },
                word = snippet.trigger,
                label = snippet.trigger,
                kind = vim.lsp.protocol.CompletionItemKind.Snippet,
                insertText = type(snippet.body) == "function" and snippet.body() or snippet.body,
                insertTextFormat = vim.lsp.protocol.InsertTextFormat.Snippet,
              }
              return item
            end, get_buffer_snippets(params.context.filetype))
            cache[bufnr] = completion_items
          end

          callback(cache[bufnr])
        end,
      }

      cmp.register_source("snippets", cmp_source)
      cmp.setup({
        snippet = {
          expand = function(args)
            vim.snippet.expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["Tab"] = cmp.config.disable,
          ["S-Tab"] = cmp.config.disable,
          ["<C-f>"] = cmp.config.disable,
          ["<C-d>"] = cmp.mapping.scroll_docs(4),
          ["<C-u>"] = cmp.mapping.scroll_docs(-4),
          ["<CR>"] = cmp.mapping.confirm({
            behavior = cmp.ConfirmBehavior.Insert,
            select = false,
          }),
        }),
        sources = {
          { name = "nvim_lsp" },
          { name = "snippets" },
          {
            name = "buffer",
            option = {
              get_bufnrs = function()
                return vim.api.nvim_list_bufs()
              end,
            },
          },
        },
        formatting = {
          format = function(entry, vim_item)
            vim_item.menu = ({
              buffer = "[Buffer]",
              nvim_lsp = "[LSP]",
              snippets = "[Snippet]",
            })[entry.source.name]
            local label = vim_item.abbr
            -- https://github.com/hrsh7th/nvim-cmp/discussions/609
            local ELLIPSIS_CHAR = "…"
            local MAX_LABEL_WIDTH = math.floor(vim.o.columns * 0.4)
            local truncated_label = vim.fn.strcharpart(label, 0, MAX_LABEL_WIDTH)
            if truncated_label ~= label then
              vim_item.abbr = truncated_label .. ELLIPSIS_CHAR
            end
            return vim_item
          end,
        },
        sorting = {
          comparators = {
            compare.offset,
            compare.exact,
            -- compare.score,
            -- https://github.com/p00f/clangd_extensions.nvim/blob/main/lua/clangd_extensions/cmp_scores.lua
            function(entry1, entry2)
              local diff
              if entry1.completion_item.score and entry2.completion_item.score then
                diff = (entry2.completion_item.score * entry2.score)
                  - (entry1.completion_item.score * entry1.score)
              else
                diff = entry2.score - entry1.score
              end
              if diff < 0 then
                return true
              elseif diff > 0 then
                return false
              end
            end,
            -- https://github.com/lukas-reineke/cmp-under-comparator
            function(entry1, entry2)
              local _, entry1_under = entry1.completion_item.label:find("^_+")
              local _, entry2_under = entry2.completion_item.label:find("^_+")
              entry1_under = entry1_under or 0
              entry2_under = entry2_under or 0
              if entry1_under > entry2_under then
                return false
              elseif entry1_under < entry2_under then
                return true
              end
            end,
            compare.recently_used,
            compare.kind,
            compare.sort_text,
            compare.length,
            compare.order,
          },
        },
      })
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "master",
    build = ":TSUpdate",
    event = { "VeryLazy" },
    dependencies = {
      "nvim-treesitter/nvim-treesitter-textobjects",
    },
    opts = {
      ensure_installed = {
        "bash",
        "c",
        "c_sharp",
        "cmake",
        "cpp",
        "dockerfile",
        "fish",
        "html",
        "xml",
        "http",
        "javascript",
        "json",
        "lua",
        "comment",
        "make",
        "markdown",
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
        "yaml",
        "zig",
      },
      highlight = {
        enable = true,
        disable = function(lang, buf)
          return (lang == "html")
            -- Disable highlighting for files without a filetype
            or (vim.api.nvim_buf_get_option(buf, "filetype") == "")
        end,
      },
      incremental_selection = {
        enable = true,
        keymaps = {
          init_selection = "<A-w>",
          node_incremental = "<A-w>",
          scope_incremental = "<A-e>",
          node_decremental = "<A-S-w>",
        },
      },
      textobjects = {
        select = {
          enable = true,
          lookahead = true, -- Automatically jump forward to textobj, similar to targets.vim
          keymaps = {
            ["af"] = "@function.outer",
            ["if"] = "@function.inner",
            ["ac"] = "@class.outer",
            ["ic"] = "@class.inner",
            ["ap"] = "@parameter.outer",
            ["ip"] = "@parameter.inner",
            ["ao"] = "@conditional.outer",
            ["io"] = "@conditional.inner",
            ["al"] = "@loop.outer",
            ["il"] = "@loop.inner",
          },
        },
        swap = {
          enable = true,
          swap_next = {
            ["<leader>a"] = "@parameter.inner",
          },
          swap_previous = {
            ["<leader>A"] = "@parameter.inner",
          },
        },
        move = {
          enable = true,
          set_jumps = true, -- whether to set jumps in the jumplist
          goto_next_start = {
            ["]f"] = "@function.outer",
            ["]c"] = "@class.outer",
          },
          goto_next_end = {
            ["]F"] = "@function.outer",
            ["]C"] = "@class.outer",
          },
          goto_previous_start = {
            ["[f"] = "@function.outer",
            ["[c"] = "@class.outer",
          },
          goto_previous_end = {
            ["[F"] = "@function.outer",
            ["[C"] = "@class.outer",
          },
        },
      },
    },
    config = function(_, opts)
      require("nvim-treesitter.configs").setup(opts)
    end,
  },
}, {
  defaults = {
    lazy = true, -- every plugin is lazy-loaded by default
  },
  checker = { enabled = false }, -- automatically check for plugin updates
  performance = {
    rtp = {
      disabled_plugins = {
        "matchparen",
      },
    },
  },
  change_detection = {
    enabled = false,
    notify = false,
  },
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
    float = true,
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
vim.opt.statusline = [[%<%f %m%r%{luaeval("lsp_status()")}]]
vim.opt.smartindent = false
vim.opt.pumheight = 20
vim.opt.completeopt = "menuone,noselect,noinsert,fuzzy"
vim.opt.complete:append({ "U", "i", "d" })
vim.opt.wildmode = "longest:full,full"
vim.opt.wildignore:append({ "*.pyc", ".git", ".idea", "*.o" })
vim.opt.wildoptions = "pum,tagfile,fuzzy"
vim.opt.suffixes:append({ ".pyc", ".tmp" })
vim.opt.spell = true

if vim.fn.executable("rg") == 1 then
  vim.opt.grepprg = "rg --no-messages --vimgrep --no-heading --smart-case"
  vim.opt.grepformat = "%f:%l:%c:%m,%f:%l:%m"
end

vim.g.mapleader = " "
vim.g.maplocalleader = " "
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

vim.cmd.colorscheme("vim")
vim.cmd.colorscheme("onedark")
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

local function try_jump(direction, key)
  if vim.snippet.active({ direction = direction }) then
    return string.format("<cmd>lua vim.snippet.jump(%d)<cr>", direction)
  end
  return key
end

vim.keymap.set({ "i", "s" }, "<Tab>", function()
  return try_jump(1, "<Tab>")
end, { expr = true })
vim.keymap.set({ "i", "s" }, "<S-Tab>", function()
  return try_jump(-1, "<S-Tab>")
end, { expr = true })

vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set({ "i", "s" }, "<ESC>", function()
  if vim.snippet then
    vim.snippet.stop()
  end
  return "<ESC>"
end, { expr = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("n", "gs", function()
  vim.lsp.buf.document_symbol({
    on_list = function(options)
      vim.fn.setqflist({}, " ", options)
      q.quickfix()
    end,
  })
end, { silent = true })

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
      "rg --no-messages --no-heading --trim --line-number --smart-case " .. cword,
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

local center_screen = function(command)
  return function()
    local ok, _ = pcall(command)
    if ok then
      vim.cmd.normal("zz")
    end
  end
end

vim.keymap.set("n", "]q", center_screen(vim.cmd.cnext), { silent = true })
vim.keymap.set("n", "[q", center_screen(vim.cmd.cprevious), { silent = true })
vim.keymap.set("n", "]Q", center_screen(vim.cmd.clast), { silent = true })
vim.keymap.set("n", "[Q", center_screen(vim.cmd.cfirst), { silent = true })
vim.keymap.set("n", "]a", center_screen(vim.cmd.next), { silent = true })
vim.keymap.set("n", "[a", center_screen(vim.cmd.previous), { silent = true })
vim.keymap.set("n", "]A", center_screen(vim.cmd.last), { silent = true })
vim.keymap.set("n", "[A", center_screen(vim.cmd.first), { silent = true })
vim.keymap.set("n", "]l", center_screen(vim.cmd.lnext), { silent = true })
vim.keymap.set("n", "[l", center_screen(vim.cmd.lprevious), { silent = true })
vim.keymap.set("n", "]L", center_screen(vim.cmd.lfirst), { silent = true })
vim.keymap.set("n", "[L", center_screen(vim.cmd.llast), { silent = true })
vim.keymap.set("n", "]t", center_screen(vim.cmd.tn), { silent = true })
vim.keymap.set("n", "[t", center_screen(vim.cmd.tp), { silent = true })

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
      if vim.loop.fs_stat(vim.fs.normalize(mark[4])) then
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
