# The trained question reader: labels each word of an Ask question.
# Built by Ansible (host/roles/memento_extras), or in dev by ./memento.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
WORKDIR /app
# ONNX Runtime's usage reporting off.
ENV ORT_DISABLE_TELEMETRY=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Packages pinned with hashes (requirements.txt).
COPY requirements.txt .
# Wheels only.
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt
COPY model/ ./model/
COPY common.py ./
COPY reader/ ./reader/
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["python", "-m", "reader.server"]
