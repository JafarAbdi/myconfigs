-- Treesitter configuration
-- Parsers must be installed manually via :TSInstall
require("nvim-treesitter.configs").setup({
  highlight = {
    ensure_installed = {
      "query",
      "cpp",
      "rust",
      "python",
      "fish",
      "bash",
      "lua",
      "yaml",
      "c",
      "cmake",
      "make",
      "markdown",
      "vim",
    },
    enable = true, -- false will disable the whole extension
  },
  incremental_selection = {
    enable = true,
    keymaps = {
      init_selection = "<A-w>",
      node_incremental = "<A-w>",
      scope_incremental = "<A-e>",
      node_decremental = "<A-S-w>",
    },
  },
  indent = {
    enable = false,
  },
  textobjects = {
    select = {
      enable = true,
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
      },
    },
    -- TODO: https://www.reddit.com/r/neovim/comments/tlkieq/swapping_objects_with_nvimtreesittertextobjects/
    swap = {
      enable = true,
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
      set_jumps = true, -- whether to set jumps in the jumplist
      goto_next_start = {
        ["]p"] = "@parameter.inner",
        ["]f"] = "@function.outer",
        ["]c"] = "@class.outer",
      },
      goto_next_end = {
        ["]F"] = "@function.outer",
        ["]C"] = "@class.outer",
      },
      goto_previous_start = {
        ["[p"] = "@parameter.inner",
        ["[f"] = "@function.outer",
        ["[c"] = "@class.outer",
      },
      goto_previous_end = {
        ["[F"] = "@function.outer",
        ["[C"] = "@class.outer",
      },
    },
    lsp_interop = {
      enable = true,
      border = "none",
      peek_definition_code = {
        ["<leader>pf"] = "@function.outer",
        ["<leader>pc"] = "@class.outer",
      },
    },
  },
  playground = {
    enable = true,
    disable = {},
    updatetime = 25, -- Debounced time for highlighting nodes in the playground from source code
    persist_queries = false, -- Whether the query persists across vim sessions
    keybindings = {
      toggle_query_editor = "o",
      toggle_hl_groups = "i",
      toggle_injected_languages = "t",
      toggle_anonymous_nodes = "a",
      toggle_language_display = "I",
      focus_language = "f",
      unfocus_language = "F",
      update = "R",
      goto_node = "<cr>",
      show_help = "?",
    },
  },
  query_linter = {
    enable = true,
    use_virtual_text = true,
    lint_events = { "BufWrite", "CursorHold" },
  },
  nt_cpp_tools = {
    enable = true,
    preview = {
      quit = "q", -- optional keymapping for quit preview
      accept = "<CR>", -- optional keymapping for accept preview
    },
  },
  refactor = {
    highlight_current_scope = { enable = true, highlight_eol = true },
  },
})
