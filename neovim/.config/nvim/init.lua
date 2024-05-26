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

local new_window = function()
  -- Why I can't call this by indexing vim.cmd???
  vim.cmd("botright " .. math.floor(vim.opt.lines:get() / 4) .. " new")
end

local term = {
  jobid = nil,
  bufnr = nil,
  open_bufnr = nil,
}
term.close = function()
  if not term.jobid then
    return
  end
  vim.fn.jobstop(term.jobid)
  vim.fn.jobwait({ term.jobid })
end
term.create = function(cmd, args, opts)
  if term.open_bufnr and vim.api.nvim_buf_is_valid(term.open_bufnr) then
    vim.api.nvim_buf_delete(term.open_bufnr, { force = true, unload = false })
    term.open_bufnr = nil
  end
  opts = vim.tbl_extend("keep", opts or {}, {
    auto_close = true,
    focus_terminal = false,
  })
  args = args or {}
  new_window()
  term.bufnr = vim.api.nvim_win_get_buf(vim.fn.win_getid())
  vim.api.nvim_buf_set_option(0, "buftype", "nofile")
  vim.api.nvim_buf_set_option(0, "bufhidden", "wipe")
  vim.api.nvim_buf_set_option(0, "buflisted", false)
  vim.api.nvim_buf_set_option(0, "swapfile", false)
  local term_opts = {
    cwd = opts.cwd or vim.loop.cwd(),
    on_exit = function()
      term.jobid = nil
      if opts.auto_close then
        if vim.api.nvim_buf_is_valid(term.bufnr) then
          vim.api.nvim_buf_delete(term.bufnr, { force = true, unload = false })
        end
      else
        if term.open_bufnr then
          print(
            string.format(
              "open_bufnr: %s -- it should be nil you forgot to cleanup the previous terminal buffer",
              term.open_bufnr
            )
          )
        end
        term.open_bufnr = term.bufnr
      end
      term.bufnr = nil
    end,
  }
  if opts.env and not vim.tbl_isempty(opts.env) then
    term_opts.env = opts.env
  end
  term.jobid = vim.fn.termopen(cmd .. " " .. vim.fn.join(args, " "), term_opts)

  if opts.focus_terminal then
    vim.cmd.startinsert({ bang = true })
  else
    vim.cmd.wincmd("p")
  end
end
term.run = function(cmd, args, opts)
  term.close()
  term.create(cmd, args, opts)
end

-- Copied from https://github.com/mfussenegger/dotfiles/
local gh_ns = vim.api.nvim_create_namespace("gh")

local gh = {
  comments = function()
    local branch = vim.trim(vim.fn.system("git branch --show current"))
    local pr_list = vim.fn.system('gh pr list --head "' .. branch .. '" --json number')
    local prs = assert(vim.json.decode(pr_list), "gh pr list must have a result that decodes")
    if vim.tbl_isempty(prs) then
      print("No PR found for branch " .. branch)
      return
    end
    local comments_cmd = 'gh api "repos/{owner}/{repo}/pulls/'
      .. prs[1].number
      .. '/comments" --cache 30m'
    local comments = vim.json.decode(vim.fn.system(comments_cmd), { luanil = { object = true } })
    assert(comments, "gh api ... should have json list result")
    local buf_diagnostic = vim.defaulttable()
    for _, comment in pairs(comments) do
      if comment.line then
        local path = comment.path
        local bufnr = vim.fn.bufadd(path)
        table.insert(buf_diagnostic[bufnr], {
          bufnr = bufnr,
          lnum = comment.line - 1,
          col = 0,
          message = comment.body,
          severity = vim.diagnostic.severity.WARN,
        })
      end
    end
    local qflist = {}
    for bufnr, diagnostic in pairs(buf_diagnostic) do
      local list = vim.diagnostic.toqflist(diagnostic)
      vim.list_extend(qflist, list)
      vim.diagnostic.set(gh_ns, bufnr, diagnostic)
    end
    vim.fn.setqflist(qflist, "r")
    vim.cmd.copen()
  end,
  clear = function()
    vim.diagnostic.reset(gh_ns)
  end,
}

local program = function()
  return vim.fn.input({
    prompt = "Path to executable: ",
    default = vim.fn.getcwd() .. "/",
    completion = "file",
  })
end

local launch_lldb_in_terminal = {
  name = "lldb: Launch (integratedTerminal)",
  type = "lldb",
  request = "launch",
  program = program,
  cwd = "${workspaceFolder}",
  stopOnEntry = false,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " ")
  end,
  runInTerminal = true,
}

