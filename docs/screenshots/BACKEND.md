```markdown
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
- [CLI](#cli)
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
                │  Rule engine (8 rules)     │
                │  Cost estimator            │
                └───────────────────────────┘
```

Three Lambda functions behind a single API Gateway HTTP API. No database. No state. Every request parses, analyzes, and returns. The Bedrock Lambdas call the same analysis engine but use it as context for narration rather than computation.

Cold start characteristics: ARM64 Node 20 Lambdas. `ParseFunction` bundles `js-yaml`, `js-yaml-cloudformation-schema`, and the analysis modules (~250 KB). `AnalyzeFunction` and `AskFunction` bundle `@aws-sdk/client-bedrock-runtime` (~500 KB). Cold start for parse is ~400ms; Bedrock functions are ~600ms plus model latency.

The same analysis engine is also consumed by the CLI (`cli/`) which runs locally without a Lambda.

---

## File Structure

```
backend/
├── package.json                # CommonJS, deps: js-yaml, js-yaml-cloudformation-schema,
│                               # @aws-sdk/client-bedrock-runtime
├── node_modules/               # Bundled into Lambda deployment package
├── parser/
│   ├── parse.cjs               # Template loader + reference walker (returns nodes, edges)
│   ├── blast-radius.cjs        # Reverse BFS over edges
│   └── fixtures/
│       ├── s3-lambda.yaml
│       ├── vpc.yaml
│       ├── nested-stack.yaml
│       ├── sam.yaml
│       ├── conditions.yaml
│       ├── rds-ebs.yaml
│       ├── managed-policies.yaml
│       ├── permission-gap.yaml
│       └── permission-gap-dynamo.yaml
├── rules/
│   ├── rules.cjs               # 8 deterministic misconfiguration rules
│   └── cost.cjs                # Monthly cost heuristic
└── handlers/
    ├── api.cjs                 # POST /parse
    ├── analyze.cjs             # POST /analyze
    ├── ask.cjs                 # POST /ask
    └── test-event.json         # Local test fixture for api.cjs

cli/                             # Thin wrapper around the parser, blast-radius, and rules
├── package.json
├── bin/
│   └── iac.cjs                 # `iac check <template.yaml>` entry point
├── lib/
│   └── format.cjs              # Text and JSON output formatting
└── test.cjs

scripts/
└── test.cjs                    # Backend test suite (runs on push via GitHub Actions)

.github/
└── workflows/
    └── test.yml                # CI: runs scripts/test.cjs and cli/test.cjs
```

### CommonJS over ESM

The repository's root `package.json` has `"type": "module"` because it hosts the Vite frontend. The backend is CommonJS and uses the `.cjs` extension to override. Do not convert to ESM mid-project; the parser and rule engine both rely on `require()`.

### Pinned dependency

`js-yaml-cloudformation-schema` is pinned to an exact version (no caret). The parser's correctness depends on how this package converts intrinsic tags to JSON, and a minor version bump could change that behavior silently.

---

## Deployment

Deployed via AWS SAM. The SAM template is at `infra/template.yaml` and points its `CodeUri` at `../backend`.

### First-time deploy

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

### Subsequent deploys

```bash
cd infra
sam build --no-cached
sam deploy
```

The `--no-cached` flag forces a rebuild. Without it, SAM may reuse a cached build and miss backend changes — particularly `node_modules` updates.

### Output

API Gateway base URL printed as `ApiUrl` in the deploy output. Copy it into the frontend's `VITE_API_URL` and into the CLI if running against the deployed endpoint.

---

## API Contract

### POST /parse

Parses a CloudFormation template and returns the graph, flags, and cost estimate.

#### Request

```json
{
  "template": "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  ..."
}
```

#### Response 200

```json
{
  "nodes": [
    { "id": "DataBucket", "type": "AWS::S3::Bucket", "properties": { ... } }
  ],
  "edges": [
    {
      "source": "ProcessFunction",
      "target": "DataBucket",
      "relationship": "references",
      "path": "Properties.Environment.Variables.BUCKET_NAME"
    }
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
```

