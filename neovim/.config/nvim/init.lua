vim.opt.shell = "bash"

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  -- bootstrap lazy.nvim
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

local myconfigs_path = vim.fs.joinpath(vim.env.HOME, "myconfigs")
-----------------
--- Functions ---
-----------------

local clangd_opening_root_dir = nil

local set_clangd_opening_path = function(callback)
  return function()
    local ft = vim.api.nvim_get_option_value("filetype", {})
    if ft == "cpp" or ft == "c" then
      for _, client in pairs(vim.lsp.get_clients({ bufnr = 0 })) do
        if client.name == "clangd" then
          clangd_opening_root_dir = client.config.root_dir
          break
        end
      end
    end
    callback()
  end
end

local wezterm = {
  run = function(cmd, opts)
    opts = opts or {}
    local args = { "wezterm", "cli", "split-pane", "--bottom", "--percent", "25" }
    if opts.cwd then
      table.insert(args, "--cwd")
      table.insert(args, opts.cwd)
    end
    local escaped = table.concat(vim.tbl_map(vim.fn.shellescape, cmd), " ")
    vim.list_extend(args, { "bash", "-c", escaped .. '; read -p "Press Enter to close..."' })
    vim.system(args)
  end,
  spawn = function(cmd, opts)
    opts = opts or {}
    local args = { "wezterm", "cli", "spawn" }
    if opts.new_window then
      table.insert(args, "--new-window")
    end
    if opts.cwd then
      table.insert(args, "--cwd")
      table.insert(args, opts.cwd)
    end
    local escaped = table.concat(vim.tbl_map(vim.fn.shellescape, cmd), " ")
    vim.list_extend(args, { "bash", "-c", escaped .. '; read -p "Press Enter to close..."' })
    vim.system(args)
  end,
  notify = function(title, body)
    local cmd = string.format("\x1b]777;notify;%s;%s\x1b\\", title or "", body or "")
    vim.api.nvim_chan_send(vim.v.stderr, cmd)
  end,
}

