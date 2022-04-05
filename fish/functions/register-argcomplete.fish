function register-argcomplete
  if type -f register-python-argcomplete &> /dev/null
    set -l script_path ~/.config/fish/completions/$argv[1].fish
    if command -v $argv[1] &> /dev/null
      if ! test -e $script_path
        register-python-argcomplete --shell fish $argv[1] > $script_path
      end
    end
  end
end
