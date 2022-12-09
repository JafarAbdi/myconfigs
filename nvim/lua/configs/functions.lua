local ok, _ = pcall(require, "plenary")
if not ok then
  return
end

local Path = require("plenary.path")
local Job = require("plenary.job")

local M = {}

M.clean_whitespaces = function()
  local current_view = vim.fn.winsaveview()
  vim.cmd([[keeppatterns %s/\s\+$//e]])
  vim.fn.winrestview(current_view)
end

P = function(v)
  print(vim.inspect(v))
  return v
end

M.generate_all_python_stubs = function()
  local job = Job
    :new({
      command = "python3",
      args = {
        "-c",
        [[
import os
import pkg_resources
for pkg in pkg_resources.working_set:
    # TODO: Pass as parameter????
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
      if package then
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
      -- TODO: Handle 'PKG_NAME: Failed to import, skipping'
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

M.load_clangd_config = function(root_path)
  assert(type(root_path) == "string", "root_path have to be a string")
  return vim.trim(Path:new(M.clangd_root_dir(root_path), ".clangd_config"):read())
end

M.is_buffer_exists = function(name)
  local buffers = vim.tbl_filter(function(b)
    if 1 ~= vim.fn.buflisted(b) then
      return false
    end
    if not vim.api.nvim_buf_is_loaded(b) then
      return false
    end
    return true
  end, vim.api.nvim_list_bufs())
  for _, buf in ipairs(buffers) do
    if vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":t") == name then
      return buf
    end
  end
end

M.is_parent = function(parent, path)
  assert(type(parent) == "string")
  assert(type(path) == "string")
  parent = Path:new(parent):normalize("/")
  path = Path:new(path):normalize("/")
  if path:len() < parent:len() then
    return false
  end
  if parent == path then
    return true
  end
  for dir in vim.fs.parents(Path:new(path):normalize()) do
    if dir:len() < parent:len() then
      break
    end
    if parent == dir then
      return true
    end
  end
  return false
end

return M
