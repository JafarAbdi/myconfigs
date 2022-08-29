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

    -- Prettier
    use({ "junegunn/vim-easy-align", cmd = "EasyAlign" })
    -- Commenting
    use("tpope/vim-commentary")
    -- Telescope
    use({ "nvim-telescope/telescope.nvim", requires = { "nvim-lua/plenary.nvim" } })
    use({ "nvim-telescope/telescope-fzf-native.nvim", run = "make" })
    use({ "nvim-telescope/telescope-ui-select.nvim" })
    -- Theme
    use("mjlbach/onedark.nvim")
    -- Status line
    use("nvim-lualine/lualine.nvim")
    use("nvim-lua/lsp-status.nvim")
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
    use({ "nvim-treesitter/nvim-treesitter", run = ":TSUpdate" })
    -- Spell checker
    use({
      "lewis6991/spellsitter.nvim",
      config = function()
        require("spellsitter").setup()
      end,
    })
    -- Highlights & Text selection
    use("nvim-treesitter/nvim-treesitter-textobjects")
    use("nvim-treesitter/nvim-treesitter-context")
    -- Maybe no longer needed with
    -- https://github.com/llvm/llvm-project/commit/68eac9a6e7a10eba8081bab340fda8be13a7840e
    -- https://github.com/llvm/llvm-project/commit/afa94306a8c197e346d3234e5ac5292ab90eae73
    use({
      "Badhi/nvim-treesitter-cpp-tools",
    })
    use({
      "nvim-treesitter/playground",
    })
    -- LSP clients configurations
    use("neovim/nvim-lspconfig")
    -- Completion
    use({ "hrsh7th/nvim-cmp" })
    use("hrsh7th/cmp-nvim-lsp")
    use("saadparwaiz1/cmp_luasnip")
    use("L3MON4D3/LuaSnip")
    use("hrsh7th/cmp-buffer")
    use("hrsh7th/cmp-path")
    use("hrsh7th/cmp-cmdline")
    use("hrsh7th/cmp-nvim-lua")
    use("hrsh7th/cmp-nvim-lsp-signature-help")
    use("lukas-reineke/cmp-under-comparator")
    use({ "mtoohey31/cmp-fish", ft = "fish" })
    use("kdheepak/cmp-latex-symbols")
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
    use("mfussenegger/nvim-dap")
    use("rcarriga/nvim-dap-ui")
    use({
      "theHamsta/nvim-dap-virtual-text",
      config = function()
        require("nvim-dap-virtual-text").setup()
      end,
    })

    use({
      "mfussenegger/nvim-dap-python",
      config = function()
        require("dap-python").setup("python3")
      end,
    })
    -- Rust
    use("simrat39/rust-tools.nvim")
    -- CMake
    use({ "JafarAbdi/neovim-cmake", branch = "pr-auto_select_target" })
    -- C++
    use("p00f/clangd_extensions.nvim")
    -- TODO: Uncomment once https://github.com/neovim/neovim/pull/15723 is merged
    -- use({
    --   "theHamsta/nvim-semantic-tokens",
    --   config = function()
    --     if pcall(require, "vim.lsp.semantic_tokens") then
    --       require("nvim-semantic-tokens").setup({
    --         preset = "default",
    --         -- highlighters is a list of modules following the interface of nvim-semantic-tokens.table-highlighter or
    --         -- function with the signature: highlight_token(ctx, token, highlight) where
    --         --        ctx (as defined in :h lsp-handler)
    --         --        token  (as defined in :h vim.lsp.semantic_tokens.on_full())
    --         --        highlight (a helper function that you can call (also multiple times) with the determined highlight group(s) as the only parameter)
    --         highlighters = { require("nvim-semantic-tokens.table-highlighter") },
    --       })
    --     end
    --   end,
    -- })
    use("p00f/godbolt.nvim")

    use("tpope/vim-sleuth")
    -- Used to fix symlink files
    use("famiu/bufdelete.nvim")
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
        "nvim-lua/plenary.nvim",
        "nvim-treesitter/nvim-treesitter",
        "antoinemadec/FixCursorHold.nvim",
        "nvim-neotest/neotest-python",
        "JafarAbdi/neotest-gtest",
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
