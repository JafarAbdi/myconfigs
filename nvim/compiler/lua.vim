if exists('current_compiler')
    finish
endif
let current_compiler = 'lua'

CompilerSet makeprg=nvim\ --headless\ -c\ source\ %:t\ --noplugin\ -c\ exit\ -n
