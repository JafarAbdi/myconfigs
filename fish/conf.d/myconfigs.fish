alias mybashrc="nvim $MYCONFIGS_DIR/.bashrc"
alias mysetup="nvim $MYCONFIGS_DIR/install/setup.sh"
alias myreadme="nvim $MYCONFIGS_DIR/README.md"

if type -f register-python-argcomplete &> /dev/null
  register-python-argcomplete --shell fish _workon_workspace.py | source
  register-python-argcomplete --shell fish ros_build | source
  register-python-argcomplete --shell fish ros_test | source
  register-python-argcomplete --shell fish clang_tidy | source
  register-python-argcomplete --shell fish ros_clang_tidy | source
  register-python-argcomplete --shell fish config_clangd | source
  # TODO: Push upstream
  register-python-argcomplete --shell fish ros2 | source
  register-python-argcomplete --shell fish rosidl | source
  register-python-argcomplete --shell fish ament_cmake | source
end
