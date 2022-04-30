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

local get_gtests = function(query, node, bufnr)
  local gtests = {}
  for _, match, _ in query:iter_matches(node, bufnr) do
    local gtest = {}
    for id, key in ipairs(match) do
      gtest[query.captures[id]] = ts_query.get_node_text(key, bufnr)
    end
    table.insert(gtests, gtest)
  end
  return gtests
end
function _G.RunGtest(opts)
  -- Whether to only run the test at cursor or not
  opts.at_cursor = vim.F.if_nil(opts.at_cursor, false)
  opts.debug = vim.F.if_nil(opts.debug, false)
  local bufnr = vim.api.nvim_get_current_buf()

  local query = vim.treesitter.parse_query(
    "cpp",
    [[
(function_definition
  declarator: (function_declarator
    parameters: (parameter_list
                  (parameter_declaration
                      type: (type_identifier) @gtest_suite_name)
                  .
                  (parameter_declaration
                      type: (type_identifier) @gtest_test_name))) @gtest_test
  (#match? @gtest_test "TEST|TEST_F"))
]]
  )
  local gtests
  if opts.at_cursor then
    local _, _, node = ts_shared.textobject_at_point("@function.outer", nil, nil, {})
    if not node then
      vim.notify("No test at the current cursor position", vim.log.levels.ERROR)
      return
    end
    gtests = get_gtests(query, node, bufnr)
  else
    local language_tree = vim.treesitter.get_parser(bufnr)
    local syntax_tree = language_tree:parse()
    gtests = get_gtests(query, syntax_tree[1]:root(), bufnr)
  end

  local run_test = function(gtest)
    require("cmake").build():after_success(function()
      local command = "--gtest_filter=" .. gtest.gtest_suite_name .. "." .. gtest.gtest_test_name
      vim.schedule(function()
        if opts.debug then
          require("cmake").debug(command)
        else
          require("cmake").run(command)
        end
      end)
    end)
  end

  if opts.at_cursor then
    run_test(gtests[1])
  else
    vim.ui.select(gtests, {
      prompt = "Select test: ",
      format_item = function(gtest)
        return gtest.gtest_test
      end,
    }, run_test)
  end
end

function _G.ExpandMacro()
  local Path = require("plenary.path")
  require("telescope.builtin").lsp_code_actions({
    execute_action = function(action, offset_encoding)
      if not vim.startswith(action.title, "Expand macro ") then
        vim.notify("Not an Expand macro code action", vim.log.levels.ERROR)
        return
      end
      -- TODO: Should remove the temp file?
      local temp_file = Path:new(vim.fn.tempname() .. ".cpp")
      local original_file = vim.split(action.command.arguments[1].file, "file://")[2]
      Path:new(original_file):copy({ destination = temp_file.filename })
      action.command.arguments[1].file = "file://" .. temp_file.filename
      if action.edit or type(action.command) == "table" then
        if action.edit then
          vim.lsp.util.apply_workspace_edit(action.edit, offset_encoding)
        end
        if type(action.command) == "table" then
          vim.lsp.buf.execute_command(action.command)
        end
      else
        vim.lsp.buf.execute_command(action)
      end
      local diff = vim.fn.system(
        string.format("git --no-pager diff %s %s", original_file.filename, temp_file.filename)
      )
      print(diff)
    end,
  })
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
