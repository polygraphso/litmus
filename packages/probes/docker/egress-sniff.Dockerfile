# Egress-sniff image — used for BOTH the sinkhole (--entrypoint /sink-entrypoint.sh,
# with NET_ADMIN) and the target run (--entrypoint npx, all caps dropped).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables iproute2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY sinkhole.mjs /sinkhole.mjs
COPY sink-entrypoint.sh /sink-entrypoint.sh
RUN chmod +x /sink-entrypoint.sh

# No default CMD/ENTRYPOINT: callers set it (sink vs target) at `docker run`.
