#!/usr/bin/env node
// cli/bin/iac.cjs
//
// Thin wrapper around the backend analysis engine. Run from inside the repo:
//
//   node cli/bin/iac.cjs check backend/parser/fixtures/vpc.yaml
//
// Not published as a standalone npm package. The require() paths below
// resolve to ../../backend relative to this file, which only exists when the
// repo is checked out.
//
// Exit codes:
//   0  no flags at or above the failure threshold
//   1  at least one flag at or above the threshold
//   2  usage error or parse failure

const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '..', '..', 'backend');
const { parseTemplate, loadTemplate } = require(path.join(backend, 'parser', 'parse.cjs'));
const { computeBlastRadius } = require(path.join(backend, 'parser', 'blast-radius.cjs'));
const { runRules } = require(path.join(backend, 'rules', 'rules.cjs'));
const { formatText, formatJson } = require('../lib/format.cjs');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const USAGE = `
iac — CloudFormation blast radius and misconfiguration checks

Usage:
  iac check <template.yaml> [options]

Options:
  --json                Machine-readable output for CI
  --blast <resourceId>  Also print the blast radius of the given resource
  --fail-on <severity>  Minimum severity that causes a non-zero exit
                        (high | medium | low — default: high)
  --help, -h            Show this message

Exit codes:
  0  no flags at or above the failure threshold
  1  flags found at or above the threshold
  2  usage error or parse failure

Note: run from inside the repository. This is not a standalone package.
`;

function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE.trim());
    return 0;
  }

  if (args[0] !== 'check') {
    console.error(`Unknown command: ${args[0]}\n`);
    console.error(USAGE.trim());
    return 2;
  }

  const file = args[1];
  if (!file) {
    console.error('Missing template path.\n');
    console.error(USAGE.trim());
    return 2;
  }

  const jsonMode = args.includes('--json');

  const blastIndex = args.indexOf('--blast');
  const blastTarget = blastIndex >= 0 ? args[blastIndex + 1] : null;

  const failIndex = args.indexOf('--fail-on');
  const failOn = failIndex >= 0 ? args[failIndex + 1] : 'high';
  if (!['high', 'medium', 'low'].includes(failOn)) {
    console.error(`Invalid --fail-on value: ${failOn}. Must be high, medium, or low.`);
    return 2;
  }
  const failThreshold = SEVERITY_ORDER[failOn];

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    return 2;
  }

  let graph, template, flags;
  try {
    graph = parseTemplate(resolved);
    template = loadTemplate(resolved);
    flags = runRules(template,graph);
  } catch (err) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`Parse failed: ${err.message}`);
    }
    return 2;
  }

  const blast = blastTarget ? computeBlastRadius(graph, blastTarget) : null;

  const result = {
    ok: true,
    file: resolved,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    failOn,
    flags,
    blast,
  };

  const breached = flags.some((f) => SEVERITY_ORDER[f.severity] <= failThreshold);

  if (jsonMode) {
    console.log(formatJson(result));
  } else {
    console.log(formatText(result));
  }

  return breached ? 1 : 0;
}

process.exit(main(process.argv));