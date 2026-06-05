#!/bin/bash

# =====================================================================
# Atreus Premium Runner
# =====================================================================

# Color configurations
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0;37m' # No Color

clear

echo -e "${PURPLE}"
echo "    ___   __"
echo "   /   | / /________  __  _______"
echo "  / /| |/ __/ ___/ _ \/ / / / ___/"
echo " / ___ / /_/ /  /  __/ /_/ (__  )"
echo "/_/  |_|\__/_/   \___/\__,_/____/"
echo "                                "
echo -e "${CYAN}================== PREMIUM VAULT CHECKS & BOOTLOADER ==================${NC}"
echo ""

# Get project root directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# 1. Setting up Python Virtual Environment
echo -e "${BLUE}[1/3] Activating secure Python environments...${NC}"
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}No virtual environment found. Generating fresh python venv...${NC}"
    python3 -m venv venv
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to create Python virtual environment. Ensure python3-venv is installed.${NC}"
        exit 1
    fi
fi

source venv/bin/activate
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to activate Python virtual environment.${NC}"
    exit 1
fi

# 2. Update dependencies
echo -e "${BLUE}[2/3] Validating and downloading library dependencies...${NC}"
pip install -r backend/requirements.txt
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to install Python dependencies.${NC}"
    exit 1
fi

# 3. Fetch System Local IP addresses for Android connectivity
echo -e "${BLUE}[3/3] Scanning network adapters for mobile connections...${NC}"
IP_ADDRS=$(hostname -I 2>/dev/null)
PRIMARY_IP=$(echo "$IP_ADDRS" | awk '{print $1}')

if [ -z "$PRIMARY_IP" ]; then
    PRIMARY_IP="YOUR-HOMESERVER-IP"
fi

echo -e ""
echo -e "${GREEN}✔ SUCCESS: Obsidian Tasks Server is fully compiled!${NC}"
echo -e "--------------------------------------------------------"
echo -e "${YELLOW}LINUX DESKTOP PORTAL:${NC}"
echo -e "👉 ${CYAN}http://localhost:8000/${NC}"
echo -e ""
echo -e "${YELLOW}ANDROID APP PORTAL (Homeserver connection):${NC}"
echo -e "👉 ${CYAN}http://${PRIMARY_IP}:8000/${NC}"
echo -e "--------------------------------------------------------"
echo -e "${BLUE}Starting FastAPI Uvicorn engine...${NC}"
echo -e ""

# Run the FastAPI server via Uvicorn with hot reloading
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
