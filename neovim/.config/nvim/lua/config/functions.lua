local M = {}

M.root_dirs = {
  csharp = function(startpath)
    return require("lspconfig.util").root_pattern("*.sln", "*.csproj", ".git")(startpath)
  end,
  python = function(startpath)
    return require("lspconfig.util").root_pattern(
      ".vscode",
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "package.xml"
    )(startpath)
  end,
  cmake = function(startpath)
    return require("lspconfig.util").root_pattern(".vscode", "package.xml", ".git")(startpath)
  end,
  cpp = function(startpath)
    local util = require("lspconfig.util")
    local search_fn = util.root_pattern(".clangd")
    local fallback_search_fn = util.root_pattern(
      ".vscode",
      ".clang-tidy",
      ".clang-format",
      "compile_commands.json",
      "compile_flags.txt",
      "configure.ac",
      ".git"
    )
    -- If root directory not found set it to file's directory
    local search = function(path)
      return vim.F.if_nil(search_fn(path), search_fn(vim.fn.expand("%:p:h")))
        or fallback_search_fn(path)
    end
    local dir = search(startpath)
      or search(require("config.keymaps").clangd_opening_root_dir)
      or vim.fn.getcwd()
    require("config.keymaps").clangd_opening_root_dir = nil
    return dir
  end,
  rust = function(startpath)
    local search_fn =
      require("lspconfig.util").root_pattern("Cargo.toml", "rust-project.json", ".vscode", ".git")
    local dir = vim.F.if_nil(search_fn(startpath), search_fn(vim.fn.expand("%:p:h")))
      or vim.fn.getcwd()
    return dir
  end,
}
M.root_dirs.c = M.root_dirs.cpp

M.generate_all_python_stubs = function()
  local Job = require("plenary.job")
  local job = Job
    :new({
      command = "python3",
      args = {
        "-c",
        [[
import os
import pkg_resources
for pkg in pkg_resources.working_set:
    if pkg.location.startswith(os.environ["HOME"] + "/workspaces") or pkg.location.startswith("/opt"):
        print(pkg.project_name.replace("-", "_"))
    ]],
      },
    })
    :after(function(job, code)
      if code == 0 then
        vim.schedule(function()
          if #job:result() == 0 then
            vim.notify("No package found")
            return
          end
          M.generate_python_stubs(job:result())
        end)
      else
        vim.notify(
          "Failed to list python packages: " .. vim.fn.join(job:stderr_result(), "\n"),
          vim.log.levels.ERROR
        )
      end
    end)
  job:start()
end

M.generate_python_stubs = function(missing_packages)
  if not vim.fn.executable("stubgen") then
    vim.notify("stubgen executable doesn't exists", vim.log.levels.WARN)
    return
  end

  local Path = require("plenary.path")
  local stubs_dir = Path.new(vim.env.HOME, ".cache", "python-stubs", "stubs")

  if #missing_packages == 0 then
    if vim.opt.filetype:get() ~= "python" then
      vim.notify("generate_python_stubs only works with python", vim.log.levels.ERROR)
      return
    end

    local diagnostics = vim.diagnostic.get(0)

    missing_packages = {}
    for _, diagnostic in ipairs(diagnostics) do
      local package = diagnostic.message:match(
        'Cannot find implementation or library stub for module named "(.+)"'
      ) or diagnostic.message:match(
        'Skipping analyzing "(.+)": module is installed, but missing library stubs or py.typed marker'
      ) or diagnostic.message:match('Library stubs not installed for "(.+)".+')
      if package and package ~= "numpy" then
        local package_name = vim.split(package, ".", { plain = true })[1]
        missing_packages[#missing_packages + 1] = package_name
      end
    end

    if #missing_packages == 0 then
      vim.notify("No missing stubs.")
      return
    end
  end

  missing_packages = vim.fn.uniq(vim.fn.sort(missing_packages))

  if not stubs_dir:exists() then
    if not stubs_dir:mkdir({ parents = true }) then
      vim.notify(
        "Failed to create stubs directory '" .. stubs_dir.filename .. "'",
        vim.log.levels.ERROR
      )
    end
  end

  local Job = require("plenary.job")
  local job = Job:new({
    command = "stubgen",
    args = vim.tbl_flatten({
      vim.tbl_map(function(package_name)
        return { "-p", package_name }
      end, missing_packages),
      "-o",
      stubs_dir.filename,
    }),
  }):after(function(job, signal)
    for _, package in ipairs(missing_packages) do
      stubs_dir:joinpath(package):copy({
        destination = stubs_dir:parent():joinpath(package .. "-stubs").filename,
        recursive = true,
      })
    end
    vim.schedule(function()
      vim.api.nvim_command("silent! w")
      -- It return success so use job:result() to access the output
      -- Maybe use tbl_filter and output the names????
      if signal == 0 then
        vim.notify("Successfully generated stubs.")
      else
        vim.notify(
          "Failed to run stubgen: " .. vim.fn.join(job:stderr_result(), "\n"),
          vim.log.levels.ERROR
        )
      end
    end)
  end)
  job:start()
end

M.lsp_status = function()
  local lsp_status = vim.lsp.status()
  if lsp_status == "" then
    return ""
  end
  return " | " .. lsp_status
end

M.ts_status = function()
  if require("lazy.core.config").plugins["nvim-treesitter"]._.loaded == nil then
    return ""
  end
  local ok, ts = pcall(require, "nvim-treesitter")
  if not ok then
    return ""
  end
  return ts.statusline({
    indicator_size = 100,
    separator = " | ",
    type_patterns = {
      "class",
      "function",
      "method",
      "struct",
      -- Rust
      "trait_item",
      "impl_item",
      "enum",
      -- C++
      "namespace",
    },
    allow_duplicates = false,
  }) or ""
end

M.dap_status = function()
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

M.run_file = function(is_test)
  local filetype = vim.filetype.match({ filename = vim.fn.expand("%:p") })
  if not filetype or filetype == "" then
    return
  end

  local dirname = vim.fn.expand("%:p:h")
  local root_dir = M.root_dirs[filetype]
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
    cmd = "micromamba"
    for _, v in
      ipairs(
        vim.fn.reverse({ "run", "-n", "myconfigs", "python3", "~/.local/bin/build_project.py" })
      )
    do
      table.insert(args, 1, v)
    end
  end
  if is_test then
    table.insert(args, "--test")
  end
  local term = require("config.term")
  term.run(cmd, args, { cwd = root_dir, auto_close = false })
end

return M
