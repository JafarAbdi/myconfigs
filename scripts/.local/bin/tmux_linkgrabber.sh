#!/bin/sh
input=$(mktemp -u --suffix .linkgrabber.input)
output=$(mktemp -u --suffix .linkgrabber.output)
mkfifo $input
mkfifo $output
chmod 600 $input $output

tmux popup -E "cat $input | ~/myconfigs/scripts/linkgrabber.sh | tee $output" & disown

# handle ctrl+c outside child terminal window
trap "kill $! 2>/dev/null; rm -f $input $output" EXIT

cat > $input
cat $output | awk '{print $1}' | xargs -d '\n' -I{} -n1 -r xdg-open '{}' > /dev/null
