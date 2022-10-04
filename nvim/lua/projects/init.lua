--- @class Project
--- @field lang string
--- @field build_system "cargo" | "rustc" | "cmake" | "clang"

local M = {}

--- @return Project
-- function Project:new(options)
--   assert(options.lang, "Language have to be specified")
--   assert(options.build_system, "Build system have to be specified")
--   setmetatable(options, self)
--   self.__index = self
--   return options
-- end

--- @type table<Path, Project>
M.projects = {}

--- @param root_path string
--- @param project Project
M.add_project = function(root_path, project)
  local p = M.projects[root_path]
  if p and (p.lang ~= project.lang or p.build_system ~= p.build_system) then
    vim.notify("Conflicting configurations for project '".. project.)
  end
  -- assert(not M.projects[root_path], "Root path is already associated with different a project")
  M.projects[root_path] = project
end

return M
