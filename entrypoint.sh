#!/bin/sh

CONFIG_PATH="/iron-bot/storage/config.json"
EXAMPLE_PATH="/iron-bot/storage/config-example.json"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "config.json not found. Initializing from config-example.json..."
  cp "$EXAMPLE_PATH" "$CONFIG_PATH"
fi

exec "$@"
