#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
  exec /usr/local/bin/quantbot "$@"
fi

# Docker may create ./data as root when it first mounts the directory.
# Only initialize the mount point. Leave existing files and subdirectories alone.
case "${1:-serve}" in
  serve|backup|restore)
    if [ "$(stat -c '%u:%g' /data)" != "10001:10001" ]; then
      chown --no-dereference 10001:10001 /data
    fi
    if [ "$(stat -c '%a' /data)" != "700" ]; then
      chmod 0700 /data
    fi
    ;;
esac

exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs   /usr/local/bin/quantbot "$@"
