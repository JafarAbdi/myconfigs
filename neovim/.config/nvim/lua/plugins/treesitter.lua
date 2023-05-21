vim.treesitter.language.register("html", { "xml", "xacro", "urdf" })

local disable = function(lang, bufnr) -- Disable in large C++ buffers
  return (lang == "cpp" or lang == "c") and vim.api.nvim_buf_line_count(bufnr) > 50000
end

return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "VeryLazy", "BufNewFile" },
    dependencies = {
      "nvim-treesitter/nvim-treesitter-textobjects",
    },
    opts = {
      ensure_installed = {
        "bash",
        "c",
        "cmake",
        "cpp",
        "c_sharp",
        "dockerfile",
        "fish",
        "vimdoc",
        "html",
        "http",
        "javascript",
        "json",
        "latex",
        "lua",
        "make",
        "markdown",
        "ninja",
        "proto",
        "python",
        "query",
        "rst",
        "rust",
        "toml",
        "typescript",
        "vim",
        "yaml",
      },
      highlight = {
        enable = true,
        disable = function(lang, buf)
          return (lang == "html")
            or disable(lang, buf)
            -- Disable highlighting for files without a filetype
            or (vim.api.nvim_buf_get_option(buf, "filetype") == "")
        end,
      },
      incremental_selection = {
        enable = true,
        disable = disable,
        keymaps = {
          init_selection = "<A-w>",
          node_incremental = "<A-w>",
          scope_incremental = "<A-e>",
          node_decremental = "<A-S-w>",
        },
      },
      -- indent = {
      --   enable = false,
      -- },
      textobjects = {
        select = {
          enable = true,
          disable = disable,
          lookahead = true, -- Automatically jump forward to textobj, similar to targets.vim
          keymaps = {
            -- You can use the capture groups defined in textobjects.scm
            ["af"] = "@function.outer",
            ["if"] = "@function.inner",
            ["ac"] = "@class.outer",
            ["ic"] = "@class.inner",
            ["ap"] = "@parameter.outer",
            ["ip"] = "@parameter.inner",
            ["ao"] = "@conditional.outer",
            ["io"] = "@conditional.inner",
            ["al"] = "@loop.outer",
            ["il"] = "@loop.inner",
          },
        },
        swap = {
          enable = true,
          disable = disable,
          swap_next = {
            ["<leader>a"] = "@parameter.inner",
          },
          swap_previous = {
            ["<leader>A"] = "@parameter.inner",
          },
        },
        -- [ prev, ] --> next, lower > start, upper end
        move = {
          enable = true,
          disable = disable,
          set_jumps = true, -- whether to set jumps in the jumplist
          goto_next_start = {
            ["]f"] = "@function.outer",
            ["]c"] = "@class.outer",
          },
          goto_next_end = {
            ["]F"] = "@function.outer",
            ["]C"] = "@class.outer",
          },
          goto_previous_start = {
            ["[f"] = "@function.outer",
            ["[c"] = "@class.outer",
          },
          goto_previous_end = {
            ["[F"] = "@function.outer",
            ["[C"] = "@class.outer",
          },
        },
      },
    },
    config = function(_, opts)
      require("nvim-treesitter.configs").setup(opts)
    end,
  },
}
