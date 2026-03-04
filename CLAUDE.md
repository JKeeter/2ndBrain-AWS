# Second Brain

AWS-hosted personal knowledge capture system: Slack messages are ingested, embedded, and stored in DynamoDB for semantic search via MCP.

## MCP Integration

At the start of every conversation, use the `search_thoughts` MCP tool to search for any prior thoughts relevant to the current task or topic. This provides context from previously captured ideas, decisions, tasks, and notes.
