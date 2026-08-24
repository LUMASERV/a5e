FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir ansible-core

COPY packages/runner-image/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN useradd -u 1000 -m runner
USER runner
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
