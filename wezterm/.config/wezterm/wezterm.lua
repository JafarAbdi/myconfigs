local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action

local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

config.scrollback_lines = 20000
config.max_fps = 120

-- Enable bidirectional text support (Arabic, Hebrew, Farsi, etc.)
config.bidi_enabled = true
config.bidi_direction = "AutoLeftToRight"

-- Show which key table is active in the status area
wezterm.on("update-right-status", function(window, pane)
  local name = window:active_key_table()
  if name then
    name = " - " .. name
  end
  local zoomed = ""
  local domain = pane:get_domain_name()
  local panes = window:active_tab():panes_with_info()
  for _, p in ipairs(panes) do
    if p.pane:pane_id() == pane:pane_id() then
      if p.is_zoomed then
        zoomed = " - [Z]"
      end
    end
  end

  window:set_right_status(
    window:active_workspace()
      .. "/"
      .. #mux.get_workspace_names()
      .. " - ("
      .. domain
      .. ")"
      .. (name or "")
      .. zoomed
  )
end)

config.use_fancy_tab_bar = false
config.show_new_tab_button_in_tab_bar = false
config.tab_max_width = 25
config.disable_default_key_bindings = true
config.default_gui_startup_args = { "start", "--always-new-process" }
config.window_padding = {
  left = 0,
  right = 0,
  top = 0,
  bottom = 0,
}

config.leader = { key = "q", mods = "CTRL", timeout_milliseconds = 1000 }
config.keys = {
  {
    key = "l",
    mods = "LEADER",
    action = wezterm.action.ShowLauncherArgs({
      flags = "LAUNCH_MENU_ITEMS|FUZZY|TABS|DOMAINS|WORKSPACES",
    }),
  },
  { key = "Tab", mods = "CTRL", action = act.ActivateTabRelative(1) },
  { key = "Tab", mods = "SHIFT|CTRL", action = act.ActivateTabRelative(-1) },
  { key = "s", mods = "LEADER", action = act.SplitVertical({ domain = "CurrentPaneDomain" }) },
  { key = "v", mods = "LEADER", action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }) },
  { key = "1", mods = "LEADER", action = act.ActivateTab(0) },
  { key = "9", mods = "LEADER", action = act.ActivateTab(8) },
  { key = "2", mods = "LEADER", action = act.ActivateTab(1) },
  { key = "3", mods = "LEADER", action = act.ActivateTab(2) },
  { key = "4", mods = "LEADER", action = act.ActivateTab(3) },
  { key = "5", mods = "LEADER", action = act.ActivateTab(4) },
  { key = "6", mods = "LEADER", action = act.ActivateTab(5) },
  { key = "7", mods = "LEADER", action = act.ActivateTab(6) },
  { key = "8", mods = "LEADER", action = act.ActivateTab(7) },
  { key = "c", mods = "SHIFT|CTRL", action = act.CopyTo("Clipboard") },
  { key = "v", mods = "SHIFT|CTRL", action = act.PasteFrom("Clipboard") },
  { key = "f", mods = "SHIFT|CTRL", action = act.Search("CurrentSelectionOrEmptyString") },
  { key = "l", mods = "SHIFT|CTRL", action = act.ShowDebugOverlay },
  { key = "p", mods = "SHIFT|CTRL", action = act.ActivateCommandPalette },
  { key = "c", mods = "LEADER", action = act.SpawnTab("CurrentPaneDomain") },
  { key = "a", mods = "LEADER", action = act.ActivateLastTab },
  {
    key = "d",
    mods = "LEADER",
    action = act.DetachDomain("CurrentPaneDomain"),
  },
  {
    key = "r",
    mods = "LEADER",
    action = act.ActivateKeyTable({
      name = "resize_pane",
      one_shot = false,
    }),
  },
  {
    key = "u",
    mods = "SHIFT|CTRL",
    action = act.CharSelect({ copy_on_select = true, copy_to = "ClipboardAndPrimarySelection" }),
  },
  { key = "q", mods = "LEADER", action = act.PaneSelect({}) },
  { key = "x", mods = "LEADER", action = act.CloseCurrentPane({ confirm = true }) },
  { key = "x", mods = "SHIFT|CTRL", action = act.ActivateCopyMode },
  { key = "z", mods = "LEADER", action = act.TogglePaneZoomState },
  { key = "phys:Space", mods = "SHIFT|CTRL", action = act.QuickSelect },
  { key = "PageUp", mods = "SHIFT|CTRL", action = act.MoveTabRelative(-1) },
  { key = "PageDown", mods = "SHIFT|CTRL", action = act.MoveTabRelative(1) },
  { key = "PageUp", mods = "SHIFT", action = act.ScrollByPage(-1) },
  { key = "PageDown", mods = "SHIFT", action = act.ScrollByPage(1) },
  { key = "h", mods = "ALT", action = act.ActivatePaneDirection("Left") },
  { key = "l", mods = "ALT", action = act.ActivatePaneDirection("Right") },
  { key = "k", mods = "ALT", action = act.ActivatePaneDirection("Up") },
  { key = "j", mods = "ALT", action = act.ActivatePaneDirection("Down") },
  { key = "k", mods = "ALT|SHIFT", action = act.SwitchWorkspaceRelative(1) },
  { key = "j", mods = "ALT|SHIFT", action = act.SwitchWorkspaceRelative(-1) },
  { key = "n", mods = "ALT|SHIFT", action = act.SwitchToWorkspace },
  { key = "Copy", mods = "NONE", action = act.CopyTo("Clipboard") },
  { key = "Paste", mods = "NONE", action = act.PasteFrom("Clipboard") },
  {
    key = "q",
    mods = "LEADER|CTRL",
    action = act.SendString("\x11"),
  },
  { key = "UpArrow", mods = "SHIFT", action = act.ScrollToPrompt(-1) },
  { key = "DownArrow", mods = "SHIFT", action = act.ScrollToPrompt(1) },
  -- Send the Kitty CSI-u shift+enter sequence so apps (pi, Claude Code) decode a
  -- real shift+enter without enabling enable_kitty_keyboard globally.
  -- Not "\x1b\r": pi only reads that as shift+enter when its kitty protocol is
  -- active, otherwise it parses as alt+enter and the bare CR submits.
  -- Not enable_kitty_keyboard=true: that switches CSI-u on for *every* key
  -- globally; this targets only shift+enter and leaves everything else legacy.
  { key = "Enter", mods = "SHIFT", action = act.SendString("\x1b[13;2u") },
}

