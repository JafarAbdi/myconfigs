MACHINE_NAME_FILE=$HOME/.machine_name
if [[ -f "$MACHINE_NAME_FILE" ]]; then
  export MACHINE_NAME="$(< $MACHINE_NAME_FILE)"
fi
