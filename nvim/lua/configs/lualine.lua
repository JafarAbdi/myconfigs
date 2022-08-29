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
    lualine_b = {
      "filename",
      "branch",
      "diff",
      function()
        return require("configs.cmake").status()
      end,
      function()
        local ok, dap = pcall(require, "dap")
        if not ok then
          return ""
        end
        return dap.status()
      end,
    },
    lualine_c = {
      function()
        -- require("nvim-treesitter").statusline({indicator_size=1000, separator="\n"})
        -- TODO: Maybe use require("nvim-treesitter").statusline()
        return nvim_status.status()
      end,
    },
  },
})
