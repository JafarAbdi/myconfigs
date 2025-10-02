local wezterm = require("wezterm")
local mux = wezterm.mux
local act = wezterm.action

local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

config.scrollback_lines = 20000
config.max_fps = 120

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
  {
    key = "S",
    mods = "CTRL|SHIFT",
    action = act.SwitchToWorkspace({
      name = "code-snippets",
      spawn = {
        args = {
          "bash",
          "-c",
          "nvim -c 'set nospell' -c \"lua require('fzy').execute('fd --type f --strip-cwd-prefix', require('fzy').sinks.edit_file)\"",
        },
        cwd = os.getenv("HOME") .. "/Nextcloud/Notes/CodeSnippets",
      },
    }),
  },
  {
    key = "N",
    mods = "CTRL|SHIFT",
    action = act.SwitchToWorkspace({
      name = "notes",
      spawn = {
        args = {
          "bash",
          "-c",
          "nvim -c \"lua require('fzy').execute('fd --type f --strip-cwd-prefix --extension md', require('fzy').sinks.edit_file)\"",
        },
        cwd = os.getenv("HOME") .. "/Nextcloud/Notes",
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

config.check_for_updates = false

wezterm.on("bell", function(window, pane)
  if window:is_focused() and window:active_pane():pane_id() == pane:pane_id() then
    return
  end
  window:toast_notification("wezterm", "Bell in pane '" .. pane:get_title() .. "'", nil, 2500)
end)

config.ssh_domains = wezterm.default_ssh_domains()
for _, domain in ipairs(config.ssh_domains) do
  domain.remote_wezterm_path = "$HOME/.local/bin/wezterm"
end

return config
