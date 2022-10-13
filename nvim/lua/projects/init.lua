local filetype = require("plenary.filetype")

--- @class Project
--- @field language string
--- @field root_path string
--- @field build_system "cargo" | "rustc" | "cmake" | "clang"
local Project = {}

--- @return Project
function Project:new(opts)
  setmetatable(opts, self)
  self.__index = self
  return opts
end

function Project:set()
  vim.cmd.cd(self.root_path)
  if self.build_system == "cmake" then
    require("configs.cmake").cmake_project(self.root_path)
  end
end

--- @param file string
function Project:run(file) end

local M = {}

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

--- @param rhs string
--- @param lhs string
local startswith = function(rhs, lhs)
  return rhs:find("^" .. lhs) ~= nil
end

--- @param file_path string
--- @return Project
M.set_project = function(file_path)
  -- local type = filetype.detect(file_path)
  for root_path, project in pairs(M.projects) do
    if startswith(file_path, root_path) then
      project:set()
      -- vim.cmd.cd(root_path)
      -- if project.build_system == "cmake" then
      --   require("configs.cmake").cmake_project(root_path)
      -- end
      -- return project
    end
  end
end

return M
