#!/bin/bash -eu

# Helpers for formatting code
source ~/myconfigs/scripts/colors.sh

# Setup:
#   sagi clang-format-3.9  # already setup with emacsinstall
alias clang-format="clang-format-3.9"
function clang_this_directory_custom # recursive
{
  # CLANG_FORMAT_EXECUTABLE=$(ls -1 /usr/bin/clang-format* | head -1)
  # Make sure no changes have occured in repo
  if ! git diff-index --quiet HEAD --; then
    # changes
    console_red
    read -p "You have uncommitted changes, are you sure you want to continue? (y/n)" resp
    console_nored

    if [[ "$resp" = "y" ]]; then
      echo "Formatting..."
    else
      return -1
    fi
  fi

  clang_command="clang-format-3.9"
  # If a clang version was provided as argument 1
  if [ "$#" -gt 0 ]; then
    clang_command="clang-format-${1}"
  else
    echo 'Usage: clang_this_directory_custom (optional clang_version)'
    echo 'e.g.: clang_this_directory_custom 3.9'
    echo 'Default clang version is 3.9'
  fi
  echo 'Using clang command '$clang_command


  find . -name '*.h' -or -name '*.hpp' -or -name '*.cpp' -o -name '*.c' -o -name '*.cc' -o -name '*.proto' | xargs $clang_command -i -style=file $1
}

# Recursively remove all whitespace from code-type files
function remove_trailing_whitespace_code_recursively {
  find . \( -name '*.h' -o -name '*.hpp' -o -name '*.cpp' -o -name '*.c' -o -name '*.markdown' -o -name '*.md' -o -name '*.xml' -o -name '*.m' -o -name '*.txt' -o -name '*.sh' -o -name '*.launch' -o -name '*.world' -o -name '*.urdf' -o -name '*.xacro' -o -name '*.py' -o -name '*.cfg' -o -name '*.msg' -o -name '*.yml' -o -name '*.yaml' -o -name '*.rst' -o -name '*.proto' \) -exec sed -i 's/ *$//' '{}' ';'
}
