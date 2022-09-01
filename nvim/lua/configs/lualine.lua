--Set statusbar
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
      require("configs.cmake").status,
      function()
        local ok, dap = pcall(require, "dap")
        if not ok then
          return ""
        end
        return dap.status()
      end,
    },
  },
})
