#!/usr/bin/env bash
# Kahana Fusi installer: tools + models. Safe to re-run (skips what's already there).
set -euo pipefail
cd "$(dirname "$0")"

WHISPER_URL="${WHISPER_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"

[[ "$(uname)" == "Darwin" ]] || { echo "Kahana Fusi currently supports macOS only."; exit 1; }
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
command -v node >/dev/null || brew install node
command -v whisper-cli >/dev/null || brew install whisper-cpp
command -v ollama >/dev/null || brew install ollama

M="$HOME/.kahana-fusi/models"
mkdir -p "$M"
get() { # get <url> <file>
  if [[ -s "$M/$2" ]]; then echo "  $2 already downloaded"
  else curl -L --fail -o "$M/$2.part" "$1" && mv "$M/$2.part" "$M/$2"; fi
}
echo "→ Speech model (~550 MB) → $M/ggml.bin"
get "$WHISPER_URL" ggml.bin
echo "→ Silence detector (~1 MB) → $M/vad.bin"
get https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin vad.bin

echo "→ Cleanup model ($OLLAMA_MODEL, ~2 GB) → ~/.ollama/models"
curl -s localhost:11434 >/dev/null || { (ollama serve >/dev/null 2>&1 &); sleep 3; }
ollama pull "$OLLAMA_MODEL"

echo "→ App dependencies"
npm install

echo "→ Building Kahana Fusi.app → /Applications"
npm run build-app

echo "✓ Done. Open 'Kahana Fusi' from /Applications (or Spotlight), then hold Right Option and talk."