config.key_tables = {
  resize_pane = {
    { key = "LeftArrow", action = act.AdjustPaneSize({ "Left", 1 }) },
    { key = "h", action = act.AdjustPaneSize({ "Left", 1 }) },

    { key = "RightArrow", action = act.AdjustPaneSize({ "Right", 1 }) },
    { key = "l", action = act.AdjustPaneSize({ "Right", 1 }) },

    { key = "UpArrow", action = act.AdjustPaneSize({ "Up", 1 }) },
    { key = "k", action = act.AdjustPaneSize({ "Up", 1 }) },

    { key = "DownArrow", action = act.AdjustPaneSize({ "Down", 1 }) },
    { key = "j", action = act.AdjustPaneSize({ "Down", 1 }) },
    -- Cancel the mode by pressing escape
    { key = "Escape", action = "PopKeyTable" },
  },
  copy_mode = {
    { key = "Escape", mods = "NONE", action = act.CopyMode("Close") },
    { key = "$", mods = "SHIFT", action = act.CopyMode("MoveToEndOfLineContent") },
    { key = ",", mods = "NONE", action = act.CopyMode("JumpReverse") },
    { key = "0", mods = "NONE", action = act.CopyMode("MoveToStartOfLine") },
    { key = ";", mods = "NONE", action = act.CopyMode("JumpAgain") },
    { key = "F", mods = "NONE", action = act.CopyMode({ JumpBackward = { prev_char = false } }) },
    { key = "G", mods = "NONE", action = act.CopyMode("MoveToScrollbackBottom") },
    { key = "O", mods = "NONE", action = act.CopyMode("MoveToSelectionOtherEndHoriz") },
    { key = "T", mods = "NONE", action = act.CopyMode({ JumpBackward = { prev_char = true } }) },
    { key = "Space", mods = "NONE", action = act.CopyMode({ SetSelectionMode = "Cell" }) },
    { key = "V", mods = "NONE", action = act.CopyMode({ SetSelectionMode = "Line" }) },
    { key = "^", mods = "SHIFT", action = act.CopyMode("MoveToStartOfLineContent") },
    { key = "b", mods = "NONE", action = act.CopyMode("MoveBackwardWord") },
    { key = "b", mods = "CTRL", action = act.CopyMode("PageUp") },
    {
      key = "c",
      mods = "CTRL",
      action = act.Multiple({
        { CopyTo = "ClipboardAndPrimarySelection" },
        { CopyMode = "Close" },
      }),
    },
    { key = "d", mods = "CTRL", action = act.CopyMode({ MoveByPage = 0.5 }) },
    { key = "e", mods = "NONE", action = act.CopyMode("MoveForwardWordEnd") },
    { key = "f", mods = "NONE", action = act.CopyMode({ JumpForward = { prev_char = false } }) },
    { key = "f", mods = "CTRL", action = act.CopyMode("PageDown") },
    { key = "g", mods = "NONE", action = act.CopyMode("MoveToScrollbackTop") },
    { key = "h", mods = "NONE", action = act.CopyMode("MoveLeft") },
    { key = "j", mods = "NONE", action = act.CopyMode("MoveDown") },
    { key = "k", mods = "NONE", action = act.CopyMode("MoveUp") },
    { key = "l", mods = "NONE", action = act.CopyMode("MoveRight") },
    { key = "m", mods = "ALT", action = act.CopyMode("MoveToStartOfLineContent") },
    { key = "o", mods = "NONE", action = act.CopyMode("MoveToSelectionOtherEnd") },
    { key = "q", mods = "NONE", action = act.CopyMode("Close") },
    { key = "t", mods = "NONE", action = act.CopyMode({ JumpForward = { prev_char = true } }) },
    { key = "u", mods = "CTRL", action = act.CopyMode({ MoveByPage = -0.5 }) },
    { key = "v", mods = "NONE", action = act.CopyMode({ SetSelectionMode = "Cell" }) },
    { key = "v", mods = "CTRL", action = act.CopyMode({ SetSelectionMode = "Block" }) },
    { key = "w", mods = "NONE", action = act.CopyMode("MoveForwardWord") },
    {
      key = "y",
      mods = "NONE",
      action = act.Multiple({
        { CopyTo = "ClipboardAndPrimarySelection" },
        { CopyMode = "Close" },
      }),
    },
    { key = "LeftArrow", mods = "NONE", action = act.CopyMode("MoveLeft") },
    { key = "RightArrow", mods = "NONE", action = act.CopyMode("MoveRight") },
    { key = "UpArrow", mods = "NONE", action = act.CopyMode("MoveUp") },
    { key = "DownArrow", mods = "NONE", action = act.CopyMode("MoveDown") },
  },
}