-- Float image preview (Kitty Graphics Protocol — native pixel quality)
local imgcat = (function()
  local hover = nil -- { win, buf, src, id, width, height }
  local img_id = 0
  local cell_px = nil -- { w, h } pixels per cell

  local function get_cell_pixels()
    if cell_px then
      return cell_px
    end
    pcall(function()
      local ffi = require("ffi")
      -- pcall the cdef separately: another plugin may have already defined these symbols
      pcall(
        ffi.cdef,
        [[
        typedef struct { unsigned short row; unsigned short col; unsigned short xpixel; unsigned short ypixel; } winsize_t;
        int ioctl(int, int, ...);
      ]]
      )
      local sz = ffi.new("winsize_t")
      if ffi.C.ioctl(1, 0x5413, sz) == 0 and sz.col > 0 and sz.row > 0 and sz.xpixel > 0 then
        cell_px = { w = sz.xpixel / sz.col, h = sz.ypixel / sz.row }
      end
    end)
    cell_px = cell_px or { w = 9, h = 18 }
    return cell_px
  end

  local function kitty(opts)
    local parts = {}
    for k, v in pairs(opts) do
      if k ~= "data" then
        parts[#parts + 1] = k .. "=" .. v
      end
    end
    local msg = "\27_Gq=2," .. table.concat(parts, ",")
    if opts.data then
      msg = msg .. ";" .. opts.data
    end
    vim.api.nvim_ui_send(msg .. "\27\\")
  end

  local function close()
    if not hover then
      return
    end
    kitty({ a = "d", d = "i", i = hover.id })
    pcall(vim.api.nvim_win_close, hover.win, true)
    pcall(vim.api.nvim_buf_delete, hover.buf, { force = true })
    hover = nil
  end

  local function image_size(path)
    local out = vim.fn.system({ "file", path })
    local w, h = out:match("(%d+)%s*x%s*(%d+)")
    if w and h then
      return tonumber(w), tonumber(h)
    end
  end

  local function render()
    if not hover then
      return
    end
    if not vim.api.nvim_win_is_valid(hover.win) then
      return
    end
    local pos = vim.api.nvim_win_get_position(hover.win)
    -- Save cursor, move to float, place image, restore cursor
    vim.api.nvim_ui_send("\27[s") -- DECSC: save cursor position
    vim.api.nvim_ui_send("\27[" .. (pos[1] + 1) .. ";" .. (pos[2] + 1) .. "H")
    kitty({ a = "p", i = hover.id, p = hover.id, C = 1, c = hover.width, r = hover.height })
    vim.api.nvim_ui_send("\27[u") -- DECRC: restore cursor position
  end

  local function place(path)
    if hover and hover.src == path then
      return
    end
    close()

    img_id = img_id + 1
    local cur_id = img_id

    -- Compute float size from image pixel dimensions
    local cp = get_cell_pixels()
    local img_w, img_h = image_size(path)
    if not img_w then
      img_w, img_h = 800, 600
    end

    -- Colorcolumn is the max left boundary — float must not cross it
    -- Account for gutter (line numbers, signs, fold) shifting text rightward
    local cc = tonumber(vim.wo.colorcolumn) or vim.bo.textwidth
    -- getwininfo(id) returns { { winid, bufnr, height, width, textoff, ... } }
    -- textoff = columns used by gutter (line numbers + sign column + fold column)
    local gutter = vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff
    local min_col = (cc and cc > 0) and (cc + gutter) or math.floor(vim.o.columns * 0.5)
    local max_w = vim.o.columns - min_col
    local max_h = vim.o.lines - 4
    local nat_w = math.floor(img_w / cp.w)
    local nat_h = math.floor(img_h / cp.h)

    -- Scale down to fit, preserving aspect
    local scale = math.min(1, max_w / nat_w, max_h / nat_h)
    local width = math.max(10, math.floor(nat_w * scale))
    local height = math.max(5, math.floor(nat_h * scale))

    -- Anchor to top-right, but never left of colorcolumn
    local float_col = math.max(min_col, vim.o.columns - width)

    -- Transmit original file (terminal reads it directly)
    kitty({ t = "f", i = cur_id, f = 100, data = vim.base64.encode(path) })

    local buf = vim.api.nvim_create_buf(false, true)
    local win = vim.api.nvim_open_win(buf, false, {
      relative = "editor",
      row = 0,
      col = float_col,
      width = width,
      height = height,
      style = "minimal",
      focusable = false,
    })

    hover = {
      win = win,
      buf = buf,
      src = path,
      id = cur_id,
      width = width,
      height = height,
    }
    vim.schedule(render)
  end

  local image_exts = { png = true, jpg = true, jpeg = true, gif = true, webp = true, avif = true }

  ---------------------------------------------------------------------------
  -- Path resolution
  ---------------------------------------------------------------------------

  local function resolve_image_path(path)
    if path:match("^%w+://") then
      return
    end
    if not path:match("^/") then
      path = vim.fn.fnamemodify(vim.fn.expand("%:p:h") .. "/" .. path, ":p")
    end
    return vim.fn.filereadable(path) == 1 and path or nil
  end

  local function resolve_obsidian(name)
    local file_dir = vim.fn.expand("%:p:h")
    local try = file_dir .. "/" .. name
    if vim.fn.filereadable(try) == 1 then
      return try
    end
    local vault = vim.fs.root(file_dir, ".obsidian")
    if not vault then
      return
    end
    local fd = io.open(vault .. "/.obsidian/app.json", "r")
    if fd then
      local ok, conf = pcall(vim.json.decode, fd:read("*a"))
      fd:close()
      if ok and conf.attachmentFolderPath then
        local att = conf.attachmentFolderPath:gsub("^%./", "")
        try = file_dir .. "/" .. att .. "/" .. name
        if vim.fn.filereadable(try) == 1 then
          return try
        end
        try = vault .. "/" .. att .. "/" .. name
        if vim.fn.filereadable(try) == 1 then
          return try
        end
      end
    end
    return vim.fs.find(name, { path = vault, type = "file" })[1]
  end

  ---------------------------------------------------------------------------
  -- Treesitter helpers
  ---------------------------------------------------------------------------

  --- Strip $ or $$ delimiters from LaTeX content for rendering.
  local function strip_latex_delimiters(text)
    return vim.trim(text:gsub("^%$%$?", ""):gsub("%$%$?$", ""))
  end

  --- Walk ancestors of `node` until `predicate(node)` returns true.
  local function find_ancestor(node, predicate)
    while node do
      if predicate(node) then
        return node
      end
      node = node:parent()
    end
  end

  --- Get fenced code block language and content.
  local function get_code_block_info(node)
    local lang, content
    for child in node:iter_children() do
      if child:type() == "info_string" then
        local lang_node = child:named_child(0)
        if lang_node then
          lang = vim.treesitter.get_node_text(lang_node, 0)
        end
      elseif child:type() == "code_fence_content" then
        content = vim.treesitter.get_node_text(child, 0)
      end
    end
    return lang, content
  end

  --- Get command name from a generic_command node (e.g. "\\mathbf").
  local function get_command_name(node)
    for child in node:iter_children() do
      if child:type() == "command_name" then
        return vim.treesitter.get_node_text(child, 0)
      end
    end
  end

  ---------------------------------------------------------------------------
  -- Detection: what is under the cursor?
  -- Uses parser:for_each_tree() to handle injected languages.
  -- Pattern from nvim-treesitter-textobjects/shared.lua.
  --
  -- Priority: latex(3) > markdown_inline(2) > markdown(1)
  -- Multiple trees can cover the same range (e.g. $E=mc^2$ lives in both
  -- markdown_inline and an injected latex tree). Priority ensures the most
  -- specific tree wins regardless of iteration order.
  ---------------------------------------------------------------------------

  local function detect_image(node)
    for child in node:iter_children() do
      if child:type() == "link_destination" then
        return resolve_image_path(vim.treesitter.get_node_text(child, 0))
      elseif child:type() == "image_description" then
        local desc = vim.treesitter.get_node_text(child, 0)
        local name = desc:match("^%[(.-)%]$") or desc
        local ext = name:match("%.(%w+)$")
        if ext and image_exts[ext:lower()] then
          return resolve_obsidian(name)
        end
      end
    end
  end

  --- Inspect all parsed trees and find what's under the cursor.
  --- Separated from parsing so it can be called after async parse completes.
  local function inspect_trees(parser, row, col)
    local result, priority

    parser:for_each_tree(function(tree, lang_tree)
      if priority and priority >= 3 then
        return
      end
      local root = tree:root()
      if not vim.treesitter.is_in_node_range(root, row, col) then
        return
      end

      local lang = lang_tree:lang()

      if lang == "latex" then
        -- Priority 3: directly inside the injected latex tree
        local eq = root
        for child in root:iter_children() do
          local t = child:type()
          if t == "displayed_equation" or t == "inline_formula" then
            eq = child
            break
          end
        end
        local text = vim.treesitter.get_node_text(eq, 0)
        if text and #text > 0 then
          result = { kind = "latex", content = text, root = root }
          priority = 3
        end
      elseif lang == "markdown_inline" then
        local node = root:named_descendant_for_range(row, col, row, col)
        local ancestor = find_ancestor(node, function(n)
          local t = n:type()
          return t == "image" or t == "latex_block" or t == "latex_span"
        end)
        if not ancestor then
          return
        end
        local t = ancestor:type()
        if t == "image" then
          local path = detect_image(ancestor)
          if path then
            result = { kind = "image", path = path }
          end
        elseif (t == "latex_block" or t == "latex_span") and (not priority or priority < 2) then
          -- Priority 2: cursor on delimiters ($, ^, _, etc.) owned by markdown_inline
          local text = vim.treesitter.get_node_text(ancestor, 0)
          if text and #text > 0 then
            result = { kind = "latex", content = text }
            priority = 2
          end
        end
      elseif lang == "python" then
        -- Detect :math:`...` and .. math:: blocks inside docstrings.
        -- docstring_to_markdown converts these to $...$ / $$...$$ for LSP hover,
        -- but we render them directly from source without needing the LSP.
        local node = root:named_descendant_for_range(row, col, row, col)
        local str_node = find_ancestor(node, function(n)
          return n:type() == "string_content"
        end)
        if str_node then
          local str_text = vim.treesitter.get_node_text(str_node, 0)
          local _, str_sc = str_node:range()
          -- Find which line of the string the cursor is on
          local str_sr = select(1, str_node:range())
          local line_in_str = row - str_sr
          local lines = vim.split(str_text, "\n")
          local cursor_line = lines[line_in_str + 1] or ""

          -- Inline: :math:`...`
          local s = 1
          while true do
            local ms, me, latex = cursor_line:find(":math:`([^`]+)`", s)
            if not ms then
              break
            end
            -- Compute column range relative to buffer
            local line_start_col = (line_in_str == 0) and str_sc or 0
            if col >= line_start_col + ms - 1 and col < line_start_col + me then
              result = { kind = "latex", content = latex }
              return
            end
            s = me + 1
          end

          -- Block: .. math:: — search backwards for the directive,
          -- collect indented content, check if cursor is within.
          local cursor_idx = line_in_str + 1
          for i = cursor_idx, 1, -1 do
            if lines[i]:match("^%s*%.%. math::") then
              local indent = #lines[i]:match("^(%s*)")
              local content_lines = {}
              local block_end = i
              for j = i + 1, #lines do
                if lines[j]:match("^%s*$") then
                  content_lines[#content_lines + 1] = ""
                  block_end = j
                elseif #(lines[j]:match("^(%s*)") or "") > indent then
                  content_lines[#content_lines + 1] = vim.trim(lines[j])
                  block_end = j
                else
                  break
                end
              end
              if cursor_idx >= i and cursor_idx <= block_end then
                local content = table.concat(content_lines, "\n")
                if #content > 0 then
                  result = { kind = "latex", content = content }
                end
                return
              end
              break
            end
            if not lines[i]:match("^%s") and not lines[i]:match("^$") then
              break
            end
          end
        end
      elseif lang == "markdown" then
        local node = root:named_descendant_for_range(row, col, row, col)
        local block = find_ancestor(node, function(n)
          return n:type() == "fenced_code_block"
        end)
        if not block then
          return
        end
        local block_lang, content = get_code_block_info(block)
        if block_lang == "mermaid" and content then
          result = { kind = "mermaid", content = content }
        elseif (block_lang == "math" or block_lang == "latex") and content then
          result = { kind = "latex", content = content }
        end
      end
    end)

    return result
  end

  --- Detect what's under the cursor.
  --- Uses async parse (pattern from neovim/runtime/lua/vim/treesitter/highlighter.lua):
  ---   parser:parse(range, on_parse) — internally uses coroutine, yields every 3ms.
  ---   Callback always fires (sync or async), so we only need the callback path.
  local function detect_at_cursor(on_result)
    local ok, parser = pcall(vim.treesitter.get_parser, 0)
    if not ok or not parser then
      return on_result(nil)
    end

    local row, col = unpack(vim.api.nvim_win_get_cursor(0)) ---@type integer, integer
    row = row - 1

    -- on_parse fires synchronously if parse completes in <3ms, else async via vim.schedule
    parser:parse({ row, row + 1 }, function(err)
      if err then
        return on_result(nil)
      end
      on_result(inspect_trees(parser, row, col))
    end)
  end

  ---------------------------------------------------------------------------
  -- LaTeX highlighting: wrap the generic_command under cursor with
  -- \textcolor{cyan}{...} + adjacent sub/superscripts.
  -- Only generic_command is safe to wrap — sub/superscripts and \text*
  -- commands break when wrapped.
  ---------------------------------------------------------------------------

  local function latex_with_highlight(content, latex_root)
    if not content then
      return content
    end
    local node = vim.treesitter.get_node({ ignore_injections = false })
    if not node then
      return content
    end

    -- Only generic_command nodes are safe to wrap with \textcolor.
    -- Sub/superscripts break when wrapped. \text* commands aren't supported by mitex.
    local cmd = find_ancestor(node, function(n)
      return n:type() == "generic_command"
    end)
    if not cmd then
      return content
    end
    local name = get_command_name(cmd)
    if name and name:match("^\\text") then
      return content
    end

    -- Extend range to include adjacent subscript/superscript siblings
    local _, _, start_byte, _, _, end_byte = cmd:range(true)
    local sibling = cmd:next_named_sibling()
    while sibling and (sibling:type() == "subscript" or sibling:type() == "superscript") do
      _, _, _, _, _, end_byte = sibling:range(true)
      sibling = sibling:next_named_sibling()
    end

    -- content keeps $ delimiters, so node byte offsets map directly.
    -- Just subtract the root's start byte to get positions within content.
    local root = latex_root or find_ancestor(cmd, function(n)
      return not n:parent()
    end)
    local _, _, root_byte = root:range(true)
    local hl_start = start_byte - root_byte + 1
    local hl_end = end_byte - root_byte
    if hl_start < 1 or hl_end > #content or hl_start > hl_end then
      return content
    end

    return content:sub(1, hl_start - 1)
      .. "\\textcolor{cyan}{"
      .. content:sub(hl_start, hl_end)
      .. "}"
      .. content:sub(hl_end + 1)
  end

  ---------------------------------------------------------------------------
  -- Minimal coroutine-based async (from nvim-treesitter/async.lua).
  -- Lets us write flat sequential code that runs fully non-blocking.
  --
  --   async.run(function()
  --     local stat = async.await(2, vim.uv.fs_stat, path)
  --     local r = async.await(3, vim.system, cmd, {})
  --     vim.schedule(function() place(r) end)
  --   end)
  ---------------------------------------------------------------------------

  local async = {}

  --- Yield the coroutine, call fn(..., callback). Resume when callback fires.
  --- argc = position of the callback argument in fn's signature.
  --- @async
  function async.await(argc, fn, ...)
    local args = { ... }
    return coroutine.yield(function(resume)
      args[argc] = resume
      return fn(unpack(args, 1, argc))
    end)
  end

  --- Yield to the Neovim event loop (required before calling vim.api.*)
  --- @async
  function async.schedule()
    coroutine.yield(function(resume)
      vim.schedule(resume)
    end)
  end

  --- Run fn in a new coroutine. Non-blocking.
  function async.run(fn)
    local co = coroutine.create(fn)
    local function step(...)
      local ok, yielded = coroutine.resume(co, ...)
      if not ok then
        vim.schedule(function()
          vim.notify("imgcat: " .. tostring(yielded), vim.log.levels.WARN)
        end)
      end
      if coroutine.status(co) ~= "dead" and type(yielded) == "function" then
        yielded(step)
      end
    end
    step()
  end

  ---------------------------------------------------------------------------
  -- Async rendering pipeline
  ---------------------------------------------------------------------------

  local render_cache = {} -- content hash -> output path
  local cache_dir = (os.getenv("TMPDIR") or "/tmp") .. "/nvim-imgcat"
  vim.fn.mkdir(cache_dir, "p")

  --- @async
  --- Write source to temp file, run cmd, return output path or nil.
  local function render_to_png(content, ext, source, cmd_fn)
    -- Use vim.text.hexencode of a simple hash — safe in fast event context (no Vimscript)
    local h = 0x811c9dc5 -- FNV-1a
    for i = 1, #content do
      h = bit.bxor(h, content:byte(i))
      h = bit.band(h * 0x01000193, 0xFFFFFFFF)
    end
    local key = string.format("%08x", h)
    if render_cache[key] then
      return render_cache[key]
    end

    local input = cache_dir .. "/" .. key .. ext
    local output = cache_dir .. "/" .. key .. ".png"

    -- Async file write
    local err, fd = async.await(4, vim.uv.fs_open, input, "w", 420) -- 0644
    if err or not fd then
      return
    end
    async.await(4, vim.uv.fs_write, fd, source, 0)
    async.await(2, vim.uv.fs_close, fd)

    -- Async external process
    local r = async.await(3, vim.system, cmd_fn(input, output), {})

    -- Clean up input file immediately (pattern from nvim-treesitter/install.lua)
    async.await(2, vim.uv.fs_unlink, input)

    if r.code ~= 0 then
      -- DEBUG: uncomment to see rendering errors (async.schedule needed for vim.notify in fast context)
      -- async.schedule()
      -- vim.notify(("imgcat: render failed (exit %d)\n%s"):format(r.code, r.stderr or ""), vim.log.levels.WARN)
      async.await(2, vim.uv.fs_unlink, output)
      return
    end

    render_cache[key] = output
    return output
  end

  --- @async
  local function render_latex(content)
    return render_to_png(
      content,
      ".typ",
      table.concat({
        '#set page(width: auto, height: auto, margin: 10pt, fill: rgb("#1e1e2e"))',
        "#set text(fill: white, size: 16pt)",
        '#import "@preview/mitex:0.2.5": *',
        "#mitex(`" .. content .. "`)",
      }, "\n"),
      function(input, output)
        return { "typst", "compile", "--format", "png", "--ppi", "300", input, output }
      end
    )
  end

  --- @async
  local function render_mermaid(content)
    local cp = get_cell_pixels()
    local px_w = math.floor((vim.o.columns - 4) * cp.w)
    local px_h = math.floor((vim.o.lines - 4) * cp.h)
    return render_to_png(content .. px_w, ".mmd", content, function(input, output)
      return {
        "mmdr",
        "-i",
        input,
        "-o",
        output,
        "-e",
        "png",
        "-w",
        tostring(px_w),
        "-H",
        tostring(px_h),
      }
    end)
  end

  ---------------------------------------------------------------------------
  -- Update: detect → render (async) → place
  -- render_id ensures stale results are discarded when cursor moves.
  ---------------------------------------------------------------------------

  local render_id = 0

  local function update()
    render_id = render_id + 1
    local this_id = render_id

    detect_at_cursor(function(detected)
      if render_id ~= this_id then
        return
      end -- cursor moved, discard
      if not detected then
        close()
        return
      end

      -- DEBUG: uncomment to see what was detected
      -- vim.notify(("imgcat: detected %s content=%s"):format(detected.kind, (detected.content or ""):sub(1,40)))

      if detected.kind == "image" then
        place(detected.path)
        return
      end

      async.run(function()
        local path
        if detected.kind == "latex" then
          local highlighted = latex_with_highlight(detected.content, detected.root)
          -- Strip $ delimiters at render time (content keeps them for offset math)
          path = render_latex(strip_latex_delimiters(highlighted))
            or render_latex(strip_latex_delimiters(detected.content))
        elseif detected.kind == "mermaid" then
          path = render_mermaid(detected.content)
        end
        async.schedule()
        if path and render_id == this_id then
          place(path)
        end
      end)
    end)
  end

  -- Debounced updates: normal mode (50ms) and insert mode (300ms).
  -- Prevents detect_at_cursor + for_each_tree from running on every single keystroke.
  local debounce_timer = vim.uv.new_timer()
  local function update_debounced(ms)
    return function()
      debounce_timer:stop()
      debounce_timer:start(ms, 0, vim.schedule_wrap(update))
    end
  end

  return {
    update = update_debounced(50),
    update_insert = update_debounced(300),
    close = close,
  }
end)()

local root_dirs = {
  python = function(startpath)
    return vim.fs.root(startpath, {
      {
        ".pixi",
        "pixi.toml",
        ".venv",
      },
      {
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "Pipfile",
      },
    })
  end,
  cmake = function(startpath)
    return vim.fs.root(startpath, { ".vscode" })
  end,
  cpp = function(startpath)
    local search_fn = function(path)
      return vim.fs.root(path, { ".clangd" })
    end
    local fallback_search_fn = function(path)
      return vim.fs.root(path, {
        ".vscode",
        "compile_commands.json",
        "compile_flags.txt",
      })
    end
    -- If root directory not found set it to file's directory
    local search = function(path)
      return vim.F.if_nil(search_fn(path), search_fn(vim.fn.expand("%:p:h")))
        or fallback_search_fn(path)
    end
    local dir = search(startpath)
      or (clangd_opening_root_dir and search(clangd_opening_root_dir))
      or vim.fn.getcwd()
    clangd_opening_root_dir = nil
    return dir
  end,
  rust = function(_)
    local search_fn = function(path)
      return vim.fs.root(path, { "Cargo.toml", "rust-project.json", ".vscode" })
    end
    return search_fn(vim.fn.getcwd())
  end,
  zig = function(startpath)
    return vim.fs.root(startpath, { "build.zig" })
  end,
  dockerfile = function(startpath)
    return vim.fs.root(startpath, { "Dockerfile" })
  end,
  javascript = function(startpath)
    return vim.fs.root(
      startpath,
      { "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "deno.lock" }
    )
  end,
}
root_dirs.c = root_dirs.cpp
root_dirs.cuda = root_dirs.cpp
root_dirs.tsx = root_dirs.javascript
root_dirs.jsx = root_dirs.javascript
root_dirs.typescript = root_dirs.javascript
root_dirs.typescriptreact = root_dirs.javascript

local run_file = function()
  if not vim.bo.readonly and vim.bo.modified then
    vim.cmd.write()
  end
  wezterm.run({ "runner", vim.fn.expand("%:p") })
end

----------------
--- Commands ---
----------------

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})
local lsp_group = vim.api.nvim_create_augroup("lsp", {})

vim.api.nvim_create_autocmd("VimResume", { command = "checktime", group = general_group })
-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  group = general_group,
  pattern = "qf",
  callback = function()
    vim.opt_local.winfixbuf = true
    vim.opt_local.spell = false
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "cpp", "c" },
  group = general_group,
  callback = function()
    -- This fixes an issue with nvim-cmp -- see https://github.com/hrsh7th/nvim-cmp/issues/1035#issuecomment-1195456419
    vim.opt_local.cindent = false
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown" },
  group = general_group,
  callback = function()
    vim.opt_local.wrap = true
    vim.opt_local.conceallevel = 3
    vim.opt_local.colorcolumn = "100"
  end,
})
-- A terrible way to handle symlinks
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function(params)
    local fname = params.file
    local resolved_fname = vim.fn.resolve(fname)
    if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
      return
    end
    vim.print("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
    vim.schedule(function()
      local cursor = vim.api.nvim_win_get_cursor(0)
      vim.cmd.bwipeout({ params.buf, bang = true })
      vim.api.nvim_command("edit " .. resolved_fname)
      vim.api.nvim_win_set_cursor(0, cursor)
    end)
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("TermOpen", {
  callback = function()
    vim.opt_local.signcolumn = "no"
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.winfixbuf = true
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    vim.keymap.set({ "n", "i" }, "<C-k>", function()
      local cmp = require("cmp")
      if cmp.visible() then
        cmp.close()
      end
      vim.lsp.buf.signature_help()
    end, { buffer = args.buf, silent = true })
    vim.keymap.set(
      { "n", "v" },
      "<F3>",
      vim.lsp.buf.code_action,
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gi",
      set_clangd_opening_path(vim.lsp.buf.implementation),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gr",
      set_clangd_opening_path(vim.lsp.buf.references),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set(
      "n",
      "gd",
      set_clangd_opening_path(vim.lsp.buf.definition),
      { buffer = args.buf, silent = true }
    )
    vim.keymap.set("n", "<F2>", vim.lsp.buf.rename, { buffer = args.buf, silent = true })
    vim.keymap.set("n", "<leader>f", function()
      vim.lsp.buf.format({ async = true })
    end, { buffer = args.buf, silent = true })
    vim.keymap.set({ "i", "n" }, "<M-i>", function()
      return vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
    end, { buffer = args.buf, silent = true })
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    client.server_capabilities.semanticTokensProvider = nil
    -- if client.supports_method("textDocument/documentHighlight") then
    --   local group =
    --     vim.api.nvim_create_augroup(string.format("lsp-%s-%s", args.buf, args.data.client_id), {})
    --   vim.api.nvim_create_autocmd("CursorHold", {
    --     group = group,
    --     buffer = args.buf,
    --     callback = vim.lsp.buf.document_highlight,
    --   })
    --   vim.api.nvim_create_autocmd("CursorMoved", {
    --     group = group,
    --     buffer = args.buf,
    --     callback = function()
    --       pcall(vim.lsp.util.buf_clear_references, args.buf)
    --     end,
    --   })
    -- end
  end,
  group = lsp_group,
})

vim.api.nvim_create_autocmd("LspDetach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)

    if client:supports_method("textDocument/documentHighlight") then
      local group =
        vim.api.nvim_create_augroup(string.format("lsp-%s-%s", args.buf, args.data.client_id), {})
      pcall(vim.api.nvim_del_augroup_by_name, group)
    end
  end,
})

vim.api.nvim_create_autocmd("BufNewFile", {
  group = vim.api.nvim_create_augroup("templates", { clear = true }),
  desc = "Load template file",
  callback = function(args)
    local fname = vim.fn.fnamemodify(args.file, ":t")
    local ext = vim.fn.fnamemodify(args.file, ":e")
    for _, candidate in ipairs({ fname, ext }) do
      local templates_dir =
        vim.fs.joinpath(myconfigs_path, "neovim", ".config", "nvim", "templates")
      local tpl = vim.fs.joinpath(templates_dir, candidate .. ".tpl")
      local stpl = vim.fs.joinpath(templates_dir, candidate .. ".stpl")
      if vim.uv.fs_stat(tpl) then
        vim.cmd("0r " .. tpl)
        return
      elseif vim.uv.fs_stat(stpl) then
        local f = io.open(stpl, "r")
        if f then
          local content = f:read("*a")
          vim.snippet.expand(content)
          return
        end
      end
    end
  end,
})

-- Float image preview: show on hover, close when cursor moves away
vim.api.nvim_create_autocmd("CursorMoved", {
  group = general_group,
  callback = imgcat.update,
})
vim.api.nvim_create_autocmd({ "TextChangedI", "CursorMovedI" }, {
  group = general_group,
  callback = imgcat.update_insert,
})

vim.api.nvim_create_autocmd({ "BufLeave", "WinLeave" }, {
  group = general_group,
  callback = imgcat.close,
})

vim.api.nvim_create_user_command("Rename", function(kwargs)
  local buf = vim.api.nvim_get_current_buf()
  local from = vim.api.nvim_buf_get_name(buf)
  local to = kwargs.args
  vim.fn.mkdir(vim.fs.dirname(to), "p")
  local changes = {
    files = {
      {
        oldUri = vim.uri_from_fname(from),
        newUri = vim.uri_from_fname(to),
      },
    },
  }

  local clients = vim.lsp.get_clients()
  for _, client in ipairs(clients) do
    if client.supports_method("workspace/willRenameFiles") then
      local resp = client.request_sync("workspace/willRenameFiles", changes, 1000, 0)
      if resp and resp.result ~= nil then
        vim.lsp.util.apply_workspace_edit(resp.result, client.offset_encoding)
      end
    end
  end

  if vim.fn.rename(from, to) == 0 then
    vim.cmd.edit(to)
    vim.api.nvim_buf_delete(buf, { force = true })
    vim.fn.delete(from)
  end

  for _, client in ipairs(clients) do
    if client.supports_method("workspace/didRenameFiles") then
      client.notify("workspace/didRenameFiles", changes)
    end
  end
end, { complete = "file", nargs = 1 })

local get_rust_lsp_client = function()
  local clients = vim.lsp.get_clients({ name = "rust-langserver" })
  if #clients == 0 then
    return
  end
  assert(#clients == 1, "Multiple rust-analyzer clients attached to this buffer")
  return clients[1]
end
vim.api.nvim_create_user_command("RustReloadWorkspace", function()
  local client = get_rust_lsp_client()
  vim.notify("Reloading Cargo Workspace")
  client.request("rust-analyzer/reloadWorkspace", nil, function(err)
    if err then
      vim.notify("Error reloading Cargo workspace: " .. vim.inspect(err), vim.log.levels.WARN)
    end
    vim.notify("Cargo workspace reloaded")
  end)
end, {})
vim.api.nvim_create_user_command("RustExpandMacro", function()
  local client = get_rust_lsp_client()
  if not client then
    vim.notify("rust-analyzer is not attached to this buffer", vim.log.levels.WARN)
    return
  end
  vim.lsp.buf_request_all(
    0,
    "rust-analyzer/expandMacro",
    vim.lsp.util.make_position_params(0, client.offset_encoding),
    function(result)
      vim.cmd.vsplit()
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_win_set_buf(0, buf)
      if result then
        vim.api.nvim_set_option_value("filetype", "rust", { buf = 0 })
        for _, res in pairs(result) do
          if res and res.result and res.result.expansion then
            vim.api.nvim_buf_set_lines(buf, -1, -1, false, vim.split(res.result.expansion, "\n"))
          else
            vim.api.nvim_buf_set_lines(buf, -1, -1, false, {
              "No expansion available.",
            })
          end
        end
      else
        vim.api.nvim_buf_set_lines(buf, -1, -1, false, {
          "Error: No result returned.",
        })
      end
    end
  )
end, {})

-----------------
--- LSP Setup ---
-----------------

local servers = {
  ts_ls = {
    name = "typescript-language-server",
    cmd = { "bunx", "typescript-language-server", "--stdio" },
    filetypes = {
      "javascript",
      "javascriptreact",
      "javascript.jsx",
      "typescript",
      "typescriptreact",
      "typescript.tsx",
    },
  },
  yamlls = {
    name = "yamlls",
    cmd = { "bunx", "yaml-language-server", "--stdio" },
    filetypes = { "yaml" },
    settings = {
      yaml = {
        schemas = {
          ["https://json.schemastore.org/pre-commit-config.json"] = {
            ".pre-commit-config.yml",
            ".pre-commit-config.yaml",
          },
          ["https://json.schemastore.org/github-action.json"] = {
            "action.yml",
            "action.yaml",
          },
          ["https://json.schemastore.org/github-workflow.json"] = {
            ".github/workflows/**.yml",
            ".github/workflows/**.yaml",
          },
          ["https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json"] = {
            "docker-compose.yml",
          },
        },
      },
    },
  },
  {
    name = "taplo",
    filetypes = { "toml" },
    cmd = {
      "taplo",
      "lsp",
      "--config",
      vim.fs.joinpath(myconfigs_path, "taplo.toml"),
      "stdio",
    },
  },
  {
    name = "clangd",
    filetypes = { "c", "cpp", "cuda" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "lsps", "bin", "clangd"),
      "--completion-style=detailed",
      -- "-log=verbose"
    },
    init_options = function()
      return {
        clangdFileStatus = true,
      }
    end,
  },
  {
    name = "efm",
    filetypes = {
      "python",
      "cmake",
      "json",
      "markdown",
      "rst",
      "sh",
      "tex",
      "yaml",
      "lua",
      "dockerfile",
      "xml",
      "zig",
    },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "lsps", "bin", "efm-langserver"),
      -- "-loglevel=5", "-logfile=/tmp/efm.log"
    },
    init_options = function()
      return {
        documentFormatting = true,
        documentRangeFormatting = true,
        hover = false,
        documentSymbol = true,
        codeAction = true,
        completion = false,
      }
    end,
    settings = {
      languages = {
        zig = {
          {
            formatCommand = "zig fmt --stdin",
            formatStdin = true,
          },
        },
        python = {
          {
            formatCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "black"
            ) .. " --quiet -",
            formatStdin = true,
          },
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "ruff"
            ) .. " check --output-format=concise --quiet ${INPUT}",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c: %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
            lintIgnoreExitCode = true,
          },
        },
        cmake = {
          {
            lintAfterOpen = true,
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "cmake-lint"
            ) .. " ${INPUT}",
            lintFormats = {
              "%f:%l: %m",
            },
          },
          {
            formatCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "cmake-format -"
            ),
            formatStdin = true,
          },
        },
        json = {
          {
            formatCommand = "bunx @fsouza/prettierd ${INPUT}",
            formatStdin = true,
            rootMarkers = {
              ".prettierrc",
              ".prettierrc.json",
              ".prettierrc.js",
              ".prettierrc.yml",
              ".prettierrc.yaml",
              ".prettierrc.json5",
              ".prettierrc.mjs",
              ".prettierrc.cjs",
              ".prettierrc.toml",
            },
          },
        },
        markdown = {
          {
            formatCommand = "pandoc -f markdown -t gfm -sp --tab-stop=2",
            formatStdin = true,
          },
        },
        rst = {
          {
            formatCommand = "pandoc -f rst -t rst -s --columns=79",
            formatStdin = true,
          },
          {
            lintCommand = "rstcheck -",
            lintStdin = true,
            lintFormats = {
              "%f:%l: (%tNFO/1) %m",
              "%f:%l: (%tARNING/2) %m",
              "%f:%l: (%tRROR/3) %m",
              "%f:%l: (%tEVERE/4) %m",
            },
          },
        },
        sh = {
          {
            lintCommand = "shellcheck -f gcc -x -",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c: %trror: %m",
              "%f:%l:%c: %tarning: %m",
              "%f:%l:%c: %tote: %m",
            },
          },
        },
        tex = {
          {
            lintCommand = "chktex -v0 -q",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c:%m",
            },
          },
        },
        yaml = {
          {
            lintCommand = vim.fs.joinpath(
              myconfigs_path,
              ".pixi",
              "envs",
              "linters",
              "bin",
              "yamllint"
            ) .. " -f parsable -",
            lintStdin = true,
          },
          {
            prefix = "actionlint",
            lintCommand = "bash -c \"[[ '${INPUT}' =~ \\\\.github/workflows/ ]]\" && actionlint -oneline -no-color -",
            lintStdin = true,
            lintFormats = {
              "%f:%l:%c: %m",
            },
            rootMarkers = { ".github" },
          },
        },
        lua = {
          {
            formatCommand = "stylua --search-parent-directories -",
            formatStdin = true,
          },
        },
        dockerfile = {
          {
            lintCommand = "hadolint --no-color",
            lintFormats = {
              "%f:%l %m",
            },
            lintSeverity = vim.diagnostic.severity.WARN,
          },
        },
      },
    },
  },
  {
    name = "lua-langserver-server",
    filetypes = { "lua" },
    cmd = { vim.env.HOME .. "/.config/lua-lsp/bin/lua-language-server" },
    settings = {
      Lua = {
        hint = {
          enable = true,
        },
        format = {
          enable = false,
        },
        runtime = {
          version = "LuaJIT",
        },
        diagnostics = {
          globals = { "vim" },
        },
        workspace = {
          library = vim.api.nvim_get_runtime_file("", true),
          checkThirdParty = false,
        },
        telemetry = {
          enable = false,
        },
      },
    },
  },
  {
    name = "rust-langserver",
    filetypes = { "rust" },
    cmd = {
      vim.env.HOME .. "/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rust-analyzer",
    },
    settings = {
      -- to enable rust-analyzer settings visit:
      -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
      -- https://rust-analyzer.github.io/book/configuration.html
      ["rust-analyzer"] = {
        check = true,
        completion = {
          snippets = {
            custom = {
              ["main"] = {
                prefix = "main_result",
                body = {
                  "fn main() -> Result<(), Box<dyn Error>> {",
                  "\t${1:unimplemented!();}",
                  "\tOk(())",
                  "}",
                },
                requires = "std::error::Error",
                description = "main function with Result",
                scope = "item",
              },
            },
          },
        },
      },
    },
  },
  {
    name = "zls",
    filetypes = { "zig" },
    cmd = { "zls" },
  },
  {
    name = "cmake_language_server",
    filetypes = { "cmake" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "cmake-lsp", "bin", "cmake-language-server"),
    },
    init_options = function(file)
      local root_dir = root_dirs.cmake(file)
      if not root_dir then
        return {}
      end
      local cmake_settings_filename = vim.fs.joinpath(root_dir, ".vscode", "settings.json")
      local settings = vim.fn.json_decode(vim.fn.readfile(cmake_settings_filename))
      return {
        buildDirectory = settings["cmake.buildDirectory"],
      }
    end,
  },
  -- {
  --   cmd = { "ty", "server" },
  --   filetypes = { "python" },
  --   root_markers = { "ty.toml", "pyproject.toml", ".git" },
  --     settings = {
  --       -- ty = {
  --       --   diagnosticMode = 'workspace',
  --       -- },
  --     },
  --   -- init_options = function(file)
  --     -- return settings
  --     -- if vim.env.CONDA_PREFIX then
  --     --   return {
  --     --     settings = {
  --     --       environment = {
  --     --         python = vim.env.CONDA_PREFIX,
  --     --       },
  --     --     },
  --     --   }
  --     -- end
  --     -- local pixi = vim.fs.find(".pixi", {
  --     --   upward = true,
  --     --   stop = vim.uv.os_homedir(),
  --     --   path = vim.uv.fs_realpath(file),
  --     --   type = "directory",
  --     -- })
  --     -- if #pixi > 0 then
  --     --   local pixi_python_executable = vim.fs.joinpath(pixi[1], "envs", "default", "bin", "python")
  --     --   if vim.uv.fs_stat(pixi_python_executable) then
  --     --     return {
  --     --       settings = {
  --     --         environment = {
  --     --           python = pixi[1] .. "/envs/default",
  --     --         },
  --     --       },
  --     --     }
  --     --   end
  --     -- end
  --     -- return {}
  --   -- end,
  -- },
  -- {
  --   name = "pyrefly",
  --   filetypes = { "python" },
  --   cmd = {
  --     "pyrefly",
  --     "lsp",
  --   },
  -- },
  -- {
  --   Doesn't work with bindings (import mujoco;mujoco.XXX) doesn't complete MjModel etc
  --   name = "zubanls",
  --   filetypes = { "python" },
  --   cmd = { "zuban", "server" },
  -- },
  {
    name = "jedi_language_server",
    filetypes = { "python" },
    cmd = {
      vim.fs.joinpath(myconfigs_path, ".pixi", "envs", "python-lsp", "bin", "jedi-language-server"),
      -- "-vv",
      -- "--log-file",
      -- "/tmp/logging.txt",
    },
    init_options = function(file)
      local options = {
        workspace = {
          extraPaths = {
            vim.env.HOME .. "/.cache/python-stubs",
          },
          environmentPath = "/usr/bin/python3",
        },
      }
      if vim.env.CONDA_PREFIX then
        options.workspace.environmentPath = vim.env.CONDA_PREFIX .. "/bin/python"
      end

      local venv = vim.fs.find(".venv", {
        upward = true,
        stop = vim.uv.os_homedir(),
        path = vim.uv.fs_realpath(file),
        type = "directory",
      })

      if #venv > 0 then
        local venv_python_executable = vim.fs.joinpath(venv[1], "bin", "python")
        if vim.uv.fs_stat(venv_python_executable) then
          options.workspace.environmentPath = venv[1]
          return options
        end
      end

      local pixi = vim.fs.find(".pixi", {
        upward = true,
        stop = vim.uv.os_homedir(),
        path = vim.uv.fs_realpath(file),
        type = "directory",
      })
      if #pixi > 0 then
        local pixi_python_executable = vim.fs.joinpath(pixi[1], "envs", "default", "bin", "python")
        if vim.uv.fs_stat(pixi_python_executable) then
          options.workspace.environmentPath = pixi[1] .. "/envs/default"
        end
      end
      return options
    end,
  },
  {
    name = "marksman",
    filetypes = { "markdown" },
    cmd = { "marksman", "server" },
  },
  {
    name = "lemminx",
    filetypes = { "xml" },
    cmd = { "lemminx" },
  },
  {
    name = "docker-ls",
    cmd = { "bunx", "dockerfile-language-server-nodejs", "--stdio" },
    filetypes = {
      "dockerfile",
    },
  },
}

