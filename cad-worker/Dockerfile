# syntax=docker/dockerfile:1

# CADForge cad-worker: CadQuery execution, validation, and export.
#
# The OpenCascade wheels are platform specific, so this image pins Python 3.11
# (section 4 of SETUP.md) rather than whatever the base image ships.
#
#   docker build -t cadforge-worker .
#   docker run --rm -p 8000:8000 -v "$(pwd)/../storage:/app/storage" cadforge-worker

FROM python:3.11-slim-bookworm

# OpenCascade's shared libraries are not all in slim; cadquery will not import
# without them. curl is only here for the healthcheck below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglu1-mesa \
        libxrender1 \
        libxext6 \
        libsm6 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so the layer caches across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY tests ./tests
COPY pytest.ini ./

# Where artifacts are written; mount a volume here to persist them.
ENV CADFORGE_STORAGE_ROOT=/app/storage \
    PYTHONUNBUFFERED=1
RUN mkdir -p /app/storage

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
