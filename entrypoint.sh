#!/bin/sh
# Sync default data files from the repo to DATA_DIR.
# Only copies files that don't exist yet OR are config files (products, settings, tokens, roles, shifts-settings)
# that should be kept in sync with the repo. User-generated data (cache, etc.) is preserved.

DATA_DIR="${DATA_DIR:-./data}"
REPO_DATA="./data"

# Config files that should be updated from the repo on each deploy
CONFIG_FILES="products.json settings.json tokens.json roles.json shifts-settings.json monitors.json"

if [ -d "$REPO_DATA" ]; then
  echo "[entrypoint] Syncing config from $REPO_DATA to $DATA_DIR..."
  for guild_dir in "$REPO_DATA"/*/; do
    guild_id=$(basename "$guild_dir")
    target_dir="$DATA_DIR/$guild_id"
    mkdir -p "$target_dir"
    
    for config_file in $CONFIG_FILES; do
      src="$guild_dir$config_file"
      dst="$target_dir/$config_file"
      if [ -f "$src" ]; then
        cp "$src" "$dst"
        echo "  ✅ $guild_id/$config_file"
      fi
    done
  done
  echo "[entrypoint] Config sync complete."
fi

# Run the app
exec deno task start
