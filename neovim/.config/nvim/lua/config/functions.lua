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
      "package.xml",
      "pixi.toml"
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

M.lsp_status = function()
  local lsp_status = vim.lsp.status()
  if lsp_status == "" then
    return ""
  end
  return " | " .. lsp_status
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
