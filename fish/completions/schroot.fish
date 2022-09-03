if command -v schroot &> /dev/null
  set -l commands (schroot --help | sed 's/\(^\|[[:space:]]\)[^[:space:]-][^[:space:]]*//g' | string trim | string match -r '.+')
  for command in $commands
    set -l short (echo $command | cut -f1 -d' ' --only-delimited | string sub --start 2)
    set -l long (echo $command | cut -f2 -d' ' | string sub --start 3)
    set -l options "--long-option" $long
    if test -n "$short"
      set options $options "--short-option" $short
    end
    complete -c schroot $options -d $long
  end
  complete -c schroot -n "__fish_seen_subcommand_from --chroot -c" -x -a "(schroot -a -l)"
end
