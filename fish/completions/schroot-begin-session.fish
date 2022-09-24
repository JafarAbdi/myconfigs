if command -v schroot &> /dev/null
  set -l chroots (schroot --list --all 2> /dev/null)
  complete -c schroot-begin-session -x -a "$chroots"
end