config.warn_about_missing_glyphs = false
config.force_reverse_video_cursor = true
config.font =
  wezterm.font({ family = "JetBrains Mono", harfbuzz_features = { "calt=0", "clig=0", "liga=0" } })
config.term = "wezterm"

-- Docker domains
local split_lines = function(s)
  local lines = {}
  for line in s:gmatch("[^\n]+") do
    table.insert(lines, line)
  end
  return lines
end

local docker_list = function()
  local success, stdout, _ =
    wezterm.run_child_process({ "docker", "container", "ls", "--format", "{{.Names}}" })
  if success then
    return split_lines(stdout)
  end
  return {}
end

local make_docker_fixup_func = function(id)
  return function(cmd)
    local _, stdout, _ = wezterm.run_child_process({
      "docker",
      "exec",
      id,
      "bash",
      "-c",
      string.format(
        [[awk -F: -v user="%s" '$1 == user {print $NF}' /etc/passwd]],
        os.getenv("USER")
      ),
    })
    local shell = split_lines(stdout)[1]
    -- TODO: Better detection for fish
    if shell == "/usr/sbin/nologin" then
      shell = "fish"
    end
    cmd.args = cmd.args or { shell }
    local wrapped = {
      "docker",
      "exec",
      "-it",
      "--user",
      os.getenv("USER"),
    }
    for k, v in pairs(cmd.set_environment_variables) do
      table.insert(wrapped, "-e")
      table.insert(wrapped, k .. "=" .. v)
    end
    table.insert(wrapped, id)
    for _, arg in ipairs(cmd.args) do
      table.insert(wrapped, arg)
    end

    cmd.args = wrapped
    return cmd
  end
