return {
  {
    "nvim-lualine/lualine.nvim",
    event = "VeryLazy",
    opts = {
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
    },
  },
  {
    "lukas-reineke/indent-blankline.nvim",
    event = "BufReadPre",
    opts = {
      char = "┊",
      filetype_exclude = { "help", "alpha", "dashboard", "neo-tree", "Trouble", "lazy" },
      show_trailing_blankline_indent = false,
      show_current_context = false,
    },
  },
}
