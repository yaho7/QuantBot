# The demo strategy. Build context is the repo root: docker build -f examples/Dockerfile .
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY client/quantbot_client.py examples/demo.py ./
RUN useradd --uid 10001 demo
USER demo
CMD ["python", "demo.py"]
