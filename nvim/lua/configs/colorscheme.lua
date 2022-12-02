-- Copied from mjlbach/onedark.nvim
local colors = {
  red = "#E06C75",
  dark_red = "#BE5046",
  green = "#98C379",
  yellow = "#E5C07B",
  dark_yellow = "#D19A66",
  blue = "#61AFEF",
  purple = "#C678DD",
  cyan = "#56B6C2",
  white = "#ABB2BF",
  black = "#282C34",
  foreground = "#ABB2BF",
  background = "#282C34",
  comment_grey = "#5C6370",
  gutter_fg_grey = "#4B5263",
  cursor_grey = "#2C323C",
  visual_grey = "#3E4452",
  menu_grey = "#3E4452",
  special_grey = "#3B4048",
  vertsplit = "#3E4452",
}

local highlights = {
  Comment = { fg = colors.comment_grey, italic = true, cterm = { italic = true } }, -- any comment
  Constant = { fg = colors.cyan }, --any constant
  String = { fg = colors.green }, --a string constant: "this is a string"
  Character = { fg = colors.green }, --a character constant: 'c', '\n'
  Number = { fg = colors.dark_yellow }, --a number constant: 234, 0xff
  Boolean = { fg = colors.dark_yellow }, --a boolean constant: TRUE, false
  Float = { fg = colors.dark_yellow }, --a floating point constant: 2.3e10
  Identifier = { fg = colors.red }, --any variable name
  Function = { fg = colors.blue }, --function name (also: methods for classes)
  Statement = { fg = colors.purple }, --any statement
  Conditional = { fg = colors.purple }, --if, then, else, endif, switch, etc.
  Repeat = { fg = colors.purple }, --for, do, while, etc.
  Label = { fg = colors.purple }, --case, default, etc.
  Operator = { fg = colors.purple }, --sizeof", "+", "*", etc.
  Keyword = { fg = colors.red }, --any other keyword
  Exception = { fg = colors.purple }, --try, catch, throw
  PreProc = { fg = colors.yellow }, --generic Preprocessor
  Include = { fg = colors.blue }, --preprocessor #include
  Define = { fg = colors.purple }, --preprocessor #define
  Macro = { fg = colors.purple }, --same as Define
  PreCondit = { fg = colors.yellow }, --preprocessor #if, #else, #endif, etc.
  Type = { fg = colors.yellow }, --int, long, char, etc.
  StorageClass = { fg = colors.yellow }, --static, register, volatile, etc.
  Structure = { fg = colors.yellow }, --struct, union, enum, etc.
  Typedef = { fg = colors.yellow }, --A typedef
  Special = { fg = colors.blue }, --any special symbol
  SpecialChar = { fg = colors.dark_yellow }, --special character in a constant
  Tag = {}, --you can use CTRL-] on this
  Delimiter = {}, --character that needs attention
  SpecialComment = { fg = colors.comment_grey }, --special things inside a comment
  Debug = {}, --debugging statements
  Underlined = { underline = true, cterm = { underline = true } }, --text that stands out, HTML links
  Ignore = {}, --left blank, hidden
  Error = { fg = colors.red }, --any erroneous construct
  Todo = { fg = colors.purple }, --anything that needs extra attention; mostly the keywords TODO FIXME and XXX

  -- Highlighting Groups (descriptions and ordering from ` =h highlight-groups`) {{{
  ColorColumn = { bg = colors.cursor_grey }, --used for the columns set with 'colorcolumn'
  Conceal = {}, --placeholder characters substituted for concealed text (see 'conceallevel')
  Cursor = { fg = colors.black, bg = colors.blue }, --the character under the cursor
  CursorIM = {}, --like Cursor, but used when in IME mode
  CursorLine = { bg = colors.cursor_grey }, --the screen line that the cursor is in when 'cursorline' is set
  Directory = { fg = colors.blue }, --directory names (and other special names in listings)
  DiffAdd = { bg = colors.green, fg = colors.black }, --diff mode: Added line
  DiffChange = { fg = colors.yellow, underline = true, cterm = { underline = true } }, --diff mode: Changed line
  DiffDelete = { bg = colors.red, fg = colors.black }, --diff mode: Deleted line
  DiffText = { bg = colors.yellow, fg = colors.black }, --diff mode: Changed text within a changed line
  ErrorMsg = { fg = colors.red }, --error messages on the command line
  VertSplit = { fg = colors.vertsplit }, --the column separating vertically split windows
  Folded = { fg = colors.comment_grey }, --line used for closed folds
  FoldColumn = {}, --'foldcolumn'
  SignColumn = {}, --column where signs are displayed
  IncSearch = { fg = colors.yellow, bg = colors.comment_grey }, --'incsearch' highlighting; also used for the text replaced with ":s///c"
  LineNr = { fg = colors.gutter_fg_grey }, --Line number for " =number" and ":#" commands, and when 'number' or 'relativenumber' option is set.
  CursorLineNr = {}, --Like LineNr when 'cursorline' or 'relativenumber' is set for the cursor line.
  MatchParen = { fg = colors.blue, underline = true, cterm = { underline = true } }, --The character under the cursor or just before it, if it is a paired bracket, and its match.
  ModeMsg = {}, --'showmode' message (e.g., "-- INSERT --")
  MoreMsg = {}, --more-prompt
  NonText = { fg = colors.special_grey }, --'~' and '@' at the end of the window, characters from 'showbreak' and other characters that do not really exist in the text (e.g., ">" displayed when a double-wide character doesn't fit at the end of the line).
  Normal = { fg = colors.foreground, bg = colors.background }, --normal text
  Pmenu = { fg = colors.white, bg = colors.menu_grey }, --Popup menu: normal item.
  PmenuSel = { fg = colors.cursor_grey, bg = colors.blue }, --Popup menu: selected item.
  PmenuSbar = { bg = colors.cursor_grey }, --Popup menu: scrollbar.
  PmenuThumb = { bg = colors.white }, --Popup menu: Thumb of the scrollbar.
  Question = { fg = colors.purple }, --hit-enter prompt and yes/no questions
  QuickFixLine = { fg = colors.black, bg = colors.yellow }, --Current quickfix item in the quickfix window.
  Search = { fg = colors.black, bg = "#a2ad6a" }, --Last search pattern highlighting (see 'hlsearch'). Also used for similar items that need to stand out.
  SpecialKey = { fg = colors.special_grey }, --Meta and special keys listed with " =map", also for text used to show unprintable characters in the text, 'listchars'. Generally: text that is displayed differently from what it really is.
  SpellBad = { fg = colors.red, underline = true, cterm = { underline = true } }, --Word that is not recognized by the spellchecker. This will be combined with the highlighting used otherwise.
  SpellCap = { fg = colors.dark_yellow }, --Word that should start with a capital. This will be combined with the highlighting used otherwise.
  SpellLocal = { fg = colors.dark_yellow }, --Word that is recognized by the spellchecker as one that is used in another region. This will be combined with the highlighting used otherwise.
  SpellRare = { fg = colors.dark_yellow }, --Word that is recognized by the spellchecker as one that is hardly ever used. spell This will be combined with the highlighting used otherwise.
  StatusLine = { fg = colors.white, bg = colors.cursor_grey }, --status line of current window
  StatusLineNC = { fg = colors.comment_grey }, --status lines of not-current windows Note = if this is equal to "StatusLine" Vim will use "^^^" in the status line of the current window.
  StatusLineTerm = { fg = colors.white, bg = colors.cursor_grey }, --status line of current :terminal window
  StatusLineTermNC = { fg = colors.comment_grey }, --status line of non-current  =terminal window
  TabLine = { fg = colors.comment_grey }, --tab pages line, not active tab page label
  TabLineFill = {}, --tab pages line, where there are no labels
  TabLineSel = { fg = colors.white }, --tab pages line, active tab page label
  Terminal = { fg = colors.white, bg = colors.black }, --terminal window (see terminal-size-color)
  Title = { fg = colors.green }, --titles for output from " =set all", ":autocmd" etc.
  Visual = { bg = colors.visual_grey }, --Visual mode selection
  VisualNOS = { bg = colors.visual_grey }, --Visual mode selection when vim is "Not Owning the Selection". Only X11 Gui's gui-x11 and xterm-clipboard supports this.
  WarningMsg = { fg = colors.yellow }, --warning messages
  WildMenu = { fg = colors.black, bg = colors.blue }, --current match in 'wildmenu' completion

  -- Diagnostics
  DiagnosticError = { fg = colors.red },
  DiagnosticWarn = { fg = colors.yellow },
  DiagnosticInfo = { fg = colors.blue },
  DiagnosticHint = { fg = colors.cyan },
  DiagnosticUnderlineError = { fg = colors.red, underline = true, cterm = { underline = true } },
  DiagnosticUnderlineWarn = { fg = colors.yellow, underline = true, cterm = { underline = true } },
  DiagnosticUnderlineInfo = { fg = colors.blue, underline = true, cterm = { underline = true } },
  DiagnosticUnderlineHint = { fg = colors.cyan, underline = true, cterm = { underline = true } },

  -- Neovim's built-in language server client
  LspReferenceWrite = { underline = true },
  LspReferenceText = { underline = true },
  LspReferenceRead = { underline = true },
  LspSignatureActiveParameter = { fg = colors.yellow, bold = true },

  -- ... an exception for my favorite plugin
  GitSignsAdd = { fg = colors.green },
  GitSignsChange = { fg = colors.yellow },
  GitSignsDelete = { fg = colors.red },
}

local colorscheme = function()
  for group, keys in pairs(highlights) do
    vim.api.nvim_set_hl(0, group, keys)
  end
end



local ts_highlights = {
  -- ["error"] = "TSError",
  -- ["variable"] = "TSVariable",
  ["none"] = { default = true },
  ["punctuation.delimiter"] = { link = "Delimiter", default = true },
  ["punctuation.bracket"] = { link = "Delimiter", default = true },
  ["punctuation.special"] = { link = "Delimiter", default = true },

  ["constant"] = { link = "Constant", default = true },
  ["constant.builtin"] = { link = "Special", default = true },
  ["constant.macro"] = { link = "Define", default = true },
  ["string"] = { link = "String", default = true },
  ["string.regex"] = { link = "String", default = true },
  ["string.escape"] = { link = "SpecialChar", default = true },
  ["string.special"] = { link = "SpecialChar", default = true },
  ["character"] = { link = "Character", default = true },
  ["character.special"] = { link = "SpecialChar", default = true },
  ["number"] = { link = "Number", default = true },
  ["boolean"] = { link = "Boolean", default = true },
  ["float"] = { link = "Float", default = true },

  ["function"] = { link = "Function", default = true },
  ["function.call"] = { link = "@function", default = true },
  ["function.builtin"] = { link = "Special", default = true },
  ["function.macro"] = { link = "Macro", default = true },
  ["parameter"] = { link = "Identifier", default = true },
  ["parameter.reference"] = { link = "@parameter", default = true },
  ["method"] = { link = "Function", default = true },
  ["method.call"] = { link = "@method", default = true },
  ["field"] = { link = "Identifier", default = true },
  ["property"] = { link = "Identifier", default = true },
  ["constructor"] = { link = "Special", default = true },
  ["annotation"] = { link = "PreProc", default = true },
  ["attribute"] = { link = "PreProc", default = true },
  ["namespace"] = { link = "Include", default = true },
  ["symbol"] = { link = "Identifier", default = true },
  ["conditional"] = { link = "Conditional", default = true },
  ["repeat"] = { link = "Repeat", default = true },
  ["label"] = { link = "Label", default = true },
  ["operator"] = { link = "Operator", default = true },
  ["keyword"] = { link = "Keyword", default = true },
  ["keyword.function"] = { link = "Keyword", default = true },
  ["keyword.operator"] = { link = "@operator", default = true },
  ["keyword.return"] = { link = "@keyword", default = true },
  ["exception"] = { link = "Exception", default = true },
  ["debug"] = { link = "Debug", default = true },
  ["define"] = { link = "Define", default = true },
  ["preproc"] = { link = "PreProc", default = true },
  ["storageclass"] = { link = "StorageClass", default = true },

  ["todo"] = { link = "Todo", default = true },

  ["type"] = { link = "Type", default = true },
  ["type.builtin"] = { link = "Type", default = true },
  ["type.qualifier"] = { link = "Type", default = true },
  ["type.definition"] = { link = "Typedef", default = true },

  ["include"] = { link = "Include", default = true },

  ["variable.builtin"] = { link = "Special", default = true },

  ["text"] = { link = "@none", default = true },
  ["text.strong"] = { bold = true, default = true },
  ["text.emphasis"] = { italic = true, default = true },
  ["text.underline"] = { underline = true },
  ["text.strike"] = { strikethrough = true },
  ["text.math"] = { link = "Special", default = true },
  ["text.reference"] = { link = "Constant", default = true },
  ["text.environment"] = { link = "Macro", default = true },
  ["text.environment.name"] = { link = "Type", default = true },
  ["text.title"] = { link = "Title", default = true },
  ["text.literal"] = { link = "String", default = true },
  ["text.uri"] = { link = "Underlined", default = true },
  ["text.note"] = { link = "SpecialComment", default = true },
  ["text.warning"] = { link = "Todo", default = true },
  ["text.danger"] = { link = "WarningMsg", default = true },

  ["comment"] = { link = "Comment", default = true },

  ["tag"] = { link = "Label", default = true },
  ["tag.delimiter"] = { link = "Delimiter", default = true },
  ["tag.attribute"] = { link = "@property", default = true },
}

for capture, hlgroup in pairs(ts_highlights) do
  vim.api.nvim_set_hl(0, "@" .. capture, hlgroup)
end

colorscheme()
