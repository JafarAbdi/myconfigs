local ls = require("luasnip")
local types = require("luasnip.util.types")

ls.config.set_config({
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
})

-- https://github.com/L3MON4D3/LuaSnip/blob/master/Examples/snippets.lua
-- https://github.com/L3MON4D3/LuaSnip/blob/master/DOC.md

-- in a cpp file: search c-snippets, then all-snippets only (no cpp-snippets!!).
-- ls.filetype_set("cpp", { "c" })

-- -- luasnip setup
-- -- Expansion key
-- -- this will expand the current item or jump to the next item within the snippet.
-- vim.keymap.set({ "i", "s" }, "<C-Right>", function()
--   if ls.expand_or_jumpable() then
--     ls.expand_or_jump()
--   end
-- end, { silent = true })

-- -- Jump backwards key.
-- -- this always moves to the previous item within the snippet
-- vim.keymap.set({ "i", "s" }, "<C-Left>", function()
--   if ls.jumpable(-1) then
--     ls.jump(-1)
--   end
-- end, { silent = true })
require("luasnip.loaders.from_vscode").lazy_load({ paths = { "~/myconfigs/nvim/snippets" } })
require("luasnip.loaders.from_lua").load({
  paths = "~/myconfigs/nvim/lua/luasnip_snippets/snippets",
})
