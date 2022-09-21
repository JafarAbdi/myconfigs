-- Install packer
local install_path = vim.fn.stdpath("data") .. "/site/pack/packer/start/packer.nvim"
local compile_path = vim.fn.stdpath("data") .. "/site/plugin/packer_compiled.vim"

if vim.fn.empty(vim.fn.glob(install_path)) > 0 then
  vim.fn.execute("!git clone https://github.com/wbthomason/packer.nvim " .. install_path)
end

vim.cmd([[packadd packer.nvim]])
local packer = require("packer")

return packer.startup({
  function(use)
    -- Packer
    use("wbthomason/packer.nvim")
    -- Neovim utilities
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
    -- Theme
    use("mjlbach/onedark.nvim")
    -- Status line
    use("nvim-lualine/lualine.nvim")
    use({
      "j-hui/fidget.nvim",
      config = function()
        require("fidget").setup()
      end,
    })
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
          },
        })
      end,
    })
    -- Tree-sitter
    use({
      "nvim-treesitter/nvim-treesitter",
      run = ":TSUpdate",
      requires = {
        -- Highlights & Text selection
        "nvim-treesitter/nvim-treesitter-textobjects",
        "nvim-treesitter/nvim-treesitter-context",
        "Badhi/nvim-treesitter-cpp-tools",
        "nvim-treesitter/playground",
      },
    })
    -- LSP clients configurations
    use("neovim/nvim-lspconfig")
    -- Completion
    use({
      "hrsh7th/nvim-cmp",
      requires = {
        "JafarAbdi/cmp-conan",
        "hrsh7th/cmp-nvim-lsp",
        "saadparwaiz1/cmp_luasnip",
        "L3MON4D3/LuaSnip",
        "hrsh7th/cmp-buffer",
        "hrsh7th/cmp-path",
        "hrsh7th/cmp-cmdline",
        "hrsh7th/cmp-nvim-lua",
        "hrsh7th/cmp-nvim-lsp-signature-help",
        "lukas-reineke/cmp-under-comparator",
        "kdheepak/cmp-latex-symbols",
        { "mtoohey31/cmp-fish", ft = "fish" },
      },
    })
    -- Movement
    use({
      "ggandor/leap.nvim",
      config = function()
        require("leap").setup({})
        require("leap").set_default_keymaps()
      end,
    })
    -- Undo tree
    use({ "mbbill/undotree", cmd = "UndotreeToggle" })
    -- Go to files file.ex:row_number:col_number
    use("wsdjeg/vim-fetch")
    -- Debugger
    use({
      "mfussenegger/nvim-dap",
      requires = {
        "rcarriga/nvim-dap-ui",
        "theHamsta/nvim-dap-virtual-text",
        "mfussenegger/nvim-dap-python",
      },
    })
    -- Rust
    use("simrat39/rust-tools.nvim")
    -- CMake
    use({ "JafarAbdi/neovim-cmake", branch = "pr-auto_select_target" })
    -- C++
    use("p00f/clangd_extensions.nvim")
    use({
      "theHamsta/nvim-semantic-tokens",
      config = function()
        require("nvim-semantic-tokens").setup({
          preset = "default",
          highlighters = { require("nvim-semantic-tokens.table-highlighter") },
        })
      end,
    })
    use("p00f/godbolt.nvim")
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
    -- Notes
    use("mickael-menu/zk-nvim")
    -- Testing
    use({
      "nvim-neotest/neotest",
      requires = {
        "antoinemadec/FixCursorHold.nvim",
        "nvim-neotest/neotest-python",
        "nvim-neotest/neotest-plenary",
        "JafarAbdi/neotest-gtest",
        "rouge8/neotest-rust",
      },
    })
    if vim.fn.empty(vim.fn.glob(compile_path)) > 0 then
      packer.compile()
    end
  end,
  config = {
    compile_path = compile_path,
  },
})