#### Response 400 — parse error

```json
{
  "error": "unknown tag !<!Ref>",
  "context": {
    "line": 14,
    "column": 22,
    "snippet": "      VpcId: !Ref VPC",
    "pointer": "                     ^"
  }
}
```

#### Response 413 — oversized template

```json
{ "error": "Template exceeds 200 KB limit" }
```

The `/parse` handler rejects templates larger than 200 KB before they reach the YAML parser. This closes the YAML-bomb attack surface (exponential anchor/alias expansion) on a public unauthenticated endpoint.

### POST /analyze

Takes a graph and its flags, asks Bedrock to narrate them in plain English. Does not re-analyze the template.

#### Request

```json
{
  "nodes": [{ "id": "DataBucket", "type": "AWS::S3::Bucket" }],
  "flags": [{ "severity": "medium", "resourceId": "DataBucket", "message": "..." }]
}
```

#### Response 200

```json
{ "summary": "This template deploys ..." }
```

#### Response 500

```json
{ "error": "<bedrock error message>" }
```

### POST /ask

Free-form Q&A grounded in the parsed graph. Same input shape as `/analyze` plus a `question` field.

#### Request

```json
{
  "question": "What references the VPC?",
  "nodes": [ ... ],
  "edges": [ ... ],
  "flags": [ ... ]
}
```

#### Response 200

```json
{ "answer": "Four resources reference the VPC: ..." }
```

---

## Handlers

### handlers/api.cjs

The `/parse` handler. Sequence:

1. Handles CORS preflight (`OPTIONS`) → 204 with no body.
2. Reads the request body. Handles both base64-encoded and plain bodies.
3. Extracts `template` field. Returns 400 if missing or not a string.
4. Checks `template.length` against `MAX_TEMPLATE_BYTES` (200 KB). Returns 413 if exceeded.
5. Writes the template to a temp file (`os.tmpdir()`) so it can reuse `parseTemplate`'s disk-based loader.
6. Calls `parseTemplate` → `{ nodes, edges }` (edges include the `path` field).
7. Calls `loadTemplate` → raw parsed YAML structure (needed by the rule engine and cost estimator).
8. Calls `runRules(template, graph)` → flags array. The graph is passed because `PERMISSION_NOT_GRANTED` needs to know what each Lambda references.
9. Calls `estimateCost(template)` → cost object.
10. Deletes the temp file.
11. Returns the combined JSON.

#### Structured parse errors

