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

local term = {
  jobid = nil,
  bufnr = nil,
  open_bufnr = nil,
}
term.close = function()
  if term.open_bufnr and vim.api.nvim_buf_is_valid(term.open_bufnr) then
    vim.api.nvim_buf_delete(term.open_bufnr, { force = true, unload = false })
    term.open_bufnr = nil
  end
  if not term.jobid then
    return
  end
  vim.fn.jobstop(term.jobid)
  vim.fn.jobwait({ term.jobid })
end
term.create = function(cmd, args, opts)
  opts = vim.tbl_extend("keep", opts or {}, {
    auto_close = true,
    focus_terminal = false,
  })
  args = args or {}
  vim.cmd.new({ mods = { split = "botright" }, range = { math.floor(vim.opt.lines:get() / 4) } })
  term.bufnr = vim.api.nvim_win_get_buf(vim.fn.win_getid())
  vim.api.nvim_buf_set_option(0, "buftype", "nofile")
  vim.api.nvim_buf_set_option(0, "bufhidden", "wipe")
  vim.api.nvim_buf_set_option(0, "buflisted", false)
  vim.api.nvim_buf_set_option(0, "swapfile", false)
  vim.api.nvim_buf_set_option(0, "spell", false)
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
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pixi.toml",
      ".pixi",
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
    local search_fn = function(path)
      return vim.fs.root(path, { "Cargo.toml", "rust-project.json", ".vscode" })
    end
    local dir = vim.F.if_nil(search_fn(startpath), search_fn(vim.fn.expand("%:p:h")))
      or vim.fn.getcwd()
    return dir
  end,
  zig = function(startpath)
    return vim.fs.root(startpath, { "build.zig" })
  end,
}
root_dirs.c = root_dirs.cpp
root_dirs.cuda = root_dirs.cpp

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

