
# Backend Reference — IaC Visualizer

Technical documentation for the serverless backend of the IaC Visualizer. This file describes what the backend does, how it works, what it depends on, and where its boundaries are. It is written for someone picking up the code cold — a reviewer, a collaborator, or the future version of the author.

---

## Table of Contents

- [Architecture](#architecture)
- [File Structure](#file-structure)
- [Deployment](#deployment)
- [API Contract](#api-contract)
- [Handlers](#handlers)
- [Parser](#parser)
- [Blast Radius](#blast-radius)
- [Rule Engine](#rule-engine)
- [Cost Estimator](#cost-estimator)
- [Bedrock Integration](#bedrock-integration)
- [AWS Resources](#aws-resources)
- [Environment Variables](#environment-variables)
- [Local Testing](#local-testing)
- [Known Limitations](#known-limitations)
- [Design Decisions and Rationale](#design-decisions-and-rationale)

---

## Architecture

```
                    ┌──────────────────────────┐
                    │   API Gateway HTTP API   │
                    │   /parse /analyze /ask   │
                    └────┬─────────┬────────┬──┘
                         │         │        │
                         ▼         ▼        ▼
                    ┌────────┐ ┌────────┐ ┌────────┐
                    │ Lambda │ │ Lambda │ │ Lambda │
                    │ /parse │ │/analyze│ │  /ask  │
                    └───┬────┘ └───┬────┘ └───┬────┘
                        │          │          │
                        │          ▼          ▼
                        │     ┌────────────────────┐
                        │     │  Amazon Bedrock    │
                        │     │  Nova Micro        │
                        │     └────────────────────┘
                        ▼
                ┌───────────────────────────┐
                │  Parser                    │
                │  Reference walker          │
                │  Blast-radius BFS          │
                │  Rule engine (6 rules)     │
                │  Cost estimator            │
                └───────────────────────────┘
```

**Three Lambda functions behind a single API Gateway HTTP API.** No database. No state. Every request parses, analyzes, and returns. The Bedrock Lambdas call the same analysis engine but use it as context for narration rather than computation.

**Cold start characteristics:** ARM64 Node 20 Lambdas. `ParseFunction` bundles only `js-yaml` and the CloudFormation schema (~200 KB). `AnalyzeFunction` and `AskFunction` bundle `@aws-sdk/client-bedrock-runtime` (~500 KB). Cold start for parse is ~400ms; Bedrock functions are ~600ms plus model latency.

---

## File Structure

```
backend/
├── package.json                # CommonJS, deps: js-yaml, js-yaml-cloudformation-schema, @aws-sdk/client-bedrock-runtime, @aws-sdk/client-cloudformation
├── node_modules/               # Bundled into Lambda deployment package
├── parser/
│   ├── parse.cjs               # Template loader + reference walker
│   ├── blast-radius.cjs        # Reverse BFS over edges
│   └── fixtures/
│       ├── s3-lambda.yaml
│       ├── vpc.yaml
│       ├── nested-stack.yaml
│       ├── sam.yaml
│       ├── conditions.yaml
│       └── rds-ebs.yaml
├── rules/
│   ├── rules.cjs               # 6 deterministic misconfiguration rules
│   └── cost.cjs                # Monthly cost heuristic
└── handlers/
    ├── api.cjs                 # POST /parse
    ├── analyze.cjs             # POST /analyze
    ├── ask.cjs                 # POST /ask
    └── test-event.json         # Local test fixture for api.cjs
```

**`CommonJS` (`.cjs` extension).** The repository's root `package.json` has `"type": "module"` because it hosts the Vite frontend. The backend is CommonJS and uses the `.cjs` extension to override. Do not convert to ESM mid-project; the parser and rule engine both rely on `require()`.

---

## Deployment

Deployed via AWS SAM. The SAM template is at `infra/template.yaml` and points its `CodeUri` at `../backend`.

**First-time deploy:**

```bash
cd infra
sam build
sam deploy --guided
```

Guided prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `iac-visualizer` |
| AWS Region | `us-east-1` |
| Confirm changes before deploy | `N` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| Authorize public API | `Y` |
| Save arguments to config | `Y` |

**Subsequent deploys:**

```bash
cd infra
sam build --no-cached
sam deploy
```

The `--no-cached` flag forces a rebuild. Without it, SAM may reuse a cached build and miss backend changes — particularly `node_modules` updates.

**Output:** API Gateway base URL printed as `ApiUrl` in the deploy output. Copy it into the frontend's `VITE_API_URL`.

---

## API Contract

### `POST /parse`

Parses a CloudFormation template and returns the graph, flags, and cost estimate.

**Request:**

```json
{
  "template": "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  ..."
}
```

**Response (200):**

```json
{
  "nodes": [
    { "id": "DataBucket", "type": "AWS::S3::Bucket", "properties": { ... } }
  ],
  "edges": [
    { "source": "ProcessFunction", "target": "DataBucket", "relationship": "references" }
  ],
  "flags": [
    {
      "ruleId": "S3_NO_PUBLIC_ACCESS_BLOCK",
      "severity": "medium",
      "resourceId": "DataBucket",
      "message": "S3 bucket has no PublicAccessBlockConfiguration.",
      "detail": { "hasPublicAccessBlock": false, "accessControl": null }
    }
  ],
  "cost": {
    "total": 16.85,
    "breakdown": [
      { "id": "AppDB", "type": "AWS::RDS::DBInstance", "monthly": 15.0 }
    ],
    "unknownCount": 3
  }
}

**Response (400):** `{ "error": "<parse error message>" }` — returned when the template is not valid CloudFormation YAML.

### `POST /analyze`

Takes a graph and its flags, asks Bedrock to narrate them in plain English. Does **not** re-analyze the template.

**Request:**

```json
{
  "nodes": [{ "id": "DataBucket", "type": "AWS::S3::Bucket" }],
  "flags": [{ "severity": "medium", "resourceId": "DataBucket", "message": "..." }]
}
```

**Response (200):** `{ "summary": "This template deploys ..." }`

**Response (500):** `{ "error": "<bedrock error message>" }`

### `POST /ask`

Free-form Q&A grounded in the parsed graph. Same input shape as `/analyze` plus a `question` field.

**Request:**

```json
{
  "question": "What references the VPC?",
  "nodes": [ ... ],
  "edges": [ ... ],
  "flags": [ ... ]
}
```

**Response (200):** `{ "answer": "Four resources reference the VPC: ..." }`

---

## Handlers

### `handlers/api.cjs`

The `/parse` handler. Sequence:

1. Handles CORS preflight (`OPTIONS`) → 204 with no body.
2. Reads the request body. Handles both base64-encoded and plain bodies.
3. Extracts `template` field. Returns 400 if missing or not a string.
4. Writes the template to a temp file (`os.tmpdir()`) so it can reuse `parseTemplate`'s disk-based loader.
5. Calls `parseTemplate` → `{ nodes, edges }`.
6. Calls `loadTemplate` → raw parsed YAML structure (needed by the rule engine and cost estimator).
7. Calls `runRules(template)` → flags array.
8. Calls `estimateCost(template)` → cost object.
9. Deletes the temp file.
10. Returns the combined JSON.

**Why the temp file?** `parseTemplate` and `loadTemplate` were written for the CLI, taking a file path. The Lambda receives a string. The alternative — refactoring to accept strings — was rejected because the CLI tests were already passing and refactoring mid-project risked the deployed demo. Writing to `os.tmpdir()` is a 4-line workaround that costs ~5ms and zero correctness.

### `handlers/analyze.cjs`

Bedrock narration. The prompt explicitly instructs the model:

- Do not invent new flags
- Do not second-guess the rule engine
- Do not add generic security advice
- Write 2–4 short sentences
- Plain prose, no markdown

The prompt structure:

```
You are an infrastructure reviewer. You will be given a list of AWS resources
and a list of pre-computed misconfiguration flags. The flags were detected
deterministically by a rule engine — do NOT invent new flags, do NOT
second-guess them, do NOT add generic security advice.

Your job is only to explain, in plain English, what this template deploys
and why each flagged issue matters.

RESOURCES:
- DataBucket (AWS::S3::Bucket)
- ProcessFunction (AWS::Lambda::Function)

FLAGS:
- [medium] DataBucket: S3 bucket has no PublicAccessBlockConfiguration.

Write 2-4 short sentences. ...
```

**Why this matters:** the model is downstream of deterministic analysis. It's not doing the analysis. If Bedrock were to invent additional issues, the tool would be less trustworthy, not more. The prompt is engineered to keep the model in a narrating role only.

### `handlers/ask.cjs`

Same shape as `/analyze` but takes a question. The prompt includes the full node list, edge list, and flag list as context, and instructs the model to answer **only** from that context, returning a specific decline phrase if the answer isn't derivable.

The decline phrase — "I don't have that information in this template" — was chosen so that Q&A responses that exceed the graph's information are obvious, not silent. A judge or reviewer asking "does this hallucinate?" can test it by asking a question the template can't answer.

---

## Parser

### `parser/parse.cjs`

**CloudFormation's intrinsic tags are not YAML.** `!Ref`, `!GetAtt`, `!Sub`, and a dozen others are custom tags. Standard YAML parsers throw `unknown tag !<!Ref>` because the YAML spec doesn't define them.

The parser handles this in one of two ways depending on which version is deployed:

- **Current:** uses `js-yaml-cloudformation-schema`, an npm package that registers all standard CloudFormation tags and converts each to its JSON equivalent (`!Ref X` → `{ Ref: 'X' }`, `!GetAtt X.Y` → `{ 'Fn::GetAtt': ['X', 'Y'] }`).
- **Earlier:** a hand-rolled schema with 16 tag definitions. This was the original implementation and it broke on real templates because each new intrinsic form (e.g. `!ImportValue` with a nested `Fn::Sub` mapping) required a new schema entry. The package handles all of them.

**Parser output:**

```js
{
  nodes: [{ id, type, properties }],
  edges: [{ source, target, relationship }]
}
```

**Reference walker.** For each resource, `collectRefs` recurses through the resource's properties looking for four patterns:

| Pattern | Matches |
|---|---|
| `{ Ref: 'Target' }` | `!Ref Target` |
| `{ 'Fn::GetAtt': ['Target', 'Attr'] }` | `!GetAtt Target.Attr` |
| `{ 'Fn::Sub': '${Target}' }` | `!Sub '${Target}'` or `'${Target.Attr}'` |
| `{ DependsOn: 'Target' }` | `DependsOn: Target` |

**The critical filter.** Every extracted name is checked against the actual resource list (`resourceIds.has(name)`) before being added to the graph. Without this filter:

- `AWS::StackName`, `AWS::Region`, `AWS::AccountId` — pseudo-parameters that look like references — become fake nodes
- `Environment`, `VPCName`, `InstanceType` — parameters — become fake nodes
- `IsProd`, `IsDev` — condition names — become fake nodes

The `resourceIds.has(...)` check is the difference between a correct graph and a garbage graph. It's one line of code. It's also the single most important piece of logic in the parser.

**`Fn::Sub` handling.** Substitution strings can contain `${Foo}`, `${Foo.Arn}`, `${AWS::StackName}`, or arbitrary text. The parser uses a regex (`/\$\{([A-Za-z0-9:_]+)(\.[A-Za-z0-9._]+)?\}/g`) to extract every candidate. Each candidate is then filtered against `resourceIds`. `AWS::StackName` is extracted but rejected. `DataBucket` is extracted and accepted.

**Deduplication.** A resource with two `!GetAtt` references to the same target produces one edge, not two. The walker collects into a `Set` per source.

**Self-references.** A resource that references itself (`Ref: 'Self'`) is filtered out before edges are created. CloudFormation rejects these anyway, but the parser is defensive.

**`loadTemplate` export.** `parse.cjs` exports both `parseTemplate` (returns the graph) and `loadTemplate` (returns the raw parsed template). The rule engine and cost estimator need the raw template; the frontend needs the graph.

---

## Blast Radius

### `parser/blast-radius.cjs`

Pure function. Takes a graph and a starting node ID. Returns:

```js
{
  start: 'SSHSecurityGroup',
  direct: ['WebServer', 'DatabaseServer'],
  indirect: [],
  total: 2
}
```

**Algorithm:**

1. Build a reverse adjacency map — for each edge `A → B`, register `A` as a dependent of `B`.
2. BFS from the start node, tracking depth.
3. Depth 1 = direct dependents. Depth 2+ = indirect.
4. Return the two lists plus a total count.

**Complexity:** O(V + E). Under 1ms for the templates tested (up to ~200 resources).

**Why reverse BFS?** The user clicks a node and asks "what breaks if I change this?" That's a downstream question. `A → B` means A depends on B. If B changes, A is affected. So the blast radius of B is everything upstream of it in the edge direction — reverse traversal.

**Same algorithm in the frontend.** `src/lib/blastRadius.js` implements the identical function so clicking a node doesn't require a network round trip. The backend version exists for CLI testing and for future server-side consumers.

---

## Rule Engine

### `rules/rules.cjs`

Six deterministic rules. Each is a pure function over the parsed template. Each returns an array of flag objects:

```js
{
  ruleId: 'SG_OPEN_SENSITIVE_PORT',
  severity: 'high',
  resourceId: 'SSHSecurityGroup',
  message: 'Security group opens port(s) 22-22 to the public internet.',
  detail: { cidr: '0.0.0.0/0', fromPort: 22, toPort: 22 }
}
```

| Rule ID | Severity | Detects |
|---|---|---|
| `SG_OPEN_SENSITIVE_PORT` | high | Security groups with `CidrIp: 0.0.0.0/0` on ports 22, 3389, 3306, 5432, 6379, 27017, 9200 |
| `S3_NO_PUBLIC_ACCESS_BLOCK` | medium/high | Buckets missing all four `PublicAccessBlockConfiguration` flags, or with a public-read ACL |
| `IAM_WILDCARD` | high | IAM statements with `Action: "*"` or `Resource: "*"` |
| `IAM_WILDCARD_ACTION_ON_SCOPED_RESOURCE` | medium | Wildcard actions (`dynamodb:*`) scoped to a specific resource |
| `RDS_PUBLICLY_ACCESSIBLE` | high | RDS instances with `PubliclyAccessible: true` |
| `EBS_UNENCRYPTED` | medium | EBS volumes without `Encrypted: true` |

**Rule implementation notes:**

- `SG_OPEN_SENSITIVE_PORT` handles both `CidrIp` and `CidrIpv6`, and treats an unspecified port range as "all ports" (which triggers the rule).
- `S3_NO_PUBLIC_ACCESS_BLOCK` requires *all four* block flags to be `true` to consider the bucket "protected." Partial blocks still fire.
- `IAM_WILDCARD` navigates `Policies[].PolicyDocument.Statement[]` and handles both scalar and array forms of `Action` and `Resource`.
- `IAM_WILDCARD_ACTION_ON_SCOPED_RESOURCE` is the sharpest rule — it fires only when the action uses a wildcard suffix (`dynamodb:*`) *and* the resource is scoped (not `"*"`). This is the over-permission pattern that cfn-lint doesn't flag as a distinct case.

**Rules are deterministic by construction.** Same template → same flags → same order every time. No LLM in the detection path. This is the entire differentiation argument against "paste it into Claude."

---

## Cost Estimator

### `rules/cost.cjs`

Flat lookup table mapping `AWS::*` resource types to monthly USD estimates at low-traffic assumptions.

```js
const BASE_COST = {
  'AWS::EC2::Instance': 8.0,       // t3.micro running 24/7
  'AWS::RDS::DBInstance': 15.0,    // db.t3.micro
  'AWS::S3::Bucket': 0.25,         // 10GB storage
  'AWS::Lambda::Function': 0.20,   // ~1M invocations
  // ... ~20 more
};
```

Output:

```js
{
  total: 16.85,
  breakdown: [
    { id: 'AppDB', type: 'AWS::RDS::DBInstance', monthly: 15.0 },
    { id: 'AppDataVolume', type: 'AWS::EC2::Volume', monthly: 0.80 }
  ],
  unknownCount: 3
}
```

**It is a heuristic, not a bill.** The UI labels it explicitly. `unknownCount` reports how many resources weren't costed (their types aren't in the table). The `breakdown` array is sorted descending so the largest line items appear first.

**Why not the AWS Pricing API?** The Pricing API requires a call per resource type, is region-dependent, and returns a complex schema. For a hackathon, the flat table is honest and instant. The README and UI both use the word "heuristic."

---

## Bedrock Integration

**Model:** `amazon.nova-micro-v1:0` in `us-east-1`.

**Why Nova Micro and not Claude:**

- Nova is a first-party Amazon model. It works immediately with standard Bedrock permissions — no AWS Marketplace subscription required.
- Accounts registered under AISPL (AWS India's billing entity) hit a Marketplace gate when trying to invoke Anthropic models. The error is `Model access is denied due to INVALID_PAYMENT_INSTRUMENT`.
- Nova Micro costs $0.035 per million input tokens. Claude Haiku 4.5 costs ~7x more. For narrating pre-computed flags, the extra cost buys nothing.

**Request shape** (Bedrock's `messages-v1` schema):

```js
{
  schemaVersion: 'messages-v1',
  messages: [{ role: 'user', content: [{ text: prompt }] }],
  inferenceConfig: { maxTokens: 512, temperature: 0.3 }
}
```

**Response shape:**

```js
{
  output: {
    message: {
      content: [{ text: '...' }]
    }
  }
}
```

Note: Anthropic models on Bedrock return `{ content: [{ text }] }` at the top level. Nova nests under `output.message.content`. The handlers use optional chaining (`parsed.output?.message?.content?.[0]?.text`) so a shape mismatch degrades to `"No summary generated"` rather than throwing.

**Graceful failure:** both Bedrock handlers catch errors and return a 500 with the error message. The frontend displays it. There is no fallback to canned narration — a deliberate choice, because a silently-substituted canned string would be indistinguishable from a live Bedrock response to the user.

**Credential flow:** the Lambda's execution role has `bedrock:InvokeModel` on the Nova Micro foundation model and `aws-marketplace:Subscribe` / `aws-marketplace:ViewSubscriptions` on `*`. The Marketplace permissions are required for the *first* invocation on any Bedrock model, regardless of whether the model is first-party. After the first successful call, the subscription is established account-wide and the permissions could be removed — but keeping them avoids a class of `AccessDenied` errors on a fresh stack.

---

## AWS Resources

Provisioned by `infra/template.yaml`:

| Logical ID | Type | Purpose |
|---|---|---|
| `ParseApi` | `AWS::Serverless::HttpApi` | API Gateway HTTP API with CORS configured |
| `ParseFunction` | `AWS::Serverless::Function` | Handles `POST /parse` |
| `AnalyzeFunction` | `AWS::Serverless::Function` | Handles `POST /analyze` |
| `AskFunction` | `AWS::Serverless::Function` | Handles `POST /ask` |
| Lambda execution roles | auto-generated by SAM | One per function |

**Function configuration:**

- Runtime: `nodejs20.x`
- Architecture: `arm64` (20% cheaper than x86_64, same performance for Node)
- Timeout: 30s
- Memory: 512 MB

**CORS:** configured at the API Gateway level (`AllowOrigins: ['*']`, `AllowMethods: [POST, OPTIONS]`). The handlers also set CORS headers defensively. Both mechanisms are present; either alone would work.

---

## Environment Variables

Set in `infra/template.yaml` per function:

| Variable | Used by | Value |
|---|---|---|
| `BEDROCK_REGION` | analyze, ask | `us-east-1` |
| `BEDROCK_MODEL_ID` | analyze, ask | `amazon.nova-micro-v1:0` |

**Frontend env var (not backend):** `VITE_API_URL` — set in Amplify console, read by `src/App.jsx`.

---

## Local Testing

The handlers can be invoked directly with `node -e` — no SAM, no Docker, no deploy.

**Test `/parse` locally:**

```bash
node -e "require('./backend/handlers/api.cjs').handler(require('./backend/handlers/test-event.json')).then(r => console.log(r.statusCode, r.body))"
```

Expected: `200` followed by JSON with one node (`Bucket`), zero edges, one flag (`S3_NO_PUBLIC_ACCESS_BLOCK`).

**Test the parser CLI:**

```bash
node backend/parser/parse.cjs backend/parser/fixtures/vpc.yaml
```

**Test blast radius:**

```bash
node backend/parser/blast-radius.cjs backend/parser/fixtures/vpc.yaml VPC
```

Expected: 4 direct, 2 indirect, total 6.

**Test the rule engine:**

```bash
node backend/rules/rules.cjs backend/parser/fixtures/s3-lambda.yaml
```

Expected: 1 flag (`S3_NO_PUBLIC_ACCESS_BLOCK`).

**Test the cost estimator:**

```bash
node backend/rules/cost.cjs backend/parser/fixtures/vpc.yaml
```

(Note: `cost.cjs` doesn't have a CLI entry — this command is only valid if one is added.)

**Local Bedrock testing** requires AWS credentials configured (`aws configure`) and a Bedrock-enabled account. Use `aws sts get-caller-identity` to confirm credentials before invoking.

---

## Known Limitations

**SAM templates are not fully expanded.** `AWS::Serverless::Function` is a shorthand that the SAM transform expands at deploy time into a Lambda function, IAM role, event source mappings, and permission resources. The parser sees one node; the deployed stack has four or more. A template that uses SAM will produce a graph that under-represents the deployed architecture. This is a deliberate scope decision, not a bug.

**Cross-stack references are not followed.** `Fn::ImportValue` references to exports in other templates are treated as external. The graph is single-template. A multi-stack repo where stack B imports a subnet ID from stack A won't show the dependency in either graph.

**Managed IAM policies are not inspected.** Rules check inline `Policies` blocks. `ManagedPolicyArns` entries like `arn:aws:iam::aws:policy/AmazonS3FullAccess` are attached-policy references — the rule engine doesn't expand them. A Lambda with `AmazonS3FullAccess` attached won't fire `IAM_WILDCARD` unless its inline policy also uses wildcards.

**Cost estimates are heuristic.** The lookup table is hardcoded and low-traffic. It is not a bill and the UI says so.

**No persistence.** The backend is stateless. Nothing is saved between requests. No accounts, no history, no saved analyses.

**No live AWS integration.** The backend does not assume roles, query deployed stacks, or detect drift. Everything is static template analysis.

**Resource type coverage is ~40 types.** Everything outside the map renders as a generic node with the default color and no icon. The full AWS resource catalog is not covered.

---

## Design Decisions and Rationale

**CommonJS over ESM.** The frontend and backend share a repository. The frontend uses ESM (Vite requires it), the backend uses CommonJS (`js-yaml` ecosystem, all examples, and the `@aws-sdk` SDKs work more predictably). The `.cjs` extension lets both coexist without a monorepo tool.

**Temp file for parse input.** `parseTemplate` was written for the CLI, taking a file path. Refactoring to accept strings mid-project risked the deployed demo. Writing to `os.tmpdir()` is a 4-line workaround with zero correctness cost.

**Single `resourceIds` filter.** The parser filters every extracted reference name against the actual resource list. This is what makes `AWS::StackName`, parameters, and condition names safe. Without it, the graph fills with fake nodes and edges. This is the single most important piece of logic in the codebase.

**Reverse BFS for blast radius, not forward.** The user's question is "what breaks if I change this?" Change propagates *downstream* (reverse edges). Forward traversal would answer "what does this depend on?" — a different and less useful question.

**Bedrock narration, not Bedrock analysis.** The rule engine and graph traversal compute the results deterministically. Bedrock's job is to phrase those results in plain English. The prompt explicitly forbids the model from inventing new flags. This is the architectural decision that separates the tool from "paste it into Claude."

**Nova Micro over Claude Haiku.** Cheaper (7x), faster, first-party Amazon model that avoids AISPL Marketplace restrictions, and sufficient for a formatting-and-narration task.

**ARM64 Lambda.** 20% cheaper than x86_64, same performance for Node.js. One line in the SAM template.

**HTTP API over REST API.** Simpler configuration, cheaper, no VPC link needed. For three routes with CORS, there's no reason to use REST.

**No database.** Every request parses, analyzes, and returns. State is client-side. Adding persistence would add a VPC, an RDS instance, or a DynamoDB table, plus auth — none of which improve the tool's core value proposition.

---

## Cost

At demo scale — a handful of Lambda invocations, a few dozen Bedrock calls:

| Service | Monthly estimate |
|---|---|
| Lambda | within free tier (1M requests/month free) |
| API Gateway HTTP API | <$0.01 |
| Bedrock Nova Micro | <$0.01 |
| CloudWatch Logs | <$0.01 |
| SAM-managed S3 bucket | negligible |
| **Total** | **~$0.02/month** |

The Lambda configuration (ARM64, 512 MB, 30s timeout) is chosen so a spike of traffic doesn't produce an unexpected bill. Even at 10,000 requests/month the total stays under $0.10.

---

## Verification Checklist Before Deploy

1. `node backend/parser/parse.cjs backend/parser/fixtures/vpc.yaml` → 7 nodes, 9 edges
2. `node backend/parser/blast-radius.cjs backend/parser/fixtures/vpc.yaml VPC` → 4 direct, 2 indirect
3. `node backend/rules/rules.cjs backend/parser/fixtures/vpc.yaml` → 1 flag on `SSHSecurityGroup`
4. `node -e "require('./backend/handlers/api.cjs').handler(require('./backend/handlers/test-event.json')).then(r => console.log(r.statusCode))"` → 200
5. `cd infra && sam validate` → template valid
6. `sam build && sam deploy` → `Successfully created/updated stack`
7. `curl -X POST <ApiUrl>/parse -H "Content-Type: application/json" -d '{"template":"Resources:\n  B:\n    Type: AWS::S3::Bucket\n"}'` → 200 with one node, one flag
```

