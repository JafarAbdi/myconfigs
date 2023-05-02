return {
  {
    "L3MON4D3/LuaSnip",
    opts = function()
      local types = require("luasnip.util.types")

      return {
        -- This tells LuaSnip to remember to keep around the last snippet.
        -- You can jump back into it even if you move outside of the selection
        history = true,
        delete_check_events = "TextChanged",
        -- This one is cool cause if you have dynamic snippets, it updates as you type!
        updateevents = "TextChanged,TextChangedI",

        -- Autosnippets:
        enable_autosnippets = true,
        store_selection_keys = "<Tab>",
        ext_opts = {
          [types.choiceNode] = {
            active = {
              virt_text = { { "choiceNode", "Comment" } },
            },
          },
        },
      }
    end,
    config = function(_, opts)
      require("luasnip").config.set_config(opts)
      require("luasnip.loaders.from_vscode").load({
        paths = { "~/myconfigs/vscode/.config/Code/User/snippets" },
      })
    end,
  },
  {
    "hrsh7th/nvim-cmp",
    event = { "InsertEnter", "CmdlineEnter" },
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
      "saadparwaiz1/cmp_luasnip",
      "L3MON4D3/LuaSnip",
      "hrsh7th/cmp-nvim-lua",
      "lukas-reineke/cmp-under-comparator",
    },
    opts = function()
      local cmp = require("cmp")
      local compare = require("cmp.config.compare")
      return {
        snippet = {
          expand = function(args)
            require("luasnip").lsp_expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["Tab"] = cmp.config.disable,
          ["S-Tab"] = cmp.config.disable,
          ["<C-f>"] = cmp.config.disable,
          ["<C-d>"] = cmp.mapping.scroll_docs(4),
          ["<C-u>"] = cmp.mapping.scroll_docs(-4),
          ["<C-Space>"] = cmp.mapping.complete(),
          ["<C-c>"] = cmp.mapping.abort(),
          ["<C-e>"] = cmp.mapping(function(_fallback)
            vim.api.nvim_feedkeys(
              vim.fn["copilot#Accept"](vim.api.nvim_replace_termcodes("<Tab>", true, true, true)),
              "n",
              true
            )
          end),
          ["<CR>"] = cmp.mapping.confirm({
            behavior = cmp.ConfirmBehavior.Insert,
            select = false,
          }),
        }),
        sources = {
          { name = "nvim_lsp_signature_help", priority = 100 },
          { name = "nvim_lsp" },
          { name = "luasnip", max_item_count = 2 },
          {
            name = "buffer",
            max_item_count = 20,
            option = {
              get_bufnrs = function()
                return vim.api.nvim_list_bufs()
              end,
            },
          },
          { name = "nvim_lua" },
          { name = "fish" },
        },
        formatting = {
          format = function(entry, vim_item)
            vim_item.menu = ({
              buffer = "[Buffer]",
              nvim_lsp = "[LSP]",
              luasnip = "[LuaSnip]",
              nvim_lua = "[Lua]",
              nvim_lsp_signature_help = "[Signature]",
            })[entry.source.name]
            local label = vim_item.abbr
            -- https://github.com/hrsh7th/nvim-cmp/discussions/609
            local ELLIPSIS_CHAR = "…"
            local MAX_LABEL_WIDTH = 100
            local truncated_label = vim.fn.strcharpart(label, 0, MAX_LABEL_WIDTH)
            if truncated_label ~= label then
              vim_item.abbr = truncated_label .. ELLIPSIS_CHAR
            end
            return vim_item
          end,
        },
        sorting = {
          comparators = {
            compare.offset,
            compare.exact,
            -- compare.score,
            -- https://github.com/p00f/clangd_extensions.nvim/blob/main/lua/clangd_extensions/cmp_scores.lua
            function(entry1, entry2)
              local diff
              if entry1.completion_item.score and entry2.completion_item.score then
                diff = (entry2.completion_item.score * entry2.score)
                  - (entry1.completion_item.score * entry1.score)
              else
                diff = entry2.score - entry1.score
              end
              if diff < 0 then
                return true
              elseif diff > 0 then
                return false
              end
            end,
            require("cmp-under-comparator").under,
            compare.recently_used,
            compare.kind,
            compare.sort_text,
            compare.length,
            compare.order,
          },
        },
      }
    end,
    config = function(_, opts)
      local cmp = require("cmp")

      cmp.setup.filetype({
        "dapui_hover",
        "dapui_stacks",
        "dapui_scopes",
        "dapui_controls",
        "dapui_breakpoints",
        "neotest-summary",
      }, {})

      cmp.setup.filetype("gitcommit", {
        sources = cmp.config.sources({
          { name = "buffer" },
        }),
      })

      cmp.setup(opts)
    end,
  },
}
