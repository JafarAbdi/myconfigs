set -l chroots (schroot --list --all)
complete -c schroot-begin-session -x -a "$chroots"
