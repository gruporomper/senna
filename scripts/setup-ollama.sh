#!/bin/bash
# Setup Ollama with lightweight models for SENNA production
# Run after docker-compose up -d

echo "Waiting for Ollama to be ready..."
until curl -s http://localhost:11434 > /dev/null 2>&1; do
  sleep 2
done
echo "Ollama is ready."

echo "Pulling dolphin-mistral:7b (main model)..."
curl -s http://localhost:11434/api/pull -d '{"name":"dolphin-mistral:7b"}' | tail -1

echo "Pulling phi3:mini (lightweight fallback)..."
curl -s http://localhost:11434/api/pull -d '{"name":"phi3:mini"}' | tail -1

echo "Setup complete. Available models:"
curl -s http://localhost:11434/api/tags | python3 -m json.tool 2>/dev/null || curl -s http://localhost:11434/api/tags
