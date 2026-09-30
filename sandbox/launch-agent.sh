#!/bin/sh
set -eu

# Sandbox SDK 0.12.10 passes an existing Bun.Terminal to Bun.spawn. Bun 1.3.12
# does not give that child a controlling terminal, so resize changes the kernel
# size without delivering SIGWINCH. Become its session leader and acquire stdin
# as the controlling terminal before replacing this process with the CLI.
if [ -t 0 ]; then
    exec setsid --ctty "/usr/local/bin/$(basename "$0")" "$@"
fi

# Non-interactive invocations (for example --version) do not need a terminal.
exec "/usr/local/bin/$(basename "$0")" "$@"