end

local make_docker_label_func = function(id)
  return function(_)
    local success, stdout, _ = wezterm.run_child_process({
      "docker",
      "container",
      "inspect",
      "-f",
      "{{.State.Status}}",
      id,
    })
    if success then
      local result = split_lines(stdout)[1]
      if result == "running" then
        return wezterm.format({
          { Foreground = { AnsiColor = "Green" } },
          { Text = "Running " .. id },
        })
      elseif result == "exited" then
        return wezterm.format({
          { Foreground = { AnsiColor = "Red" } },
          { Text = "Stopped " .. id },
        })
      else
        return wezterm.format({
          { Foreground = { AnsiColor = "Yellow" } },
          { Text = result .. " " .. id },
        })
      end
    end
    return wezterm.format({
      { Foreground = { AnsiColor = "Red" } },
      { Text = "Can't get state for " .. id },
    })
  end
end

local exec_domains = {}
for _, name in pairs(docker_list()) do
  table.insert(
    exec_domains,
    wezterm.exec_domain(
      "docker: " .. name,
      make_docker_fixup_func(name),
      make_docker_label_func(name)
    )
  )
end

config.exec_domains = exec_domains

wezterm.on("augment-command-palette", function(_, _)
  return {
    {
      brief = "Rename workspace",
      icon = "md_rename_box",

      action = act.PromptInputLine({
        description = "Enter new name for workspace",
        action = wezterm.action_callback(function(_, _, line)
          wezterm.mux.rename_workspace(wezterm.mux.get_active_workspace(), line)
        end),
      }),
    },
    {
      brief = "Rename tab",
      icon = "md_rename_box",

      action = act.PromptInputLine({
        description = "Enter new name for tab",
        action = wezterm.action_callback(function(window, _, line)
          if line then
            window:active_tab():set_title(line)
          end
        end),
      }),
    },
  }
end)
config.check_for_updates = false

wezterm.on("bell", function(window, pane)
  if window:is_focused() and window:active_pane():pane_id() == pane:pane_id() then
    return
  end
  window:toast_notification("wezterm", "Bell in pane '" .. pane:get_title() .. "'", nil, 2500)
end)

local function known_hosts_paths()
  -- Similar to bash-completion's _known_hosts_real default known-hosts set.
  -- TODO: Parse UserKnownHostsFile and GlobalKnownHostsFile from ssh_config.
  return {
    "/etc/ssh/ssh_known_hosts",
    "/etc/ssh/ssh_known_hosts2",
    "/etc/known_hosts",
    "/etc/known_hosts2",
    wezterm.home_dir .. "/.ssh/known_hosts",
    wezterm.home_dir .. "/.ssh/known_hosts2",
  }
end

local function split_known_hosts_names(field)
  local names = {}
  for name in field:gmatch("([^,]+)") do
    if name:sub(1, 1) ~= "|" and not name:find("[*?]") then
      local bracket_host, bracket_port = name:match("^%[([^%]]+)%]:(%d+)$")
      if bracket_host then
        table.insert(names, bracket_host .. ":" .. bracket_port)
      else
        table.insert(names, name)
      end
    end
  end
  return names
