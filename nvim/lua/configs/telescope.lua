-- Telescope
require("telescope").setup({
  defaults = require("telescope.themes").get_dropdown({
    layout_strategy = "vertical",
    layout_config = {
      prompt_position = "bottom",
      vertical = {
        width = 0.8,
        height = 100,
      },
    },
  }),
})

require("telescope").setup({
  extensions = {
    ["ui-select"] = {
      require("telescope.themes").get_dropdown({
        -- even more opts
      }),
    },
  },
  defaults = {
    mappings = {
      i = {
        ["<C-u>"] = false,
        ["<C-d>"] = false,
      },
    },
  },
})

-- Enable telescope extensions
require("telescope").load_extension("ui-select")
require("telescope").load_extension("fzf")