for _, server in pairs(servers) do
  if vim.fn.executable(server.cmd[1]) == 1 then
    vim.api.nvim_create_autocmd("FileType", {
      pattern = server.filetypes,
      group = lsp_group,
      callback = function(args)
        -- Don't start LSP for floating windows
        if vim.api.nvim_win_get_config(0).relative ~= "" then
          return
        end
        local capabilities =
          vim.tbl_deep_extend("force", vim.lsp.protocol.make_client_capabilities(), {
            -- Rust specific capabilities
            experimental = {
              localDocs = true, -- TODO: Support experimental/externalDocs
              hoverActions = true,
            },
            workspace = {
              didChangeWatchedFiles = {
                dynamicRegistration = true,
              },
            },
          })

        local root_dir = root_dirs[args.match] or function() end
        vim.lsp.start({
          name = server.name,
          cmd = server.cmd,
          on_attach = function(_, _) end,
          capabilities = capabilities,
          settings = server.settings or vim.empty_dict(),
          init_options = server.init_options and server.init_options(args.file) or vim.empty_dict(),
          root_dir = root_dir(args.file) or vim.fs.root(args.file, { ".git" }),
        })
      end,
    })
  end
end

-- TODO: Add https://github.com/JafarAbdi/myconfigs/commit/97ba4ecb55b5972c5bc43ce020241fb353de433f
local snippets = {
  all = {
    {
      trigger = "Current date",
      description = "Insert the current date",
      body = function()
        return os.date("%Y-%m-%d %H:%M:%S%z")
      end,
    },
    {
      trigger = "Current month name",
      description = "Insert the name of the current month",
      body = function()
        return os.date("%B")
      end,
    },
    {
      trigger = "Current filename",
      description = "Insert the current file name",
      body = function()
        return vim.fn.expand("%:t")
      end,
    },
  },
  cpp = {
    {
      trigger = "main",
      description = "Standard main function",
      body = [[
int main (int argc, char *argv[])
{
  $0
  return 0;
}]],
    },
  },
  cmake = {
    {
      trigger = "print_all_variables",
      description = "Print all cmake variables",
      body = [[
get_cmake_property(_variableNames VARIABLES)
list (SORT _variableNames)
foreach (_variableName \${_variableNames})
  message(STATUS \${_variableName}=\${\${_variableName}})
endforeach()${0}]],
    },
  },
}
snippets.c = snippets.cpp
snippets.cuda = snippets.cpp

