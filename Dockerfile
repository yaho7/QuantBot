FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/quantbot/ ./cmd/quantbot/
COPY internal/ ./internal/
COPY web/embed.go ./web/
COPY --from=frontend /src/web/dist/ ./web/dist/
RUN CGO_ENABLED=1 go build -trimpath -tags "netgo osusergo sqlite_omit_load_extension" -ldflags '-s -w -linkmode external -extldflags "-static"' -o /out/quantbot ./cmd/quantbot

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/yaho7/QuantBot" \
      org.opencontainers.image.description="QuantBot HTTP monitoring and control console" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 10001 -g 10001 /data
COPY --from=build /out/quantbot /usr/local/bin/quantbot
COPY LICENSE /usr/share/doc/quantbot/LICENSE
COPY docs/licenses/ /usr/share/doc/quantbot/licenses/
USER 10001:10001
ENV QB_DATA_DIR=/data QB_LISTEN=0.0.0.0:8888
EXPOSE 8888
HEALTHCHECK --interval=10s --timeout=4s --start-period=3s CMD ["quantbot", "health"]
ENTRYPOINT ["quantbot"]
CMD ["serve"]
