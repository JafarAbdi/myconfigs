# Config files for XP-Pen ([Source](https://gist.github.com/checooh/ca80ac20e962cb2d3c8797fe81397e95#file-52-tablet-conf))

## Usage

- Copy `52-table.conf` to `/usr/share/X11/xorg.conf.d`
- Add the following lines to `~/.profile` to configure the buttons

```bash
my_wacon_id=$(xinput | \
              grep "UC-Logic TABLET 1060N Pad pad" | \
              sed 's/^.*id=\([0-9]*\)[ \t].*$/\1/')
xsetwacom --set $my_wacon_id Button 1 "key 1"
xsetwacom --set $my_wacon_id Button 2 "key 2"
xsetwacom --set $my_wacon_id Button 3 "key 5"
xsetwacom --set $my_wacon_id Button 8 "key 7"
xsetwacom --set $my_wacon_id Button 9 "key 8"
xsetwacom --set $my_wacon_id Button 10 "key 0"
xsetwacom --set $my_wacon_id Button 11 "key ctrl z"
xsetwacom --set $my_wacon_id Button 12 "key ctrl shift z"

xsetwacom set "UC-Logic TABLET 1060N Pen stylus" "Button" "3" "button +3 "
xsetwacom set "UC-Logic TABLET 1060N Pen stylus" "Button" "2" "button +2 "
```
