local wezterm = require("wezterm")
local act = wezterm.action

local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

config.term = "wezterm"

config.use_fancy_tab_bar = false
config.tab_max_width = 25
config.hide_tab_bar_if_only_one_tab = true
config.disable_default_key_bindings = true

config.window_padding = {
  left = 0,
  right = 0,
  top = 0,
  bottom = 0,
}

config.leader = { key = "q", mods = "CTRL", timeout_milliseconds = 1000 }
config.keys = {
  { key = "Tab", mods = "CTRL", action = act.ActivateTabRelative(1) },
  { key = "Tab", mods = "SHIFT|CTRL", action = act.ActivateTabRelative(-1) },
  { key = "v", mods = "LEADER", action = act.SplitVertical({ domain = "CurrentPaneDomain" }) },
  { key = "s", mods = "LEADER", action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }) },
  { key = "1", mods = "LEADER", action = act.ActivateTab(0) },
  { key = "9", mods = "LEADER", action = act.ActivateTab(8) },
  { key = "2", mods = "LEADER", action = act.ActivateTab(1) },
  { key = "3", mods = "LEADER", action = act.ActivateTab(2) },
  { key = "4", mods = "LEADER", action = act.ActivateTab(3) },
  { key = "5", mods = "LEADER", action = act.ActivateTab(4) },
  { key = "6", mods = "LEADER", action = act.ActivateTab(5) },
  { key = "7", mods = "LEADER", action = act.ActivateTab(6) },
  { key = "8", mods = "LEADER", action = act.ActivateTab(7) },
  -- { key = "+", mods = "CTRL", action = act.IncreaseFontSize },
  -- { key = "-", mods = "CTRL", action = act.DecreaseFontSize },
  -- { key = "0", mods = "CTRL", action = act.ResetFontSize },
  { key = "c", mods = "SHIFT|CTRL", action = act.CopyTo("Clipboard") },
  { key = "v", mods = "SHIFT|CTRL", action = act.PasteFrom("Clipboard") },
  { key = "f", mods = "SHIFT|CTRL", action = act.Search("CurrentSelectionOrEmptyString") },
  { key = "l", mods = "SHIFT|CTRL", action = act.ShowDebugOverlay },
  { key = "p", mods = "SHIFT|CTRL", action = act.ActivateCommandPalette },
  { key = "c", mods = "LEADER", action = act.SpawnTab("CurrentPaneDomain") },
  {
    key = "u",
    mods = "SHIFT|CTRL",
    action = act.CharSelect({ copy_on_select = true, copy_to = "ClipboardAndPrimarySelection" }),
  },
  { key = "x", mods = "LEADER", action = act.CloseCurrentTab({ confirm = true }) },
  { key = "x", mods = "SHIFT|CTRL", action = act.ActivateCopyMode },
  { key = "z", mods = "LEADER", action = act.TogglePaneZoomState },
  { key = "phys:Space", mods = "SHIFT|CTRL", action = act.QuickSelect },
  { key = "PageUp", mods = "SHIFT", action = act.ScrollByPage(-1) },
  { key = "PageDown", mods = "SHIFT", action = act.ScrollByPage(1) },
  { key = "h", mods = "ALT", action = act.ActivatePaneDirection("Left") },
  { key = "l", mods = "ALT", action = act.ActivatePaneDirection("Right") },
  { key = "k", mods = "ALT", action = act.ActivatePaneDirection("Up") },
  { key = "j", mods = "ALT", action = act.ActivatePaneDirection("Down") },
  -- { key = "Insert", mods = "SHIFT", action = act.PasteFrom("PrimarySelection") },
  -- { key = "Insert", mods = "CTRL", action = act.CopyTo("PrimarySelection") },
  { key = "Copy", mods = "NONE", action = act.CopyTo("Clipboard") },
  { key = "Paste", mods = "NONE", action = act.PasteFrom("Clipboard") },
  {
    key = "q",
    mods = "LEADER|CTRL",
    action = act.SendString("\x11"),
  },
}

config.warn_about_missing_glyphs = false

config.force_reverse_video_cursor = true
config.font = wezterm.font("JetBrains Mono")
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

return config
