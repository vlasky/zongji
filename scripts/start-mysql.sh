#!/bin/bash
# Start MySQL Docker containers for testing
# Skips MySQL 5.7 on ARM64 (Apple Silicon) as no image is available

if [ "$(uname -m)" = "arm64" ]; then
  SERVICES="mysql80 mysql84"
else
  SERVICES="mysql57 mysql80 mysql84"
fi

docker-compose up -d $SERVICES

# Wait for MySQL to be ready
for service in $SERVICES; do
  container="zongji-${service}-1"
  echo -n "Waiting for ${service}..."
  for i in $(seq 1 30); do
    if docker exec "$container" mysqladmin ping -u root -psecret --silent 2>/dev/null; then
      echo " ready"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo " timed out"
      exit 1
    fi
    sleep 2
  done
done
