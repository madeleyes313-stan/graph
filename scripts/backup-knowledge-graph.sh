#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/knowledge-graph}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"

cd "$PROJECT_DIR"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "compose file not found: $PROJECT_DIR/$COMPOSE_FILE" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "env file not found: $PROJECT_DIR/$ENV_FILE" >&2
  exit 1
fi

PROJECT_NAME="$(
  awk -F= '/^COMPOSE_PROJECT_NAME=/{print $2}' "$ENV_FILE" | tail -n 1
)"
PROJECT_NAME="${PROJECT_NAME:-knowledge-graph}"

DATA_VOLUME="${PROJECT_NAME}_server_data"
UPLOADS_VOLUME="${PROJECT_NAME}_server_uploads"

echo "backup directory: $BACKUP_DIR"
echo "project name: $PROJECT_NAME"
echo "data volume: $DATA_VOLUME"
echo "uploads volume: $UPLOADS_VOLUME"

docker run --rm \
  -v "${DATA_VOLUME}:/from:ro" \
  -v "${BACKUP_DIR}:/to" \
  alpine:3.20 \
  sh -lc 'cd /from && tar -czf /to/sqlite-data.tar.gz .'

docker run --rm \
  -v "${UPLOADS_VOLUME}:/from:ro" \
  -v "${BACKUP_DIR}:/to" \
  alpine:3.20 \
  sh -lc 'cd /from && tar -czf /to/uploads.tar.gz .'

cp "$ENV_FILE" "$BACKUP_DIR/deploy.env"
cp "server/.env" "$BACKUP_DIR/server.env"
cp "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.prod.yml"

cat > "$BACKUP_DIR/README.txt" <<EOF
knowledge-graph backup
created_at=$TIMESTAMP
project_dir=$PROJECT_DIR
data_volume=$DATA_VOLUME
uploads_volume=$UPLOADS_VOLUME
EOF

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

echo "backup completed: $BACKUP_DIR"
