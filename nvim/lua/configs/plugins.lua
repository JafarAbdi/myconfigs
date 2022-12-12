-- Install packer
local install_path = vim.fn.stdpath("data") .. "/site/pack/packer/start/packer.nvim"
local compile_path = vim.fn.stdpath("data") .. "/site/plugin/packer_compiled.vim"

if vim.fn.empty(vim.fn.glob(install_path)) > 0 then
  vim.fn.execute("!git clone https://github.com/wbthomason/packer.nvim " .. install_path)
end

vim.cmd.packadd("packer.nvim")
local packer = require("packer")

return packer.startup({
  function(use)
    -- Packer
    use("wbthomason/packer.nvim")
    use("lewis6991/impatient.nvim")

    -- Neovim utilities
    use({
      "aserowy/tmux.nvim",
      config = function()
        require("tmux").setup({
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
        })
      end,
    })
    use("nvim-lua/plenary.nvim")
    -- Prettier
    use({ "junegunn/vim-easy-align", cmd = "EasyAlign" })
    -- Commenting
    use("tpope/vim-commentary")
    -- Telescope
    use({
      "nvim-telescope/telescope.nvim",
      requires = {
        "nvim-telescope/telescope-ui-select.nvim",
        { "nvim-telescope/telescope-fzf-native.nvim", run = "make" },
      },
    })
    -- Status line
    use("nvim-lualine/lualine.nvim")
    -- Add indentation guides even on blank lines
    use("lukas-reineke/indent-blankline.nvim")
    -- Add git related info in the signs columns and popups
    use({
      "lewis6991/gitsigns.nvim",
      requires = { "nvim-lua/plenary.nvim" },
      config = function()
        require("gitsigns").setup({
          signs = {
            add = { text = "+" },
            change = { text = "~" },
            delete = { text = "_" },
            topdelete = { text = "‾" },
            changedelete = { text = "~" },
            untracked = { text = "" },
          },
        })
      end,
    })
    -- LSP clients configurations
    use("neovim/nvim-lspconfig")
    -- Tree-sitter
    use({
      "nvim-treesitter/nvim-treesitter",
      run = ":TSUpdate",
      requires = {
        -- Highlights & Text selection
        "nvim-treesitter/nvim-treesitter-context",
        "nvim-treesitter/nvim-treesitter-textobjects",
      },
    })
    -- Completion
    use({
      "hrsh7th/nvim-cmp",
      requires = {
        "JafarAbdi/cmp-conan",
        "hrsh7th/cmp-nvim-lsp",
        "hrsh7th/cmp-buffer",
        "saadparwaiz1/cmp_luasnip",
        "hrsh7th/cmp-path",
        "L3MON4D3/LuaSnip",
        "hrsh7th/cmp-cmdline",
        "hrsh7th/cmp-nvim-lua",
        "hrsh7th/cmp-nvim-lsp-signature-help",
        "lukas-reineke/cmp-under-comparator",
        "kdheepak/cmp-latex-symbols",
        { "mtoohey31/cmp-fish", ft = "fish" },
      },
    })
    use("krady21/compiler-explorer.nvim")
    -- Undo tree
    use({ "mbbill/undotree", cmd = "UndotreeToggle" })
    -- Go to files file.ex:row_number:col_number
    use("wsdjeg/vim-fetch")
    -- C++
    use("p00f/clangd_extensions.nvim")
    -- Used to fix symlink files
    use("famiu/bufdelete.nvim")
    -- Heuristically set buffer options
    use("tpope/vim-sleuth")
    use({
      "kylechui/nvim-surround",
      config = function()
        require("nvim-surround").setup({
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
        })
      end,
    })
    use("windwp/nvim-autopairs")
    use({ "github/copilot.vim" })
    if vim.fn.empty(vim.fn.glob(compile_path)) > 0 then
      packer.compile()
    end
  end,
  config = {
    compile_path = compile_path,
  },
})
