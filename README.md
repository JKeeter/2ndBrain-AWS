# Second Brain

Personal knowledge capture system with Slack integration and MCP semantic search.

Slack messages are captured, embedded via OpenRouter, classified into 9 types, and stored in DynamoDB. Any MCP-compatible tool (Claude Code, Claude Desktop, etc.) can search, capture, and manage thoughts via semantic similarity.

## Architecture

```
Slack message
  │
  ▼
API Gateway (POST /ingest)
  │
  ▼
ingest-thought Lambda
  ├── Verify Slack signature
  ├── Embed text (OpenRouter, text-embedding-3-small, 1536-dim)
  ├── Extract metadata (OpenRouter, gpt-4o-mini → type + topics + people + action items + dates)
  ├── Store in DynamoDB
  └── Reply in Slack thread with confirmation

MCP client (Claude Code, Claude Desktop, etc.)
  │
  ▼
API Gateway (POST /mcp)
  │
  ▼
mcp-server Lambda (JSON-RPC, MCP Streamable HTTP)
  ├── search_thoughts  → cosine similarity scan
  ├── list_thoughts    → paginated query by type/date
  ├── thought_stats    → aggregate counts
  ├── capture_thought  → embed + classify + store
  ├── update_thought   → re-embed + re-classify + update
  └── delete_thought   → permanent removal
```

**6 CDK stacks:** Parameters, DynamoDB, Lambda, API Gateway, Monitoring (CloudWatch alarms + dashboard), Budgets ($5/month cap).

## MCP Tools Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_thoughts` | `query` (required), `limit?` (1-50, default 10), `type?` | Semantic similarity search across all thoughts |
| `list_thoughts` | `type?`, `start_date?`, `end_date?`, `limit?` (1-100, default 20), `cursor?` | Paginated listing with optional type/date filters |
| `thought_stats` | *(none)* | Aggregate counts by type and date range |
| `capture_thought` | `content` (required, max 10K chars) | Embed + auto-classify + store a new thought |
| `update_thought` | `id` (required, UUID), `content` (required, max 10K chars) | Re-embed + re-classify + update an existing thought |
| `delete_thought` | `id` (required, UUID) | Permanently delete a thought |

Authentication: All MCP requests require an `X-Brain-Key` header with the API key stored in SSM.

## Thought Types

| Type | When it's used |
|------|---------------|
| `task` | Actionable items with clear deliverables or deadlines |
| `idea` | Creative thoughts, proposals, brainstorming |
| `observation` | Factual notes, records, general information |
| `question` | Open questions to revisit or research |
| `reference` | Links, articles, resources, external references |
| `meeting` | Meeting notes, summaries, outcomes |
| `decision` | Records of decisions made (and why) |
| `person` | Notes about a specific person — feedback, preferences, background |
| `needs_review` | Too ambiguous or short to classify — reply in Slack thread to add context and auto-reclassify |

Thread replies: When you reply in a Slack thread to a captured thought, the original is re-embedded and re-classified with the combined content.

## Setup & Deployment

### Prerequisites

- AWS account with CLI configured
- Node.js >= 20
- Slack app with Event Subscriptions enabled
- OpenRouter API key

### 1. Create SSM parameters

```bash
aws ssm put-parameter --name "/second-brain/openrouter-api-key" --type SecureString --value "YOUR_KEY"
aws ssm put-parameter --name "/second-brain/slack-bot-token"    --type SecureString --value "xoxb-..."
aws ssm put-parameter --name "/second-brain/slack-signing-secret" --type SecureString --value "YOUR_SECRET"
aws ssm put-parameter --name "/second-brain/mcp-access-key"     --type SecureString --value "YOUR_KEY"
```

### 2. Deploy

```bash
npm install
cd infrastructure && npx cdk deploy --all --context ownerEmail=you@example.com
```

Note the `IngestUrl` and `McpUrl` outputs.

### 3. Configure Slack

In your Slack app settings:
1. **Event Subscriptions** → Enable, set Request URL to the `IngestUrl` output
2. **Subscribe to bot events** → `message.channels` (or `message.groups` for private channels)
3. **OAuth & Permissions** → Bot scopes: `chat:write`, `channels:history`

### 4. Configure MCP client

Add to your MCP client config (e.g. `~/.claude/mcp_servers.json`):

```json
{
  "second-brain": {
    "type": "streamable-http",
    "url": "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/mcp",
    "headers": {
      "X-Brain-Key": "YOUR_MCP_ACCESS_KEY"
    }
  }
}
```

## Auto-Capture with Claude Code

The project's `CLAUDE.md` configures Claude to:
- Search Second Brain at conversation start for relevant prior context
- Auto-capture decisions, discoveries, and action items during work
- Deduplicate by searching before capturing (similarity > 0.3 → skip)

## Cost

~$0.03/month on AWS free tier (DynamoDB on-demand, Lambda, API Gateway). A $5/month budget alarm is deployed automatically.

Migration path: move to Postgres + pgvector when approaching ~10K items for faster vector search.
