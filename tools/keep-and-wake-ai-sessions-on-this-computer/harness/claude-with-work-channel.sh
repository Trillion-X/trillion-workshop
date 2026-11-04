#!/bin/sh
# harness/claude-with-work-channel.sh
#
# Starts Claude Code with Trillion's work channel on, so work handed to this session's agent in Trillion reaches the
# session while it is open, even mid-task (Claude Code channels, https://code.claude.com/docs/en/channels-reference).
#   claude-with-work-channel.sh [--agent-id <id>] [any claude arguments]
# The agent id defaults to claude-code-<this folder's name>. Everything after it goes to claude unchanged.
#
# Why each piece is needed, as read from Claude Code 2.1.280 on 2026-09-30:
#   - The channel server (harness/work-consumer.mjs --host claude-channel) is added for this session only, with
#     --mcp-config, never to a settings file: a session started without the channel flag would run the consumer while
#     Claude Code drops its notices, and Trillion would say the session starts on work when it does not.
#   - --dangerously-load-development-channels server:trillion-work: a custom channel is registered only when named here
#     during the research preview; Claude Code asks once per start to confirm it is for local development.
#   - CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1: with telemetry opted out, Claude Code evaluates no feature flags,
#     so the channels flag stays off and the debug log says "Channel notifications skipped: channels feature is not
#     currently available". This lets it read the flags it already cached; telemetry stays off.
here=$(cd "$(dirname "$0")" && pwd)
agent_id="claude-code-$(basename "$PWD" | tr -c 'A-Za-z0-9_-\n' '-')"
if [ "$1" = "--agent-id" ]; then agent_id=$2; shift 2; fi
config=$(printf '{"mcpServers":{"trillion-work":{"command":"node","args":["%s/work-consumer.mjs","--agent-id","%s","--host","claude-channel","--name","Claude Code in %s"]}}}' "$here" "$agent_id" "$(basename "$PWD")")
CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1 exec claude --mcp-config "$config" --dangerously-load-development-channels server:trillion-work "$@"
