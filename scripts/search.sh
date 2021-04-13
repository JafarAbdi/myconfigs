#!/bin/bash -eu

# Searching within files, recursive from current location
function gr {
  result="$( grep --exclude-dir=.idea --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=build --exclude-dir=.PVS-Studio --exclude=*.PVS-Studio.{i,cfg} -I --color=always --ignore-case --line-number -R  "$1" . )"
  if [[ "$hide_match_numbers" = true ]] ; then
    echo "${result}"
  else
    echo "${result}" | awk '{ printf "%s \033[0;32m%s\033[0m\n", $0, NR }'
  fi
}

# Find files with name in directory
function findfile {
  if [[ $platform != 'osx' ]]; then
    result="$( find -iname *$1* 2>/dev/null )"
    if [[ "$hide_match_numbers" = true ]] ; then
      echo "${result}"
    else
      echo "${result}" | awk '{ printf "%s\033[0;32m:: %s\033[0m\n", $0, NR }'
    fi
  else
    #find . -name '[mM][yY][fF][iI][lL][eE]*' # makes mac case insensitive
    echo "'*$1*'" |perl -pe 's/([a-zA-Z])/[\L\1\U\1]/g;s/(.*)/find . -name \1/'|sh
  fi
}
alias ffthis="find . -name "
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
# Find files ignoring directories:
#find . -type d \( -path dir1 -o -path dir2 -o -path dir3 \) -prune -o -print

# Find files recursively by file type and copy them to a directory
#find . -name "*.rst" -type f -exec cp {} ~/Desktop/ \;

# Find files and delete them
#find -name *conflicted* -delete

# Also:
# find . -iname '*.so'

# Find and replace string in all files in a directory
#  param1 - old word
#  param2 - new word
function findreplace {
  grep -lr -e "$1" * | xargs sed -i "s/$1/$2/g" ;
}

function findreplacehidden {
  grep -lr -e "$1" | xargs sed -i "s/$1/$2/g" ;
}

function findreplacehiddenexcludegit {
  for f in $(find . -not -path '*/\.git*'); do
    grep --file=$f -lre "$1" | xargs sed -i "s/$1/$2/g" ;
  done
}

# interactive find and replace. Use for option to review changes before and after.
function findreplaceinteractive {

  case $3 in
    [matlab]* )
      echo "Searching matlab (*.m) files..."
      file_types="*.m";;
    * )
      echo "Searching all files..."
  esac

  # \unaliased, --include doesn't seem to work with the bash aliased version
  \grep -rw --color=auto --include=$file_types -e "$1" ./;

  read -p $'\e[36mDo you wish to replace these instances? (y/n): \e[0m' yn

  case $yn in
    [Yy]* ) echo -e "\e[36mContinuing...\e[0m";;
    [Nn]* ) echo -e "\e[31mAborting...\e[0m"
        return;;
    *) echo "Please answer yes or no.";;
  esac

  # the \b ensures that partial matches aren't replaced.
  grep -lrw  --include=$file_types -e "$1" * | xargs sed -i "s/\b$1\b/$2/g";

  echo -e "\e[36mResults of Find & Replace operation:\e[0m"

  \grep -rw --color=auto --include=$file_types -e "$2" ./;
}

# Find replace string in all file NAMES in a directory recursively
function findreplacefilename {
  find . -depth -name "*$1*" -exec bash -c 'for f; do base=${f##*/}; mv -- "$f" "${f%/*}/${base//'$1'/'$2'}"; done' _ {} +
}
