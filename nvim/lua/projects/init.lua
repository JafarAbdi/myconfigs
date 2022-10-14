local filetype = require("plenary.filetype")
local run_in_terminal = require("configs.run_in_terminal")

--- @param rhs string
--- @param lhs string
local startswith = function(rhs, lhs)
  return rhs:find("^" .. lhs) ~= nil
end

local get_dir = function(file)
  return vim.fn.fnamemodify(file, ":p:h")
end

local get_makeprg = function(file)
  local bufnr = vim.uri_to_bufnr(vim.uri_from_fname(file))
  local makeprg = vim.api.nvim_buf_get_option(bufnr, "makeprg")
  if not makeprg then
    return
  end
  local args = vim.split(vim.fn.expandcmd(makeprg), " ")
  return args[1], vim.list_slice(args, 2)
end

--- @class Project
--- @field language string
--- @field root_path string
--- @field build_system "cargo" | "cmake"
local Project = {}

--- @return Project
function Project:new(opts)
  setmetatable(opts, self)
  self.__index = self
  self._runner = {
    cpp = {
      standalone = function(file)
        local utils = require("cmake.utils")
        local makeprg, args = get_makeprg(file)
        utils.run(makeprg, args, { cwd = get_dir(file), force_quickfix = false }):after_success(
          function()
            vim.schedule(function()
              run_in_terminal(
                vim.fn.expand("%:p:r") .. ".out",
                {},
                { cwd = get_dir(file), focus_terminal = true }
              )
            end)
          end
        )
      end,
      cmake = function(file)
        local cmake = require("cmake")
        local ProjectConfig = require("cmake.project_config")
        local cwd = get_dir(file)
        if not cmake.auto_select_target(file) then
          vim.notify(
            "Failed to select target for the following path '" .. file .. "'",
            vim.log.levels.WARN
          )
          return
        end
        local project_config = ProjectConfig.new()
        local _, target, _ = project_config:get_current_target()
        cmake.build():after_success(function()
          vim.schedule(function()
            run_in_terminal(target.filename, {}, { cwd = cwd, focus_terminal = false })
          end)
        end)
      end,
    },
    rust = {
      cargo = function(file)
        local cwd = get_dir(file)
        vim.fn.jobstart({ "cargo", "metadata" }, {
          stdout_buffered = true,
          cwd = get_dir(file),
          on_stdout = function(_, data)
            local output = vim.tbl_filter(function(e)
              return e ~= ""
            end, data)[1]
            if output then
              local metadata = vim.json.decode(output)
              for _, package in ipairs(metadata.packages) do
                for _, target in ipairs(package.targets) do
                  -- TODO: Check kind?
                  if target.src_path == vim.fn.expand("%:p") then
                    vim.schedule(function()
                      -- cwd should be the root directory??
                      run_in_terminal("cargo", {
                        "run",
                        "--bin",
                        target.name,
                        "--",
                        {}, -- unpack(makeargs[vim.bo.filetype] or {}),
                      }, {
                        cwd = require("lspconfig").util.root_pattern("Cargo.toml")(cwd) or cwd,
                        -- env = makeenvs[vim.bo.filetype],
                      })
                    end)
                    return target.name
                  end
                end
              end
            else
              local output_filename = vim.fn.tempname()
              return run_in_terminal(
                "rustc",
                { vim.fn.expand("%:p"), "-o", output_filename, "&&", output_filename },
                { cwd = cwd }
              )
            end
          end,
        })
      end,
      standalone = function(file)
        local output_filename = vim.fn.tempname()
        return run_in_terminal(
          "rustc",
          { file, "-o", output_filename, "&&", output_filename },
          { cwd = get_dir(file) }
        )
      end,
    },
    default = function(file)
      local makeprg, args = get_makeprg(file)
      run_in_terminal(makeprg, args, { cwd = get_dir(file) })
    end,
  }
  return opts
end

function Project:set()
  vim.cmd.cd(self.root_path)
  if self.build_system == "cmake" then
    require("configs.cmake").cmake_project(self.root_path)
  end
end

--- @param file string
function Project:run(file)
  -- TODO: I don't think we need to set the project just use cwd
  self:set()
  local language_runner = self._runner[self.language]
  if language_runner then
    if self.build_system then
      return language_runner[self.build_system](file)
    else
      return language_runner(file)
    end
  end
  return self._runner.default(file)
end

local M = { Project = Project }

--- @type table<string, Project>
M.projects = {}

--- @param root_path string
--- @param project Project
M.add_project = function(root_path, project)
  local p = M.projects[root_path]
  if p then
    if p.language ~= project.language or p.build_system ~= p.build_system then
      vim.notify("Conflicting configurations for project '" .. root_path)
    end
    return
  end
  project.root_path = root_path
  M.projects[root_path] = project
end

--- @param file_path string
--- @return Project
M.get_project = function(file_path)
  local ft = filetype.detect(file_path)
  for root_path, project in pairs(M.projects) do
    if startswith(file_path, root_path) and (ft == "" or ft == project.language) then
      return project
    end
  end
  return Project:new({
    language = ft,
    build_system = "standalone",
  })
end

return M