local get_buffer_snippets = function(filetype)
  local ft_snippets = {}
  vim.list_extend(ft_snippets, snippets.all)
  if filetype and snippets[filetype] then
    vim.list_extend(ft_snippets, snippets[filetype])
  end
  return ft_snippets
end

require("lazy").setup({
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
  {
    "github/copilot.vim",
    lazy = false, -- Load at startup so VimEnter autocmd fires and copilot#Init() runs
    init = function()
      vim.g.copilot_node_command = myconfigs_path .. "/.pixi/envs/nodejs/bin/node"
      vim.g.copilot_no_tab_map = true
      vim.g.copilot_no_maps = true
      vim.g.copilot_assume_mapped = true
      vim.g.copilot_tab_fallback = ""
      vim.g.copilot_filetypes = {
        ["*"] = true,
        gitcommit = false,
      }
    end,
    config = function()
      vim.keymap.set("i", "<M-e>", function()
        return vim.api.nvim_feedkeys(
          vim.fn["copilot#Accept"](vim.api.nvim_replace_termcodes("<Tab>", true, true, true)),
          "n",
          true
        )
      end, { expr = true })
      vim.keymap.set("i", "<c-;>", function()
        return vim.fn["copilot#Next"]()
      end, { expr = true })
      vim.keymap.set("i", "<c-,>", function()
        return vim.fn["copilot#Previous"]()
      end, { expr = true })
      vim.keymap.set("i", "<c-c>", function()
        -- Leave insert mode and cancel completion
        vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
        return vim.fn["copilot#Dismiss"]()
      end, { expr = true })
      vim.keymap.set("i", "<C-M-l>", function()
        return vim.fn["copilot#AcceptLine"]()
      end, { expr = true, silent = true })
      vim.keymap.set("i", "<C-M-e>", function()
        return vim.fn["copilot#AcceptWord"]()
      end, { expr = true, silent = true })
    end,
  },
  {
    "hrsh7th/nvim-cmp",
    event = { "InsertEnter" },
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
    },
    config = function()
      local cmp = require("cmp")
      local compare = require("cmp.config.compare")
      local cache = {}
      local cmp_source = {
        complete = function(_, params, callback)
          local bufnr = vim.api.nvim_get_current_buf()
          if not cache[bufnr] then
            local completion_items = vim.tbl_map(function(snippet)
              ---@type lsp.CompletionItem
              local item = {
                documentation = {
                  kind = cmp.lsp.MarkupKind.PlainText,
                  value = snippet.description or "",
                },
                word = snippet.trigger,
                label = snippet.trigger,
                kind = vim.lsp.protocol.CompletionItemKind.Snippet,
                insertText = type(snippet.body) == "function" and snippet.body() or snippet.body,
                insertTextFormat = vim.lsp.protocol.InsertTextFormat.Snippet,
              }
              return item
            end, get_buffer_snippets(params.context.filetype))
            cache[bufnr] = completion_items
          end

          callback(cache[bufnr])
        end,
      }

      cmp.register_source("snippets", cmp_source)
      cmp.setup({
        snippet = {
          expand = function(args)
            vim.snippet.expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["Tab"] = cmp.config.disable,
          ["S-Tab"] = cmp.config.disable,
          ["<C-f>"] = cmp.config.disable,
          ["<C-d>"] = cmp.mapping.scroll_docs(4),
          ["<C-u>"] = cmp.mapping.scroll_docs(-4),
          ["<CR>"] = cmp.mapping.confirm({
            behavior = cmp.ConfirmBehavior.Insert,
            select = false,
          }),
        }),
        sources = {
          { name = "nvim_lsp" },
          { name = "snippets" },
          {
            name = "buffer",
            option = {
              get_bufnrs = function()
                return vim.api.nvim_list_bufs()
              end,
            },
          },
        },
        formatting = {
          format = function(entry, vim_item)
            vim_item.menu = ({
              buffer = "[Buffer]",
              nvim_lsp = "[LSP]",
              snippets = "[Snippet]",
            })[entry.source.name]
            local label = vim_item.abbr
            -- https://github.com/hrsh7th/nvim-cmp/discussions/609
            local ELLIPSIS_CHAR = "…"
            local MAX_LABEL_WIDTH = math.floor(vim.o.columns * 0.4)
            local truncated_label = vim.fn.strcharpart(label, 0, MAX_LABEL_WIDTH)
            if truncated_label ~= label then
              vim_item.abbr = truncated_label .. ELLIPSIS_CHAR
            end
            return vim_item
          end,
        },
        sorting = {
          comparators = {
            compare.offset,
            compare.exact,
            -- compare.score,
            -- https://github.com/p00f/clangd_extensions.nvim/blob/main/lua/clangd_extensions/cmp_scores.lua
            function(entry1, entry2)
              local diff
              if entry1.completion_item.score and entry2.completion_item.score then
                diff = (entry2.completion_item.score * entry2.score)
                  - (entry1.completion_item.score * entry1.score)
              else
                diff = entry2.score - entry1.score
              end
              if diff < 0 then
                return true
              elseif diff > 0 then
                return false
              end
            end,
            -- https://github.com/lukas-reineke/cmp-under-comparator
            function(entry1, entry2)
              local _, entry1_under = entry1.completion_item.label:find("^_+")
              local _, entry2_under = entry2.completion_item.label:find("^_+")
              entry1_under = entry1_under or 0
              entry2_under = entry2_under or 0
              if entry1_under > entry2_under then
                return false
              elseif entry1_under < entry2_under then
                return true
              end
            end,
            compare.recently_used,
            compare.kind,
            compare.sort_text,
            compare.length,
            compare.order,
          },
        },
      })
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    build = ":TSUpdate",
    lazy = false,
    config = function()
      require("nvim-treesitter").install({
        "bash",
        "c",
        "cmake",
        "comment",
        "cpp",
        "dockerfile",
        "fish",
        "html",
        "http",
        "javascript",
        "json",
        "latex",
        "lua",
        "make",
        "markdown",
        "markdown_inline",
        "ninja",
        "proto",
        "python",
        "query",
        "rst",
        "rust",
        "toml",
        "typescript",
        "vim",
        "vimdoc",
        "xml",
        "yaml",
        "zig",
      })
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter-textobjects",
    branch = "main",
    event = { "VeryLazy" },
    config = function()
      local ts_textobjects = require("nvim-treesitter-textobjects")
      ts_textobjects.setup({
        select = { lookahead = true },
        move = { set_jumps = true },
      })

      local select = require("nvim-treesitter-textobjects.select").select_textobject
      for _, mapping in ipairs({
        { "af", "@function.outer" },
        { "if", "@function.inner" },
        { "ac", "@class.outer" },
        { "ic", "@class.inner" },
        { "ap", "@parameter.outer" },
        { "ip", "@parameter.inner" },
        { "ao", "@conditional.outer" },
        { "io", "@conditional.inner" },
        { "al", "@loop.outer" },
        { "il", "@loop.inner" },
      }) do
        vim.keymap.set({ "x", "o" }, mapping[1], function()
          select(mapping[2], "textobjects")
        end)
      end

      local swap = require("nvim-treesitter-textobjects.swap")
      vim.keymap.set("n", "<leader>a", function()
        swap.swap_next("@parameter.inner")
      end)
      vim.keymap.set("n", "<leader>A", function()
        swap.swap_previous("@parameter.inner")
      end)

      local move = require("nvim-treesitter-textobjects.move")
      for _, mapping in ipairs({
        { "]f", "goto_next_start", "@function.outer" },
        { "]c", "goto_next_start", "@class.outer" },
        { "]F", "goto_next_end", "@function.outer" },
        { "]C", "goto_next_end", "@class.outer" },
        { "[f", "goto_previous_start", "@function.outer" },
        { "[c", "goto_previous_start", "@class.outer" },
        { "[F", "goto_previous_end", "@function.outer" },
        { "[C", "goto_previous_end", "@class.outer" },
      }) do
        vim.keymap.set({ "n", "x", "o" }, mapping[1], function()
          move[mapping[2]](mapping[3], "textobjects")
        end)
      end
    end,
  },
}, {
  defaults = {
    lazy = true, -- every plugin is lazy-loaded by default
  },
  checker = { enabled = false }, -- automatically check for plugin updates
  performance = {
    rtp = {
      disabled_plugins = {
        "matchparen",
      },
    },
  },
  change_detection = {
    enabled = false,
    notify = false,
  },
})

