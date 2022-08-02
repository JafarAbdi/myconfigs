local Path = require("plenary.path")
local Job = require("plenary.job")

local M = {}

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

M.generate_all_python_stubs = function()
  local job = Job
    :new({
      command = "python3",
      args = {
        "-c",
        [[
import os
import pkg_resources
for pkg in pkg_resources.working_set:
    # TODO: Pass as parameter????
    if pkg.location.startswith(os.environ["HOME"] + "/workspaces") or pkg.location.startswith("/opt"):
        print(pkg.project_name.replace("-", "_"))
    ]],
      },
    })
    :after(function(job, code)
      if code == 0 then
        vim.schedule(function()
          M.generate_python_stubs(job:result())
        end)
      else
        vim.notify(
          "Failed to list python packages: " .. vim.fn.join(job:stderr_result(), "\n"),
          vim.log.levels.ERROR
        )
      end
    end)
  job:start()
end

M.generate_python_stubs = function(missing_packages)
  if not vim.fn.executable("stubgen") then
    vim.notify("stubgen executable doesn't exists", vim.log.levels.WARN)
    return
  end

  local stubs_dir = Path.new(vim.env.HOME, ".cache", "python-stubs", "stubs")

  if #missing_packages == 0 then
    if vim.opt.filetype:get() ~= "python" then
      vim.notify("generate_python_stubs only works with python", vim.log.levels.ERROR)
      return
    end

    local diagnostics = vim.diagnostic.get(0)

    missing_packages = {}
    for _, diagnostic in ipairs(diagnostics) do
      local package = diagnostic.message:match(
        'Cannot find implementation or library stub for module named "(.+)"'
      ) or diagnostic.message:match(
        'Skipping analyzing "(.+)": module is installed, but missing library stubs or py.typed marker'
      )
      if package then
        local package_name = vim.split(package, ".", { plain = true })[1]
        missing_packages[#missing_packages + 1] = package_name
      end
    end

    if #missing_packages == 0 then
      vim.notify("No missing stubs.")
      return
    end
  end

  missing_packages = vim.fn.uniq(vim.fn.sort(missing_packages))

  if not stubs_dir:exists() then
    if not stubs_dir:mkdir() then
      vim.notify(
        "Failed to create stubs directory '" .. stubs_dir.filename .. "'",
        vim.log.levels.ERROR
      )
    end
  end

  local job = Job
    :new({
      command = "stubgen",
      args = vim.tbl_flatten({
        vim.tbl_map(function(package_name)
          return { "-p", package_name }
        end, missing_packages),
        "-o",
        stubs_dir.filename,
      }),
    })
    :after(function(job, signal)
      for _, package in ipairs(missing_packages) do
        stubs_dir:joinpath(package):copy({
          destination = stubs_dir:parent():joinpath(package .. "-stubs").filename,
          recursive = true,
        })
      end
      vim.schedule(function()
        vim.api.nvim_command("silent! w")
        -- TODO: Handle 'PKG_NAME: Failed to import, skipping'
        -- It return success so use job:result() to access the output
        -- Maybe use tbl_filter and output the names????
        if signal == 0 then
          vim.notify("Successfully generated stubs.")
        else
          vim.notify(
            "Failed to run stubgen: " .. vim.fn.join(job:stderr_result(), "\n"),
            vim.log.levels.ERROR
          )
        end
      end)
    end)
  job:start()
end

return M
