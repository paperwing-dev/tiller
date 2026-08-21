ARG BASE_IMAGE_REF=docker.io/jamieatlason/tiller-sandbox-base:stable
FROM ${BASE_IMAGE_REF}

# --- Runtime Layer 1: tiller-harness (changes on version bumps) ---
# Uses @homebridge/node-pty-prebuilt-multiarch — no build tools needed
ARG TILLER_IMAGE_COMMIT
ARG TILLER_REVIEWER_ISOLATION_PROTOCOL=0
RUN test -n "$TILLER_IMAGE_COMMIT" || { echo "ERROR: TILLER_IMAGE_COMMIT build arg is required"; exit 1; }
RUN test "$TILLER_REVIEWER_ISOLATION_PROTOCOL" = "0" -o "$TILLER_REVIEWER_ISOLATION_PROTOCOL" = "1" \
    && printf '%s\n' "$TILLER_REVIEWER_ISOLATION_PROTOCOL" > /etc/tiller-reviewer-isolation-protocol
LABEL dev.tiller.reviewer-isolation-protocol="$TILLER_REVIEWER_ISOLATION_PROTOCOL"
COPY tiller-harness.tgz /tmp/tiller-harness.tgz
COPY verify-codex-reviewer-contract.sh /tmp/verify-codex-reviewer-contract.sh
RUN npm install -g /tmp/tiller-harness.tgz \
    && node -e "const cp=require('child_process'); const path=require('path'); const root=cp.execSync('npm root -g',{encoding:'utf8'}).trim(); const pkg=require(path.join(root,'@paperwing-dev/tiller-harness/package.json')); process.stdout.write(pkg.version + '\n');" > /etc/tiller-harness-version \
    && bash /tmp/verify-codex-reviewer-contract.sh \
    && printf '%s\n' "$TILLER_IMAGE_COMMIT" > /etc/tiller-image-commit \
    && rm /tmp/tiller-harness.tgz /tmp/verify-codex-reviewer-contract.sh

# --- Runtime Layer 2: App files (changes most often) ---
COPY workspace-sync.mjs /workspace-sync.mjs
COPY github-env-publish.mjs /github-env-publish.mjs
COPY workspace-policy.mjs /workspace-policy.mjs
COPY workspace-policy.json /workspace-policy.json
COPY git-credential-tiller.mjs /usr/local/bin/git-credential-tiller
COPY stop-finalize.sh /stop-finalize.sh
COPY stop-control-server.mjs /stop-control-server.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /stop-finalize.sh /github-env-publish.mjs /usr/local/bin/git-credential-tiller

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
