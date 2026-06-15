-- Session persistence. Each GUI process autosaves its whole layout to a numbered
-- file under XDG_STATE_HOME; on reboot you re-attach to a previous one via
-- LEADER+R. A session's owner is stamped with its pid + process start_time, so a
-- dead session is detected (its pid no longer resolves to the same process) and
-- its number reused -- no naming, no time-based deletion. Re-attach restores the
-- layout + scrollback and types each pane's command at the prompt without running
-- it.
--
-- Wire up in wezterm.lua:
--   local sessions = require("sessions")
--   wezterm.on("gui-startup", function() sessions.on_gui_startup() end)
--   -- in config.keys:
--   { key = "R", mods = "LEADER", action = sessions.restore_action() },
--   { key = "D", mods = "LEADER", action = sessions.delete_action() },
local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action
local procinfo = wezterm.procinfo

local M = {}

local state_dir = (os.getenv("XDG_STATE_HOME") or (wezterm.home_dir .. "/.local/state"))
  .. "/wezterm/sessions"

M.max_scrollback_lines = 2000
M.autosave_interval_seconds = 60
-- backstop only: keep at most this many dead sessions; oldest roll off first.
-- the normal flow (re-attach / LEADER+D) keeps the count near your live GUIs.
M.max_saved_sessions = 20

-- shells running idle in a pane have no "command" worth restoring
local shells = { sh = true, bash = true, zsh = true, fish = true, nu = true }

local function read_first_line(p)
  local f = io.open(p, "r")
  if not f then
    return nil
  end
  local line = f:read("*l")
  f:close()
  return line
end

local boot_id = read_first_line("/proc/sys/kernel/random/boot_id") or "unknown"

-- this process's identity (pid + start_time), used to stamp and detect session
-- ownership. computed at load so it's available even when gui-startup didn't run
-- (e.g. after a config reload in an already-running GUI).
local SELF = (function()
  local pid = procinfo.pid()
  local info = pid and procinfo.get_info_for_pid(pid)
  if info then
    return { pid = pid, start_time = info.start_time, name = info.name }
  end
end)()

local function owner_stamp()
  return { pid = SELF.pid, start_time = SELF.start_time, name = SELF.name, boot_id = boot_id }
end

-- a session is live if its pid still resolves to the same process it was saved
-- by; a reused pid (e.g. after reboot) won't match name + start_time
local function is_live(data)
  if not (data and data.pid) then
    return false
  end
  local info = procinfo.get_info_for_pid(data.pid)
  return info ~= nil and info.name == data.name and info.start_time == data.start_time
end

local function ensure_dir()
  os.execute('mkdir -p "' .. state_dir .. '"')
end

local function path(id)
  return state_dir .. "/" .. id .. ".json"
end

-- atomic: write a temp file then rename over the target, so a crash mid-write
-- can't leave a torn file (readers see the old complete copy or the new one)
local function write_json(p, tbl)
  local ok, encoded = pcall(wezterm.json_encode, tbl)
  if not ok then
    wezterm.log_error("[sessions] json_encode failed for " .. p .. ": " .. tostring(encoded))
    return false
  end
  -- per-process temp name so two GUIs racing to claim a slot can't tear it
  local tmp = p .. "." .. (SELF and SELF.pid or "0") .. ".tmp"
  local f = io.open(tmp, "w+")
  if not f then
    wezterm.log_error("[sessions] cannot open for write: " .. tmp)
    return false
  end
  f:write(encoded)
  f:close()
  local renamed, err = os.rename(tmp, p)
  if not renamed then
    wezterm.log_error("[sessions] rename failed " .. tmp .. " -> " .. p .. ": " .. tostring(err))
    os.remove(tmp)
    return false
  end
  return true
end

local function read_json(p)
  local f = io.open(p, "r")
  if not f then
    return nil
  end
  local data = f:read("*a")
  f:close()
  local ok, parsed = pcall(wezterm.json_parse, data)
  if not ok then
    wezterm.log_error("[sessions] corrupt session file " .. p .. ": " .. tostring(parsed))
    return nil
  end
  return parsed
end

