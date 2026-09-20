# iac-visualizer

![test](https://github.com/aniruddha9674/iac-visualizer/actions/workflows/test.yml/badge.svg)

**[Try it →](https://main.dm50udtc9sqd0.amplifyapp.com/)**

---

I spent two days reading a 400-line CloudFormation template before I understood what it deployed. Not because the YAML was hard. Because nothing told me which resources depended on which other resources, and I didn't want to change the wrong thing.

Change sets show one hop. cfn-lint checks each resource individually. Infrastructure Composer draws the picture but doesn't compute impact. So I built the missing piece: paste a template, click a resource, see everything that transitively depends on it.

This is what it looks like:
$ iac check template.yaml

Template: ./template.yaml
Graph: 28 resources, 41 dependencies

Flags (7):
[HIGH ] AppSecurityGroup — Security group opens port(s) 22-22 to the public internet.
[HIGH ] AppDatabase — RDS instance is publicly accessible from the internet.
[HIGH ] JobProcessor — references UploadsBucket (AWS::S3::Bucket), but its
execution role (JobProcessorRole) grants no 's3:' permissions.
This will fail at runtime with AccessDenied.
[HIGH ] JobProcessorRole — IAM statement grants wildcard Resource.
[MEDIUM] UploadsBucket — S3 bucket has no PublicAccessBlockConfiguration.
[MEDIUM] LogsBucket — S3 bucket has no PublicAccessBlockConfiguration.
[MEDIUM] AppDataVolume — EBS volume is not encrypted at rest.

text

The `PERMISSION_NOT_GRANTED` flag is the one that doesn't exist in any other tool. It cross-references two resources: the Lambda, the bucket it reads from, and the IAM role in between. cfn-lint can't find this because each resource is individually valid.

---

## What it does

**Blast radius.** Click any resource in the graph. Reverse BFS over the dependency edges shows every resource that transitively depends on it — direct and indirect, with the property path that creates each edge. `WebServer — Properties.SecurityGroupIds[0]`.

**Sandbox mode.** Drag a hypothetical edge between two resources to see what the blast radius *would* be if the dependency existed. Simulate deleting a resource. Neither touches the template.

**Eight deterministic rules.** Open security groups on sensitive ports, S3 buckets without public access blocks, IAM wildcards, managed policies like `AdministratorAccess`, RDS instances marked publicly accessible, unencrypted EBS volumes, wildcard actions on scoped resources, and the Lambda-permission-mismatch rule described above. Same template in, same flags out. No LLM in the detection path.

**AI narration.** Bedrock's Nova Micro explains the flags in plain English. It's downstream of the rule engine — it narrates what was computed deterministically, it doesn't invent new findings. Ask follow-up questions grounded in the parsed graph.

**Cost estimate.** A flat lookup table of monthly USD per resource type. It's a heuristic and the UI says so, but it answers a question CloudFormation never tells you.

---

## How it works

The whole tool is three Lambda functions behind one API Gateway HTTP API:
Browser (Amplify Hosting)
│
▼
API Gateway HTTP API ──► Lambda /parse ──► Parser + BFS + Rules + Cost
──► Lambda /analyze ──► Bedrock (Nova Micro)
──► Lambda /ask ──► Bedrock (Nova Micro)

text

The parser is the interesting part. CloudFormation's `!Ref`, `!GetAtt`, and `!Sub` are not YAML. Every standard parser throws `unknown tag` on a real template. This one uses `js-yaml-cloudformation-schema` to convert intrinsics into their JSON equivalents, then walks every resource's properties looking for four reference patterns.

The critical detail: every extracted name is filtered against the actual resource list before becoming an edge. Without that filter, `AWS::StackName`, parameter names like `${Environment}`, and condition names like `IsProd` all become fake nodes. The graph is only correct because of one `Set.has()` call.

Same BFS algorithm runs on the client, so clicking a node updates the panel without a network round-trip. The backend version exists for the CLI and for future server-side consumers.

Full backend documentation: [`docs/BACKEND.md`](docs/BACKEND.md).

---

## Stack

| Frontend | React 19, Vite, React Flow, dagre |
| Backend | Node.js 20 on Lambda (ARM64), CommonJS |
| API | API Gateway HTTP API |
| AI | Amazon Bedrock, Nova Micro |
| Hosting | AWS Amplify |
| Deploy | AWS SAM |
| Parsing | js-yaml + js-yaml-cloudformation-schema |

Bedrock runs on Nova Micro rather than Claude because AISPL (AWS India) accounts hit a Marketplace subscription gate on Anthropic models. Nova is first-party, doesn't need the subscription, and costs 7x less. For narrating pre-computed flags, the bigger model buys nothing.

---

## Using it locally

```bash
git clone https://github.com/aniruddha9674/iac-visualizer.git
cd iac-visualizer
npm install
npm run dev
Opens at http://localhost:5173. The frontend points at the deployed API by default.

For the CLI, from the repo root:

bash
cd cli
npm link            # makes the `iac` command available globally
cd ..

iac check template.yaml
iac check template.yaml --blast VPC
iac check template.yaml --json
iac check template.yaml --fail-on medium
Exit codes: 0 if no flags at or above the threshold, 1 if there are, 2 for usage errors.

Run the test suites:

bash
node scripts/test.cjs    # 8 checks
node cli/test.cjs        # 8 checks
What it doesn't do
Cross-stack references. Fn::ImportValue into another template isn't followed. The graph is single-template. Multi-stack repos where stack B imports a subnet ID from stack A won't show the dependency.

SAM transform expansion. AWS::Serverless::Function expands into a Lambda, an IAM role, event source mappings, and permission resources at deploy time. The parser sees one node. A SAM template's graph under-represents the deployed architecture.

Managed policies by content. IAM_MANAGED_POLICY_OVERPERMISSIVE matches on policy name (*FullAccess, AdministratorAccess). It doesn't expand the actual statements of a custom customer-managed policy.

PERMISSION_NOT_GRANTED is scoped to S3. The resource-to-IAM-prefix map currently only includes AWS::S3::Bucket. Extending it to DynamoDB, SQS, and SNS is a one-line change per resource type.

Live AWS access. Static template analysis only. No account scanning, no drift detection, no deployed-state comparison.

Auto-fix. It flags issues. The changes belong in your repo, reviewed in a PR.

What fought back
js-yaml-cloudformation-schema returns Fn::GetAtt as a string ("Foo.Arn") when written as !GetAtt Foo.Arn, but as an array (["Foo", "Arn"]) when written as !GetAtt [Foo, Arn]. A parser that only handles one form silently loses edges on real templates. The test suite caught this — s3-lambda.yaml produced 2 edges instead of 3, and the missing one was a !GetAtt in a Lambda's Role property.

Amplify's build failed twice before I understood why. npm ci reads the lockfile, not package.json. The lockfile was stale from a previous install and didn't include @dagrejs/dagre, so the build threw Rolldown failed to resolve import "@dagrejs/dagre" even though the package was in the manifest. Fix: rm package-lock.json && npm install.

Bedrock on AISPL accounts doesn't work with Anthropic models the way the docs imply. The error INVALID_PAYMENT_INSTRUMENT is what you get when the account is registered under AWS India's billing entity and Claude tries to initiate a Marketplace subscription. Nova Micro doesn't need one because it's a first-party model.

npm link on Windows requires admin privileges. npm install -g . from the CLI directory works without. Same effect, no UAC prompt.

SAM's transform means AWS::Serverless::Function is not a real CloudFormation resource — it's a macro input that expands at deploy time. The parser sees one node; the deployed stack has four or more. That's why SAM support was cut, not because the parser is hard to extend, but because a graph that shows the shorthand isn't showing the deployed architecture.

Where this goes next
Ordered by what I'd actually build.

GitHub Action. Run the parser on a PR diff and post the blast radius as a review comment. The analysis engine exists; the integration is a wrapper. Reviewers don't open browser tabs mid-review.

Cross-stack resolution. Parse every template in a repo, resolve Fn::ImportValue against Outputs.*.Export.Name declarations, build one combined graph. This is the feature that turns the tool from "useful for one stack" into "useful for a monorepo."

Drift detection. Read-only DetectStackDrift and DescribeStackResourceDrifts calls, overlaid on the graph. Combined with blast radius, this answers "what's downstream of drifted infrastructure" — a question nothing currently addresses.

Suggested fixes. Every rule gets a fix field. "Replace CidrIp: 0.0.0.0/0 with a bastion CIDR." Turns "here's a problem" into "here's the change."

Terraform. The graph model and BFS are language-agnostic. Terraform needs a second parser (HCL), a second resource-type mapping, and a second rules engine. Estimated 2–3 days. CloudFormation first because the tooling gap is bigger — terraform graph and terraform plan already exist.

Built for
First Commit, WeMakeDevs Bharat Builds Tour, September 17–20 2026. Solo. Ship It track.