# Development image for GitHub Codespaces: Ubuntu + Bun + client tools.
# Node.js 22 is added by the devcontainer "node" feature (see devcontainer.json).
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Tested with Bun 1.4.x (CI uses the latest stable via oven-sh/setup-bun).
ARG BUN_VERSION=1.4.2

RUN apt-get update \
 && export DEBIAN_FRONTEND=noninteractive \
 && apt-get install -y --no-install-recommends \
      postgresql-client redis-tools openssl curl jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

USER vscode
ENV BUN_INSTALL=/home/vscode/.bun
ENV PATH=/home/vscode/.bun/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
