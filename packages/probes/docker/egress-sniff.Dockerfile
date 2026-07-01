# Egress-sniff image — used for BOTH the sinkhole (--entrypoint /sink-entrypoint.sh,
# with NET_ADMIN) and the target run (--entrypoint node|python3, all caps dropped).
FROM node:22-slim

# uv (offline-capable pypi staging), pinned for reproducibility. Copied from the
# official static image so the build needs no installer script / network curl.
COPY --from=ghcr.io/astral-sh/uv:0.5.29 /uv /usr/local/bin/uv

# python3 + venv so a staged pypi server can be installed into a venv (wheels only,
# no build code) and launched offline. System python3 means the venv's bin/python
# symlinks to a world-executable interpreter the non-root `node` user can run.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables iproute2 ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY sinkhole.mjs /sinkhole.mjs
COPY sink-entrypoint.sh /sink-entrypoint.sh
RUN chmod +x /sink-entrypoint.sh

# No default CMD/ENTRYPOINT: callers set it (sink vs target) at `docker run`.
