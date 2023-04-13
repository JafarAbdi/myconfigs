return {
  {
    "nvim-lualine/lualine.nvim",
    event = "VeryLazy",
    opts = {
      options = {
        theme = "onedark",
        globalstatus = true,
      },
      winbar = {
        lualine_a = {
          function()
            local ok, ts = pcall(require, "nvim-treesitter")
            if not ok then
              return ""
            end
            return ts.statusline({
              indicator_size = 300,
              separator = " | ",
              type_patterns = {
                "class",
                "function",
                "method",
                "struct",
                -- Rust
                "trait_item",
                "impl_item",
                "enum",
                -- C++
                "namespace",
              },
            }) or ""
          end,
        },
      },
      sections = {
        lualine_b = {
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
        lualine_c = {
          require("config.functions").file_or_lsp_status,
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
