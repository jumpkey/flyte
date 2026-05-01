#!/bin/sh
# usage: ./event-mode.sh [on|off]
# on  = all machines always-on (no autosuspend)
# off = return to suspend-when-idle mode

APP=flyte
MODE=${1:-on}

if [ "$MODE" = "on" ]; then
  echo "Switching $APP to always-on mode..."
  
  # update autostop to off
  # (requires editing fly.toml and redeploying, or using machine update)
  fly machine list -a $APP --json | jq -r '.[].id' | while read id; do
    echo "Updating machine $id..."
    fly machine update $id -a $APP \
      --autostop off \
      --autostart true \
      --yes
  done

  # make sure all machines are started
  fly machine list -a $APP --json | jq -r '.[].id' | while read id; do
    echo "Starting machine $id..."
    fly machine start $id -a $APP
  done

  echo "Done. All machines always-on."
  echo "Run '$0 off' to return to suspend mode."

elif [ "$MODE" = "off" ]; then
  echo "Returning $APP to suspend-when-idle mode..."

  fly machine list -a $APP --json | jq -r '.[].id' | while read id; do
    echo "Updating machine $id..."
    fly machine update $id -a $APP \
      --autostop suspend \
      --autostart true \
      --yes
  done

  echo "Done. Machines will suspend when idle."

else
  echo "Usage: $0 [on|off]"
  exit 1
fi
