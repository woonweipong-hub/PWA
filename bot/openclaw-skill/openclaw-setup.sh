#!/bin/bash
# ── SiteShrimp OpenClaw Setup ──────────────────────────────────────
# One-script setup for OpenClaw with SiteShrimp read-only integration.
# Supports: Ollama (free), Gemini (free), OpenAI, or any compatible API.
#
# Usage: bash openclaw-setup.sh
# ───────────────────────────────────────────────────────────────────

set -e

echo ""
echo "══════════════════════════════════════════════════"
echo "  🦐 SiteShrimp × 🦞 OpenClaw Setup"
echo "══════════════════════════════════════════════════"
echo ""

# ── Check Node.js ──
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  echo "❌ Node.js 22+ required. Install from https://nodejs.org/"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# ── Check/Install OpenClaw ──
if ! command -v openclaw &> /dev/null; then
  echo ""
  echo "Installing OpenClaw..."
  npm install -g openclaw@latest
fi
echo "✓ OpenClaw installed"

# ── Check/Install Ollama ──
echo ""
echo "── AI Model Selection ──────────────────────────"
echo ""
echo "Choose your AI provider (your own tokens, your own cost):"
echo ""
echo "  1) Ollama — FREE, runs locally, private (recommended)"
echo "  2) Google Gemini — FREE API key, 1500/day"
echo "  3) OpenAI / GPT — paid, most capable"
echo "  4) Skip — configure later"
echo ""
read -p "Choice [1]: " AI_CHOICE
AI_CHOICE=${AI_CHOICE:-1}

MODEL_CONFIG=""
AI_ENV=""

case $AI_CHOICE in
  1)
    echo ""
    if ! command -v ollama &> /dev/null; then
      echo "Ollama not found. Install from: https://ollama.com/download"
      echo "After installing, run: ollama pull qwen3:8b"
      read -p "Press Enter after installing Ollama, or Ctrl+C to exit..."
    fi

    echo ""
    echo "── Ollama Model Selection ────────────────────"
    echo ""
    echo "Recommended free models for construction site work:"
    echo ""
    echo "  1) qwen3:8b      — Best balance of speed + quality (recommended)"
    echo "  2) qwen3:4b      — Faster, lighter, good for older hardware"
    echo "  3) qwen3:14b     — Higher quality, needs 16GB+ RAM"
    echo "  4) llama3.3      — Meta's latest, strong general purpose"
    echo "  5) gemma3        — Google's open model"
    echo "  6) Custom         — Enter your own model name"
    echo ""
    read -p "Choice [1]: " MODEL_CHOICE
    MODEL_CHOICE=${MODEL_CHOICE:-1}

    case $MODEL_CHOICE in
      1) OLLAMA_MODEL="qwen3:8b" ;;
      2) OLLAMA_MODEL="qwen3:4b" ;;
      3) OLLAMA_MODEL="qwen3:14b" ;;
      4) OLLAMA_MODEL="llama3.3" ;;
      5) OLLAMA_MODEL="gemma3" ;;
      6) read -p "Model name: " OLLAMA_MODEL ;;
      *) OLLAMA_MODEL="qwen3:8b" ;;
    esac

    echo ""
    echo "Pulling $OLLAMA_MODEL (this may take a few minutes on first run)..."
    ollama pull "$OLLAMA_MODEL" || echo "⚠ Pull failed — make sure Ollama is running (ollama serve)"

    MODEL_CONFIG="\"ollama/$OLLAMA_MODEL\""
    AI_ENV="OLLAMA_API_KEY=ollama-local"
    echo "✓ Ollama configured with $OLLAMA_MODEL"
    ;;
  2)
    echo ""
    echo "Get your free Gemini API key from: https://aistudio.google.com/apikey"
    read -p "Gemini API Key: " GEMINI_KEY
    MODEL_CONFIG="\"google/gemini-2.5-flash\""
    AI_ENV="GEMINI_API_KEY=$GEMINI_KEY"
    echo "✓ Gemini configured"
    ;;
  3)
    echo ""
    read -p "OpenAI API Key: " OPENAI_KEY
    MODEL_CONFIG="\"openai/gpt-4o\""
    AI_ENV="OPENAI_API_KEY=$OPENAI_KEY"
    echo "✓ OpenAI configured"
    ;;
  4)
    echo "Skipping AI setup — configure later with: openclaw onboard"
    MODEL_CONFIG="\"ollama/qwen3:8b\""
    ;;
