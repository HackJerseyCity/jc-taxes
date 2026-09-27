# Pipeline image for AWS Batch (see specs/infra-dev-stack.md, specs/dvx-pipeline.md):
# python + uv + a blobless clone of this repo + `uv sync`, running `dvx run`.
#
# Clone (not COPY) keeps the build context tiny and gives dvx the `.git`
# objects its `git_deps` hashing needs. Build arg `REF` pins the rev.
#
#   docker build --platform linux/arm64 -t jct-pipeline:$(git rev-parse --short HEAD) \
#     --build-arg REF=$(git rev-parse HEAD) batch/
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG REPO=https://github.com/HackJerseyCity/jc-taxes
ARG REF=main
RUN git clone --filter=blob:none "$REPO" /app && git -C /app checkout "$REF"
WORKDIR /app

RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONFAULTHANDLER=1

RUN git config --global user.name "dvx-batch" && \
    git config --global user.email "dvx-batch@localhost"

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
