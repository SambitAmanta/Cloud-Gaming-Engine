#!/usr/bin/env bash
set -e

echo "=========================================="
echo " Building NebulaStream Runner Docker Image"
echo "=========================================="

docker build -f docker/Dockerfile.runner -t nebulastream-runner:latest .

echo ""
echo "Successfully built nebulastream-runner:latest!"
echo "To test run with GPU passthrough:"
echo "docker run --rm -it --gpus all -p 8080:8080 nebulastream-runner:latest"