local runners = {
  python = function(file_path, root_dir, is_test)
    local python_executable = "python3"
    if vim.uv.fs_stat(vim.fs.joinpath(root_dir, ".pixi")) ~= nil then
      python_executable = vim.fs.joinpath(root_dir, ".pixi", "envs", "default", "bin", "python")
    end
    if is_test then
      if not file_path:match("^test_") and not file_path:match("_test%.py$") then
        vim.notify(
          string.format(
            "Test file '%s' doesn't start/end with 'test_'/'_test' and will be ignored by pytest",
            file_path
          ),
          vim.log.levels.WARN
        )
      end
      return {
        python_executable,
        "-m",
        "pytest",
        "--capture=no",
        file_path,
      }
    end
    return {
      python_executable,
      file_path,
    }
  end,
  bash = function(file_path, _, _)
    return {
      "bash",
      file_path,
    }
  end,
  fish = function(file_path, _, _)
    return {
      "fish",
      file_path,
    }
  end,
  xml = function(_, _, _)
    return {
      "curl",
      "-X",
      "POST",
      "http://127.0.0.1:7777/set_reload_request",
    }
  end,
  lua = function(file_path, _, _)
    return { "nvim", "-l", file_path }
  end,
  rust = function(file_path, root_dir, is_test)
    if not vim.uv.fs_stat(vim.fs.joinpath(root_dir, "Cargo.toml")) then
      vim.notify(root_dir .. " is not a Cargo project", vim.log.levels.WARN)
    end
    local cmd_output = vim
      .system({ "cargo", "metadata", "--format-version=1" }, { cwd = root_dir, text = true })
      :wait()
    if cmd_output.code ~= 0 then
      vim.notify("Failed with code " .. cmd_output.code, vim.log.levels.WARN)
      return
    end

    local metadata = vim.json.decode(cmd_output.stdout)

    for _, package in ipairs(metadata.packages) do
      for _, target in ipairs(package.targets) do
        if target.kind[1] == "lib" and is_test then
          return { "cargo", "test", "--lib" }
        end
        if file_path == target.src_path then
          if target.kind[1] == "bin" then
            return { "cargo", "run", "--bin", target.name }
          elseif target.kind[1] == "example" then
            return { "cargo", "run", "--example", target.name }
          else
            vim.notify("Unsupported target kind " .. vim.inspect(target.kind), vim.log.levels.WARN)
            return
          end
        end
      end
    end
    vim.notify("Can't find a target for " .. file_path, vim.log.levels.WARN)
  end,
  c = function(file_path, root_dir, _)
    local vscode_root_dir = vim.fs.root(file_path, { ".vscode" })
    local cmake_settings_filename = vim.fs.joinpath(vscode_root_dir, ".vscode", "settings.json")
    if vim.uv.fs_stat(cmake_settings_filename) then
      local settings = vim.fn.json_decode(vim.fn.readfile(cmake_settings_filename))
      local build_directory = settings["cmake.buildDirectory"]
      local reply_directory = vim.fs.joinpath(build_directory, ".cmake", "api", "v1", "reply")
      local indices = vim.fs.find(function(name, _)
        return name:match("^index%-.*%.json$")
      end, { path = reply_directory, limit = math.huge })
      if #indices == 0 then
        vim.notify("No index files found in " .. reply_directory, vim.log.levels.WARN)
        return
      end
      assert(#indices == 1, "Expected exactly one index file")
      local index = vim.fn.json_decode(vim.fn.readfile(indices[1]))
      local response = index["reply"]["codemodel-v2"]
      local codemodel =
        vim.fn.json_decode(vim.fn.readfile(vim.fs.joinpath(reply_directory, response["jsonFile"])))
      local targets = {}
      for _, target_config in ipairs(codemodel["configurations"][1]["targets"]) do
        local target = vim.fn.json_decode(
          vim.fn.readfile(vim.fs.joinpath(reply_directory, target_config["jsonFile"]))
        )
        if target["type"] == "EXECUTABLE" then
          targets[vim.fs.joinpath(vscode_root_dir, target["sources"][1]["path"])] = {
            name = target["name"],
            path = vim.fs.joinpath(build_directory, target["artifacts"][1]["path"]),
          }
        end
      end
      return {
        "cmake",
        "--build",
        build_directory,
        "--target",
        targets[file_path].name,
        "&&",
        targets[file_path].path,
      }
    end
    local output = vim.fn.tempname()

    local cmd = { "clang++", file_path, "-o", output }

    if vim.fn.has("linux") == 1 and vim.fn.executable("mold") == 1 then
      table.insert(cmd, "-fuse-ld=mold")
    end

    -- Add compile flags from compile_flags.txt
    local compile_flags_path = vim.fs.joinpath(root_dir, "compile_flags.txt")
    if vim.uv.fs_stat(compile_flags_path) then
      vim.list_extend(cmd, vim.fn.readfile(compile_flags_path))
    end

    if vim.uv.fs_stat(vim.fs.joinpath(root_dir, ".pixi")) then
      local default_env_path = vim.fs.joinpath(root_dir, ".pixi", "envs", "default")
      vim.list_extend(cmd, {
        "-isystem",
        vim.fs.joinpath(default_env_path, "include"),
        "-L" .. vim.fs.joinpath(default_env_path, "lib"),
        "-Wl,-rpath," .. vim.fs.joinpath(default_env_path, "lib"),
      })
      local libraries = vim.tbl_map(
        function(lib)
          -- Extract the library name from the normalized path
          return "-l" .. lib:match(".*/lib(.*)%.so$")
        end,
        -- Get all shared libraries in the default environment
        vim.fs.find(function(name, _)
          return name:match(".*%.so$")
        end, { path = vim.fs.joinpath(default_env_path, "lib"), limit = math.huge })
      )
      vim.list_extend(cmd, libraries)
    end
    table.insert(cmd, "&&")
    table.insert(cmd, output)

    return cmd
  end,
  zig = function(file_path, _, is_test)
    if is_test then
      return { "zig", "test", file_path }
    end
    return { "zig", "run", file_path }
  end,
}

runners.sh = runners.bash
runners.cpp = runners.c

local run_file = function(is_test)
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

  local cmd = runner(vim.fn.expand("%:p"), root_dir, is_test)
  if not cmd then
    return
  end
  term.run(cmd[1], vim.list_slice(cmd, 2), { cwd = root_dir, auto_close = false })
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
  pattern = "dap-repl",
  callback = function()
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.colorcolumn = "-1"
    vim.opt_local.cursorcolumn = false
    vim.opt_local.winfixbuf = true
    require("dap.ext.autocompl").attach()
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
  end,
  group = lsp_group,
})

