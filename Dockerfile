FROM docker.io/cloudflare/sandbox:0.12.10
RUN npm install -g @anthropic-ai/claude-code@2.1.284 @openai/codex@0.159.0
COPY sandbox/repository.mjs /opt/agentflare/repository.mjs
