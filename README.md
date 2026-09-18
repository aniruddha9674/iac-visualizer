
# IaC Visualizer

![test](https://github.com/aniruddha9674/iac-visualizer/actions/workflows/test.yml/badge.svg)

**Live demo:** https://main.dm50udtc9sqd0.amplifyapp.com/

A tool that parses CloudFormation templates into a dependency graph, computes the transitive blast radius of any resource, runs deterministic misconfiguration rules, estimates monthly cost, and uses Amazon Bedrock to narrate the findings in plain English.

Built solo for **First Commit** (WeMakeDevs Bharat Builds Tour, September 17–20, 2026).

---

## The problem

When you change or delete a resource in a CloudFormation template, nothing tells you what else breaks. Change sets show one-hop actions on the resources being changed. cfn-lint and Checkov check properties in isolation. Infrastructure Composer and cfn-diagram draw the graph but don't compute impact.

None of them answer the question every engineer asks before touching a template: **if I change this resource, what transitively depends on it?**

This tool does.

---

## What it does

**Blast radius.** Click any resource in the diagram. The tool runs reverse BFS over the dependency graph and shows every resource that transitively depends on it — direct and indirect, with a total count.

**Sandbox mode.** Drag a hypothetical edge between two resources to see what the blast radius *would* be. Simulate deleting a node to see what would break. Neither operation touches the template.

**Six deterministic rules.** Security groups open to `0.0.0.0/0` on sensitive ports, S3 buckets missing public access blocks, IAM wildcards, RDS instances marked publicly accessible, unencrypted EBS volumes, and over-scoped IAM actions. Same template in, same flags out, every time.

**Cost estimate.** A per-resource monthly cost heuristic. Not a bill — the UI says so. But it answers the question reviewers actually ask that CloudFormation never tells you.

**AI narration.** Amazon Nova Micro via Bedrock explains the flags in plain English. The model is downstream of the analysis — it explains results that were computed deterministically. It doesn't generate them.

**Q&A.** After generating a summary, ask free-form questions grounded in the parsed graph.

---

## Why CloudFormation and not Terraform

This isn't a tool for people who love CloudFormation. It's a tool for people who have to read it. Every engineer working in AWS eventually inherits a CFN template — a vendor deliverable, a legacy stack, a CDK-synthesized artifact, a PR from a team that hasn't migrated. Terraform has `terraform graph` and `terraform plan`. CloudFormation has change sets, which are one-hop, and no graph view at all.

The tool exists because CloudFormation is what you *have to read*, not what you choose to write.

---

## Architecture

```
Browser (Amplify Hosting)
        │
        ▼
API Gateway HTTP API  ──►  Lambda /parse    ──►  Parser + BFS + Rules + Cost
                      ──►  Lambda /analyze  ──►  Bedrock (Nova Micro)
                      ──►  Lambda /ask      ──►  Bedrock (Nova Micro)
```

**Backend:** Node.js 20, ARM64 Lambdas, deployed via AWS SAM. Three functions behind one API Gateway HTTP API. Stateless — nothing persisted between requests.

**Frontend:** React 19 + Vite. React Flow for the diagram, dagre for layout. Hosted on AWS Amplify.

**AI:** Amazon Bedrock, model `amazon.nova-micro-v1:0`. Chosen over Claude Haiku for cost (7x cheaper) and because it's a first-party Amazon model that avoids AWS Marketplace subscription requirements on AISPL accounts.

See [`docs/BACKEND.md`](docs/BACKEND.md) for the full backend reference.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite, React Flow, dagre, lucide-react |
| Backend | Node.js 20, CommonJS |
| IaC deploy | AWS SAM, CloudFormation |
| Compute | AWS Lambda (ARM64) |
| API | API Gateway HTTP API |
| AI | Amazon Bedrock (Nova Micro) |
| Hosting | AWS Amplify |
| YAML parsing | js-yaml + js-yaml-cloudformation-schema |
| Tests | Custom Node script (7 checks) + GitHub Actions |

---

## What it's capable of

- Parses CloudFormation YAML with all standard intrinsic functions — `!Ref`, `!GetAtt`, `!Sub`, `!Join`, `!Select`, `!GetAZs`, `!ImportValue`, `!If`, `!FindInMap`, and more
- Builds a correct dependency graph from `Ref`, `GetAtt`, `Sub`, and `DependsOn` references, with filtering so pseudo-parameters and condition names don't create fake edges
- Computes transitive blast radius in under a millisecond for templates up to a few hundred resources
- Detects six categories of misconfiguration deterministically
- Explores hypothetical graph modifications without touching the template
- Narrates findings in plain English via Bedrock

---

## What it doesn't do

- **Cross-stack references.** `Fn::ImportValue` into another template isn't followed. Each template is analyzed in isolation.
- **SAM transform expansion.** `AWS::Serverless::Function` is shorthand. The parser sees one node; the deployed stack has four or more.
- **Live AWS account scanning.** Static template analysis only.
- **Diff mode.** One snapshot at a time.
- **Auto-fix.** It flags issues. The changes belong in your repo, reviewed in a PR.
- **Managed policy ARNs.** Rules check inline `Policies` blocks; `ManagedPolicyArns` entries aren't expanded.

---

## Running locally

```bash
git clone https://github.com/aniruddha9674/iac-visualizer.git
cd iac-visualizer
npm install
npm run dev
```

Opens at `http://localhost:5173`. The frontend defaults to the deployed API; to point it at your own backend, create `.env.local`:

```
VITE_API_URL=https://<your-api-gateway-url>
```

Run the backend tests:

```bash
node scripts/test.cjs
```

Expected: `7 passed, 0 failed`.

---

## Deploying

**Backend:**

```bash
cd infra
sam build
sam deploy --guided
```

**Frontend:** connect the repo to AWS Amplify. Amplify detects Vite. Set `VITE_API_URL` to your API Gateway URL in the Amplify console.

---

## What I learned

- CloudFormation's intrinsic tags are not YAML. Every standard parser breaks on `!Ref`. This is the first thing you discover when you parse a real template.
- The critical piece of the parser is one line: filtering extracted reference names against the resource list. Without it, `AWS::StackName`, parameters, and conditions all become fake nodes. The graph is only correct because of that filter.
- SAM's transform means the parser would be lying. `AWS::Serverless::Function` expands into four-plus real resources at deploy time. A parser that shows the shorthand isn't showing the deployed architecture. That's why SAM support was cut, not because it's hard.
- `js-yaml-cloudformation-schema` returns `Fn::GetAtt` as a **string** (`"Foo.Arn"`) not an array. A parser that only handles the array form silently loses edges on real templates. The test suite caught this.
- Bedrock needs inference profiles for newer Claude models but not for Nova. AISPL (AWS India) accounts hit AWS Marketplace subscription gates on Anthropic models. Amazon's first-party models work without.
- `npm ci` reads the lockfile, not `package.json`. A stale lockfile breaks the Amplify build even when the manifest is correct.

---

## Future work

Ordered by impact.

1. **PR integration.** A GitHub Action that runs the parser on a PR diff and comments the blast radius as a review comment. The analysis engine exists; the integration is a wrapper. This is where the tool belongs — reviewers don't open browser tabs mid-review.
2. **Cross-stack resolution.** Parse multiple templates at once, resolve `Fn::ImportValue` against `Outputs.*.Export.Name` declarations, build one combined graph.
3. **Drift detection overlay.** Read-only integration with `DetectStackDrift` and `DescribeStackResourceDrifts` to highlight resources that have diverged from the template. Combined with blast radius, answers "what's downstream of drifted infrastructure" — a question no existing tool addresses.
4. **Suggested fixes for each flag.** Every rule gets a `fix` field. Turns "here's a problem" into "here's the change."
5. **VPC/subnet boundary grouping.** React Flow supports parent/child nodes. Nesting subnets inside their VPC as a bounding box would make large templates dramatically more legible.
6. **Terraform support.** The graph model is language-agnostic. Terraform would need a second parser (HCL), a second resource-type mapping, and a second rules engine. Estimated 2–3 days.

---

## AI tools used

- **Claude (Anthropic)** — architecture discussion, code review, debugging. Not used for the parser, the BFS, or the rule engine — those were written, tested, and debugged manually against the fixtures.
- **Amazon Nova Micro via Bedrock** — embedded in the product. Narrates pre-computed flags and answers Q&A over the parsed graph.

---

