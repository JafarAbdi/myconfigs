local disable = function(lang, bufnr) -- Disable in large C++ buffers
  return (lang == "cpp" or lang == "c") and vim.api.nvim_buf_line_count(bufnr) > 50000
end

return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPost", "BufNewFile" },
    dependencies = {
      {
        "nvim-treesitter/nvim-treesitter-context",
        opts = {
          enable = true, -- Enable this plugin (Can be enabled/disabled later via commands)
          disable = disable,
          max_lines = 0, -- How many lines the window should span. Values <= 0 mean no limit.
          patterns = { -- Match patterns for TS nodes. These get wrapped to match at word boundaries.
            -- For all filetypes
            -- Note that setting an entry here replaces all other patterns for this entry.
            -- By setting the 'default' entry below, you can control which nodes you want to
            -- appear in the context window.
            default = {
              "class",
              "function",
              "method",
              -- 'for', -- These won't appear in the context
              -- 'while',
              -- 'if',
              -- 'switch',
              -- 'case',
            },
            rust = {
              "trait_item",
              "impl_item",
              "struct",
              "enum",
            },
            cpp = {
              "namespace",
              "struct",
            },
            -- Example for a specific filetype.
            -- If a pattern is missing, *open a PR* so everyone can benefit.
            --   rust = {
            --       'impl_item',
            --   },
          },
          exact_patterns = {
            -- Example for a specific filetype with Lua patterns
            -- Treat patterns.rust as a Lua pattern (i.e "^impl_item$" will
            -- exactly match "impl_item" only)
            -- rust = true,
          },

          -- [!] The options below are exposed but shouldn't require your attention,
          --     you can safely ignore them.

          zindex = 20, -- The Z-index of the context window
        },
      },
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
        "help",
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
            -- Disable highlighting for files without a filetype (telescope as an example)
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
        -- TODO: https://www.reddit.com/r/neovim/comments/tlkieq/swapping_objects_with_nvimtreesittertextobjects/
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
            ["]p"] = "@parameter.inner",
            ["]f"] = "@function.outer",
            ["]l"] = "@loop.outer",
            ["]o"] = "@conditional.outer",
            ["]c"] = "@class.outer",
          },
          goto_next_end = {
            ["]F"] = "@function.outer",
            ["]C"] = "@class.outer",
          },
          goto_previous_start = {
            ["[p"] = "@parameter.inner",
            ["[f"] = "@function.outer",
            ["[l"] = "@loop.outer",
            ["[o"] = "@conditional.outer",
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
      local ft_to_parser = require("nvim-treesitter.parsers").filetype_to_parsername
      ft_to_parser.xml = "html"
      ft_to_parser.xacro = "html"
      ft_to_parser.urdf = "html"
    end,
  },
}
