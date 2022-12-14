local ok, ls = pcall(require, "luasnip")
if not ok then
  return
end
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

require("luasnip.loaders.from_vscode").load({ paths = { "~/myconfigs/vscode/User/snippets" } })
