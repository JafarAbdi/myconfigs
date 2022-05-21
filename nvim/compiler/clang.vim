if exists("clang")
  finish
endif
let current_compiler = "clang"

let s:cpo_save = &cpo
set cpo-=C

setlocal makeprg=clang++\ %:p\ -o\ %:p:r.out
if filereadable(expand("%:p:h")."/conanbuildinfo.args")
  setlocal makeprg +=\ @conanbuildinfo.args
endif
CompilerSet errorformat=%f:%l:%c:\ %m

let &cpo = s:cpo_save
unlet s:cpo_save

