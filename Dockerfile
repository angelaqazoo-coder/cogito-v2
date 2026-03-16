# ── Build stage ───────────────────────────────────────────────────────────────
FROM python:3.12-slim AS base

WORKDIR /app

# Install dependencies first (layer cache)
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY server/ ./server/
COPY frontend/ ./frontend/

# ── Runtime ───────────────────────────────────────────────────────────────────
ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8080"]
