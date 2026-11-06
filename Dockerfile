FROM denoland/deno:2.9.8 AS deno
FROM node:22.21.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/torlink
RUN git init && git remote add origin https://github.com/baairon/torlink.git && git fetch --depth 1 origin c9f0ab0e90e9d02b63ecbb860d0f51722893e579 && git checkout --detach FETCH_HEAD
RUN npm ci && npm run build && npm prune --omit=dev
RUN curl -fsSL https://github.com/swamp-club/swamp/releases/download/v20261105.030003.0-sha.363a1dad/swamp-linux-x86_64 -o /usr/local/bin/swamp && echo '76dee1c4138de46aea5c530f0b84c45980b5e3b6da934a40b5e8fd32ff146ad3  /usr/local/bin/swamp' | sha256sum -c - && chmod +x /usr/local/bin/swamp

FROM node:22.21.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates rsync openssh-client iproute2 curl git tar perl && rm -rf /var/lib/apt/lists/*
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
COPY --from=build /usr/local/bin/swamp /usr/local/bin/swamp
COPY --from=build /opt/torlink /opt/torlink
WORKDIR /opt/hoardarr
COPY . .
RUN mkdir -p /home/node/.swamp/deno /home/node/.cache/deno && cp /usr/local/bin/deno /home/node/.swamp/deno/deno && chown -R node:node /home/node /opt/hoardarr && chmod +x bin/hoardarr deploy/compose/entrypoint.sh
ENV HOME=/home/node DENO_DIR=/home/node/.cache/deno HOARDARR_DENO=/usr/local/bin/deno
USER node
RUN deno cache cli/main.ts extensions/models/*.ts extensions/reports/*.ts
ENTRYPOINT ["/opt/hoardarr/deploy/compose/entrypoint.sh"]
CMD ["help"]