local launch_python_in_terminal = {
  type = "python",
  request = "launch",
  name = "Launch file with arguments",
  program = program,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " +")
  end,
}

local enrich_config = function(config, on_config)
  -- TODO: Handle when the virtual environment is not activated and .vscode/settings.json exists
  local venv_path = os.getenv("CONDA_PREFIX")
  if venv_path then
    config.pythonPath = venv_path .. "/bin/python"
  end
  config.console = "integratedTerminal"
  on_config(config)
end

local root_dirs = {
  python = function(startpath)
    return vim.fs.root(startpath, {
      ".vscode",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "package.xml",
      "pixi.toml",
    })
  end,
  cmake = function(startpath)
    return vim.fs.root(startpath, { ".vscode", "package.xml", ".git" })
  end,
  cpp = function(startpath)
    local search_fn = function(path)
      return vim.fs.root(path, { ".clangd" })
    end
    local fallback_search_fn = function(path)
      return vim.fs.root(path, {
        ".vscode",
        ".clang-tidy",
        ".clang-format",
        "compile_commands.json",
        "compile_flags.txt",
        "configure.ac",
        ".git",
      })
    end
    -- If root directory not found set it to file's directory
    local search = function(path)
      return vim.F.if_nil(search_fn(path), search_fn(vim.fn.expand("%:p:h")))
        or fallback_search_fn(path)
    end
    local dir = search(startpath) or search(clangd_opening_root_dir) or vim.fn.getcwd()
    clangd_opening_root_dir = nil
    return dir
  end,
  rust = function(startpath)
    local search_fn = function(path)
      return vim.fs.root(path, { "Cargo.toml", "rust-project.json", ".vscode", ".git" })
    end
    local dir = vim.F.if_nil(search_fn(startpath), search_fn(vim.fn.expand("%:p:h")))
      or vim.fn.getcwd()
    return dir
  end,
}
root_dirs.c = root_dirs.cpp

_G.lsp_status = function()
  local lsp_status = vim.lsp.status()
  if lsp_status == "" then
    return ""
  end
  return " | " .. lsp_status
end

_G.dap_status = function()
  if require("lazy.core.config").plugins["nvim-dap"]._.loaded == nil then
    return ""
  end
  local ok, dap = pcall(require, "dap")
  if not ok then
    return ""
  end
  local status = dap.status()
  if status ~= "" then
    return " | " .. status
  end
  return ""
end

local run_file = function(is_test)
  local filetype = vim.api.nvim_get_option_value("filetype", {})
  if not filetype or filetype == "" then
    return
  end

  local dirname = vim.fn.expand("%:p:h")
  local root_dir = root_dirs[filetype]
  if root_dir then
    root_dir = root_dir(dirname) or dirname
  else
    root_dir = dirname
    for dir in vim.fs.parents(vim.api.nvim_buf_get_name(0)) do
      if vim.env.HOME == dir then
        break
      end
      if vim.fn.isdirectory(dir .. "/.vscode") == 1 then
        root_dir = dir
        break
      end
    end
  end

  if
    not vim.api.nvim_buf_get_option(0, "readonly") and vim.api.nvim_buf_get_option(0, "modified")
  then
    vim.cmd.write()
  end
  local args = {
    "--workspace-folder",
    root_dir,
    "--filetype",
    filetype,
    "--file-path",
    vim.fn.expand("%:p"),
  }
  local cmd = "build_project.py"
  if filetype ~= "python" then
    cmd = "pixi"
    for _, v in
      ipairs(vim.fn.reverse({
        "run",
        "--manifest-path",
        "~/myconfigs/pixi.toml",
        "--frozen",
        "python3",
        "~/.local/bin/build_project.py",
      }))
    do
      table.insert(args, 1, v)
    end
  end
  if is_test then
    table.insert(args, "--test")
  end
  term.run(cmd, args, { cwd = root_dir, auto_close = false })
end

