#!/bin/sh
# ansible-runner-style entrypoint for AnsibleRun Jobs. One image, three steps, selected by argv[1]
# — job-builder.ts wires each step up as its own (init)container using this same image.
set -eu

STEP="${1:-}"

case "$STEP" in
  fetch-content)
    # env: GIT_URL, GIT_REVISION (default main), GIT_SSH_KEY_PATH (optional, for ssh:// / git@ URLs),
    #      GIT_HTTP_AUTH_PATH (optional, directory with username/password files, for https:// URLs)
    mkdir -p /workspace/repo
    cd /workspace/repo
    git init -q
    git remote add origin "$GIT_URL"
    if [ -n "${GIT_SSH_KEY_PATH:-}" ]; then
      export GIT_SSH_COMMAND="ssh -i $GIT_SSH_KEY_PATH -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"
    elif [ -n "${GIT_HTTP_AUTH_PATH:-}" ]; then
      # A credential helper (rather than embedding creds in the remote URL) keeps the token out
      # of `git remote -v`/process listings; reads straight from the mounted Secret files.
      git config credential.helper "!f() { echo username=\$(cat $GIT_HTTP_AUTH_PATH/username); echo password=\$(cat $GIT_HTTP_AUTH_PATH/password); }; f"
    fi
    git fetch --depth 1 origin "${GIT_REVISION:-main}" -q
    git checkout -q FETCH_HEAD
    echo "RESOLVED_SHA=$(git rev-parse HEAD)"
    ;;

  install-dependencies)
    # env: REQUIREMENTS_FILE (optional)
    mkdir -p /workspace/roles /workspace/collections
    if [ -n "${REQUIREMENTS_FILE:-}" ] && [ -s "$REQUIREMENTS_FILE" ]; then
      ansible-galaxy install -r "$REQUIREMENTS_FILE" -p /workspace/roles || true
      ansible-galaxy collection install -r "$REQUIREMENTS_FILE" -p /workspace/collections || true
    fi
    ;;

  playbook)
    # env: PLAYBOOK_DIR, ENTRY_POINT, INVENTORY_FILE, EXTRA_VARS_FILE, ANSIBLE_EXTRA_ARGS
    # No single --private-key: each host in the rendered inventory carries its own
    # ansible_ssh_private_key_file var (SSH keys are a host property, not a run property), so
    # every mounted key just needs correct file permissions.
    export ANSIBLE_ROLES_PATH="/workspace/roles:${ANSIBLE_ROLES_PATH:-}"
    export ANSIBLE_COLLECTIONS_PATH="/workspace/collections:${ANSIBLE_COLLECTIONS_PATH:-}"
    export ANSIBLE_HOST_KEY_CHECKING=False
    for key in /ssh-keys/*/ssh-privatekey; do
      [ -f "$key" ] && chmod 600 "$key"
    done 2>/dev/null || true
    cd "$PLAYBOOK_DIR"
    # shellcheck disable=SC2086
    exec ansible-playbook -i "$INVENTORY_FILE" -e "@$EXTRA_VARS_FILE" ${ANSIBLE_EXTRA_ARGS:-} "$ENTRY_POINT"
    ;;

  *)
    echo "unknown step: $STEP" >&2
    exit 1
    ;;
esac
