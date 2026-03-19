#!/bin/sh
# Sync default data files from the repo to DATA_DIR.
# products.json: always synced from repo (declarative, not edited at runtime)
# settings/tokens/roles/etc: seeded on first deploy only, then preserved (runtime-editable)

DATA_DIR="${DATA_DIR:-./data}"
REPO_DATA="./data"

# Config files that are ALWAYS overwritten from repo (static/declarative)
ALWAYS_SYNC="products.json"

# Config files that are only seeded on first deploy (runtime-editable)
SEED_ONLY="settings.json tokens.json roles.json shifts-settings.json monitors.json"

if [ -d "$REPO_DATA" ]; then
  echo "[entrypoint] Syncing config from $REPO_DATA to $DATA_DIR..."
  for guild_dir in "$REPO_DATA"/*/; do
    guild_id=$(basename "$guild_dir")
    target_dir="$DATA_DIR/$guild_id"
    mkdir -p "$target_dir"
    
    # Always overwrite these from repo
    for config_file in $ALWAYS_SYNC; do
      src="$guild_dir$config_file"
      dst="$target_dir/$config_file"
      if [ -f "$src" ]; then
        cp "$src" "$dst"
        echo "  ✅ $guild_id/$config_file (synced)"
      fi
    done

    # Only copy if not already present in DATA_DIR
    for config_file in $SEED_ONLY; do
      src="$guild_dir$config_file"
      dst="$target_dir/$config_file"
      if [ -f "$src" ] && [ ! -f "$dst" ]; then
        cp "$src" "$dst"
        echo "  🆕 $guild_id/$config_file (seeded)"
      elif [ -f "$dst" ]; then
        echo "  ⏭️  $guild_id/$config_file (kept existing)"
      fi
    done
  done
  echo "[entrypoint] Config sync complete."
fi

# Run the app
exec deno task start