----------------
--- Commands ---
----------------

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})
local lsp_group = vim.api.nvim_create_augroup("lsp", {})

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = "dap-repl",
  callback = function()
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.colorcolumn = "-1"
    vim.opt_local.cursorcolumn = false
    require("dap.ext.autocompl").attach()
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
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })
vim.api.nvim_create_autocmd("LspDetach", {
  group = lsp_group,
  callback = function(args)
    vim.lsp.completion.enable(false, args.data.client_id, args.buf)
  end,
  group = lsp_group,
})
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    vim.lsp.completion.enable(true, args.data.client_id, args.buf, { autotrigger = true })
    vim.keymap.set("i", "<c-space>", function()
      vim.lsp.completion.trigger()
    end, { buffer = args.buf })
    vim.keymap.set({ "n", "i" }, "<C-k>", function()
      if tonumber(vim.fn.pumvisible()) == 1 then
        vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<c-y>", true, false, true), "n", true)
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
      return vim.lsp.inlay_hint.enable(0, not vim.lsp.inlay_hint.is_enabled())
    end, { buffer = args.buf, silent = true })
  end,
  group = lsp_group,
})

vim.api.nvim_create_user_command("DapAttach", function()
  -- output format for ps ah
  --    " 107021 pts/4    Ss     0:00 /bin/zsh <args>"
  require("fzy").execute("ps ah", function(selection)
    require("dap").run({
      -- If you get an "Operation not permitted" error using this, try disabling YAMA:
      --  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
      name = "lldb: Attach to process",
      type = "lldb",
      request = "attach",
      pid = tonumber(vim.fn.split(vim.fn.trim(selection), " \\+")[1]),
      args = {},
    })
  end)
end, {})

