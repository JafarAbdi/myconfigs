function __fish_notes_tags
  zk tag list -q -P -f name --footer="\n"
end
complete -c notes_tag -x -a "(__fish_notes_tags)"