-- Enable treesitter highlighting for filetypes with an installed parser
vim.api.nvim_create_autocmd("FileType", {
  group = general_group,
  callback = function(args)
    local lang = vim.treesitter.language.get_lang(args.match)
    if lang and pcall(vim.treesitter.language.add, lang) then
      pcall(vim.treesitter.start)
    end
  end,
})

---------------
--- Options ---
---------------

vim.diagnostic.config({
  underline = false,
  update_in_insert = true,
  virtual_text = {
    severity = vim.diagnostic.severity.ERROR,
    source = "if_many",
  },
  severity_sort = true,
  signs = false,
  jump = {
    float = true,
  },
})
vim.opt.smoothscroll = true
vim.opt.foldenable = false
vim.opt.number = true
vim.opt.mouse = "a"
vim.opt.undofile = true
vim.opt.breakindent = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.updatetime = 250
vim.opt.tabstop = 2
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.autoindent = true
vim.opt.copyindent = true
vim.opt.cursorline = true
vim.opt.termguicolors = true
vim.opt.hlsearch = false
vim.opt.linebreak = true
vim.opt.autowrite = true
vim.opt.inccommand = "nosplit"
vim.opt.wrap = false
vim.opt.showmatch = true
vim.opt.title = true
vim.opt.relativenumber = true
vim.opt.shortmess:append("wIA")
vim.opt.matchtime = 2
vim.opt.matchpairs:append("<:>")
vim.opt.swapfile = false
vim.opt.signcolumn = "number"
vim.opt.laststatus = 3
vim.opt.statusline = [[%<%f %m%r%{luaeval("lsp_status()")}]]
vim.opt.smartindent = false
vim.opt.pumheight = 20
vim.opt.completeopt = "menuone,noselect,noinsert,fuzzy"
vim.opt.complete:append({ "U", "i", "d" })
vim.opt.wildmode = "longest:full,full"
vim.opt.wildignore:append({ "*.pyc", ".git", ".idea", "*.o" })
vim.opt.wildoptions = "pum,tagfile,fuzzy"
vim.opt.suffixes:append({ ".pyc", ".tmp" })
vim.opt.spell = true

