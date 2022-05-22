if exists('current_compiler')
    finish
endif
let current_compiler = 'fish'

CompilerSet makeprg=fish\ %:t
CompilerSet errorformat =%Afish:\ %m,%-G%*\\\ ^,%-Z%f\ (line\ %l):%s