esac

# ── Telegram Bot ──
echo ""
echo "── Telegram Setup ────────────────────────────────"
echo ""
echo "Create a NEW bot for OpenClaw (separate from SiteShrimp bot):"
echo "  1. Open Telegram → search @BotFather"
echo "  2. Send /newbot → name it (e.g., 'MyCompany AI')"
echo "  3. Copy the bot token"
echo ""
read -p "OpenClaw Telegram Bot Token: " OC_BOT_TOKEN

if [ -z "$OC_BOT_TOKEN" ]; then
  echo "⚠ No token provided — you can add it later in ~/.openclaw/openclaw.json"
  OC_BOT_TOKEN="YOUR_BOT_TOKEN_HERE"
fi

# ── SiteShrimp PocketBase ──
echo ""
echo "── SiteShrimp Connection (Read-Only) ──────────────"
echo ""
read -p "PocketBase URL (e.g., https://siteshrimp.duckdns.org): " PB_URL
PB_URL=${PB_URL:-https://siteshrimp.duckdns.org}

echo ""
echo "Create a read-only user in PocketBase first (see SETUP.md)."
echo "Then generate a token:"
read -p "Read-only API Token (or press Enter to skip): " PB_TOKEN

# ── Create Config ──
echo ""
echo "── Creating Configuration ────────────────────────"

OPENCLAW_DIR="$HOME/.openclaw"
mkdir -p "$OPENCLAW_DIR/skills/siteshrimp"

# Copy skill file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/SKILL.md" ]; then
  cp "$SCRIPT_DIR/SKILL.md" "$OPENCLAW_DIR/skills/siteshrimp/SKILL.md"
  echo "✓ SiteShrimp skill installed"
else
  echo "⚠ SKILL.md not found — copy it manually to ~/.openclaw/skills/siteshrimp/"
fi

# Write OpenClaw config
cat > "$OPENCLAW_DIR/openclaw.json" << JSONEOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": $MODEL_CONFIG
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$OC_BOT_TOKEN",
      "dmPolicy": "pairing",
      "groups": {
        "*": {
          "requireMention": true
        }
      }
    }
  },
  "skills": {
    "entries": {
      "siteshrimp": {
        "enabled": true,
        "env": {
          "SITESHRIMP_PB_URL": "$PB_URL",
          "SITESHRIMP_PB_TOKEN": "${PB_TOKEN:-PASTE_YOUR_READ_ONLY_TOKEN_HERE}"
        }
      }
    }
  }
}
JSONEOF

echo "✓ Config written to ~/.openclaw/openclaw.json"

# Write env file
if [ -n "$AI_ENV" ]; then
  echo "$AI_ENV" >> "$OPENCLAW_DIR/.env"
  echo "✓ AI credentials saved"
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✅ Setup Complete!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  AI Model:    $MODEL_CONFIG"
echo "  Telegram:    $([ "$OC_BOT_TOKEN" != "YOUR_BOT_TOKEN_HERE" ] && echo "configured" || echo "needs token")"
echo "  SiteShrimp:  $PB_URL (read-only)"
echo ""
echo "── Next Steps ────────────────────────────────────"
echo ""
echo "  1. Start Ollama (if using):  ollama serve"
echo "  2. Start OpenClaw:           openclaw gateway --verbose"
echo "  3. Add the bot to your Telegram group"
echo "  4. Test: @YourBot how many open defects?"
echo ""
echo "── Your Telegram Group Should Have ───────────────"
echo ""
echo "  🦐 @SiteShrimp_bot     — logs defects (photos/voice/text)"
echo "  🦞 @YourOpenClaw_bot   — queries & reports (read-only)"
echo ""
echo "── Free AI Models (Ollama) ───────────────────────"
echo ""
echo "  ollama pull qwen3:8b       — balanced (recommended)"
echo "  ollama pull qwen3:4b       — fast, lightweight"
echo "  ollama pull qwen3:14b      — high quality"
echo "  ollama pull llama3.3       — Meta's latest"
echo "  ollama pull deepseek-r1:8b — reasoning model"
echo "  ollama pull gemma3         — Google's open model"
echo ""
echo "  Switch model anytime:"
echo "  openclaw models set ollama/qwen3:8b"
echo ""
