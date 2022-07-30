local ts_query = require("vim.treesitter.query")
-- local ts_utils = require("nvim-treesitter.ts_utils")
-- local ts_locals = require("nvim-treesitter.locals")
local ts_shared = require("nvim-treesitter.textobjects.shared")
-- local ts_configs = require("nvim-treesitter.configs")
local buffer_writer = require("nvim-treesitter.nt-cpp-tools.buffer_writer")

local function add_text_edit(text, start_row, start_col)
  local edit = {}
  table.insert(edit, {
    range = {
      start = { line = start_row, character = start_col },
      ["end"] = { line = start_row, character = start_col },
    },
    newText = text,
  })
  buffer_writer.apply_text_edits(edit, 0)
end

-- TODO: Move definition to another class
-- For changing the texts
-- https://github.com/nvim-treesitter/nvim-treesitter/blob/50cf31065c1e3502d8964bb3674b95567d752074/lua/nvim-treesitter/ts_utils.lua#L322-L334
-- To get the source/header path
-- https://github.com/neovim/nvim-lspconfig/blob/master/lua/lspconfig/server_configurations/clangd.lua#L4-L22
-- Use textobject_at_point("@function.inner",...)

-- Rename to GetClassMembers
function _G.GetClassParameters()
  local bufnr = vim.api.nvim_get_current_buf()
  local class_name_query = vim.treesitter.parse_query(
    "cpp",
    [[
(struct_specifier
  name: (type_identifier) @class_name
)
(class_specifier
  name: (type_identifier) @class_name
)
  ]]
  )
  local parameters_query = vim.treesitter.parse_query(
    "cpp",
    [[
(class_specifier
  body: (field_declaration_list
    (field_declaration
      declarator: (field_identifier) @member_variable_name
    )
  )
)
(struct_specifier
  body: (field_declaration_list
    (field_declaration
      declarator: (field_identifier) @member_variable_name
    )
  )
)
  ]]
  )
  local _, _, node = ts_shared.textobject_at_point("@class.outer", nil, nil, {})
  -- TODO: Handle failure (node == nil)
  local class_parameters = { parameters = {} }
  for _, match, _ in parameters_query:iter_matches(node, bufnr) do
    table.insert(class_parameters.parameters, ts_query.get_node_text(match[1], bufnr))
  end
  local class_name = {}
  for _, match, _ in class_name_query:iter_matches(node, bufnr) do
    -- TODO: This's so dump, there should be a better way to handle one capture
    table.insert(class_name, ts_query.get_node_text(match[1], bufnr))
  end
  -- https://stackoverflow.com/questions/25973103/copy-swap-in-base-and-derived-class
  -- https://stackoverflow.com/questions/5695548/public-friend-swap-member-function
  -- TODO: Handle base class case
  class_parameters.class_name = class_name[1]
  local output = string.format("void swap(%s& other) noexcept", class_parameters.class_name)
    .. "\n{"
    .. "\nusing std::swap;"

  local member_swap = tostring("\nswap({member}, other.{member});")
  for _, member in ipairs(class_parameters.parameters) do
    output = output .. (member_swap:gsub("{member}", member))
  end
  output = output .. "\n}"
  local on_preview_succces = function(row)
    add_text_edit(output, row, 0)
  end

  local previewer = require("nvim-treesitter.nt-cpp-tools.preview_printer")
  previewer.start_preview(output, vim.api.nvim_win_get_cursor(0)[1], on_preview_succces)
end

function _G.CleanWhitespaces()
  local current_view = vim.fn.winsaveview()
  vim.cmd([[keeppatterns %s/\s\+$//e]])
  vim.fn.winrestview(current_view)
end

P = function(v)
  print(vim.inspect(v))
  return v
end