vim.api.nvim_create_autocmd("BufNewFile", {
  group = vim.api.nvim_create_augroup("templates", { clear = true }),
  desc = "Load template file",
  callback = function(args)
    local home = os.getenv("HOME")
    local fname = vim.fn.fnamemodify(args.file, ":t")
    local ext = vim.fn.fnamemodify(args.file, ":e")
    for _, candidate in ipairs({ fname, ext }) do
      local templates_dir =
        vim.fs.joinpath(home, "myconfigs", "neovim", ".config", "nvim", "templates")
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

vim.api.nvim_create_user_command("Errors", function()
  vim.diagnostic.setqflist({
    title = "Errors",
    severity = vim.diagnostic.severity.ERROR,
  })
end, {})

vim.api.nvim_create_user_command("Warnings", function()
  vim.diagnostic.setqflist({
    title = "Warnings",
    severity = vim.diagnostic.severity.WARN,
  })
end, {})
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
    name = "taplo",
    filetypes = { "toml" },
    cmd = {
      "taplo",
      "lsp",
      "stdio",
    },
  },
  {
    name = "clangd",
    filetypes = { "c", "cpp", "cuda" },
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
      "zig",
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
        zig = {
          {
            formatCommand = "zig fmt --stdin",
            formatStdin = true,
          },
        },
        python = {
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              vim.env.HOME,
              "myconfigs",
              ".pixi",
              "envs",
              "linters",
              "bin",
              "mypy"
            )
              .. " --show-column-numbers --install-types --non-interactive --hide-error-codes --hide-error-context --no-color-output --no-error-summary --no-pretty",
            lintFormats = {
              "%f:%l:%c: error: %m",
              "%f:%l:%c: %tarning: %m",
              "%f:%l:%c: %tote: %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
          },
          {
            formatCommand = vim.fs.joinpath(
              vim.env.HOME,
              "myconfigs",
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
              vim.env.HOME,
              "myconfigs",
              ".pixi",
              "envs",
              "linters",
              "bin",
              "ruff"
            ) .. " check --quiet ${INPUT}",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c: %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
          },
        },
        cmake = {
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              vim.env.HOME,
              "myconfigs",
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
              vim.env.HOME,
              "myconfigs",
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
            lintCommand = vim.fs.joinpath(
              vim.env.HOME,
              "myconfigs",
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
    name = "zls",
    filetypes = { "zig" },
    cmd = { "zls" },
  },
  {
    name = "cmake_language_server",
    filetypes = { "cmake" },
    cmd = {
      vim.fs.joinpath(
        vim.env.HOME,
        "myconfigs",
        ".pixi",
        "envs",
        "cmake-lsp",
        "bin",
        "cmake-language-server"
      ),
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
  {
    name = "jedi_language_server",
    filetypes = { "python" },
    cmd = {
      vim.fs.joinpath(
        vim.env.HOME,
        "myconfigs",
        ".pixi",
        "envs",
        "python-lsp",
        "bin",
        "jedi-language-server"
      ),
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
        path = vim.uv.fs_realpath(file),
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
    event = "VeryLazy",
    config = function()
      vim.g.copilot_node_command = vim.env.HOME .. "/myconfigs/.pixi/envs/nodejs/bin/node"
      vim.g.copilot_no_tab_map = true
      vim.g.copilot_no_maps = true
      vim.g.copilot_assume_mapped = true
      vim.g.copilot_tab_fallback = ""
      vim.g.copilot_filetypes = {
        ["*"] = true,
        gitcommit = false,
        ["dap-repl"] = false,
      }

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
      vim.keymap.set("i", "<C-M-l>", "<Plug>(copilot-accept-line)", { silent = true })
      vim.keymap.set("i", "<C-M-e>", "<Plug>(copilot-accept-word)", { silent = true })
    end,
  },
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
vim.opt.statusline = [[%<%f %m%r%{luaeval("lsp_status()")} %= %{luaeval("dap_status()")}]]
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

vim.filetype.add({
  extension = {
    launch = "xml",
    test = "xml",
    urdf = "xml",
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
  term.close()
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
