#!/bin/bash
# =====================================================================
# ZimaOS Auto-Updater Script for Atreus (Git & Local Build Approach)
# =====================================================================
# This script pulls changes from Git, rebuilds the Docker container
# if changes are detected, and cleans up old unused Docker images.
#
# Instructions:
# 1. Place this script in your application folder on ZimaOS.
# 2. Make it executable: chmod +x update-zimaos.sh
# 3. Schedule it with cron (e.g., crontab -e) to run periodically.

# Navigate to the script's directory
cd "$(dirname "$0")"

# Check if we are inside a Git repository
if [ ! -d ".git" ]; then
    echo "Error: Not a git repository. Please configure a Git remote first."
    exit 1
fi

echo "Fetching remote updates..."
git fetch origin main > /dev/null 2>&1

# Get the current local and remote commit hashes
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u} 2>/dev/null)

if [ -z "$REMOTE" ]; then
    echo "Error: Unable to fetch remote tracking branch. Ensure your local branch tracks a remote."
    exit 1
fi

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "--------------------------------------------------------"
    echo "New updates found! Pulling latest changes..."
    echo "--------------------------------------------------------"
    git pull origin main
    
    echo "Rebuilding and restarting Docker containers..."
    docker compose up -d --build
    
    echo "Cleaning up dangling images..."
    docker image prune -f
    
    echo "Update completed successfully!"
else
    echo "Already up-to-date."
fi
