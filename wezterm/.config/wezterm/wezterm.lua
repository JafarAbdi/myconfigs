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

-- right status as powerline pills: workspace, domain, key table, zoom.
-- wezterm bundles Nerd Font symbols, so the divider glyph needs no nerd font.
local PILL_SEP = utf8.char(0xe0b2)
local WORKSPACE_NAME_MAX = 18

local function shorten_workspace_name(name)
  if #name <= WORKSPACE_NAME_MAX then
    return name
  end
  return name:sub(1, WORKSPACE_NAME_MAX - 1) .. "…"
end

local function workspace_label(active)
  local names = mux.get_workspace_names()
  table.sort(names)
  for i, name in ipairs(names) do
    if name == active then
      return string.format("%d/%d %s", i, #names, shorten_workspace_name(active))
    end
  end
  return string.format("?/%d %s", #names, shorten_workspace_name(active))
end

wezterm.on("update-status", function(window, pane)
  local tab = window:active_tab()
  local zoomed = false
  if tab then
    for _, p in ipairs(tab:panes_with_info()) do
      if p.pane:pane_id() == pane:pane_id() and p.is_zoomed then
        zoomed = true
      end
    end
  end
  local key_table = window:active_key_table()

  -- pills drawn right-to-left with a divider between; Catppuccin Mocha palette
  local ink = "#1e1e2e"
  local workspace = workspace_label(window:active_workspace())
  -- get_domain_name throws for a pane not in the mux (transient startup pane, or
  -- the GUI-only debug overlay pane); skip the domain pill rather than error out.
  local ok, domain = pcall(function()
    return pane:get_domain_name()
  end)
  local pills = {
    { text = workspace, bg = "#89b4fa" },
  }
  if ok and domain then
    pills[#pills + 1] = { text = domain, bg = "#94e2d5" }
  end
  if key_table then
    pills[#pills + 1] = { text = key_table, bg = "#f9e2af" }
  end
  if zoomed then
    pills[#pills + 1] = { text = "Z", bg = "#eba0ac" }
  end

  local cells = {}
  for i, pill in ipairs(pills) do
    cells[#cells + 1] = { Foreground = { Color = pill.bg } }
    if i > 1 then
      cells[#cells + 1] = { Background = { Color = pills[i - 1].bg } }
    end
    cells[#cells + 1] = { Text = PILL_SEP }
    cells[#cells + 1] = "ResetAttributes"
    cells[#cells + 1] = { Foreground = { Color = ink } }
    cells[#cells + 1] = { Background = { Color = pill.bg } }
    cells[#cells + 1] = { Text = " " .. pill.text .. " " }
    cells[#cells + 1] = "ResetAttributes"
  end
  window:set_right_status(wezterm.format(cells))
end)

config.use_fancy_tab_bar = false
config.show_new_tab_button_in_tab_bar = false
config.tab_max_width = 25
config.disable_default_key_bindings = true
config.window_padding = {
  left = 0,
  right = 0,
  top = 0,
  bottom = 0,
}

-- open each ssh mux host in its own window via `wezterm connect` (real attach, so
-- remote windows resume); a per-host window sidesteps workspace-name collisions.
local function ssh_connect_picker(window, pane)
  local choices = {}
  for _, d in ipairs(config.ssh_domains) do
    if d.name:find("^SSHMUX:") then
      choices[#choices + 1] = { label = d.name }
    end
  end
  table.sort(choices, function(a, b)
    return a.label < b.label
  end)
  window:perform_action(
    act.InputSelector({
      title = "connect ssh host (new window)",
      fuzzy = true,
      choices = choices,
      action = wezterm.action_callback(function(_, _, _, label)
        if label then
          wezterm.background_child_process({ "wezterm", "connect", label })
        end
      end),
    }),
    pane
  )
end

-- snippet palette: a styled InputSelector that approximates the CharSelect look.
-- rows render as "<glyph>  <name>" (colored via wezterm.format), fuzzy-searchable;
-- Enter sends the snippet text to the active pane -- the local shell or the remote
-- shell over an SSHMUX domain. Enter RUNS the snippet (appends a newline); Tab
-- PLACES it at the prompt without running, so you can edit before hitting Enter.
--
-- the list is host-aware: `snippet_common` shows everywhere, plus per-host extras
-- keyed by the host part of the SSHMUX domain name (after "SSHMUX:"), so the
-- palette looks different depending on which machine the pane is on.
-- `text` carries no trailing newline; the picker appends one when Enter (run) is
-- used, and omits it for Tab (place).
local snippet_common = {
  {
    glyph = "📋",
    name = "OSC 52 clipboard filter",
    text = [[| base64 | tr -d '\n' | awk '{printf "\033]52;c;%s\007", $0}']],
  },
  { glyph = "📜", name = "tail journal (this boot)", text = "journalctl -b -f" },
  {
    glyph = "💾",
    name = "disk usage, top dirs",
    text = "du -xh / 2>/dev/null | sort -rh | head -30",
  },
  { glyph = "🔌", name = "listening sockets", text = "ss -tulpn" },
  { glyph = "📈", name = "uptime + who", text = "uptime; who" },
  { glyph = "🧠", name = "top memory procs", text = "ps aux --sort=-%mem | head -15" },
  { glyph = "⚡", name = "top CPU procs", text = "ps aux --sort=-%cpu | head -15" },
  { glyph = "🧮", name = "memory summary", text = "free -h" },
  { glyph = "🔥", name = "CPU/mem snapshot", text = "top -bn1 | head -20" },
  { glyph = "🗄️", name = "disk free per mount", text = "df -h -x tmpfs -x devtmpfs" },
  { glyph = "🔢", name = "inode usage", text = "df -ih" },
  {
    glyph = "📁",
    name = "biggest files here",
    text = "du -ah . 2>/dev/null | sort -rh | head -30",
  },
  { glyph = "🧱", name = "block devices", text = "lsblk" },
  { glyph = "🧹", name = "journal size", text = "journalctl --disk-usage" },
  { glyph = "💥", name = "failed units", text = "systemctl --failed" },
  { glyph = "⏱️", name = "slow boot culprits", text = "systemd-analyze blame | head -20" },
  { glyph = "🧭", name = "IPs at a glance", text = "ip -brief addr" },
  { glyph = "🔗", name = "established conns", text = "ss -tp state established" },
  { glyph = "❌", name = "errors this boot", text = "journalctl -b -p err --no-pager" },
  {
    glyph = "💀",
    name = "OOM kills",
    text = "journalctl -k | grep -iE 'oom|out of memory' | tail",
  },
  { glyph = "🌡️", name = "dmesg tail", text = "dmesg | tail -30" },
  { glyph = "🕐", name = "recent logins", text = "last -n 15" },
  -- process inspection: pid_picker (fish fn in config.fish) opens an fzf ps -ef
  -- picker and prints the PID; `| head -1` keeps a single target for tools that
  -- want one. embedded via fish command substitution so Enter fires the picker.
  { glyph = "🌲", name = "subtree of pid (descendants)", text = "pstree -p (pid_picker | head -1)" },
  { glyph = "🧬", name = "ancestry of pid (parents)", text = "pstree -sp (pid_picker | head -1)" },
  {
    glyph = "🔬",
    name = "strace — syscalls (kernel boundary)",
    text = "strace -f -p (pid_picker | head -1)",
  },
  {
    glyph = "📚",
    name = "ltrace — library calls (libc boundary)",
    text = "ltrace -f -p (pid_picker | head -1)",
  },
  { glyph = "🗃️", name = "open files (lsof pid)", text = "lsof -p (pid_picker | head -1)" },
  { glyph = "🧵", name = "threads of pid", text = "ps -T -p (pid_picker | head -1)" },
  {
    glyph = "🥞",
    name = "quick backtrace (pid)",
    text = "gdb -p (pid_picker | head -1) -batch -ex bt",
  },
  {
    glyph = "📇",
    name = "env of pid",
    text = "cat /proc/(pid_picker | head -1)/environ | tr '\\0' '\\n'",
  },
}

local snippet_by_host = {
  ["desktop.tail79ed4.ts.net"] = {},
}

local function snippet_row(s)
  return wezterm.format({
    { Foreground = { Color = "#cba6f7" } },
    { Text = s.glyph .. "  " },
    { Foreground = { Color = "#cdd6f4" } },
    { Text = s.name },
  })
end

local function snippet_picker(window, pane)
  local ok, domain = pcall(function()
    return pane:get_domain_name()
  end)
  local host = ok and domain and domain:match("^SSHMUX:(.+)$") or nil

  local choices = {}
  local function add(list)
    for _, s in ipairs(list or {}) do
      choices[#choices + 1] = { id = s.text, label = snippet_row(s) }
    end
  end
  if host then
    add(snippet_by_host[host])
  end
  add(snippet_common)

  window:perform_action(
    act.InputSelector({
      title = host and ("snippets @ " .. host) or "snippets",
      fuzzy = true,
      fuzzy_description = "snippets: ",
      choices = choices,
      -- `place` (5th arg) is true when accepted with Tab: send as-is so it sits at
      -- the prompt. Enter leaves it false: append newline to run immediately.
      action = wezterm.action_callback(function(_, p, id, _, place)
        if id then
          p:send_text(place and id or (id .. "\n"))
        end
      end),
    }),
    pane
  )
end

config.leader = { key = "q", mods = "CTRL", timeout_milliseconds = 1000 }
config.keys = {
  { key = "l", mods = "LEADER", action = wezterm.action_callback(ssh_connect_picker) },
  { key = "e", mods = "SHIFT|CTRL", action = wezterm.action_callback(snippet_picker) },
  -- full launcher (docker New Tab, all domains, tabs, workspaces); distinct from
  -- the command palette on CTRL+SHIFT+p
  {
    key = "w",
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

-- name the local workspace after this host (juruc-desktop, not "default")
config.default_workspace = (wezterm.hostname():gsub("%..*$", ""))

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

local function cwd_or_nil(cwd)
  if cwd and cwd ~= "" then
    return cwd
  end
end

-- The layout is captured as a binary guillotine tree. A leaf is a pane
-- { cwd, domain, cmd?, active? }; a split is { dir = "Right"|"Bottom", size, a, b }
-- where `b` is the pane spawned to the right of / below `a`, and `size` is b's
-- fraction of the split axis. This is the exact inverse of how wezterm creates
-- splits, so restore replays it faithfully for any layout (incl. grids).
--
-- The running command comes from fish publishing it as the WEZTERM_PROG user var
-- (empty at the prompt); user vars are synced to mux clients, so the GUI-side
-- autosave can read it. get_foreground_process_info would be more accurate but
-- returns nil for the GUI's client panes.
--
-- TODO(upstream): fish 4.3+ already sends the commandline with its OSC 133
-- command-start, but wezterm parses and drops it, so we need the fish hook. To
-- remove the hook, upstream a wezterm PR that: (1) captures the commandline in
-- `FinalTermSemanticPrompt` + its parser (wezterm-escape-parser/src/osc.rs),
-- (2) stores it on the terminal/pane state, (3) replicates it over the mux codec
-- so clients see it, and (4) exposes `pane:get_current_command()` in
-- lua-api-crates/mux/src/pane.rs. Then read that here instead of WEZTERM_PROG.
local function capture_leaf(p)
  local pane = p.pane
  local cwd = pane:get_current_working_dir()
  local leaf = {
    cwd = cwd and cwd.file_path or "",
    domain = pane:get_domain_name(),
    active = p.is_active or nil,
  }
  local prog = (pane:get_user_vars() or {}).WEZTERM_PROG
  if prog and prog ~= "" then
    leaf.cmd = prog
  end
  return leaf
end

local function is_leaf(node)
  return node.dir == nil
end

-- top-left leaf of a subtree: the pane restore spawns first / that gets its cwd
local function first_leaf(node)
  while not is_leaf(node) do
    node = node.a
  end
  return node
end

-- find the single guillotine cut and partition the panes into two groups along
-- it. tries a vertical cut (-> "Right") then horizontal ("Bottom"); returns
-- group_a, group_b, dir, b_fraction, or nil if the panes don't cleanly split.
local function split_panes(panes)
  local function try(startf, endf, dir)
    local seen = {}
    for _, p in ipairs(panes) do
      seen[startf(p)] = true
    end
    local cuts = {}
    for x in pairs(seen) do
      cuts[#cuts + 1] = x
    end
    table.sort(cuts)
    for _, x in ipairs(cuts) do
      local a, b, straddle = {}, {}, false
      for _, p in ipairs(panes) do
        if endf(p) <= x then
          a[#a + 1] = p
        elseif startf(p) >= x then
          b[#b + 1] = p
        else
          straddle = true
          break
        end
      end
      if not straddle and #a > 0 and #b > 0 then
        local lo, hi = math.huge, -math.huge
        for _, p in ipairs(panes) do
          lo = math.min(lo, startf(p))
          hi = math.max(hi, endf(p))
        end
        return a, b, dir, (hi - x) / (hi - lo)
      end
    end
  end

  local a, b, dir, size = try(function(p)
    return p.left
  end, function(p)
    return p.left + p.width
  end, "Right")
  if a then
    return a, b, dir, size
  end
  return try(function(p)
    return p.top
  end, function(p)
    return p.top + p.height
  end, "Bottom")
end

local function build_tree(panes)
  if #panes == 1 then
    return capture_leaf(panes[1])
  end
  local a, b, dir, size = split_panes(panes)
  if not a then
    return capture_leaf(panes[1]) -- unreachable for real layouts; degrade safely
  end
  return { dir = dir, size = size, a = build_tree(a), b = build_tree(b) }
end

-- structure-preserving tree of the LIVE panes (mirrors build_tree but keeps the
-- pane handle at each leaf), so we can line it up against a snapshot tree.
local function live_tree(panes)
  if #panes == 1 then
    return { pane = panes[1].pane }
  end
  local a, b = split_panes(panes)
  if not a then
    return { pane = panes[1].pane }
  end
  return { a = live_tree(a), b = live_tree(b) }
end

-- walk a snapshot tree and the matching live tree together; return the live pane
-- sitting at the snapshot's active leaf (nil if structures diverge).
local function active_live_pane(snap, live)
  if snap.dir == nil then
    return snap.active and live.pane or nil
  end
  if not (live.a and live.b) then
    return nil
  end
  return active_live_pane(snap.a, live.a) or active_live_pane(snap.b, live.b)
end

local function tab_state(tab)
  local panes = tab:panes_with_info()
  local zoomed = false
  for _, p in ipairs(panes) do
    if p.is_zoomed then
      zoomed = true
    end
  end
  return { title = tab:get_title(), zoomed = zoomed or nil, tree = build_tree(panes) }
end

local function window_state(win)
  local tabs = win:tabs_with_info()
  if #tabs == 0 then
    return nil
  end
  local ws = { workspace = win:get_workspace(), title = win:get_title(), tabs = {} }
  for i, t in ipairs(tabs) do
    local ts = tab_state(t.tab)
    ts.is_active = t.is_active
    ws.tabs[i] = ts
  end
  ws.size = tabs[1].tab:get_size()
  return ws
end

-- a window we can rebuild after reboot. skip remote ssh (they resume via their
-- own remote mux) and docker (ephemeral exec domains). the local mux reports its
-- domain as "local" in the server and as the unix-domain name ("unix") in the
-- GUI client, so we exclude by prefix rather than allow-list a single name.
local function is_local_window(ws)
  local d = ws.tabs[1] and first_leaf(ws.tabs[1].tree).domain
  return not (d and (d:find("^SSH") or d:find("^docker")))
end

-- the active workspace as the GUI sees it. mux.get_active_workspace() reads
-- Mux.identity, which isn't the GUI client, so it returns the wrong workspace
-- here; the focused GUI window reports the real one.
local function gui_active_workspace()
  local wins = wezterm.gui.gui_windows()
  for _, w in ipairs(wins) do
    if w:is_focused() then
      return w:active_workspace()
    end
  end
  return wins[1] and wins[1]:active_workspace() or mux.get_active_workspace()
end

local function save_session()
  local windows = {}
  for _, w in ipairs(mux.all_windows()) do
    local ws = window_state(w)
    if ws and is_local_window(ws) then
      windows[#windows + 1] = ws
    end
  end
  if #windows == 0 then
    return false
  end
  return write_json(snapshot_path, { windows = windows, active_workspace = gui_active_workspace() })
end

-- commands are typed at the prompt (never run); collected during restore and sent
-- after the layout is rebuilt.
local restore_pending = {}

local function restore_tree(node, pane, acc)
  if is_leaf(node) then
    if node.cmd then
      restore_pending[#restore_pending + 1] = { pane = pane, text = node.cmd }
    end
    if node.active then
      acc.active = pane
    end
    return
  end
  local child = pane:split({
    direction = node.dir,
    size = node.size,
    cwd = cwd_or_nil(first_leaf(node.b).cwd),
  })
  restore_tree(node.a, pane, acc)
  restore_tree(node.b, child, acc)
end

local function restore_tab(tab, ts, root_pane)
  if ts.title and ts.title ~= "" then
    tab:set_title(ts.title)
  end
  local acc = {}
  restore_tree(ts.tree, root_pane, acc)
  if acc.active then
    acc.active:activate()
  end
  if ts.zoomed then
    tab:set_zoomed(true)
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
      tab, root_pane = win:spawn_tab({ cwd = cwd_or_nil(first_leaf(ts.tree).cwd) })
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
    local _, _, win = mux.spawn_window({
      workspace = ws.workspace,
      width = ws.size and ws.size.cols or nil,
      height = ws.size and ws.size.rows or nil,
      cwd = cwd_or_nil(first_leaf(ws.tabs[1].tree).cwd),
    })
    restore_window(win, ws)
  end
  -- the active workspace is restored client-side in gui-attached (mux-side
  -- set_active_workspace targets a different identity and wouldn't reach the GUI).
  -- type the captured commands. sent inline: this runs in the mux server where
  -- wezterm.time timers don't fire; the pty buffers the input until the shell
  -- is ready.
  for _, c in ipairs(restore_pending) do
    pcall(function()
      c.pane:send_text(c.text)
    end)
  end
  restore_pending = {}
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

-- the client drops the server's active-tab / active-pane choices on import
-- (defaulting to the first of each), for every restored tab -- not just the
-- focused one. re-apply them client-side by pairing snapshot windows with live
-- ones (by workspace, in order) and matching each snapshot tab's active leaf to
-- the live pane. active_live_pane returns nil on any structural mismatch, so a
-- bad pairing is skipped rather than mis-activated.
local function restore_focus(data)
  local by_ws = {}
  for _, sw in ipairs(data.windows or {}) do
    local list = by_ws[sw.workspace]
    if not list then
      list = {}
      by_ws[sw.workspace] = list
    end
    list[#list + 1] = sw
  end
  local nth = {}
  for _, w in ipairs(mux.all_windows()) do
    -- guard per window: a stale window/pane (id 0) left over from startup would
    -- throw on get_workspace/activate; swallow it so remaining windows still get
    -- focused and restore_focus returns, letting gui-attached finish (arm autosave).
    pcall(function()
      local ws = w:get_workspace()
      local list = by_ws[ws]
      if list then
        nth[ws] = (nth[ws] or 0) + 1
        local sw = list[nth[ws]]
        if sw then
          for i, t in ipairs(w:tabs_with_info()) do
            local st = sw.tabs[i]
            if st then
              local p = active_live_pane(st.tree, live_tree(t.tab:panes_with_info()))
              if p then
                p:activate()
              end
              if st.is_active then
                t.tab:activate()
              end
            end
          end
        end
      end
    end)
  end
end

os.execute('mkdir -p "' .. state_dir .. '"')

-- these events are process-specific, so registering both everywhere is safe:
-- gui-attached only fires in the GUI, mux-startup only in the mux server.
-- autosave must run in the GUI -- wezterm.time timers only tick there -- and it
-- sees the server's windows over the unix domain. restore must run in the mux
-- server at boot, before the default window spawns. (gui-startup does not fire
-- under `wezterm connect`, so we use gui-attached.)
wezterm.on("gui-attached", function()
  -- Restore focus first, THEN arm autosave (delayed): the frontend tracks the
  -- active workspace per client, so switch via a GUI-window action (mux
  -- .set_active_workspace targets a different identity and is a no-op here). only
  -- switch to a workspace that was actually restored, else SwitchToWorkspace would
  -- create an empty one and spawn a stray window. autosave must be armed after and
  -- delayed so its first save can't clobber the snapshot's active workspace with
  -- the default we briefly show before the switch settles.
  local data = read_json(snapshot_path)
  local target = data and data.active_workspace
  local win = wezterm.gui.gui_windows()[1]
  if target and win then
    for _, name in ipairs(mux.get_workspace_names()) do
      if name == target then
        restore_focus(data)
        win:perform_action(act.SwitchToWorkspace({ name = target }), win:active_pane())
        break
      end
    end
  end
  wezterm.time.call_after(AUTOSAVE_INTERVAL, autosave_tick)
end)

wezterm.on("mux-startup", function()
  local ok, err = pcall(restore_session)
  if not ok then
    wezterm.log_error("[sessions] restore crashed: " .. tostring(err))
  end
end)

return config
