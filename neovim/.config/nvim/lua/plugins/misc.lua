return {
  {
    "danymat/neogen",
    cmd = "Neogen",
    opts = {
      snippet_engine = "luasnip",
      languages = {
        python = {
          template = {
            annotation_convention = "google_docstrings",
          },
        },
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
  { "famiu/bufdelete.nvim", lazy = false },
  { "github/copilot.vim", event = "VeryLazy" },
  {
    "krady21/compiler-explorer.nvim",
    cmd = { "CESetup", "CECompile", "CECompileLive" },
  },
  -- Heuristically set buffer options
  { "tpope/vim-sleuth", lazy = false },
  { "tpope/vim-commentary", keys = { { "gc", mode = "v" }, "gcc" } },
  { "wsdjeg/vim-fetch", lazy = false },
  "nvim-lua/plenary.nvim",
}
