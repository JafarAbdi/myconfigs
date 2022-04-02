-- Install packer
local install_path = vim.fn.stdpath("data") .. "/site/pack/packer/start/packer.nvim"
local compile_path = vim.fn.stdpath("data") .. "/site/plugin/packer_compiled.vim"

if vim.fn.empty(vim.fn.glob(install_path)) > 0 then
  vim.fn.execute("!git clone https://github.com/wbthomason/packer.nvim " .. install_path)
end

local hotpot_path = vim.fn.stdpath("data") .. "/site/pack/packer/start/hotpot.nvim"

if vim.fn.empty(vim.fn.glob(hotpot_path)) > 0 then
  print("Could not find hotpot.nvim, cloning new copy to", hotpot_path)
  vim.fn.system({
    "git",
    "clone",
    "https://github.com/rktjmp/hotpot.nvim",
    hotpot_path,
  })
  vim.cmd("helptags " .. hotpot_path .. "/doc")
end
-- Bootstrap .fnl support
require("hotpot")

vim.cmd([[packadd packer.nvim]])
local packer = require("packer")

return packer.startup({
  function(use)
    -- Packer
    use("wbthomason/packer.nvim")
    use("rktjmp/hotpot.nvim")

    -- Profiler
    use("dstein64/vim-startuptime")
    -- Prettier
    use("junegunn/vim-easy-align")
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
    use("nvim-treesitter/nvim-treesitter")
    -- Spell checker
    use({
      "lewis6991/spellsitter.nvim",
      config = function()
        require("spellsitter").setup()
      end,
    })
    -- Highlights & Text selection
    use("nvim-treesitter/nvim-treesitter-textobjects")
    use("Badhi/nvim-treesitter-cpp-tools")
    use("nvim-treesitter/playground")
    use({ "JafarAbdi/nvim-treesitter-refactor", branch = "pr-hl_screenline" })
    -- LSP clients configurations
    use("neovim/nvim-lspconfig")
    use("mattn/efm-langserver")
    -- Completion
    use("hrsh7th/nvim-cmp")
    use("hrsh7th/cmp-nvim-lsp")
    use("saadparwaiz1/cmp_luasnip")
    use("L3MON4D3/LuaSnip")
    use("hrsh7th/cmp-buffer")
    use("hrsh7th/cmp-path")
    use("hrsh7th/cmp-cmdline")
    use("hrsh7th/cmp-nvim-lua")
    use("hrsh7th/cmp-nvim-lsp-signature-help")
    -- TODO: Push upstream with custom format function
    use({ "JafarAbdi/cmp-nvim-lsp-document-symbol", branch = "pr-custom_format" })
    -- Movement
    use("ggandor/lightspeed.nvim")
    -- Undo tree
    use("mbbill/undotree")
    -- Go to files file.ex:row_number:col_number
    use("wsdjeg/vim-fetch")
    -- Debugger
    use("mfussenegger/nvim-dap")
    use("rcarriga/nvim-dap-ui")
    use("nvim-telescope/telescope-dap.nvim")
    use({
      "theHamsta/nvim-dap-virtual-text",
      config = function()
        require("nvim-dap-virtual-text").setup()
      end,
    })

    use({
      "mfussenegger/nvim-dap-python",
      config = function()
        require("dap-python").setup("~/.virtualenvs/debugpy/bin/python")
      end,
    })
    -- Show diffs between directories
    use("will133/vim-dirdiff")
    -- Rust
    use("simrat39/rust-tools.nvim")
    -- CMake
    use({
      "JafarAbdi/neovim-cmake",
      branch = "pr-fixes",
    })
    -- C++
    use("p00f/clangd_extensions.nvim")
    use({
      "theHamsta/nvim-semantic-tokens",
      config = function()
        if pcall(require, "vim.lsp.semantic_tokens") then
          require("nvim-semantic-tokens").setup({
            preset = "default",
            -- highlighters is a list of modules following the interface of nvim-semantic-tokens.table-highlighter or
            -- function with the signature: highlight_token(ctx, token, highlight) where
            --        ctx (as defined in :h lsp-handler)
            --        token  (as defined in :h vim.lsp.semantic_tokens.on_full())
            --        highlight (a helper function that you can call (also multiple times) with the determined highlight group(s) as the only parameter)
            highlighters = { require("nvim-semantic-tokens.table-highlighter") },
          })
        end
      end,
    })
    use({
      "p00f/godbolt.nvim",
      config = function()
        require("godbolt").setup({
          languages = {
            cpp = {
              compiler = "clang12",
              options = {
                userArguments = "-O3 -std=c++2a",
                libraries = {
                  { id = "fmt", version = "trunk" },
                  { id = "range-v3", version = "trunk" },
                },
                filters = {
                  binary = false,
                  commentOnly = true,
                  demangle = true,
                  directives = true,
                  execute = false,
                  intel = true,
                  labels = true,
                  libraryCode = true,
                  trim = false,
                },
              },
            },
          },
          url = "http://localhost:10240",
        })
      end,
    })

    -- Use to fix symlink files
    use("moll/vim-bbye")
    use({
      "tpope/vim-surround",
      config = function()
        -- https://github.com/tpope/vim-surround/blob/master/plugin/surround.vim
        vim.keymap.set("n", "ds", "<Plug>Dsurround")
        vim.keymap.set("n", "cs", "<Plug>Csurround")
        vim.keymap.set("n", "yss", "<Plug>Yssurround")
        vim.keymap.set("n", "ySs", "<Plug>YSsurround")
        vim.keymap.set("x", "gs", "<Plug>VSurround")
        vim.keymap.set("x", "gS", "<Plug>VgSurround")
      end,
    })

    -- Documentation
    use({
      "https://gitlab.com/JafarAbdi/zeal-lynx-cli.git",
      run = "ln -sf "
        .. vim.fn.stdpath("data")
        .. "/site/pack/packer/start/zeal-lynx-cli.git/zeal-cli ~/.local/bin/zeal-cli",
    })
    use({
      "https://gitlab.com/ivan-cukic/nvim-telescope-zeal-cli.git",
      config = function()
        require("telescope_zeal").setup({
          documentation_sets = {
            cpp = { title = "C++ Reference" },
            cmake = { title = "CMake Documentation" },
            boost = { title = "Boost Documentation" },
          },
        })
      end,
    })
    -- File manager
    use({
      "luukvbaal/nnn.nvim",
      config = function()
        require("nnn").setup({})
      end,
    })
    if vim.fn.empty(vim.fn.glob(compile_path)) > 0 then
      packer.compile()
    end
  end,
  config = {
    compile_path = compile_path,
  },
})
