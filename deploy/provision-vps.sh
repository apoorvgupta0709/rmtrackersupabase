#!/usr/bin/env bash
#
# One-time setup of the dashboard's home on the VPS. Idempotent: safe to re-run, and it
# will not overwrite an env file that already exists.
#
# Run as root on the host:
#
#   NEXT_PUBLIC_SUPABASE_URL=... \
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
#   SUPABASE_SERVICE_ROLE_KEY=... \
#   GITHUB_DISPATCH_TOKEN=... \
#   DEPLOY_PUBLIC_KEY='ssh-ed25519 AAAA...' \
#     bash provision-vps.sh
#
# It touches nothing outside /srv/rmtracker, /var/lib/rmtracker.img, /etc/fstab and
# root's authorized_keys. Traefik, n8n and /root/docker-compose.yml are left alone.

set -euo pipefail

ROOT=/srv/rmtracker
IMAGE=/var/lib/rmtracker.img
SIZE=30G
REPO=apoorvgupta0709/rmtrackersupabase

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

# --------------------------------------------------------------------------------
# 1. A filesystem the app cannot grow out of.
#
# The point is not that the dashboard needs 30 GB — it is stateless and needs almost
# none. The point is that whatever it does write can never eat the disk out from under
# n8n, and that the space is reserved rather than merely available. A loop-mounted image
# is the way to get a kernel-enforced ceiling on a box with one partition.
# --------------------------------------------------------------------------------
say "30 GB filesystem at $ROOT"
if [ -f "$IMAGE" ]; then
  echo "$IMAGE already exists — leaving it alone."
else
  fallocate -l "$SIZE" "$IMAGE"
  # -E nodiscard is the whole game. mkfs.ext4 TRIMs the device by default, the loop
  # driver turns that into hole-punching on the backing file, and the 30 GB fallocate
  # just claimed evaporates: you end up with a 30 GB *ceiling* but no reservation, and
  # `df /` still cheerfully reports the space as free for n8n to take.
  mkfs.ext4 -q -F -E nodiscard "$IMAGE"
  echo "Created $IMAGE ($SIZE, ext4)."
fi

mkdir -p "$ROOT"

# nofail matters: without it a corrupt or missing image drops the whole box into
# emergency mode at boot, taking n8n with it. A dashboard that is down is a nuisance; a
# host that will not boot is an outage.
if grep -qF "$IMAGE" /etc/fstab; then
  echo "fstab entry already present."
else
  # nodiscard again, for the same reason: without it ext4 hands blocks back to the host
  # as files are deleted and the reservation leaks away over time.
  echo "$IMAGE $ROOT ext4 loop,defaults,nodiscard,nofail 0 2" >> /etc/fstab
  echo "Added fstab entry."
fi

mountpoint -q "$ROOT" || mount "$ROOT"
mountpoint -q "$ROOT" || { echo "Failed to mount $ROOT" >&2; exit 1; }

# uid 1000 is the `node` user the container runs as.
mkdir -p "$ROOT/cache"
chown 1000:1000 "$ROOT/cache"

# Prove the reservation actually happened rather than assuming it. If actual usage is far
# below the apparent size the image went sparse and the space is not really held.
actual=$(du -BG --apparent-size "$IMAGE" | cut -f1)
held=$(du -BG "$IMAGE" | cut -f1)
echo "Image: ${actual} apparent, ${held} allocated on the root disk."
[ "${held%G}" -ge 29 ] || echo "WARNING: image is sparse — the 30 GB is a ceiling but not a reservation."

df -h / "$ROOT"

# --------------------------------------------------------------------------------
# 2. Runtime configuration.
#
# Everything the container needs that is not baked into the image. The service-role key
# and the dispatch token live here and only here.
# --------------------------------------------------------------------------------
say "Runtime env at $ROOT/app.env"
if [ -f "$ROOT/app.env" ]; then
  echo "app.env already exists — not overwriting. Edit it by hand to change a value."
else
  for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
           SUPABASE_SERVICE_ROLE_KEY GITHUB_DISPATCH_TOKEN; do
    [ -n "${!v:-}" ] || { echo "$v is not set; export it and re-run." >&2; exit 1; }
  done

  umask 077
  cat > "$ROOT/app.env" <<EOF
NODE_ENV=production
NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
GITHUB_DISPATCH_TOKEN=$GITHUB_DISPATCH_TOKEN
# Vercel sets this for free; here it has to be stated. Without it the Refresh button
# returns a 501 telling the reader to check their Vercel settings, which on this host is
# advice to nowhere.
GITHUB_REPOSITORY=$REPO
EOF
  chmod 600 "$ROOT/app.env"
  echo "Wrote app.env (0600)."
fi

# --------------------------------------------------------------------------------
# 3. The key GitHub Actions deploys with.
#
# A dedicated key, so the deploy can be revoked on its own and the host password never
# has to leave the owner's machine.
# --------------------------------------------------------------------------------
say "Deploy key"
if [ -z "${DEPLOY_PUBLIC_KEY:-}" ]; then
  echo "DEPLOY_PUBLIC_KEY not set — skipping. Add it by hand if the deploy cannot log in."
else
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  if grep -qF "$DEPLOY_PUBLIC_KEY" /root/.ssh/authorized_keys; then
    echo "Key already authorised."
  else
    echo "$DEPLOY_PUBLIC_KEY" >> /root/.ssh/authorized_keys
    echo "Authorised the deploy key."
  fi
fi

# --------------------------------------------------------------------------------
# 4. Sanity checks on the things this deployment borrows from the existing stack.
# --------------------------------------------------------------------------------
say "Preconditions"
docker network inspect root_default >/dev/null 2>&1 \
  && echo "root_default network: present" \
  || { echo "root_default network is missing — is the n8n stack up?" >&2; exit 1; }

docker ps --format '{{.Names}}' | grep -q traefik \
  && echo "Traefik: running" \
  || echo "WARNING: no Traefik container found; the domain will not resolve to the app."

[ -f "$ROOT/docker-compose.yml" ] \
  && echo "compose file: present" \
  || echo "compose file: not yet copied — the deploy job scp's it in."

say "Done"
echo "Next: the GitHub Action builds the image and runs 'docker compose up -d' here."
