# OneDark theme https://github.com/jarun/nnn/wiki/Themes#onedark
set -l BLK "04"
set -l CHR "04"
set -l DIR "04"
set -l EXE "00"
set -l REG "00"
set -l HARDLINK "00"
set -l SYMLINK "06"
set -l MISSING "00"
set -l ORPHAN "01"
set -l FIFO "0F"
set -l SOCK "0F"
set -l OTHER "02"
export NNN_FCOLORS="$BLK$CHR$DIR$EXE$REG$HARDLINK$SYMLINK$MISSING$ORPHAN$FIFO$SOCK$OTHER"
export NNN_OPTS="ea"
export NNN_FIFO='/tmp/nnn.fifo'
export NNN_BMS="c:$MYCONFIGS_DIR;w:$WORKSPACE_DIR"
export NNN_PLUG="b:fzplug;c:fzcd;o:fzopen;n:bulknew;p:preview-tui"
export NNN_TRASH=2