When `parseTemplate` throws a `YAMLException`, the handler inspects `err.mark.line` and `err.mark.column`, extracts the offending line from the original submitted template, and returns a `context` object with a line number (1-indexed), column, snippet, and a caret pointer string. The frontend renders this below the error message. If `err.mark` is not present (e.g. the input isn't a mapping at all), the handler returns the plain message.

#### Why the temp file

`parseTemplate` and `loadTemplate` were written for the CLI, taking a file path. The Lambda receives a string. The alternative — refactoring to accept strings — was rejected because the CLI tests were already passing and refactoring mid-project risked the deployed demo. Writing to `os.tmpdir()` is a 4-line workaround that costs ~5ms and zero correctness.

### handlers/analyze.cjs

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

The model is downstream of deterministic analysis. It's not doing the analysis. If Bedrock were to invent additional issues, the tool would be less trustworthy, not more. The prompt is engineered to keep the model in a narrating role only.

### handlers/ask.cjs

Same shape as `/analyze` but takes a question. The prompt includes the full node list, edge list, and flag list as context, and instructs the model to answer only from that context, returning a specific decline phrase if the answer isn't derivable.

The decline phrase — "I don't have that information in this template" — was chosen so that Q&A responses that exceed the graph's information are obvious, not silent. A judge or reviewer asking "does this hallucinate?" can test it by asking a question the template can't answer.

---

## Parser

### parser/parse.cjs

CloudFormation's intrinsic tags are not YAML. `!Ref`, `!GetAtt`, `!Sub`, and a dozen others are custom tags. Standard YAML parsers throw `unknown tag !<!Ref>` because the YAML spec doesn't define them.

The parser uses `js-yaml-cloudformation-schema`, an npm package that registers all standard CloudFormation tags and converts each to its JSON equivalent (`!Ref X` → `{ Ref: 'X' }`, `!GetAtt X.Y` → `{ 'Fn::GetAtt': ['X', 'Y'] }`). A hand-rolled schema with 16 tag definitions was the original implementation and broke on real templates because each new intrinsic form (e.g. `!ImportValue` with a nested `Fn::Sub` mapping) required a new schema entry. The package handles all of them, including the case where `!ImportValue` is followed by a mapping.

Parser output:

```js
{
  nodes: [{ id, type, properties }],
  edges: [{ source, target, relationship, path }]
}
```

Each edge includes a `path` field — the property chain that produced the reference. For example, `Properties.Role`, `Properties.Environment.Variables.BUCKET_NAME`, or `Properties.Policies[0].PolicyDocument.Statement[0].Resource`. The frontend renders this in the inspector so the user can see why two resources are connected.

#### Reference walker

For each resource, `collectRefs` recurses through the resource's properties looking for four patterns:

| Pattern | Matches |
|---|---|
| `{ Ref: 'Target' }` | `!Ref Target` |
| `{ 'Fn::GetAtt': ['Target', 'Attr'] }` or `{ 'Fn::GetAtt': 'Target.Attr' }` | `!GetAtt Target.Attr` |
| `{ 'Fn::Sub': '${Target}' }` | `!Sub '${Target}'` or `'${Target.Attr}'` |
| `{ DependsOn: 'Target' }` | `DependsOn: Target` |

`Fn::GetAtt` handles both forms. `js-yaml-cloudformation-schema` returns `Fn::GetAtt` as a string when written as `!GetAtt Foo.Arn` and as an array when written as `!GetAtt [Foo, Arn]`. A parser that only handles one form silently loses edges on real templates. Both are supported. This bug was caught by the test suite.

#### The critical filter

Every extracted name is checked against the actual resource list (`resourceIds.has(name)`) before being added to the graph. Without this filter:

- `AWS::StackName`, `AWS::Region`, `AWS::AccountId` — pseudo-parameters that look like references — become fake nodes
- `Environment`, `VPCName`, `InstanceType` — parameters — become fake nodes
- `IsProd`, `IsDev` — condition names — become fake nodes

The `resourceIds.has(...)` check is the difference between a correct graph and a garbage graph. It's one line of code. It's also the single most important piece of logic in the parser.

#### Property paths

`collectRefs` threads a `path` argument through its recursion. Each time it recurses into an object key, it appends `.key`; each time it recurses into an array index, it appends `[i]`. When a reference is found, the current path is stored as the edge's `path`. If a resource references the same target from two different properties, the first path encountered wins (the walker uses a `Map` keyed by target ID).

#### Fn::Sub handling

Substitution strings can contain `${Foo}`, `${Foo.Arn}`, `${AWS::StackName}`, or arbitrary text. The parser uses a regex (`/\$\{([A-Za-z0-9:_]+)(\.[A-Za-z0-9._]+)?\}/g`) to extract every candidate. Each candidate is then filtered against `resourceIds`. `AWS::StackName` is extracted but rejected. `DataBucket` is extracted and accepted.

#### Deduplication

A resource with two `!GetAtt` references to the same target produces one edge, not two. The walker collects into a `Map` per source keyed by target ID.

#### Self-references

A resource that references itself (`Ref: 'Self'`) is filtered out before edges are created. CloudFormation rejects these anyway, but the parser is defensive.

#### loadTemplate export

`parse.cjs` exports both `parseTemplate` (returns the graph) and `loadTemplate` (returns the raw parsed template). The rule engine and cost estimator need the raw template; the frontend needs the graph.

---

## Blast Radius

### parser/blast-radius.cjs

Pure function. Takes the full graph object (`{ nodes, edges }`) and a starting node ID. Returns:

```js
{
  start: 'SSHSecurityGroup',
  direct: ['WebServer', 'DatabaseServer'],
  indirect: [],
  total: 2
}
```

The function takes the graph object, not the edges array. It reads `graph.edges` internally. Passing only the edges array will throw `edges is not iterable`.

#### Algorithm

1. Build a reverse adjacency map — for each edge `A → B`, register `A` as a dependent of `B`.
2. BFS from the start node, tracking depth.
3. Depth 1 = direct dependents. Depth 2+ = indirect.
4. Return the two lists plus a total count.

Complexity: O(V + E). Under 1ms for the templates tested (up to ~200 resources).

#### Why reverse BFS

The user clicks a node and asks "what breaks if I change this?" That's a downstream question. `A → B` means A depends on B. If B changes, A is affected. So the blast radius of B is everything upstream of it in the edge direction — reverse traversal.

Same algorithm in the frontend. `src/lib/blastRadius.js` implements the identical function so clicking a node doesn't require a network round trip. The backend version exists for the CLI and for future server-side consumers.

---

## Rule Engine

### rules/rules.cjs

Eight deterministic rules. Each is a pure function that takes the parsed template (and, for one rule, the graph) and returns an array of flag objects:

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
| `IAM_MANAGED_POLICY_OVERPERMISSIVE` | high/medium | Roles attaching `AdministratorAccess`, `PowerUserAccess`, `IAMFullAccess`, or any `*FullAccess` managed policy |
| `PERMISSION_NOT_GRANTED` | high | A Lambda referencing an S3 bucket whose execution role grants no `s3:` permissions |

#### Rule implementation notes

`SG_OPEN_SENSITIVE_PORT` handles both `CidrIp` and `CidrIpv6`, and treats an unspecified port range as "all ports" (which triggers the rule).

`S3_NO_PUBLIC_ACCESS_BLOCK` requires all four block flags to be `true` to consider the bucket "protected." Partial blocks still fire.

`IAM_WILDCARD` navigates `Policies[].PolicyDocument.Statement[]` and handles both scalar and array forms of `Action` and `Resource`.

`IAM_WILDCARD_ACTION_ON_SCOPED_RESOURCE` fires only when the action uses a wildcard suffix (`dynamodb:*`) and the resource is scoped (not `"*"`). This is the over-permission pattern that cfn-lint doesn't flag as a distinct case.

`IAM_MANAGED_POLICY_OVERPERMISSIVE` scans `ManagedPolicyArns` and pattern-matches the policy name. `AdministratorAccess`, `PowerUserAccess`, and `IAMFullAccess` are always `high`. Anything ending in `FullAccess` (including `AmazonS3FullAccess`, `AWSLambda_FullAccess`) is `medium`. `AmazonSSMManagedInstanceCore` and `AWSLambdaBasicExecutionRole` correctly do not fire.

`PERMISSION_NOT_GRANTED` is the semantic cross-reference rule. For every `AWS::Lambda::Function`, it finds the execution role (from `Role`, which can be a `Ref` or `GetAtt`), collects the granted action prefixes from inline policies, then checks each resource the Lambda references against a `RESOURCE_IAM_PREFIX` mapping. If the required prefix isn't granted, it fires. Currently scoped to `AWS::S3::Bucket` → `s3:`.

#### runRules signature

```js
function runRules(template, graph) {
  const flags = [];
  for (const rule of RULES) flags.push(...rule.run(template, graph));
  return flags;
}
```

Most rules ignore the second argument. `PERMISSION_NOT_GRANTED` uses it. The CLI and the `/parse` handler both pass `(template, graph)`.

Rules are deterministic by construction. Same template → same flags → same order every time. No LLM in the detection path. This is the entire differentiation argument against "paste it into Claude."

---

## Cost Estimator

### rules/cost.cjs

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

It is a heuristic, not a bill. The UI labels it explicitly. `unknownCount` reports how many resources weren't costed (their types aren't in the table). The `breakdown` array is sorted descending so the largest line items appear first.

