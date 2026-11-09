FROM python:3.12-slim

WORKDIR /app

COPY index.html ./
COPY assets ./assets
COPY server ./server

ENV PORT=8080 \
    XN_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data
EXPOSE 8080

CMD ["python", "server/app.py", "--port", "8080"]
