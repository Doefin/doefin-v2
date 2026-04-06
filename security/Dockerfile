FROM ubuntu:22.04

RUN apt update && apt install -y \
    python3 \
    python3-pip \
    git \
    curl \
    python3-dev \
    libgmp-dev \
    cmake \
    build-essential \
    pkg-config \
    libffi-dev \
    zlib1g-dev \
    wget \
    unzip

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt install -y nodejs

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install maturin (Python build tool for Rust extensions)
RUN pip3 install maturin

# Install Hardhat analysis tools
RUN pip3 install slither-analyzer
RUN pip3 install mythril

ARG ECHIDNA_VERSION=v2.3.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) echidna_arch="x86_64-linux" ;; \
        arm64) echidna_arch="aarch64-linux" ;; \
        *) echo "Unsupported architecture for Echidna: $arch" >&2; exit 1 ;; \
    esac; \
    version_no_v="${ECHIDNA_VERSION#v}"; \
    url="https://github.com/crytic/echidna/releases/download/${ECHIDNA_VERSION}/echidna-${version_no_v}-${echidna_arch}.tar.gz"; \
    curl -L "$url" -o /tmp/echidna.tar.gz; \
    tar -xzf /tmp/echidna.tar.gz -C /tmp; \
    install -m 0755 /tmp/echidna /usr/local/bin/echidna-test; \
    rm -f /tmp/echidna.tar.gz /tmp/echidna

RUN mkdir -p /app && chown -R root:root /app
WORKDIR /app
