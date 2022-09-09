local actions_layout = require("telescope.actions.layout")
local actions = require("telescope.actions")
-- Telescope
local dropdown_configs = {
  layout_strategy = "vertical",
  layout_config = {
    prompt_position = "bottom",
    vertical = {
      width = 0.8,
      height = 100,
    },
  },
}

require("telescope").setup({
  defaults = require("telescope.themes").get_dropdown(dropdown_configs),
})

require("telescope").setup({
  extensions = {
    ["ui-select"] = {
      require("telescope.themes").get_dropdown(dropdown_configs),
    },
  },
  defaults = {
    mappings = {
      i = {
        ["<F2>"] = actions_layout.toggle_preview,
        ["<C-j>"] = actions.move_selection_next,
        ["<C-k>"] = actions.move_selection_previous,
        ["<M-j>"] = actions.preview_scrolling_down,
        ["<M-k>"] = actions.preview_scrolling_up,
        ["<esc>"] = actions.close,
        ["<C-u>"] = false,
        ["<C-d>"] = false,
      },
    },
  },
})

-- Enable telescope extensions
require("telescope").load_extension("ui-select")
require("telescope").load_extension("fzf")
