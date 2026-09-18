// scripts/test.cjs
const { execSync } = require('node:child_process');
const path = require('node:path');

let passed = 0;
let failed = 0;

function run(name, cmd, assert) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = assert(out);
    if (result === true) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}\n     reason: ${result}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ ${name}\n     crash: ${err.message.split('\n')[0]}`);
    failed++;
  }
}

const root = path.resolve(__dirname, '..');
const fixture = (f) => path.join(root, 'backend/parser/fixtures', f);
const parser = path.join(root, 'backend/parser/parse.cjs');
const blast = path.join(root, 'backend/parser/blast-radius.cjs');
const rules = path.join(root, 'backend/rules/rules.cjs');

console.log('\nparser fixtures');
run(
  's3-lambda: 3 nodes, 3 edges',
  `node ${parser} ${fixture('s3-lambda.yaml')}`,
  (out) => {
    const g = JSON.parse(out);
    if (g.nodes.length !== 3) return `expected 3 nodes, got ${g.nodes.length}`;
    if (g.edges.length !== 3) return `expected 3 edges, got ${g.edges.length}`;
    return true;
  }
);

run(
  'vpc: 7 nodes, 9 edges',
  `node ${parser} ${fixture('vpc.yaml')}`,
  (out) => {
    const g = JSON.parse(out);
    if (g.nodes.length !== 7) return `expected 7 nodes, got ${g.nodes.length}`;
    if (g.edges.length !== 9) return `expected 9 edges, got ${g.edges.length}`;
    return true;
  }
);

console.log('\nblast radius');
run(
  'vpc: VPC has 4 direct, 2 indirect',
  `node ${blast} ${fixture('vpc.yaml')} VPC`,
  (out) => {
    const r = JSON.parse(out);
    if (r.direct.length !== 4) return `expected 4 direct, got ${r.direct.length}`;
    if (r.indirect.length !== 2) return `expected 2 indirect, got ${r.indirect.length}`;
    return true;
  }
);

run(
  'vpc: SSHSecurityGroup has 2 direct',
  `node ${blast} ${fixture('vpc.yaml')} SSHSecurityGroup`,
  (out) => {
    const r = JSON.parse(out);
    if (r.direct.length !== 2) return `expected 2 direct, got ${r.direct.length}`;
    return true;
  }
);

console.log('\nrules');
run(
  'vpc: fires exactly one flag (SSH port 22)',
  `node ${rules} ${fixture('vpc.yaml')}`,
  (out) => {
    const flags = JSON.parse(out);
    if (flags.length !== 1) return `expected 1 flag, got ${flags.length}`;
    if (flags[0].ruleId !== 'SG_OPEN_SENSITIVE_PORT') return `wrong rule: ${flags[0].ruleId}`;
    if (flags[0].resourceId !== 'SSHSecurityGroup') return `wrong resource: ${flags[0].resourceId}`;
    return true;
  }
);

run(
  's3-lambda: fires exactly one flag (public access block)',
  `node ${rules} ${fixture('s3-lambda.yaml')}`,
  (out) => {
    const flags = JSON.parse(out);
    if (flags.length !== 1) return `expected 1 flag, got ${flags.length}`;
    if (flags[0].ruleId !== 'S3_NO_PUBLIC_ACCESS_BLOCK') return `wrong rule: ${flags[0].ruleId}`;
    return true;
  }
);

console.log('\nhandler');

(async () => {
  try {
    const apiHandler = require(path.join(root, 'backend/handlers/api.cjs'));
    const testEvent = require(path.join(root, 'backend/handlers/test-event.json'));
    const res = await apiHandler.handler(testEvent);

    if (res.statusCode === 200) {
      console.log('  ✓ api handler returns 200');
      passed++;
    } else {
      console.log(`  ✗ api handler returns 200 (got ${res.statusCode})`);
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ api handler crashed: ${err.message}`);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();