vim.api.nvim_create_user_command("DapLaunchLLDB", function()
  require("dap").run(launch_lldb_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPython", function()
  require("dap").run(launch_python_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPytest", function()
  require("dap").run({
    name = "Pytest: " .. vim.fn.expand("%:p"),
    type = "python",
    request = "launch",
    justMyCode = false,
    module = "pytest",
    args = { "-s", vim.fn.expand("%:p") },
  })
end, {})

vim.api.nvim_create_user_command("Gh", function(opts)
  if opts.args == "comments" then
    gh.comments()
  elseif opts.args == "clear" then
    gh.clear()
  end
end, {
  nargs = 1,
  complete = function()
    return { "comments", "clear" }
  end,
})
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

-----------------
--- LSP Setup ---
-----------------

local servers = {
  {
    name = "clangd",
    filetypes = { "c", "cpp" },
    cmd = {
      vim.env.HOME .. "/.config/clangd-lsp/bin/clangd",
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
    },
    cmd = { "efm-langserver" },
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
        python = {
          {
            lintCommand = "pixi run --manifest-path ~/myconfigs/pixi.toml --frozen --environment linters mypy --show-column-numbers --install-types --non-interactive --hide-error-codes --hide-error-context --no-color-output --no-error-summary --no-pretty",
            lintFormats = {
              "%f:%l:%c: error: %m",
              "%f:%l:%c: %tarning: %m",
              "%f:%l:%c: %tote: %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
          },
          {
            formatCommand = "pixi run --manifest-path ~/myconfigs/pixi.toml --frozen --environment linters black --quiet -",
            formatStdin = true,
          },
          {
            lintCommand = "pixi run --manifest-path ~/myconfigs/pixi.toml --frozen --environment linters ruff --quiet ${INPUT}",
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
        xml = {
          {
            formatCommand = "xmllint --format -",
            formatStdin = true,
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
  {
    name = "jedi_language_server",
    filetypes = { "python" },
    cmd = {
      vim.env.HOME .. "/.local/bin/pixi",
      "run",
      "--manifest-path",
      vim.env.HOME .. "/myconfigs/pixi.toml",
      "--frozen",
      "--environment",
      "python-lsp",
      "jedi-language-server",
    }, -- "-vv", "--log-file", "/tmp/logging.txt"
    init_options = function(file)
      local options = {
        workspace = {
          extraPaths = { vim.env.HOME .. "/.cache/python-stubs" },
          environmentPath = "/usr/bin/python3",
        },
      }
      if vim.env.CONDA_PREFIX then
        options.workspace.environmentPath = vim.env.CONDA_PREFIX .. "/bin/python"
      end
      local pixi = vim.fs.find(".pixi", {
        upward = true,
        stop = vim.uv.os_homedir(),
        path = file,
        type = "directory",
      })
      if #pixi > 0 then
        if vim.fn.isdirectory(vim.fs.joinpath(pixi[1], "envs", "default")) == 1 then
          options.workspace.environmentPath = pixi[1] .. "/envs/default/bin/python"
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
}
local capabilities = vim.tbl_deep_extend("force", vim.lsp.protocol.make_client_capabilities(), {
  -- TODO: This's causing issues with clangd
  -- https://github.com/neovim/neovim/pull/27339#discussion_r1615314435
  -- textDocument = {
  --   completion = {
  --     editsNearCursor = true,
  --   },
  -- },
  offsetEncoding = { "utf-16" },
})

for _, server in pairs(servers) do
  vim.api.nvim_create_autocmd("FileType", {
    pattern = server.filetypes,
    group = lsp_group,
    callback = function(args)
      local root_dir = root_dirs[args.match]
        or function(startpath)
          return vim.fs.root(startpath, { ".git" })
        end
      vim.lsp.start({
        name = server.name,
        cmd = server.cmd,
        on_attach = function(_, _) end,
        capabilities = capabilities,
        settings = server.settings or vim.empty_dict(),
        init_options = server.init_options and server.init_options(args.file) or vim.empty_dict(),
        root_dir = vim.fs.joinpath(vim.uv.cwd(), root_dir(args.file)),
      })
    end,
  })
end

require("lazy").setup({
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
  { "Exafunction/codeium.vim", event = "VeryLazy" },
  {
    "mfussenegger/nvim-dap",
    event = "VeryLazy",
    config = function()
      local dap = require("dap")
      local widgets = require("dap.ui.widgets")
      vim.keymap.set("n", "<F5>", dap.continue, { silent = true })
      vim.keymap.set("n", "<leader>b", dap.toggle_breakpoint, { silent = true })
      vim.keymap.set("n", "<leader>db", function()
        dap.toggle_breakpoint(vim.fn.input({ prompt = "Breakpoint Condition: " }), nil, nil, true)
      end, { silent = true })
      vim.keymap.set("n", "<leader>dl", function()
        dap.list_breakpoints(true)
      end, { silent = true })
      vim.keymap.set("n", "<leader>dr", function()
        dap.repl.toggle({ height = 15 })
      end, { silent = true })
      vim.keymap.set({ "n", "v" }, "<leader>dh", widgets.hover, { silent = true })
      vim.keymap.set({ "n", "v" }, "<leader>dp", widgets.preview, { silent = true })
      -- dap.defaults.fallback.exception_breakpoints = { "userUnhandled" }
      dap.defaults.fallback.switchbuf = "usetab,uselast"
      dap.defaults.fallback.terminal_win_cmd = "tabnew"
      dap.defaults.fallback.external_terminal = {
        command = "wezterm",
        args = { "--skip-config" },
      }

      ------------------------
      -- CPP/C/Rust configs --
      ------------------------
      -- Fixes issues with lldb-vscode
      -- When it starts it doesn't report any threads
      dap.listeners.after.event_initialized["lldb-vscode"] = function(session)
        session:update_threads()
      end
      -- After pausing the threads could be wrong
      dap.listeners.after.pause["lldb-vscode"] = function(session)
        session:update_threads()
      end
      -- When we continue it report the allThreadsContinued in a very weird way
      dap.listeners.after.continue["lldb-vscode"] = function(session, _, response)
        if response.allThreadsContinued then
          for _, t in pairs(session.threads) do
            t.stopped = false
          end
        else
          local thread = session.threads[response.threadId]
          if thread and thread.stopped then
            thread.stopped = false
          end
        end
      end
      local lldb_executable_name = "/usr/bin/lldb-vscode"
      local lldb_executables = vim.split(vim.fn.glob(lldb_executable_name .. "*"), "\n")
      if vim.fn.empty(lldb_executables) == 1 then
        vim.api.nvim_notify(
          "No lldb-vscode executable found -- make sure to install it using 'sudo apt install lldb'",
          vim.log.levels.ERROR,
          {}
        )
      end
      local lldb_version = lldb_executables[#lldb_executables]:match("lldb%-vscode%-(%d+)")
      if lldb_version then
        if tonumber(lldb_version) < 11 then
          vim.api.nvim_notify(
            "lldb-vscode version '" .. lldb_version .. "' doesn't support integratedTerminal",
            vim.log.levels.DEBUG,
            {}
          )
        end
      end
      dap.adapters.lldb = {
        id = "lldb",
        type = "executable",
        command = lldb_executables[#lldb_executables],
      }
      local configs = {
        -- M.launch_console,
        launch_lldb_in_terminal,
      }
      dap.configurations.c = configs
      dap.configurations.cpp = configs
      dap.configurations.rust = configs

      ----------------------
      --- Python configs ---
      ----------------------
      dap.adapters.python = function(cb, config)
        if config.request == "attach" then
          local port = (config.connect or config).port
          local host = (config.connect or config).host or "127.0.0.1"
          cb({
            type = "server",
            port = assert(port, "`connect.port` is required for a python `attach` configuration"),
            host = host,
            enrich_config = enrich_config,
            options = {
              source_filetype = "python",
            },
          })
        else
          cb({
            type = "executable",
            command = vim.env.HOME .. "/myconfigs/.pixi/envs/default/bin/python",
            args = { "-m", "debugpy.adapter" },
            enrich_config = enrich_config,
            options = {
              source_filetype = "python",
            },
          })
        end
      end

      dap.configurations.python = {
        {
          type = "python",
          request = "launch",
          name = "Launch file",
          program = "${file}",
        },
        launch_python_in_terminal,
        {
          type = "python",
          request = "attach",
          name = "Attach remote",
          connect = function()
            local host = vim.fn.input("Host [127.0.0.1]: ")
            host = host ~= "" and host or "127.0.0.1"
            local port = tonumber(vim.fn.input("Port [5678]: ")) or 5678
            return { host = host, port = port }
          end,
        },
        {
          type = "python",
          request = "launch",
          name = "Run doctests in file",
          module = "doctest",
          args = { "${file}" },
          noDebug = true,
        },
      }

      ----------------------
      ------- CMake --------
      ----------------------
      dap.adapters.cmake = {
        type = "pipe",
        pipe = "${pipe}",
        executable = {
          command = "cmake",
          args = { "--debugger", "--debugger-pipe", "${pipe}" },
        },
      }
      dap.configurations.cmake = {
        {
          name = "Build",
          type = "cmake",
          request = "launch",
        },
      }
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
  virtual_text = { severity = vim.diagnostic.severity.ERROR },
  severity_sort = true,
  signs = false,
})
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
vim.opt.titlestring = "NVIM: %{substitute(getcwd(), $HOME, '~', '')}%a%r%m "
vim.opt.shortmess:append("wIA")
vim.opt.matchtime = 2
vim.opt.matchpairs:append("<:>")
vim.opt.swapfile = false
vim.opt.signcolumn = "number"
vim.opt.laststatus = 3
vim.opt.statusline = [[%<%f %m%r%{luaeval("lsp_status()")} %= %{luaeval("dap_status()")}]]
vim.opt.smartindent = false
vim.opt.pumheight = 20
vim.opt.completeopt = "menuone,noselect,noinsert"
vim.opt.complete:append({ "U", "i", "d" })
vim.opt.wildmode = "longest:full,full"
vim.opt.wildignore:append({ "*.pyc", ".git", ".idea", "*.o" })
vim.opt.wildoptions = "pum,tagfile,fuzzy"
vim.opt.suffixes:append({ ".pyc", ".tmp" })

if vim.fn.executable("rg") == 1 then
  vim.opt.grepprg = "rg --no-messages --vimgrep --no-heading --smart-case"
  vim.opt.grepformat = "%f:%l:%c:%m,%f:%l:%m"
end

vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.g.codeium_disable_bindings = 1
vim.g.codeium_filetypes = {
  gitcommit = false,
  ["dap-repl"] = false,
}

vim.filetype.add({
  extension = {
    launch = "xml",
    test = "xml",
    urdf = "xml",
    xacro = "xml",
    install = "text",
    repos = "yaml",
  },
})

vim.cmd.colorscheme("retrobox")
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

vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set({ "i", "s" }, "<ESC>", function()
  if vim.snippet then
    vim.snippet.stop()
  end
  return "<ESC>"
end, { expr = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("i", "<M-e>", function()
  return vim.api.nvim_feedkeys(vim.fn["codeium#Accept"](), "n", true)
end, { expr = true })
vim.keymap.set("i", "<c-;>", function()
  return vim.fn["codeium#CycleCompletions"](1)
end, { expr = true })
vim.keymap.set("i", "<c-,>", function()
  return vim.fn["codeium#CycleCompletions"](-1)
end, { expr = true })
vim.keymap.set("i", "<c-c>", function()
  -- Leave insert mode and cancel completion
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
  return vim.fn["codeium#Clear"]()
end, { expr = true })

vim.keymap.set("n", "gs", function()
  q.try(q.lsp_tags, q.buf_tags)
end, { silent = true })

vim.keymap.set("n", "<leader>t", function()
  run_file(true)
end, { silent = true })
vim.keymap.set("n", "<leader>x", function()
  run_file(false)
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
      api.nvim_command("cclose")
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
  api.nvim_command("botright copen")
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