if vim.fn.executable("rg") == 1 then
  vim.opt.grepprg = "rg --no-messages --vimgrep --no-heading --smart-case"
  vim.opt.grepformat = "%f:%l:%c:%m,%f:%l:%m"
end

vim.g.mapleader = " "
vim.g.maplocalleader = " "
if os.getenv("SSH_CLIENT") then
  vim.g.clipboard = "osc52"
end

vim.treesitter.language.register("xml", { "xacro", "urdf", "srdf" })
vim.treesitter.language.register("cpp", { "cuda" })
vim.filetype.add({
  pattern = {
    [".*.bazelrc"] = "bazelrc",
  },
  extension = {
    launch = "xml",
    test = "xml",
    urdf = "xml",
    srdf = "xml",
    xacro = "xml",
    install = "text",
    repos = "yaml",
    jinja = "jinja",
    jinja2 = "jinja",
    j2 = "jinja",
  },
})

vim.cmd.packadd("cfilter")
vim.cmd.packadd("nvim.undotree")

vim.cmd.colorscheme("vim")
vim.cmd.colorscheme("onedark")
---------------
--- Keymaps ---
---------------

local fzy = require("fzy")
fzy.command = function(opts)
  return string.format(
    'fzf --height %d --prompt "%s" --no-multi --preview=""',
    opts.height,
    vim.F.if_nil(opts.prompt, "")
  )
