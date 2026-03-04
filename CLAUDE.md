# Second Brain

AWS-hosted personal knowledge capture system: Slack messages are ingested, embedded, and stored in DynamoDB for semantic search via MCP.

## MCP Integration

At the start of every conversation, use the `search_thoughts` MCP tool to search for any prior thoughts relevant to the current task or topic. This provides context from previously captured ideas, decisions, tasks, and notes.

## Auto-Capture Rules

Use the `capture_thought` MCP tool to persist knowledge that has value beyond the current session.

### What to capture

- **Decisions with reasoning**: "Chose X over Y because..." — the *why* matters more than the *what*
- **Non-obvious discoveries**: Surprising codebase behavior, undocumented gotchas, subtle bugs
- **User preferences**: Workflow choices, tool preferences, conventions they want enforced
- **Project context changes**: Architecture shifts, new dependencies, config changes, cost/scaling decisions
- **Action items & follow-ups**: Identified during work but not immediately addressed
- **Hard-won solutions**: Anything that took significant debugging to resolve

### What NOT to capture

- Routine code changes (git log has that)
- Temporary debugging info
- Information already documented in the codebase
- Duplicates of existing thoughts (search first!)
- Session-specific state (current task, in-progress work)

### Dedup protocol

Before capturing, run `search_thoughts` with a relevant query. If a similar thought exists with similarity > 0.3, skip or update instead of creating a duplicate.

### Session lifecycle

- **Start**: Search for thoughts relevant to the current task (reinforces existing MCP Integration rule above)
- **During**: Capture decisions and discoveries as they happen — don't batch
- **End**: Capture a brief summary of what was accomplished + any open follow-ups
