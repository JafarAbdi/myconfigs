local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node
local f = ls.function_node

-- https://sbulav.github.io/vim/neovim-setting-up-luasnip/#snippets-over-selected-text
return {
  s({
    trig = "link",
    namr = "markdown_link",
    dscr = "Create markdown link [txt](url)",
  }, {
    t("["),
    i(1),
    t("]("),
    f(function(_, snip)
      return snip.env.TM_SELECTED_TEXT[1] or {}
    end, {}),
    t(")"),
    i(0),
  }),
}
