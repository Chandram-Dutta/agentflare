FROM docker.io/cloudflare/sandbox:0.12.10
USER root
RUN apt-get update && apt-get install -y --no-install-recommends tini util-linux coreutils && rm -rf /var/lib/apt/lists/*
COPY sandbox/acp/package.json sandbox/acp/package-lock.json /opt/agentflare/acp/
RUN cd /opt/agentflare/acp && npm ci --omit=dev --ignore-scripts
COPY sandbox/acp/ /opt/agentflare/acp/
COPY sandbox/repository.mjs /opt/agentflare/repository.mjs
COPY sandbox/review-tests.mjs /opt/agentflare/review-tests.mjs
COPY sandbox/native-workspace.mjs sandbox/native-workspace.sh /opt/agentflare/
EXPOSE 8766 8767
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/opt/agentflare/native-workspace.sh"]
