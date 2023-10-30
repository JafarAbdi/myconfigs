-- Copied from https://github.com/mfussenegger/dotfiles/
local api = vim.api
local M = {}

local function exit()
  local key = api.nvim_replace_termcodes("<C-j>", true, false, true)
  api.nvim_feedkeys(key, "n", true)
end

local snippets = {
  ["*"] = {
    date = function()
      return os.date("%Y-%m-%d")
    end,
  },
}

-- Expose those in nvim-lsp-compl or add { filter = ..., on_results = ...} options?

---@param item lsp.CompletionItem
---@param defaults lsp.ItemDefaults|nil
local function apply_defaults(item, defaults)
  if not defaults then
    return
  end
  item.insertTextFormat = item.insertTextFormat or defaults.insertTextFormat
  item.insertTextMode = item.insertTextMode or defaults.insertTextMode
  item.data = item.data or defaults.data
  if defaults.editRange then
    local textEdit = item.textEdit or {}
    item.textEdit = textEdit
    textEdit.newText = textEdit.newText or item.textEditText or item.insertText
    if defaults.editRange.start then
      textEdit.range = textEdit.range or defaults.editRange
    elseif defaults.editRange.insert then
      textEdit.insert = defaults.editRange.insert
      textEdit.replace = defaults.editRange.replace
    end
  end
end

--- Extract the completion items from a `textDocument/completion` response
--- and apply defaults
---
---@param result lsp.CompletionItem[]|lsp.CompletionList
---@returns lsp.CompletionItem[]
local function get_completion_items(result)
  if result.items then
    for _, item in pairs(result.items) do
      apply_defaults(item, result.itemDefaults)
    end
    return result.items
  else
    return result
  end
end

function M.maybe()
  local lnum, col = unpack(api.nvim_win_get_cursor(0))
  local line = api.nvim_get_current_line()
  local word = vim.fn.matchstr(line, "\\w\\+\\%.c")
  local ft_snippets = snippets[vim.bo.filetype] or {}
  local snippet = ft_snippets[word]
  if not snippet then
    snippet = snippets["*"][word]
  end
  if snippet then
    api.nvim_buf_set_text(0, lnum - 1, col - #word, lnum - 1, col, {})
    if type(snippet) == "function" then
      snippet = snippet()
    end
    vim.snippet.expand(snippet)
    return
  end

  local clients = vim.lsp.get_clients({ bufnr = 0 })
  if not next(clients) then
    return exit()
  end
  local params = vim.lsp.util.make_position_params()
  local results, err = vim.lsp.buf_request_sync(0, "textDocument/completion", params, 3000)
  assert(not err, vim.inspect(err))
  local mode = api.nvim_get_mode()["mode"]
  if mode ~= "i" and mode ~= "ic" then
    return
  end
  local matches = {}
  for client_id, resp in pairs(results or {}) do
    local result = resp.result or {}
    local items = get_completion_items(result)
    for _, item in pairs(items) do
      local kind = vim.lsp.protocol.CompletionItemKind[item.kind] or ""
      if kind == "Snippet" then
        table.insert(matches, {
          word = item.label,
          abbr = item.label,
          kind = "Snippet",
          menu = item.detail or "",
          icase = 1,
          dup = 1,
          empty = 1,
          user_data = {
            item = item,
            client_id = client_id,
          },
        })
      end
    end
  end
  if #matches == 0 then
    return exit()
  end
  local line_to_cursor = line:sub(1, col)
  local word_boundary = vim.fn.match(line_to_cursor, "\\k*$")
  vim.fn.complete(word_boundary + 1, matches)
  if #matches == 1 then
    api.nvim_feedkeys(api.nvim_replace_termcodes("<C-n>", true, false, true), "n", true)
    api.nvim_feedkeys(api.nvim_replace_termcodes("<CR>", true, false, true), "m", true)
  end
end

return M
