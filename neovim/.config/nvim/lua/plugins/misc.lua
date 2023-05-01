return {
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
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
