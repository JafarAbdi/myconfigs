function __fish_schroots
  if command -v schroot &> /dev/null
    set -l chroots (schroot --list --all 2> /dev/null)
  end
end
complete -c schroot-begin-session -x -a "(__fish_schroots)"
