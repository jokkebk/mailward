#!/usr/bin/env bash
set -euo pipefail

title="${MAILWARD_DEV_TITLE:-Mailward}"

set_title() {
	printf '\033]0;%s\007' "$title"
}

set_title
(
	while true; do
		sleep 2
		set_title
	done
) &
title_pid=$!

cleanup() {
	kill "$title_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

bunx --bun vite dev
