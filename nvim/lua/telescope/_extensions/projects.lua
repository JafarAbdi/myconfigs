local telescope = require("telescope")
local conf = require("telescope.config").values
local pickers = require("telescope.pickers")
local finders = require("telescope.finders")
local Projects = require("projects")

return telescope.register_extension({
  exports = {
    cd = function()
      local projects = Projects.projects
      local projects_flattened = {}
      for _, v in pairs(projects) do
        -- Don't include single-files projects
        if v.root_path:is_dir() then
          projects_flattened[#projects_flattened + 1] = {
            root_path = v.root_path.filename,
            language = v.language,
            build_system = v.build_system,
          }
        end
      end
      -- TODO: Show args and env-variables
      pickers
        .new({}, {
          prompt_title = "Projects",
          finder = finders.new_table({
            results = projects_flattened,
            entry_maker = function(entry)
              local display = "Root path: "
                .. entry.root_path
                .. " -- Language: "
                .. entry.language
                .. " -- Build system: "
                .. entry.build_system
              return {
                value = entry,
                display = display,
                ordinal = display,
              }
            end,
          }),
          sorter = conf.generic_sorter({}),
          attach_mappings = function(prompt_bufnr, _)
            local actions = require("telescope.actions")
            local actions_state = require("telescope.actions.state")
            actions.select_default:replace(function()
              local selected_entry = actions_state.get_selected_entry()
              Projects.get_project(selected_entry.value.root_path):set()
              actions.close(prompt_bufnr)
            end)
            return true
          end,
        })
        :find()
    end,
  },
})
