local ls = require("luasnip")
local s = ls.snippet
-- local sn = ls.snippet_node
local t = ls.text_node
local i = ls.insert_node
-- local f = ls.function_node
-- local c = ls.choice_node
-- local d = ls.dynamic_node
-- local r = ls.restore_node
-- local l = require("luasnip.extras").lambda
local rep = require("luasnip.extras").rep
-- local p = require("luasnip.extras").partial
-- local m = require("luasnip.extras").match
-- local n = require("luasnip.extras").nonempty
-- local dl = require("luasnip.extras").dynamic_lambda
-- local fmt = require("luasnip.extras.fmt").fmt
-- local fmta = require("luasnip.extras.fmt").fmta
-- local types = require("luasnip.util.types")
-- local conds = require("luasnip.extras.expand_conditions")

return {
  s(
    "type_erasure",
    {
      t("class "),
      i(1),
      t({ "", "{", "  private:", "" }),
      t("struct "),
      rep(1),
      t({ "Concept", "", "{", "   virtual ~" }),
      rep(1),
      t("Concept() = default;"),
      t({ "", "}" }),
      t({ "template <typename T>", "", "struct " }),
      rep(1),
      t({ "Model: " }),
      rep(1),
      t({ "Concept", "", "{", "" }),
      rep(1),
      t({ "Model(T&& value): object(std::forward<T>(value)){}", "", "    T object;", "", "};" }),
    }
    -- fmt(
    --   [[
    -- class {name}
    -- {{
    -- private:
    -- struct {name}Concept
    -- {{
    --   virtual ~{name}Concept() = default;
    --   /* Operations */
    --   /* clone ???? */
    -- }};
    -- template <typename T>
    -- struct {name}Model : {name}Concept
    -- {{
    --   {name}Model(T&& value): object(std::forward<T>(value)){{}}
    --   /* Operations */

    --   T object;
    -- }};
    -- /* Operations */
    -- std::unique_ptr<{name}Concept> pimpl;

    -- public:
    -- template <typename T>
    -- {name}(const T& x): pimpl(std::make_unique<{name}Model<T>>(x)){{}}
    -- /* Special member functions */

    -- }};
    -- ]],
    --   { name = i(0) }
    -- )
  ),
}