end

local function add_known_hosts_domains(domains)
  local seen = {}
  for _, domain in ipairs(domains) do
    seen[domain.name] = true
  end

  for _, path in ipairs(known_hosts_paths()) do
    wezterm.add_to_config_reload_watch_list(path)
    local file = io.open(path, "r")
    if file then
      for line in file:lines() do
        local first = line:match("^%s*(%S+)")
        if first and first:sub(1, 1) ~= "#" then
          local hosts = first
          if first:sub(1, 1) == "@" then
            hosts = line:match("^%s*%S+%s+(%S+)")
          end

          if hosts then
            for _, host in ipairs(split_known_hosts_names(hosts)) do
              local name = "SSHMUX:" .. host
              if not seen[name] then
                seen[name] = true
                table.insert(domains, {
                  name = name,
                  remote_address = host,
                  multiplexing = "WezTerm",
                  remote_wezterm_path = "$HOME/.local/bin/wezterm",
                })
              end
            end
          end
        end
      end
      file:close()
    end
  end
end

config.ssh_domains = wezterm.default_ssh_domains()
for _, domain in ipairs(config.ssh_domains) do
  domain.remote_wezterm_path = "$HOME/.local/bin/wezterm"
end
add_known_hosts_domains(config.ssh_domains)

-- the GUI is a viewer onto a persistent unix mux server, so panes outlive a GUI
-- crash/restart (reconnect and they're still live). switch workspaces / attach
-- ssh mux domains via the LEADER+l launcher.
config.unix_domains = { { name = "unix" } }
config.default_gui_startup_args = { "connect", "unix" }

-- Reboot survival for local layout. The mux server autosaves one snapshot of the
-- local windows/tabs/panes (cwd, split geometry, running command) and rebuilds it
-- when it next starts. Live sessions across GUI restarts are handled by the unix
-- mux domain itself; remote (ssh) sessions by their own remote mux -- so only
-- local panes are serialized, only to survive a full reboot.
local AUTOSAVE_INTERVAL = 60
local state_dir = (os.getenv("XDG_STATE_HOME") or (wezterm.home_dir .. "/.local/state"))
  .. "/wezterm"
local snapshot_path = state_dir .. "/session.json"

-- shells running idle in a pane have no "command" worth restoring
local shells = { sh = true, bash = true, zsh = true, fish = true, nu = true }

-- atomic: write a temp file then rename over the target, so a crash mid-write
-- can't leave a torn file
local function write_json(p, tbl)
  local ok, encoded = pcall(wezterm.json_encode, tbl)
  if not ok then
    wezterm.log_error("[sessions] json_encode failed: " .. tostring(encoded))
    return false
  end
  local tmp = p .. ".tmp"
  local f = io.open(tmp, "w+")
  if not f then
    wezterm.log_error("[sessions] cannot open for write: " .. tmp)
    return false
  end
  f:write(encoded)
  f:close()
  local renamed, err = os.rename(tmp, p)
  if not renamed then
    wezterm.log_error("[sessions] rename failed: " .. tostring(err))
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
    wezterm.log_error("[sessions] corrupt snapshot " .. p .. ": " .. tostring(parsed))
    return nil
  end
  return parsed
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

-- record cwd/domain/command on a pane node, then drop the live handle
local function capture_node(node)
  local pane = node.pane
  node.domain = pane:get_domain_name()
  local cwd = pane:get_current_working_dir()
  node.cwd = cwd and cwd.file_path or ""
  if node.domain == "local" then
    local info = pane:get_foreground_process_info()
    if info and info.argv and #info.argv > 0 and not is_shell(info) then
      node.argv = info.argv
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
  return { title = tab:get_title(), tree = pane_tree(tab:panes_with_info()) }
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

-- a window we can rebuild after reboot: its root pane is a local shell. remote
-- (ssh mux) windows live on their own server and are reattached natively
local function is_local_window(ws)
  local d = ws.tabs[1] and ws.tabs[1].tree and ws.tabs[1].tree.domain
  return d == nil or d == "" or d == "local"
end

local function save_session()
  local windows = {}
  for _, w in ipairs(mux.all_windows()) do
    local ws = window_state(w)
    if is_local_window(ws) then
      windows[#windows + 1] = ws
    end
  end
  if #windows == 0 then
    return false
  end
  return write_json(
    snapshot_path,
    { windows = windows, active_workspace = mux.get_active_workspace() }
  )
end

local function cwd_or_nil(cwd)
  if cwd and cwd ~= "" then
    return cwd
  end
end

-- commands are typed after a short delay; typing them inline races shell startup
-- and the keystrokes can be eaten. they are typed, never run (no newline).
local restore_pending = {}

local function queue_command(node)
  if node.argv and #node.argv > 0 then
    restore_pending[#restore_pending + 1] =
      { pane = node.pane, text = wezterm.shell_join_args(node.argv) }
  end
end

local function spawn_child(parent, node, direction, size)
  node.pane = parent:split({ direction = direction, cwd = cwd_or_nil(node.cwd), size = size })
end

local function restore_node(node, acc)
  queue_command(node)
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
  local acc = restore_node(ts.tree, {})
  if acc.active then
    acc.active:activate()
  end
end

local function restore_window(win, ws)
  if ws.title and ws.title ~= "" then
    win:set_title(ws.title)
  end
  local active_tab
  for i, ts in ipairs(ws.tabs) do
    local tab, root_pane
    -- the first tab reuses the window's initial pane, already spawned in the
    -- right cwd (see restore_session); later tabs spawn fresh with their own cwd
    if i == 1 then
      tab, root_pane = win:active_tab(), win:active_pane()
    else
      tab, root_pane = win:spawn_tab({ cwd = cwd_or_nil(ts.tree.cwd) })
    end
    restore_tab(tab, ts, root_pane)
    if ts.is_active then
      active_tab = tab
    end
  end
  if active_tab then
    active_tab:activate()
  end
end

local function restore_session()
  if #mux.all_windows() > 0 then
    return false
  end
  local data = read_json(snapshot_path)
  if not data or not data.windows or #data.windows == 0 then
    return false
  end
  restore_pending = {}
  for _, ws in ipairs(data.windows) do
    local first = ws.tabs[1]
    local _, _, win = mux.spawn_window({
      workspace = ws.workspace,
      width = ws.size and ws.size.cols or nil,
      height = ws.size and ws.size.rows or nil,
      cwd = cwd_or_nil(first.tree.cwd),
    })
    restore_window(win, ws)
  end
  if data.active_workspace then
    mux.set_active_workspace(data.active_workspace)
  end
  -- type the captured commands once shells have had time to initialize
  if #restore_pending > 0 then
    local cmds = restore_pending
    restore_pending = {}
    wezterm.time.call_after(1.0, function()
      for _, c in ipairs(cmds) do
        pcall(function()
          c.pane:send_text(c.text)
        end)
      end
    end)
  end
  wezterm.log_info("[sessions] restored " .. #data.windows .. " window(s)")
  return true
end

local function autosave_tick()
  local ok, err = pcall(save_session)
  if not ok then
    wezterm.log_error("[sessions] autosave failed: " .. tostring(err))
  end
  wezterm.time.call_after(AUTOSAVE_INTERVAL, autosave_tick)
end

-- the mux server owns the panes; restore + autosave run there, once. the GUI
-- process evaluates this too but never fires mux-startup, so it stays a viewer.
if not wezterm.GLOBAL.sessions_registered then
  wezterm.GLOBAL.sessions_registered = true
  os.execute('mkdir -p "' .. state_dir .. '"')
  wezterm.on("mux-startup", function()
    local ok, err = pcall(restore_session)
    if not ok then
      wezterm.log_error("[sessions] restore crashed: " .. tostring(err))
    end
    wezterm.time.call_after(AUTOSAVE_INTERVAL, autosave_tick)
  end)
end

return config
