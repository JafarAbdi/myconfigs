local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action

local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

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

config.launch_menu = { { args = { "htop" } } }
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
  {
    key = "N",
    mods = "CTRL|SHIFT",
    action = act.SwitchToWorkspace({
      name = "notes",
      spawn = {
        cwd = os.getenv("HOME") .. "/mynotes",
      },
    }),
  },
  { key = "Copy", mods = "NONE", action = act.CopyTo("Clipboard") },
  { key = "Paste", mods = "NONE", action = act.PasteFrom("Clipboard") },
  {
    key = "q",
    mods = "LEADER|CTRL",
    action = act.SendString("\x11"),
  },
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
config.front_end = "OpenGL"
config.font =
  wezterm.font({ family = "JetBrains Mono", harfbuzz_features = { "calt=0", "clig=0", "liga=0" } })
config.term = "wezterm"
-- Same colors as st's onedark theme
config.colors = {
  -- The default text color
  foreground = "#ABB2BF",
  -- The default background color
  background = "#282C34",

  ansi = {
    "#000000",
    "#E06C75",
    "#98C379",
    "#E5C07B",
    "#61AFEF",
    "#ff79c6",
    "#56B6C2",
    "#ABB2BF",
  },
  brights = {
    "#44475a",
    "#ff5555",
    "#50fa7b",
    "#f1fa8c",
    "#bd93f9",
    "#ff79c6",
    "#8be9fd",
    "#ffffff",
  },
}

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
      id,
    }
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

return config
