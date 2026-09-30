FROM docker.io/cloudflare/sandbox:0.12.10
COPY sandbox/acp/package.json sandbox/acp/package-lock.json /opt/agentflare/acp/
RUN cd /opt/agentflare/acp && npm ci --omit=dev --ignore-scripts
COPY sandbox/acp/bridge.mjs /opt/agentflare/acp/bridge.mjs
COPY sandbox/acp/content.mjs /opt/agentflare/acp/content.mjs
COPY sandbox/acp/auth-checkpoint.mjs /opt/agentflare/acp/auth-checkpoint.mjs
COPY sandbox/acp/checkpoint-loop.mjs /opt/agentflare/acp/checkpoint-loop.mjs
COPY sandbox/repository.mjs /opt/agentflare/repository.mjs
