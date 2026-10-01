#!/usr/bin/env bash
# Kahana Fusi installer: tools + models. Safe to re-run (skips what's already there).
set -euo pipefail
cd "$(dirname "$0")"

# Custom model: set WHISPER_URL and WHISPER_SHA="" (or its sha256) together.
WHISPER_URL="${WHISPER_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"

[[ "$(uname)" == "Darwin" ]] || { echo "Kahana Fusi currently supports macOS only."; exit 1; }
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
command -v node >/dev/null || brew install node
command -v whisper-cli >/dev/null || brew install whisper-cpp
command -v ollama >/dev/null || brew install ollama

M="$HOME/.kahana-fusi/models"
mkdir -p "$M"
get() { # get <url> <file> [sha256]: refuses to install a file whose checksum doesn't match
  if [[ -s "$M/$2" ]]; then echo "  $2 already downloaded"; return; fi
  curl -L --fail --proto '=https' -o "$M/$2.part" "$1"
  if [[ -n "${3:-}" ]] && [[ "$(shasum -a 256 "$M/$2.part" | cut -d' ' -f1)" != "$3" ]]; then
    rm -f "$M/$2.part"; echo "✗ Checksum mismatch for $2. Download aborted."; exit 1
  fi
  mv "$M/$2.part" "$M/$2"
}
echo "→ Speech model (~550 MB) → $M/ggml.bin"
get "$WHISPER_URL" ggml.bin "${WHISPER_SHA:-394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2}"
echo "→ Silence detector (~1 MB) → $M/vad.bin"
get https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin vad.bin 29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf

echo "→ Cleanup model ($OLLAMA_MODEL, ~2 GB) → ~/.ollama/models"
curl -s localhost:11434 >/dev/null || { (ollama serve >/dev/null 2>&1 &); sleep 3; }
ollama pull "$OLLAMA_MODEL"

echo "→ App dependencies"
npm install

echo "→ Building Kahana Fusi.app → /Applications"
npm run build-app

echo "✓ Done. Open 'Kahana Fusi' from /Applications (or Spotlight), then hold Right Option and talk."