local function list_files()
  local out = {}
  local ok, files = pcall(wezterm.read_dir, state_dir)
  if not ok then
    return out
  end
  for _, p in ipairs(files) do
    local n = p:match("(%d+)%.json$")
    if n then
      out[#out + 1] = { id = tonumber(n), path = p }
    end
  end
  return out
end

local function compare_pane(a, b)
  if a.left == b.left then
    return a.top < b.top
  end
  return a.left < b.left
end

local function is_right(root, p)
  return root.left + root.width < p.left
end

local function is_bottom(root, p)
  return root.top + root.height < p.top
end

local function pop_right(root, panes)
  for i, p in ipairs(panes) do
    if root.top == p.top and root.left + root.width + 1 == p.left then
      table.remove(panes, i)
      return p
    end
  end
end

local function pop_bottom(root, panes)
  for i, p in ipairs(panes) do
    if root.left == p.left and root.top + root.height + 1 == p.top then
      table.remove(panes, i)
      return p
    end
  end
end

local function is_shell(info)
  local exe = info.executable or info.name or ""
  local base = (exe:match("([^/\\]+)$") or exe):gsub("^%-", "")
  return shells[base] == true
end

-- record cwd/domain/command/scrollback on a pane node, then drop the live handle
local function capture_node(node)
  local pane = node.pane
  node.domain = pane:get_domain_name()
  local cwd = pane:get_current_working_dir()
  node.cwd = cwd and cwd.file_path or ""
  -- TODO: remote panes (ssh/sshmux/docker) get cwd + title only. wezterm's
  -- ClientPane returns None for get_foreground_process_info/_name and no-ops
  -- perform_actions, so for non-local domains we can neither capture the running
  -- command nor replay scrollback. Upstream limitation (multiplexer panes don't
  -- report process info): https://github.com/wezterm/wezterm/discussions/3648
  -- Workaround path: have remote shell integration publish the command via a user
  -- var (OSC 1337 SetUserVar), which IS synced, then read pane:get_user_vars().
  if node.domain == "local" then
    node.alt_screen = pane:is_alt_screen_active()
    local info = pane:get_foreground_process_info()
    if info and info.argv and #info.argv > 0 and not is_shell(info) then
      node.argv = info.argv
    end
    -- alt-screen scrollback is the alt buffer (e.g. nvim), not useful to replay
    if not node.alt_screen then
      local nlines = pane:get_dimensions().scrollback_rows
      if nlines > M.max_scrollback_lines then
        nlines = M.max_scrollback_lines
      end
      node.text = pane:get_lines_as_escapes(nlines)
    end
  end
  node.pane = nil
end

-- rebuild the binary split tree from a flat list of panes-with-info by coords
local function build_tree(root, panes)
  if root == nil then
    return nil
  end
  capture_node(root)
  if #panes == 0 then
    return root
  end
  local right, bottom = {}, {}
  for _, p in ipairs(panes) do
    if is_right(root, p) then
      table.insert(right, p)
    end
    if is_bottom(root, p) then
      table.insert(bottom, p)
    end
  end
  if #right > 0 then
    root.right = build_tree(pop_right(root, right), right)
  end
  if #bottom > 0 then
    root.bottom = build_tree(pop_bottom(root, bottom), bottom)
  end
  return root
end

local function pane_tree(panes)
  table.sort(panes, compare_pane)
  return build_tree(table.remove(panes, 1), panes)
end

local function tab_state(tab)
  local panes = tab:panes_with_info()
  local zoomed = false
  for _, p in ipairs(panes) do
    if p.is_zoomed then
      zoomed = true
    end
  end
  return { title = tab:get_title(), is_zoomed = zoomed, tree = pane_tree(panes) }
end

local function window_state(win)
  local ws = { workspace = win:get_workspace(), title = win:get_title(), tabs = {} }
  local tabs = win:tabs_with_info()
  for i, t in ipairs(tabs) do
    local ts = tab_state(t.tab)
    ts.is_active = t.is_active
    ws.tabs[i] = ts
  end
  ws.size = tabs[1].tab:get_size()
  return ws
end

-- the whole GUI process: every window across every workspace
local function process_state()
  local st = owner_stamp()
  st.id = wezterm.GLOBAL.session_id
  st.saved_at = os.time()
  st.active_workspace = mux.get_active_workspace()
  st.windows = {}
  for _, w in ipairs(mux.all_windows()) do
    table.insert(st.windows, window_state(w))
  end
  return st
end

local function save()
  local id = wezterm.GLOBAL.session_id
  if not id then
    return false
  end
  local st = process_state()
  if #st.windows == 0 then
    return false
  end
  return write_json(path(id), st)
end

-- keep at most max_saved_sessions dead sessions; drop the oldest by save time
local function prune_orphans()
  local orphans = {}
  for _, e in ipairs(list_files()) do
    local data = read_json(e.path)
    if data and not is_live(data) then
      orphans[#orphans + 1] = { path = e.path, saved_at = data.saved_at or 0 }
    end
  end
  if #orphans <= M.max_saved_sessions then
    return
  end
  table.sort(orphans, function(a, b)
    return a.saved_at > b.saved_at
  end)
  for i = M.max_saved_sessions + 1, #orphans do
    os.remove(orphans[i].path)
  end
end

-- reserve the lowest unused number; never reuses a dead session's file, so an
-- un-restored session is safe until you re-attach or it ages past the cap. the
-- read-back guards against two GUIs reserving the same number at once
local function claim_slot()
  ensure_dir()
  for n = 1, 1000 do
    local used = false
    for _, e in ipairs(list_files()) do
      if e.id == n then
        used = true
        break
      end
    end
    if not used then
      local st = owner_stamp()
      st.id = n
      st.saved_at = os.time()
      st.active_workspace = mux.get_active_workspace()
      st.windows = {}
      write_json(path(n), st)
      local back = read_json(path(n))
      if back and back.pid == SELF.pid and back.start_time == SELF.start_time then
        wezterm.GLOBAL.session_id = n
        wezterm.log_info("[sessions] claimed slot " .. n)
        return n
      end
    end
  end
  wezterm.log_error("[sessions] could not claim a slot (all in use?)")
end

function M.start_autosave()
  local function tick()
    local ok, err = pcall(save)
    if not ok then
      wezterm.log_error("[sessions] autosave failed: " .. tostring(err))
    end
    wezterm.time.call_after(M.autosave_interval_seconds, tick)
  end
  wezterm.time.call_after(M.autosave_interval_seconds, tick)
end

function M.on_gui_startup()
  if not SELF then
    wezterm.log_warn("[sessions] disabled: could not identify this process via procinfo")
    return
  end
  -- prune only here: growth happens at new-GUI/reboot time, which is now
  local ok, err = pcall(claim_slot)
  if not ok then
    wezterm.log_error("[sessions] claim_slot failed: " .. tostring(err))
  end
  ok, err = pcall(prune_orphans)
  if not ok then
    wezterm.log_error("[sessions] prune failed: " .. tostring(err))
  end
  M.start_autosave()
end

local function cwd_or_nil(cwd)
  if cwd and cwd ~= "" then
    return cwd
  end
end

-- a saved domain may be gone after reboot (stopped container, offline host)
local function spawnable(domain)
  if not domain or domain == "" or domain == "local" then
    return nil
  end
  local d = mux.get_domain(domain)
  if d and d:is_spawnable() then
    return domain
  end
end

-- commands are typed after a short delay (see restore); typing them inline races
-- shell startup and the keystrokes can be eaten
local restore_pending = {}

-- replay output now; queue the command to be typed at the prompt (never run)
local function restore_content(node)
  local pane = node.pane
  if node.text and node.text ~= "" then
    pane:inject_output((node.text:gsub("%s+$", "")))
  end
  if node.argv and #node.argv > 0 then
    restore_pending[#restore_pending + 1] =
      { pane = pane, text = wezterm.shell_join_args(node.argv) }
  end
end

local function spawn_child(parent, node, direction, size)
  local args = { direction = direction, cwd = cwd_or_nil(node.cwd), size = size }
  local dom = spawnable(node.domain)
  if dom then
    args.domain = { DomainName = dom }
  end
  node.pane = parent:split(args)
  if node.domain and node.domain ~= "local" and not dom then
    node.pane:inject_output(
      "[session] domain '" .. node.domain .. "' unavailable; opened local shell\r\n"
    )
  end
end

local function restore_node(node, acc)
  restore_content(node)
  if node.bottom then
    spawn_child(
      node.pane,
      node.bottom,
      "Bottom",
      node.bottom.height / (node.height + node.bottom.height)
    )
  end
  if node.right then
    spawn_child(node.pane, node.right, "Right", node.right.width / (node.width + node.right.width))
  end
  if node.is_active then
    acc.active = node.pane
  end
  if node.is_zoomed then
    acc.zoomed = true
  end
  if node.right then
    restore_node(node.right, acc)
  end
  if node.bottom then
    restore_node(node.bottom, acc)
  end
  return acc
end

local function restore_tab(tab, ts, root_pane)
  ts.tree.pane = root_pane
  if ts.title and ts.title ~= "" then
    tab:set_title(ts.title)
  end
  local acc = restore_node(ts.tree, { zoomed = false })
  if acc.active then
    acc.active:activate()
  end
  return acc.zoomed
end

local function restore_window(win, ws)
  if ws.title and ws.title ~= "" then
    win:set_title(ws.title)
  end
  local active_tab
  for i, ts in ipairs(ws.tabs) do
    local tab, root_pane
    if i == 1 then
      tab, root_pane = win:active_tab(), win:active_pane()
    else
      local args = { cwd = cwd_or_nil(ts.tree.cwd) }
      local dom = spawnable(ts.tree.domain)
      if dom then
        args.domain = { DomainName = dom }
      end
      tab, root_pane = win:spawn_tab(args)
    end
    local zoomed = restore_tab(tab, ts, root_pane)
    if ts.is_active then
      active_tab = tab
    end
    if zoomed then
      tab:set_zoomed(true)
    end
  end
  if active_tab then
    active_tab:activate()
  end
end

-- rebuild a saved session into this GUI and adopt its number (re-attach)
local function restore(id, cur_win)
  if not SELF then
    wezterm.log_error("[sessions] restore aborted: no process identity")
    return false
  end
  local data = read_json(path(id))
  if not data or not data.windows then
    wezterm.log_error("[sessions] restore: session " .. tostring(id) .. " missing or invalid")
    return false
  end
  restore_pending = {}
  for i, ws in ipairs(data.windows) do
    local win
    if i == 1 and cur_win then
      win = cur_win
    else
      local first = ws.tabs[1]
      local _, _, nw = mux.spawn_window({
        workspace = ws.workspace,
        width = ws.size and ws.size.cols or nil,
        height = ws.size and ws.size.rows or nil,
        cwd = cwd_or_nil(first.tree.cwd),
      })
      win = nw
    end
    restore_window(win, ws)
  end
  if data.active_workspace then
    mux.set_active_workspace(data.active_workspace)
  end
  local prev = wezterm.GLOBAL.session_id
  if prev and prev ~= id then
    os.remove(path(prev))
  end
  wezterm.GLOBAL.session_id = id
  -- re-stamp the adopted slot live-owned by us now (re-reading the clean on-disk
  -- copy, since the in-memory `data` now holds live pane handles), so prune and
  -- other GUIs don't treat it as a free orphan before the next save
  local fresh = read_json(path(id))
  if fresh then
    for k, v in pairs(owner_stamp()) do
      fresh[k] = v
    end
    fresh.saved_at = os.time()
    write_json(path(id), fresh)
  end
  -- type the captured commands once shells have had time to initialize
  if #restore_pending > 0 then
    local cmds = restore_pending
    restore_pending = {}
    wezterm.time.call_after(1.0, function()
      for _, c in ipairs(cmds) do
        local ok, err = pcall(function()
          c.pane:send_text(c.text)
        end)
        if not ok then
          wezterm.log_error("[sessions] typing command failed: " .. tostring(err))
        end
      end
    end)
  end
  wezterm.log_info("[sessions] re-attached to session " .. tostring(id))
  return true
end

local function lua_pattern_escape(s)
  return (s:gsub("([^%w])", "%%%1"))
end

local function compact_path(p)
  if not p or p == "" then
    return "?"
  end
  local s = p:gsub("/+$", "")
  if s == wezterm.home_dir then
    s = "~"
  else
    s = s:gsub("^" .. lua_pattern_escape(wezterm.home_dir) .. "/", "~/", 1)
  end
  if #s <= 28 then
    return s
  end
  local parent, base = s:match("^(.*)/([^/]+)$")
  if parent then
    local parent_base = parent:match("([^/]+)$")
    if parent_base then
      return "…/" .. parent_base .. "/" .. base
    end
    return "…/" .. base
  end
  return s:sub(1, 25) .. "..."
end

local function pane_count(tree)
  if not tree then
    return 0
  end
  return 1 + pane_count(tree.right) + pane_count(tree.bottom)
end

local function argv_name(argv)
  if argv and argv[1] then
    return argv[1]:match("([^/\\]+)$") or argv[1]
  end
end

local function node_summary(tree)
  local s = compact_path(tree.cwd)
  local cmd = argv_name(tree.argv)
  if cmd then
    s = s .. " (" .. cmd .. ")"
  end
  local panes = pane_count(tree)
  if panes > 1 then
    s = s .. " ×" .. panes
  end
  return s
end

local function tab_summary(ts)
  local title = ts.title
  if title and title ~= "" then
    return title .. ": " .. node_summary(ts.tree)
  end
  return node_summary(ts.tree)
end

local function session_counts(data)
  local windows_count = #(data.windows or {})
  local tabs_count = 0
  local panes_count = 0
  for _, w in ipairs(data.windows or {}) do
    for _, t in ipairs(w.tabs or {}) do
      tabs_count = tabs_count + 1
      panes_count = panes_count + pane_count(t.tree)
    end
  end
  return windows_count, tabs_count, panes_count
end

local function append_tab_summaries(data, segs, only_active)
  for _, w in ipairs(data.windows or {}) do
    for _, t in ipairs(w.tabs or {}) do
      if t.tree then
        if (not only_active) or t.is_active then
          local prefix = t.is_active and "*" or ""
          segs[#segs + 1] = prefix .. tab_summary(t)
        end
      end
    end
  end
end

local function tabs_body(data)
  local segs = {}
  append_tab_summaries(data, segs, true)
  append_tab_summaries(data, segs, false)
  local unique = {}
  local body = {}
  for _, seg in ipairs(segs) do
    if not unique[seg] and #body < 3 then
      body[#body + 1] = seg
      unique[seg] = true
    end
  end
  local _, tabs_count = session_counts(data)
  if tabs_count > #body then
    body[#body + 1] = "+" .. (tabs_count - #body) .. " tabs"
  end
  return table.concat(body, " | ")
end

local function is_current_boot(data)
  return data.boot_id == boot_id
end

local function label_time(data)
  if not data.saved_at then
    return "?"
  end
  if is_current_boot(data) then
    return "current " .. os.date("%H:%M", data.saved_at)
  end
  return os.date("%b %d %H:%M", data.saved_at)
end

local function build_label(data)
  local windows_count, tabs_count, panes_count = session_counts(data)
  local active_workspace = data.active_workspace or "?"
  local body = tabs_body(data)
  if #body > 86 then
    body = body:sub(1, 83) .. "..."
  end
  return string.format(
    "%s · #%s · %s · %d window, %d tabs, %d panes · %s",
    label_time(data),
    tostring(data.id or "?"),
    active_workspace,
    windows_count,
    tabs_count,
    panes_count,
    body
  )
end

-- dead sessions only, newest first; these are the ones worth re-attaching to
local function orphan_choices()
  local entries = {}
  for _, e in ipairs(list_files()) do
    local data = read_json(e.path)
    if data and data.windows and #data.windows > 0 and not is_live(data) then
      entries[#entries + 1] = { id = e.id, data = data, saved_at = data.saved_at or 0 }
    end
  end
  table.sort(entries, function(a, b)
    local current_a = is_current_boot(a.data)
    local current_b = is_current_boot(b.data)
    if current_a ~= current_b then
      return current_a
    end
    return a.saved_at > b.saved_at
  end)
  local choices = {}
  for _, e in ipairs(entries) do
    choices[#choices + 1] = { id = tostring(e.id), label = build_label(e.data) }
  end
  return choices
end

function M.restore_action()
  return wezterm.action_callback(function(window, pane)
    local choices = orphan_choices()
    if #choices == 0 then
      window:toast_notification("wezterm", "No saved sessions to re-attach", nil, 3000)
      return
    end
    window:perform_action(
      act.InputSelector({
        title = "Re-attach session",
        fuzzy = true,
        choices = choices,
        action = wezterm.action_callback(function(_, _, id)
          if id then
            local ok, err = pcall(restore, tonumber(id), window:mux_window())
            if not ok then
              wezterm.log_error("[sessions] restore crashed: " .. tostring(err))
            end
          end
        end),
      }),
      pane
    )
  end)
end

function M.delete_action()
  return wezterm.action_callback(function(window, pane)
    local choices = orphan_choices()
    if #choices == 0 then
      window:toast_notification("wezterm", "No saved sessions to delete", nil, 3000)
      return
    end
    window:perform_action(
      act.InputSelector({
        title = "Delete saved session",
        fuzzy = true,
        choices = choices,
        action = wezterm.action_callback(function(_, _, id)
          if id then
            local ok, err = os.remove(path(tonumber(id)))
            if not ok then
              wezterm.log_error("[sessions] delete failed for " .. id .. ": " .. tostring(err))
            end
            window:toast_notification("wezterm", "Deleted session", nil, 2000)
          end
        end),
      }),
      pane
    )
  end)
end

return M
