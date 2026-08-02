#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
until python -c "import psycopg2; psycopg2.connect('$BOARD_DB_URL')" 2>/dev/null; do
  sleep 1
done
echo "PostgreSQL ready"

echo "Running migrations..."
python -m alembic upgrade head

echo "Starting server..."
exec python -m uvicorn app:app --host 0.0.0.0 --port 8000
