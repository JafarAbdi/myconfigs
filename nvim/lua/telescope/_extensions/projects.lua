local telescope = require("telescope")
local conf = require("telescope.config").values
local pickers = require("telescope.pickers")
local finders = require("telescope.finders")

return telescope.register_extension({
  exports = {
    cd = function(opts)
      opts = opts or {}

      local projects = require("projects").projects
      local projects_flattened = {}
      for k, v in pairs(projects) do
        projects_flattened[#projects_flattened + 1] = {
          root_path = k,
          lang = v.lang,
          build_system = v.build_system,
        }
      end
      pickers.new({}, {
        prompt_title = "Projects",
        finder = finders.new_table({
          results = projects_flattened,
          entry_maker = function(entry)
            return {
              value = entry,
              display = entry.root_path .. ": " .. entry.lang .. " - " .. entry.build_system,
              ordinal = entry.root_path .. ": " .. entry.lang .. " - " .. entry.build_system,
            }
          end,
        }),
        sorter = conf.generic_sorter({}),
        attach_mappings = function(prompt_bufnr, _)
          local actions = require("telescope.actions")
          local actions_state = require("telescope.actions.state")
          actions.select_default:replace(function()
            vim.cmd.cd(actions_state.get_selected_entry().value.root_path)
            actions.close(prompt_bufnr)
          end)
          return true
        end,
      }):find()
    end,
  },
})
