# ---------- 1: build do frontend ----------
FROM node:22-alpine AS web
WORKDIR /app
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 2: agent + estatico ----------
FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir psutil==7.* websockets==15.*

COPY agent/ /app/agent/
COPY --from=web /app/dist /app/web

EXPOSE 8765 8080
# --static faz o proprio agent servir o frontend, entao um container so basta
CMD ["python", "/app/agent/server.py", \
     "--host", "0.0.0.0", "--port", "8765", \
     "--static", "/app/web", "--http-port", "8080", \
     "--interval", "1", "--top", "300"]
