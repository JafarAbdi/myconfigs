--- @class Project
--- @field lang string
--- @field build_system "cargo" | "rustc" | "cmake" | "clang"

local M = {}

--- @type table<string, Project>
M.projects = {}

--- @param root_path string
--- @param project Project
M.add_project = function(root_path, project)
  local p = M.projects[root_path]
  if p then
    if p.lang ~= project.lang or p.build_system ~= p.build_system then
      vim.notify("Conflicting configurations for project '" .. root_path)
    end
    return
  end
  M.projects[root_path] = project
end

--- @param rhs string
--- @param lhs string
local startswith = function(rhs, lhs)
  return rhs:find("^" .. lhs) ~= nil
end

--- @param file_path string
M.set_project = function(file_path)
  for project_root_path, info in pairs(M.projects) do
    if startswith(file_path, project_root_path) then
      vim.cmd.cd(project_root_path)
      if info.build_system == "cmake" then
        require("configs.cmake").cmake_project(project_root_path)
      end
    end
  end
end

return M
