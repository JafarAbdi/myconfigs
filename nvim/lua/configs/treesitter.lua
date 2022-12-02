local ok, ts_configs = pcall(require, "nvim-treesitter.configs")
if not ok then
  return
end

-- Treesitter configuration
local disable = function(lang, bufnr) -- Disable in large C++ buffers
  return (lang == "cpp" or lang == "c") and vim.api.nvim_buf_line_count(bufnr) > 50000
end
ts_configs.setup({
  ensure_installed = {
    "bash",
    "c",
    "cmake",
    "cpp",
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
    enable = not vim.g.vscode,
    disable = disable,
  },
  -- TODO: Why this is not working in vscode?
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
})

local ft_to_parser = require("nvim-treesitter.parsers").filetype_to_parsername
ft_to_parser.xml = "html"
ft_to_parser.xacro = "html"
ft_to_parser.urdf = "html"