Why not the AWS Pricing API? The Pricing API requires a call per resource type, is region-dependent, and returns a complex schema. For a hackathon, the flat table is honest and instant. The README and UI both use the word "heuristic."

---

## Bedrock Integration

Model: `amazon.nova-micro-v1:0` in `us-east-1`.

### Why Nova Micro and not Claude

- Nova is a first-party Amazon model. It works immediately with standard Bedrock permissions — no AWS Marketplace subscription required.
- Accounts registered under AISPL (AWS India's billing entity) hit a Marketplace gate when trying to invoke Anthropic models. The error is `Model access is denied due to INVALID_PAYMENT_INSTRUMENT`.
- Nova Micro costs $0.035 per million input tokens. Claude Haiku 4.5 costs ~7x more. For narrating pre-computed flags, the extra cost buys nothing.

### Request shape

Bedrock's `messages-v1` schema:

```js
{
  schemaVersion: 'messages-v1',
  messages: [{ role: 'user', content: [{ text: prompt }] }],
  inferenceConfig: { maxTokens: 512, temperature: 0.3 }
}
```

### Response shape

```js
{
  output: {
    message: {
      content: [{ text: '...' }]
    }
  }
}
```

Anthropic models on Bedrock return `{ content: [{ text }] }` at the top level. Nova nests under `output.message.content`. The handlers use optional chaining (`parsed.output?.message?.content?.[0]?.text`) so a shape mismatch degrades to `"No summary generated"` rather than throwing.

### Graceful failure

Both Bedrock handlers catch errors and return a 500 with the error message. The frontend displays it. There is no fallback to canned narration — a deliberate choice, because a silently-substituted canned string would be indistinguishable from a live Bedrock response to the user.

### Credential flow

The Lambda's execution role has `bedrock:InvokeModel` on the Nova Micro foundation model and `aws-marketplace:Subscribe` / `aws-marketplace:ViewSubscriptions` on `*`. The Marketplace permissions are required for the first invocation on any Bedrock model, regardless of whether the model is first-party. After the first successful call, the subscription is established account-wide and the permissions could be removed — but keeping them avoids a class of `AccessDenied` errors on a fresh stack.

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

Function configuration:

- Runtime: `nodejs20.x`
- Architecture: `arm64` (20% cheaper than x86_64, same performance for Node)
- Timeout: 30s
- Memory: 512 MB

CORS is configured at the API Gateway level (`AllowOrigins: ['*']`, `AllowMethods: [POST, OPTIONS]`). The handlers also set CORS headers defensively. Both mechanisms are present; either alone would work.

---

## Environment Variables

Set in `infra/template.yaml` per function:

| Variable | Used by | Value |
|---|---|---|
| `BEDROCK_REGION` | analyze, ask | `us-east-1` |
| `BEDROCK_MODEL_ID` | analyze, ask | `amazon.nova-micro-v1:0` |

Frontend env var (not backend): `VITE_API_URL` — set in Amplify console, read by `src/App.jsx`.

---

## Local Testing

The handlers can be invoked directly with `node -e` — no SAM, no Docker, no deploy.

### Test /parse locally

```bash
node -e "require('./backend/handlers/api.cjs').handler(require('./backend/handlers/test-event.json')).then(r => console.log(r.statusCode, r.body))"
```

Expected: `200` followed by JSON with one node (`Bucket`), zero edges, one flag (`S3_NO_PUBLIC_ACCESS_BLOCK`).

### Test the parser CLI

```bash
node backend/parser/parse.cjs backend/parser/fixtures/vpc.yaml
```

Expected: 7 nodes, 9 edges, each edge with a `path` field.

### Test blast radius

```bash
node backend/parser/blast-radius.cjs backend/parser/fixtures/vpc.yaml VPC
```

Expected: 4 direct, 2 indirect, total 6.

### Test the rule engine

```bash
node backend/rules/rules.cjs backend/parser/fixtures/vpc.yaml
```

Expected: 1 flag on `SSHSecurityGroup`.

```bash
node backend/rules/rules.cjs backend/parser/fixtures/permission-gap.yaml
```

Expected: 3 flags — `S3_NO_PUBLIC_ACCESS_BLOCK` on `DataBucket`, `IAM_WILDCARD` on `ProcessRole`, and `PERMISSION_NOT_GRANTED` on `ProcessFunction`.

### Full test suite

```bash
node scripts/test.cjs    # 8 checks
node cli/test.cjs        # 8 checks
```

Runs the parser, blast radius, and rule engine against the fixtures with hardcoded expected counts. Also invokes the `/parse` handler with `test-event.json` and asserts a 200. This suite runs on every push via `.github/workflows/test.yml`.

Local Bedrock testing requires AWS credentials configured (`aws configure`) and a Bedrock-enabled account. Use `aws sts get-caller-identity` to confirm credentials before invoking.

---

## CLI

The `cli/` folder contains a thin wrapper that runs the same analysis engine from a terminal.

```bash
iac check template.yaml
iac check template.yaml --blast VPC
iac check template.yaml --json
iac check template.yaml --fail-on medium
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | No flags at or above the failure threshold |
| 1 | At least one flag at or above the threshold |
| 2 | Usage error or parse failure |

### How it consumes the backend

`cli/bin/iac.cjs` requires `../../backend/parser/parse.cjs`, `../../backend/parser/blast-radius.cjs`, and `../../backend/rules/rules.cjs` by relative path. This means the CLI must be run from inside a checked-out repository — it is not published as a standalone npm package. `npm link` from `cli/` makes the `iac` command available globally on the local machine, but the require paths still resolve back into the repo.

### Why this exists

The web app requires a user to remember it exists. The CLI slots into pre-commit hooks and CI pipelines. Same analysis, different trigger.

---

## Known Limitations

SAM templates are not fully expanded. `AWS::Serverless::Function` is a shorthand that the SAM transform expands at deploy time into a Lambda function, IAM role, event source mappings, and permission resources. The parser sees one node; the deployed stack has four or more. A template that uses SAM will produce a graph that under-represents the deployed architecture. This is a deliberate scope decision, not a bug.

Cross-stack references are not followed. `Fn::ImportValue` references to exports in other templates are treated as external. The graph is single-template. A multi-stack repo where stack B imports a subnet ID from stack A won't show the dependency in either graph.

Managed IAM policies are inspected by name, not by content. The `IAM_MANAGED_POLICY_OVERPERMISSIVE` rule pattern-matches the policy name (`*FullAccess`, `AdministratorAccess`). It does not expand the policy's actual statements. A custom customer-managed policy with a wildcard action won't fire this rule.

`PERMISSION_NOT_GRANTED` is scoped to S3. The `RESOURCE_IAM_PREFIX` mapping currently includes `AWS::S3::Bucket` → `s3:`. DynamoDB, SQS, SNS, and other common resource types are not yet mapped. Extending this is a one-line change per resource type plus a fixture.

Cost estimates are heuristic. The lookup table is hardcoded and low-traffic. It is not a bill and the UI says so.

No persistence. The backend is stateless. Nothing is saved between requests. No accounts, no history, no saved analyses.

No live AWS integration. The backend does not assume roles, query deployed stacks, or detect drift. Everything is static template analysis.

Resource type coverage is ~40 types. Everything outside the map renders as a generic node with the default color and no icon. The full AWS resource catalog is not covered.

---

## Design Decisions and Rationale

### CommonJS over ESM

The frontend and backend share a repository. The frontend uses ESM (Vite requires it), the backend uses CommonJS. The `.cjs` extension lets both coexist without a monorepo tool.

### Temp file for parse input

`parseTemplate` was written for the CLI, taking a file path. Refactoring to accept strings mid-project risked the deployed demo. Writing to `os.tmpdir()` is a 4-line workaround with zero correctness cost.

### Single resourceIds filter

The parser filters every extracted reference name against the actual resource list. This is what makes `AWS::StackName`, parameters, and condition names safe. Without it, the graph fills with fake nodes and edges. This is the single most important piece of logic in the codebase.

### Reverse BFS for blast radius, not forward

The user's question is "what breaks if I change this?" Change propagates downstream (reverse edges). Forward traversal would answer "what does this depend on?" — a different and less useful question.

### Property paths on edges

The parser records which property produced each reference so the frontend can render "WebServer — Properties.SecurityGroupIds[0]" instead of just "WebServer". This turns a list of names into an explained dependency chain.

### Bedrock narration, not Bedrock analysis

The rule engine and graph traversal compute the results deterministically. Bedrock's job is to phrase those results in plain English. The prompt explicitly forbids the model from inventing new flags. This is the architectural decision that separates the tool from "paste it into Claude."

### Nova Micro over Claude Haiku

Cheaper (7x), faster, first-party Amazon model that avoids AISPL Marketplace restrictions, and sufficient for a formatting-and-narration task.

### ARM64 Lambda

20% cheaper than x86_64, same performance for Node.js. One line in the SAM template.

### HTTP API over REST API

Simpler configuration, cheaper, no VPC link needed. For three routes with CORS, there's no reason to use REST.

### No database

Every request parses, analyzes, and returns. State is client-side. Adding persistence would add a VPC, an RDS instance, or a DynamoDB table, plus auth — none of which improve the tool's core value proposition.

### 200 KB input cap

The `/parse` endpoint is public and unauthenticated. A YAML bomb (exponential anchor/alias expansion) is a well-documented DoS class against any YAML parser. Rejecting oversized input before it reaches `js-yaml.load` closes the surface. Real CloudFormation templates are far under 200 KB.

### Pinned schema dependency

`js-yaml-cloudformation-schema` is pinned to an exact version. The parser's correctness depends on how it converts intrinsic tags to JSON. A minor version bump could silently change that behavior.

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
| Total | ~$0.02/month |

The Lambda configuration (ARM64, 512 MB, 30s timeout) is chosen so a spike of traffic doesn't produce an unexpected bill. Even at 10,000 requests/month the total stays under $0.10.

---

## Verification Checklist Before Deploy

1. `node backend/parser/parse.cjs backend/parser/fixtures/vpc.yaml` → 7 nodes, 9 edges, each edge with `path`
2. `node backend/parser/blast-radius.cjs backend/parser/fixtures/vpc.yaml VPC` → 4 direct, 2 indirect
3. `node backend/rules/rules.cjs backend/parser/fixtures/vpc.yaml` → 1 flag on `SSHSecurityGroup`
4. `node backend/rules/rules.cjs backend/parser/fixtures/permission-gap.yaml` → 3 flags including `PERMISSION_NOT_GRANTED`
5. `node backend/rules/rules.cjs backend/parser/fixtures/managed-policies.yaml` → 2 flags on `BadRole`
6. `node scripts/test.cjs` → all tests pass
7. `node cli/test.cjs` → all tests pass
8. `cd infra && sam validate` → template valid
9. `sam build --no-cached && sam deploy` → `Successfully created/updated stack`
10. `curl -X POST <ApiUrl>/parse -H "Content-Type: application/json" -d '{"template":"Resources:\n  B:\n    Type: AWS::S3::Bucket\n"}'` → 200 with one node, one flag
11. `curl -X POST <ApiUrl>/ask -H "Content-Type: application/json" -d '{"question":"test","nodes":[],"edges":[],"flags":[]}'` → 200 with an `answer` field
12. Send a 300 KB payload to `/parse` → 413
