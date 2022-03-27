local ls = require("luasnip")
local types = require("luasnip.util.types")

ls.config.set_config({
  -- This tells LuaSnip to remember to keep around the last snippet.
  -- You can jump back into it even if you move outside of the selection
  history = false,

  -- This one is cool cause if you have dynamic snippets, it updates as you type!
  updateevents = "TextChanged,TextChangedI",

  -- Autosnippets:
  -- enable_autosnippets = true,

  -- Crazy highlights!!
  -- #vid3
  -- ext_opts = nil,
  ext_opts = {
    [types.choiceNode] = {
      active = {
        virt_text = { { "<-", "Error" } },
      },
    },
  },
})

-- local all_snippets = require("plugins/snippets/all")

-- some shorthands...
local s = ls.snippet
-- local sn = ls.snippet_node
local t = ls.text_node
local i = ls.insert_node
local f = ls.function_node
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

local all_snippets = {}
-- https://github.com/L3MON4D3/LuaSnip/blob/master/Examples/snippets.lua
-- https://github.com/L3MON4D3/LuaSnip/blob/master/DOC.md
-- TODO: Add advanced options like optional clone function ...etc
local cpp_snippets = {
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

table.insert(
  cpp_snippets,
  s(
    "swap",
    f(function()
      local class_parameters = _G.GetClassParameters()
      local result = {
        string.format("void swap(%s& other)", class_parameters.class_name),
        "{",
        "using std::swap;",
      }
      local member_swap = tostring("swap({member}, other.{member});")
      for _, member in ipairs(class_parameters.parameters) do
        table.insert(result, (member_swap:gsub("{member}", member)))
      end
      table.insert(result, "}")
      return result
    end)
  )
)

-- ls.snippets = {
--   all = all_snippets,
--   -- cpp = cpp_snippets,
-- }
ls.add_snippets("all", all_snippets)

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
