#!/bin/sh
# One-time setup for Fusion Desk's charge limit (run as root via pkexec):
#   setup.sh install <folder with the helper and policy>
#   setup.sh remove
set -eu
HELPER=/usr/local/libexec/fusion-desk-charge
POLICY=/usr/share/polkit-1/actions/io.github.hafij-deu.fusion-desk.charge.policy

case "${1:-}" in
install)
    src="${2:?folder}"
    install -D -m 0755 -o root -g root "$src/fusion-desk-charge" "$HELPER"
    install -D -m 0644 -o root -g root "$src/io.github.hafij-deu.fusion-desk.charge.policy" "$POLICY"
    ;;
remove)
    rm -f "$HELPER" "$POLICY"
    ;;
*)
    exit 2
    ;;
esac
