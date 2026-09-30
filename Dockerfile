FROM docker.io/cloudflare/sandbox:0.12.10
RUN npm install -g @anthropic-ai/claude-code@2.1.284 @openai/codex@0.159.0
COPY sandbox/repository.mjs /opt/agentflare/repository.mjs
COPY sandbox/launch-agent.sh /opt/agentflare/launch-agent.sh
RUN command -v setsid && chmod 755 /opt/agentflare/launch-agent.sh \
    && mkdir -p /opt/agentflare/bin \
    && ln -s ../launch-agent.sh /opt/agentflare/bin/claude \
    && ln -s ../launch-agent.sh /opt/agentflare/bin/codex
ENV PATH="/opt/agentflare/bin:${PATH}"
