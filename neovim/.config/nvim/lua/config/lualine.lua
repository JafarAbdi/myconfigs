local lualine_ok, lualine = pcall(require, "lualine")
if not lualine_ok then
  return
end
--Set statusbar
lualine.setup({
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
        local ok, dap = pcall(require, "dap")
        if not ok then
          return ""
        end
        return dap.status()
      end,
    },
  },
})
