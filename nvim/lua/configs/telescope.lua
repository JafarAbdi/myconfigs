-- Telescope
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
require('telescope').load_extension('dap')
