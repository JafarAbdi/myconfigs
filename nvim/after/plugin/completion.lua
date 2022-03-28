-- nvim-cmp setup

-- Same as the default compare.kind with field set to 25
local completion_item_kind = {}
completion_item_kind.Text = 1
completion_item_kind.Method = 2
completion_item_kind.Function = 3
completion_item_kind.Constructor = 4
completion_item_kind.Field = 26 -- Default 5
completion_item_kind.Variable = 6
completion_item_kind.Class = 7
completion_item_kind.Interface = 8
completion_item_kind.Module = 9
completion_item_kind.Property = 10
completion_item_kind.Unit = 11
completion_item_kind.Value = 12
completion_item_kind.Enum = 13
completion_item_kind.Keyword = 14
completion_item_kind.Snippet = 15
completion_item_kind.Color = 16
completion_item_kind.File = 17
completion_item_kind.Reference = 18
completion_item_kind.Folder = 19
completion_item_kind.EnumMember = 20
completion_item_kind.Constant = 21
completion_item_kind.Struct = 22
completion_item_kind.Event = 23
completion_item_kind.Operator = 24
completion_item_kind.TypeParameter = 25
completion_item_kind = vim.tbl_add_reverse_lookup(completion_item_kind)

-- https://github.com/hrsh7th/nvim-cmp/issues/156#issuecomment-916338617
local lspkind_comparator = function(entry1, entry2)
  local kind1 = entry1:get_kind()
  kind1 = kind1 == completion_item_kind.Text and 100 or kind1
  local kind2 = entry2:get_kind()
  kind2 = kind2 == completion_item_kind.Text and 100 or kind2
  if kind1 ~= kind2 then
    if kind1 == completion_item_kind.Snippet then
      return true
    end
    if kind2 == completion_item_kind.Snippet then
      return false
    end
    local diff = kind1 - kind2
    if diff < 0 then
      return true
    elseif diff > 0 then
      return false
    end
  end
end

-- local luasnip = require("luasnip")
local cmp = require("cmp")
local compare = require("cmp.config.compare")

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
    { name = "luasnip" },
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
    { name = "nvim_lua" },
    -- { name = "nvim_lsp_document_symbol", max_item_count = 10 },
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
      })[entry.source.name]
      return vim_item
    end,
  },
  sorting = {
    comparators = {
      compare.offset,
      compare.exact,
      compare.score,
      compare.recently_used,
      lspkind_comparator,
      -- compare.kind,
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
