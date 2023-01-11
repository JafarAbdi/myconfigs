return {
  {
    "aserowy/tmux.nvim",
    event = "VeryLazy",
    opts = {
      copy_sync = {
        enable = false,
      },
      navigation = {
        cycle_navigation = false,
        enable_default_keybindings = false,
        persist_zoom = true,
      },
      resize = {
        enable_default_keybindings = false,
      },
    },
  },
  { "junegunn/vim-easy-align", cmd = "EasyAlign" },
  { "mbbill/undotree", cmd = "UndotreeToggle" },

  {
    "lewis6991/gitsigns.nvim",
    event = "BufReadPre",
    opts = {
      signs = {
        add = { text = "+" },
        change = { text = "~" },
        delete = { text = "_" },
        topdelete = { text = "‾" },
        changedelete = { text = "~" },
        untracked = { text = "" },
      },
    },
  },
  {
    "kylechui/nvim-surround",
    event = "VeryLazy",
    opts = {
      keymaps = {
        insert = false,
        insert_line = false,
        normal = "ys",
        normal_cur = "yss",
        normal_line = false,
        normal_cur_line = false,
        visual = "gs",
        visual_line = "gS",
        delete = "ds",
        change = "cs",
      },
    },
  },

  -- Used to fix symlink files
  "famiu/bufdelete.nvim",
  -- Heuristically set buffer options
  "tpope/vim-sleuth",
  { "tpope/vim-commentary", keys = { "gc", "gcc" } },
  { "wsdjeg/vim-fetch", lazy = false },
  "nvim-lua/plenary.nvim",
}
