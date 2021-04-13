#!/bin/bash -eu

# Uncompress
alias untargz=' tar xvfz ' #file.tar.gz
alias untgz=' tar xvfz ' #file.tgz
alias untarxz=' tar xvfJ ' #file.tar.xz
alias untar='   tar xvf ' #file.tar
alias untarbz2='tar xvfj ' #file.tar.bz2
alias ungz='gunzip ' #file.gz

# Ignore git folders when zipping
#   zip -r output.zip input_folder -x *.git*

# Options:
# x - extract
# v - verbose output (lists all files as they are extracted)
# j - deal with bzipped file
# f - read from a file, rather than a tape devic
