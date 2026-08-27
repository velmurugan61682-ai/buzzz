#!/usr/bin/env bash
# One-time setup to push this repository to GitHub.
# Run from the repository root after extracting the archive.
set -euo pipefail

REMOTE="${1:-https://github.com/buzzzbuzzzcom-web/buzzzplatform.git}"

echo "==> Safety check: no .env or secrets about to be committed"
if [ -f .env ]; then
  echo "    .env exists locally. It is gitignored and will NOT be pushed."
fi
if grep -rInE "(sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)" \
   --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist . >/dev/null 2>&1; then
  echo "    STOP: a possible secret was found. Remove it before pushing." >&2
  exit 1
fi
echo "    clean"

echo "==> Initialising git"
git init -q
git branch -M main

echo "==> Staging"
git add .
git status --short | head -40
echo "    $(git status --porcelain | wc -l) files staged"

echo "==> Committing"
git -c user.name="${GIT_NAME:-BUZZZ}" -c user.email="${GIT_EMAIL:-dev@buzzzbuzzz.com}" \
    commit -q -m "BUZZZ platform: web application, API skeleton, schema, specification and CI"

echo "==> Adding remote"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"

echo "==> Pushing to $REMOTE"
git push -u origin main

echo "==> Done. Verify at ${REMOTE%.git}"
