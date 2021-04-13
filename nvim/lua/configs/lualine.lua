--Set statusbar
local nvim_status = require("lsp-status")
require("lualine").setup({
  options = {
    icons_enabled = false,
    theme = "onedark",
    component_separators = "|",
    section_separators = "",
    globalstatus = true,
  },
  sections = {
    lualine_b = { "filename", "branch", "diff" },
    lualine_c = {
      function()
        -- TODO: Maybe use require("nvim-treesitter").statusline()
        return nvim_status.status()
      end,
    },
  },
})
