# Second Brain - Implementation Plan

## Context

Build a personal knowledge management system ("Second Brain") that captures thoughts from Slack, stores them with vector embeddings for semantic search, and exposes them via an MCP server so any AI assistant can query the knowledge base. Based on the [Open Brain reference architecture](https://promptkit.natebjones.com/20260224_uq1_guide_main) but rebuilt entirely on AWS services instead of Supabase.

**Why**: Persistent shared memory across AI models. One person, ~20-30 entries/week, must be secure and cheap.

---

## Architecture

```
Slack Message ──→ API Gateway ──→ Lambda: ingest-thought ──→ DynamoDB
                                    ├── OpenRouter (embed)       (thoughts table)
                                    ├── OpenRouter (metadata)
                                    └── Slack API (reply)

Any AI (MCP) ──→ API Gateway ──→ Lambda: mcp-server ──→ DynamoDB
                                    └── OpenRouter (embed query)   (vector scan)
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Database | **DynamoDB** (not RDS PostgreSQL) | Always-free tier, no VPC/NAT costs ($640+/yr savings), brute-force vector search is <12ms at this scale |
| Vector search | **Brute-force cosine similarity in Lambda** | At <2000 items/year, sub-millisecond compute; in-memory caching for warm starts |
| Compute | **Standard Lambda** (not Lambda@Edge) | Lambda@Edge has no env vars (would need runtime SSM lookups), 5s viewer timeout is tight for OpenRouter calls, bottleneck is DynamoDB+OpenRouter latency not Lambda location, single user doesn't benefit from geo-distribution |
| IaC | **AWS CDK (TypeScript)** | Matches contractor-app patterns, same language as Lambdas, L2 constructs reduce boilerplate |
| Secrets | **SSM Parameter Store SecureString** | Free (vs Secrets Manager $1.60/mo); sufficient for single-user static keys |
| Auth | **Slack signature verification + static MCP API key** | Single user, no Cognito/JWT needed |
| Framework | **No Amplify** | No frontend, no user auth flow, Amplify data layer doesn't support vector operations |

### Monthly Cost: ~$0.03

| Service | Cost |
|---------|------|
| DynamoDB | $0.00 (always free) |
| Lambda | $0.00 (always free) |
| API Gateway | $0.00 (1M calls free/12mo, then ~$3.50/yr) |
| CloudWatch | $0.00 (5GB free) |
| SSM Parameter Store | $0.00 (free) |
| OpenRouter | ~$0.03 |

---

## Project Structure

```
second-brain/
├── security-baseline.md                    # Existing
├── package.json                            # Root workspace
├── tsconfig.base.json                      # Shared TS config
│
├── backend/
│   ├── package.json                        # Runtime deps: zod, uuid, @aws-sdk/*
│   ├── tsconfig.json
│   ├── functions/
│   │   ├── ingest-thought/
│   │   │   └── handler.ts                  # Slack webhook → embed → store → reply
│   │   └── mcp-server/
│   │       ├── handler.ts                  # MCP JSON-RPC dispatch
│   │       └── tools/
│   │           ├── search-thoughts.ts      # Semantic vector search
│   │           ├── list-thoughts.ts        # Filtered/paginated list
│   │           ├── thought-stats.ts        # Aggregate statistics
│   │           └── capture-thought.ts      # Programmatic capture
│   └── shared/
│       ├── auth.ts                         # Slack signature + MCP key validation
│       ├── dynamodb.ts                     # DynamoDB client + table operations
│       ├── logger.ts                       # Structured CloudWatch logger
│       ├── openrouter.ts                   # Embedding + metadata extraction
│       ├── responses.ts                    # Standard API response builders
│       ├── slack.ts                        # Slack API client (thread reply)
│       ├── validation.ts                   # Zod schemas for all inputs
│       ├── vector.ts                       # Cosine similarity + caching
│       └── types.ts                        # Shared interfaces
│
├── infrastructure/
│   ├── package.json                        # CDK deps
│   ├── cdk.json
│   ├── bin/
│   │   └── app.ts                          # CDK app entry, stack wiring, tags
│   └── lib/
│       ├── dynamodb-stack.ts               # Thoughts table + GSIs + PITR
│       ├── lambda-stack.ts                 # Both functions + IAM roles
│       ├── api-gateway-stack.ts            # REST API + routes + throttling + logging
│       ├── parameters-stack.ts             # SSM Parameter Store secrets
│       ├── monitoring-stack.ts             # CloudWatch alarms + SNS + dashboard
│       └── budgets-stack.ts                # Cost alerts
│
├── tests/
│   ├── unit/
│   │   ├── ingest-thought.test.ts
│   │   ├── mcp-server.test.ts
│   │   ├── vector.test.ts
│   │   ├── auth.test.ts
│   │   └── validation.test.ts
│   └── integration/
│       ├── ingest-flow.test.ts
│       └── mcp-flow.test.ts
│
└── .github/workflows/
    ├── ci.yml                              # Lint, test, audit, cdk synth
    └── deploy.yml                          # CDK deploy on main merge
```

---

## Implementation Steps

### Phase 1: Foundation (IaC + Shared Utilities)

1. **Initialize project** - Root package.json with workspaces, tsconfig, .gitignore
2. **CDK infrastructure stacks** (following `contractor-app/infrastructure/` patterns):
   - `parameters-stack.ts` - SSM SecureString params for 4 secrets (OpenRouter key, Slack bot token, Slack signing secret, MCP access key)
   - `dynamodb-stack.ts` - Thoughts table (PK: `THOUGHT`, SK: `thought#<uuid>`), GSI1 by type+date, GSI2 by date, PITR enabled, on-demand billing
   - `lambda-stack.ts` - Two Node.js 20 Lambda functions (256MB, 30s timeout), least-privilege IAM (specific DynamoDB actions on specific table ARN, specific SSM params)
   - `api-gateway-stack.ts` - REST API with POST /ingest, POST /mcp, GET /health; access logging; stage throttle 10 req/sec
   - `monitoring-stack.ts` - CloudWatch alarms (Lambda errors, API 4xx/5xx rates), SNS email alert, 90-day log retention
   - `budgets-stack.ts` - $5/month budget alarm
3. **Shared backend utilities** - logger.ts, responses.ts, auth.ts, validation.ts, dynamodb.ts, openrouter.ts, slack.ts, vector.ts, types.ts

### Phase 2: Ingest Pipeline (Slack → DynamoDB)

4. **ingest-thought Lambda** handler:
   - Slack challenge/response handshake for URL verification
   - Slack signature verification (HMAC-SHA256, 5-min replay protection)
   - Parallel: embed text via OpenRouter + extract metadata via LLM
   - Store thought in DynamoDB (content, embedding as Binary, metadata as Map)
   - Reply in Slack thread with confirmation + extracted metadata

### Phase 3: MCP Server

5. **mcp-server Lambda** handler:
   - API key validation (`x-brain-key` header)
   - JSON-RPC dispatch for MCP protocol (initialize, tools/list, tools/call)
   - `search_thoughts` - embed query → brute-force cosine similarity → top-K results
   - `list_thoughts` - DynamoDB Query with GSI filters (type, date range)
   - `thought_stats` - aggregate counts by type, date ranges
   - `capture_thought` - same embed+metadata+store flow as ingest, source="mcp"
   - In-memory embedding cache (module-level, 60s TTL) for warm Lambda containers

### Phase 4: Testing + Security Audit

6. **Unit tests** - auth, validation, vector math, handler logic with mocked AWS/OpenRouter
7. **Integration tests** - end-to-end flows with mocked externals
8. **Security audit** against all 15 SECURITY rules in security-baseline.md

### Phase 5: Deployment + Verification

9. **CDK deploy** - bootstrap, create SSM params manually, `cdk deploy --all`
10. **Configure Slack app** - Event Subscription URL pointing to API Gateway /ingest
11. **Configure MCP client** - API Gateway URL + access key in Claude Desktop / other AI
12. **End-to-end verification** - Send Slack message, confirm stored, search via MCP

---

## DynamoDB Schema Detail

```
Table: second-brain-thoughts
  PK (String): "THOUGHT"                    -- Single partition (fine at <10K items)
  SK (String): "thought#<uuid>"             -- Unique per thought

  Attributes:
    content      (String)   Raw thought text
    embedding    (Binary)   Float32Array → Buffer (6144 bytes for 1536 dims)
    metadata     (Map)      { type, topics[], people[], action_items[], dates[], source }
    created_at   (String)   ISO 8601
    updated_at   (String)   ISO 8601
    slack_channel (String)  Optional - Slack channel ID
    slack_ts     (String)   Optional - Slack message timestamp

  GSI1-ByType:  PK=metadata.type, SK=created_at, Projection=ALL
  GSI2-ByDate:  PK=PK, SK=created_at, Projection=KEYS_ONLY
```

---

## Security Compliance Summary (security-baseline.md)

| Rule | How Addressed |
|------|--------------|
| SEC-01: Encryption | DynamoDB encrypted at rest (default), all traffic TLS 1.2+ |
| SEC-02: Access Logging | API Gateway access logs → CloudWatch (JSON format) |
| SEC-03: App Logging | Structured logger: timestamp, requestId, level, message; no PII |
| SEC-04: HTTP Headers | N/A (no HTML endpoints); JSON responses set Content-Type |
| SEC-05: Input Validation | Zod schemas on all inputs; max lengths; no string concat in queries |
| SEC-06: Least Privilege | Per-function IAM: specific actions on specific ARNs; no wildcards |
| SEC-07: Network Config | No VPC needed (DynamoDB/SSM over AWS SDK HTTPS); API Gateway throttling |
| SEC-08: Access Control | Slack signature verification + MCP API key on every request; fail-closed |
| SEC-09: Hardening | No default creds; generic error responses; Node.js 20 LTS |
| SEC-10: Supply Chain | package-lock.json pinned; npm audit in CI; minimal deps |
| SEC-11: Secure Design | Auth/validation/logging in dedicated modules; rate limiting; replay protection |
| SEC-12: Credential Mgmt | All secrets in SSM SecureString; no hardcoded values in code/IaC |
| SEC-13: Integrity | JSON.parse + Zod validation; pinned CI action versions; DynamoDB PITR |
| SEC-14: Alerting | CloudWatch alarms for error rates + auth failures; 90-day retention; Lambda can't delete own logs |
| SEC-15: Exception Handling | Global try/catch wrapper; fail-closed on errors; resource cleanup |

---

## Build Agents

During implementation, use four specialized agents working as a team:

1. **Lambda Developer Agent** - Writes all Lambda function code (ingest-thought handler, MCP server handler, shared utilities). Implements Slack signature verification, OpenRouter integration, DynamoDB operations, vector search, MCP JSON-RPC protocol, Zod validation schemas, and structured logging. Responsible for all files under `backend/`.
2. **DevOps Agent** - Writes and validates CDK infrastructure stacks, checks IAM policies for least privilege, verifies stack dependencies, ensures `cdk synth` succeeds. Responsible for all files under `infrastructure/` and `.github/workflows/`.
3. **QA Agent** - Writes and runs unit/integration tests after Lambda code is written, validates all MCP tools work correctly, tests edge cases (empty input, oversized content, invalid keys, replay attacks). Responsible for all files under `tests/`.
4. **Security Agent** - Audits every file against all 15 rules in security-baseline.md, checks for hardcoded secrets, validates error handling is fail-closed, confirms log sanitization, verifies IAM least-privilege. Produces a compliance report with pass/fail per SECURITY rule.

---

## Reference Files

- `contractor-app/infrastructure/lib/lambda-stack.ts` - Lambda + IAM patterns
- `contractor-app/infrastructure/lib/api-gateway-stack.ts` - API Gateway + logging patterns
- `contractor-app/infrastructure/bin/app.ts` - CDK app entry + tagging conventions
- `contractor-app/backend/shared/logger.ts` - Structured logging pattern
- `second-brain/security-baseline.md` - 15 security rules (compliance checklist)

---

## Verification Plan

1. `cd infrastructure && npx cdk synth` - All stacks synthesize without errors
2. `cd backend && npm test` - All unit tests pass
3. Send a message in the Slack capture channel → confirm DynamoDB item created with correct embedding + metadata
4. Use MCP client to `search_thoughts` → confirm semantic results return with similarity scores
5. Use MCP client to `capture_thought` → confirm round-trip storage + searchability
6. Security agent scans all code files against security-baseline.md → zero blocking findings
7. `npm audit` → zero high/critical vulnerabilities

---

## Future Migration Path

When thought count exceeds ~10,000 (5+ years), migrate to RDS PostgreSQL + pgvector:
- Add VPC stack, RDS stack, NAT instance
- Replace DynamoDB client with pg client
- Replace brute-force search with `ORDER BY embedding <=> $1 LIMIT $2`
- One-time migration Lambda: scan DynamoDB → INSERT into PostgreSQL
