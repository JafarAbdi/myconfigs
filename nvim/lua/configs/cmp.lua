-- nvim-cmp setup
local cmp = require("cmp")
local compare = require("cmp.config.compare")

require("cmp_git").setup()

cmp.setup.filetype({
  "dapui_hover",
  "dapui_stacks",
  "dapui_scopes",
  "dapui_controls",
  "dapui_breakpoints",
}, {})

cmp.setup.filetype("gitcommit", {
  sources = cmp.config.sources({
    { name = "cmp_git" },
  }, {
    { name = "buffer" },
  }),
})

cmp.setup({
  snippet = {
    expand = function(args)
      require("luasnip").lsp_expand(args.body)
    end,
  },
  mapping = {
    ["<C-p>"] = cmp.config.disable, -- cmp.mapping.select_prev_item(),
    ["<C-n>"] = cmp.config.disable, -- cmp.mapping.select_next_item(),
    ["<C-d>"] = cmp.config.disable, -- cmp.mapping.scroll_docs(-4),
    ["<C-f>"] = cmp.config.disable, -- cmp.mapping.scroll_docs(4),
    ["<C-Space>"] = cmp.mapping.complete(),
    ["<C-e>"] = cmp.mapping.close(),
    ["<CR>"] = cmp.mapping.confirm({
      behavior = cmp.ConfirmBehavior.Replace,
      select = false,
    }),
    -- ["Tab"] = cmp.config.disable,
    -- ["S-Tab"] = cmp.config.disable,
    ["<Tab>"] = cmp.mapping(function(fallback)
      if cmp.visible() then
        cmp.select_next_item()
        -- elseif luasnip.expand_or_jumpable() then
        --   luasnip.expand_or_jump()
      else
        fallback()
      end
    end, { "i", "s" }),
    ["<S-Tab>"] = cmp.mapping(function(fallback)
      if cmp.visible() then
        cmp.select_prev_item()
        -- elseif luasnip.jumpable(-1) then
        --   luasnip.jump(-1)
      else
        fallback()
      end
    end, { "i", "s" }),
  },
  --See https://github.com/topics/nvim-cmp
  sources = {
    { name = "nvim_lsp_signature_help", priority = 100 },
    { name = "nvim_lsp" },
    { name = "luasnip", max_item_count = 20 },
    {
      name = "buffer",
      max_item_count = 20,
      option = {
        get_bufnrs = function()
          local buf = vim.api.nvim_get_current_buf()
          local byte_size = vim.api.nvim_buf_get_offset(buf, vim.api.nvim_buf_line_count(buf))
          if byte_size > 1024 * 1024 then -- 1 Megabyte max
            return {}
          end
          return { buf }
        end,
      },
    },
    { name = "path" },
    { name = "nvim_lua" },
    { name = "fish" },
  },
  formatting = {
    format = function(entry, vim_item)
      -- Kind icons
      vim_item.kind = string.format("%s", vim_item.kind) -- This concatenates the icons with the name of the item kind
      -- Source
      vim_item.menu = ({
        buffer = "[Buffer]",
        nvim_lsp = "[LSP]",
        luasnip = "[LuaSnip]",
        nvim_lua = "[Lua]",
        nvim_lsp_signature_help = "[Signature]",
        nvim_lsp_document_symbol = "[Symbol]",
        fish = "[Fish]",
      })[entry.source.name]
      return vim_item
    end,
  },
  sorting = {
    comparators = {
      compare.offset,
      compare.exact,
      require("clangd_extensions.cmp_scores"),
      -- compare.score,
      compare.recently_used,
      compare.kind,
      compare.sort_text,
      compare.length,
      compare.order,
    },
  },
})
-- Use buffer source for `/` (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline("/", {
  sources = cmp.config.sources({
    { name = "nvim_lsp_document_symbol", max_item_count = 10 },
  }, {
    { name = "buffer" },
  }),
})

-- Use cmdline & path source for ':' (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline(":", {
  sources = cmp.config.sources({
    { name = "path" },
  }, {
    { name = "cmdline" },
  }),
})

-- If you want insert `(` after select function or method item
local cmp_autopairs = require("nvim-autopairs.completion.cmp")
cmp.event:on("confirm_done", cmp_autopairs.on_confirm_done({ map_char = { tex = "" } }))
