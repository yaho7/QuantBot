FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.13.6 AS uv

FROM python:3.12-slim-bookworm AS service
LABEL org.opencontainers.image.source="https://github.com/yaho7/QuantBot" \
      org.opencontainers.image.description="QuantBot HTTP monitoring and control console" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock README.md LICENSE ./
COPY src/ ./src/
RUN rm -rf src/quantbot/web
COPY --from=frontend /app/src/quantbot/web/ ./src/quantbot/web/
RUN uv sync --frozen --no-dev --no-editable \
    && groupadd --gid 10001 quantbot \
    && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home quantbot \
    && install -d -m 0700 -o quantbot -g quantbot /data
ENV PATH="/app/.venv/bin:$PATH" QB_DATA_DIR=/data QB_HOST=0.0.0.0 QB_PORT=8888 QB_DOCKER_LOCAL_HTTP=1
USER 10001:10001
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8888/healthz', timeout=3).close()"]
ENTRYPOINT ["quantbot"]
CMD ["serve"]
