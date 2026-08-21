FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates tini nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY github-env-publish.mjs /github-env-publish.mjs
COPY workspace-policy.mjs /workspace-policy.mjs
COPY workspace-policy.json /workspace-policy.json
COPY git-credential-tiller.mjs /usr/local/bin/git-credential-tiller
COPY entrypoint.scm.sh /entrypoint.sh
RUN chmod +x /github-env-publish.mjs /entrypoint.sh /usr/local/bin/git-credential-tiller

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
