# Doefin v3 security toolchain.
#
# Extends the Trail of Bits eth-security-toolbox with Mythril and the project's
# Hardhat toolchain.
#
# Built and run as linux/amd64: native `solc` binaries are amd64-only, so the
# whole toolchain must be amd64 to stay consistent. On Apple Silicon this runs
# under emulation — slower per call, but correct and uniform.
#
# Multi-stage: the Mythril virtualenv (stage `mythril`) and the project
# node_modules (stage `node`) have no dependency on each other, so BuildKit
# builds them in parallel; the final stage copies both in.
#
# Base is the :nightly tag (a multi-arch index) + an explicit --platform so the
# amd64 variant is selected. To pin by digest, resolve the amd64-specific digest
# with: docker buildx imagetools inspect ghcr.io/trailofbits/eth-security-toolbox:nightly
ARG BASE=ghcr.io/trailofbits/eth-security-toolbox:nightly

# ---- Stage: Mythril in an isolated virtualenv ----
FROM --platform=linux/amd64 ${BASE} AS mythril
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-dev make g++ \
 && rm -rf /var/lib/apt/lists/*
# `wheel` lets pip resolve Mythril's full dependency graph (legacy installs drop
# transitive deps such as zope.interface). setuptools is pinned <80 because
# Mythril's `eth` dependency imports `pkg_resources`, which setuptools 81+ removed.
RUN python3 -m venv /opt/mythril-venv \
 && /opt/mythril-venv/bin/pip install --no-cache-dir --upgrade pip wheel "setuptools<80" \
 && /opt/mythril-venv/bin/pip install --no-cache-dir mythril zope.interface

# ---- Stage: project Hardhat toolchain (node_modules) ----
FROM --platform=linux/amd64 ${BASE} AS node
USER root
WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-dev make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- Final image ----
FROM --platform=linux/amd64 ${BASE}
USER root
WORKDIR /src

# solc 0.8.20 to match hardhat.config.js (optimizer runs=1, viaIR).
RUN solc-select install 0.8.20 && solc-select use 0.8.20

# Mythril, from the `mythril` stage. Expose only the `myth` entrypoint on PATH.
COPY --from=mythril /opt/mythril-venv /opt/mythril-venv
RUN ln -sf /opt/mythril-venv/bin/myth /usr/local/bin/myth

# Stage solc 0.8.20 where Mythril's solcx looks for it — solcx's bundled
# download host (solc-bin.ethereum.org) is dead.
RUN SOLC_BIN="$(find / -path '*solc-select/artifacts/solc-0.8.20/solc-0.8.20' -type f 2>/dev/null | head -1)" \
 && test -n "$SOLC_BIN" \
 && mkdir -p /home/ethsec/.solcx \
 && cp "$SOLC_BIN" /home/ethsec/.solcx/solc-v0.8.20 \
 && chmod 755 /home/ethsec/.solcx/solc-v0.8.20

# Project node_modules, from the `node` stage (amd64-native).
COPY --from=node /src/node_modules /src/node_modules

ENV SOLC_VERSION=0.8.20
CMD ["tail", "-f", "/dev/null"]
