function nvim_config
  set -l nvim_dir ~/myconfigs/nvim
  if [ "$argv[1]" = "init.lua" ]
    nvim $nvim_dir/$argv[1]
  else
    nvim $nvim_dir/lua/configs/$argv[1]
  end
end

function cpp-scratch
  nvim $CPP_SCREATCHES_DIR/$argv[1]
end
