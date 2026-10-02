FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.2 AS computer
FROM docker.io/cloudflare/sandbox:0.12.10
USER root
RUN apt-get update && apt-get install -y --no-install-recommends fuse3 libfuse2 tini && rm -rf /var/lib/apt/lists/*
COPY --from=computer /usr/local/bin/computerd /usr/local/bin/computerd
COPY sandbox/acp/package.json sandbox/acp/package-lock.json /opt/agentflare/acp/
RUN cd /opt/agentflare/acp && npm ci --omit=dev --ignore-scripts
COPY sandbox/acp/ /opt/agentflare/acp/
COPY sandbox/repository.mjs /opt/agentflare/repository.mjs
COPY sandbox/review-tests.mjs /opt/agentflare/review-tests.mjs
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=fuse
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/computerd"]