end

local q = require("qwahl")

local function try_jump(direction, key)
  if vim.snippet.active({ direction = direction }) then
    return string.format("<cmd>lua vim.snippet.jump(%d)<cr>", direction)
  end
  return key
end

vim.keymap.set({ "i", "s" }, "<Tab>", function()
  return try_jump(1, "<Tab>")
end, { expr = true })
vim.keymap.set({ "i", "s" }, "<S-Tab>", function()
  return try_jump(-1, "<S-Tab>")
end, { expr = true })
-- Incremental treesitter node selection (built-in an/in) with old keymaps
vim.keymap.set("n", "<A-w>", "van", { remap = true, silent = true })
vim.keymap.set("x", "<A-w>", "an", { remap = true, silent = true })
vim.keymap.set("x", "<A-S-w>", "in", { remap = true, silent = true })

vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set({ "i", "s" }, "<ESC>", function()
  if vim.snippet then
    vim.snippet.stop()
  end
  return "<ESC>"
end, { expr = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("n", "gs", function()
  vim.lsp.buf.document_symbol({
    on_list = function(options)
      vim.fn.setqflist({}, " ", options)
      q.quickfix()
    end,
  })
end, { silent = true })

vim.keymap.set("n", "<leader>x", function()
  run_file()
end, { silent = true })
vim.keymap.set("n", "<leader>h", q.helptags, { silent = true })
vim.keymap.set("n", "<leader><space>", q.buffers, { silent = true })
vim.keymap.set("n", "<leader>gc", q.buf_lines, { silent = true })
vim.keymap.set("n", "<C-M-s>", function()
  local cword = vim.fn.expand("<cword>")
  if cword ~= "" then
    fzy.execute(
      "rg --no-messages --no-heading --trim --line-number --smart-case " .. cword,
      fzy.sinks.edit_live_grep
    )
  end
end, { silent = true })
vim.keymap.set("n", "<M-o>", function()
  fzy.execute("fd --hidden --type f --strip-cwd-prefix", fzy.sinks.edit_file)
end, { silent = true })
vim.keymap.set("n", "<leader>j", q.jumplist, { silent = true })

-- Diagnostic keymaps
vim.keymap.set("n", "<leader>q", q.quickfix, { silent = true })
vim.keymap.set("n", "<leader>dq", function()
  q.diagnostic(0)
end, { silent = true })

local win_pre_copen = nil
vim.keymap.set("n", "<leader>c", function()
  local api = vim.api
  for _, win in pairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)
    if api.nvim_get_option_value("buftype", { buf = buf }) == "quickfix" then
      vim.cmd.cclose()
      if win_pre_copen then
        local ok, w = pcall(api.nvim_win_get_number, win_pre_copen)
        if ok and api.nvim_win_is_valid(w) then
          api.nvim_set_current_win(w)
        end
        win_pre_copen = nil
      end
      return
    end
  end

  -- no quickfix buffer found so far, so show it
  win_pre_copen = api.nvim_get_current_win()
  vim.cmd.copen({ mods = { split = "botright" } })
end, { silent = true })

local center_screen = function(command)
  return function()
    local ok, _ = pcall(command)
    if ok then
      vim.cmd.normal("zz")
    end
  end
end

vim.keymap.set("n", "]q", center_screen(vim.cmd.cnext), { silent = true })
vim.keymap.set("n", "[q", center_screen(vim.cmd.cprevious), { silent = true })
vim.keymap.set("n", "]Q", center_screen(vim.cmd.clast), { silent = true })
vim.keymap.set("n", "[Q", center_screen(vim.cmd.cfirst), { silent = true })
vim.keymap.set("n", "]a", center_screen(vim.cmd.next), { silent = true })
vim.keymap.set("n", "[a", center_screen(vim.cmd.previous), { silent = true })
vim.keymap.set("n", "]A", center_screen(vim.cmd.last), { silent = true })
vim.keymap.set("n", "[A", center_screen(vim.cmd.first), { silent = true })
vim.keymap.set("n", "]l", center_screen(vim.cmd.lnext), { silent = true })
vim.keymap.set("n", "[l", center_screen(vim.cmd.lprevious), { silent = true })
vim.keymap.set("n", "]L", center_screen(vim.cmd.lfirst), { silent = true })
vim.keymap.set("n", "[L", center_screen(vim.cmd.llast), { silent = true })
vim.keymap.set("n", "]t", center_screen(vim.cmd.tn), { silent = true })
vim.keymap.set("n", "[t", center_screen(vim.cmd.tp), { silent = true })

vim.keymap.set({ "n" }, "<leader>m", function()
  local buffer_mark_names = "abcdefghijklmnopqrstuvwxyz"
  local global_mark_names = buffer_mark_names:upper()
  local marks = {}
  for i = 1, #buffer_mark_names do
    local letter = buffer_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_buf_get_mark, 0, letter) -- Returns (0, 0) if not set
    if ok and mark[1] ~= 0 then
      table.insert(marks, { name = letter, value = mark })
    end
  end
  for i = 1, #global_mark_names do
    local letter = global_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_get_mark, letter, {}) -- Returns (0, 0, 0, "") if not set
    if ok and not (mark[1] == 0 and mark[2] == 0 and mark[3] == 0 and mark[4] == "") then
      if vim.uv.fs_stat(vim.fs.normalize(mark[4])) then
        table.insert(marks, { name = letter, value = mark })
      end
    end
  end
  local current_bufnr = vim.api.nvim_get_current_buf()
  fzy.pick_one(marks, "Mark: ", function(item)
    if item == nil then
      return
    end
    if #item.value == 4 then
      return string.format(
        "[%s] %s: %s",
        item.name,
        item.value[4],
        item.value[3] ~= 0
            and vim.api.nvim_buf_get_lines(item.value[3], item.value[1] - 1, item.value[1], true)[1]
          or "Unloaded Buffer"
      )
    end
    return string.format(
      "[%s] %s: %s",
      item.name,
      "Current Buffer",
      vim.api.nvim_buf_get_lines(current_bufnr, item.value[1] - 1, item.value[1], true)[1]
    )
  end, function(item)
    if item ~= nil then
      vim.cmd.normal("`" .. item.name)
    end
  end)
end)
