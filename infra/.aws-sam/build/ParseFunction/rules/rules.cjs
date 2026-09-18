// backend/rules/rules.cjs
const SENSITIVE_PORTS = new Set([22, 3389, 3306, 5432, 6379, 27017, 9200]);

const OVERPERMISSIVE_MANAGED_POLICY_PATTERN =
  /^(AdministratorAccess|PowerUserAccess|IAMFullAccess|[A-Za-z0-9_]+FullAccess)$/;

const OVERPERMISSIVE_ALWAYS_HIGH = new Set([
  'AdministratorAccess',
  'PowerUserAccess',
  'IAMFullAccess',
]);

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function collectPolicies(def) {
  const stmts = [];
  const props = def.Properties || {};
  for (const p of props.Policies || []) {
    const doc = p.PolicyDocument;
    if (!doc) continue;
    if (Array.isArray(doc.Statement)) stmts.push(...doc.Statement);
    else if (doc.Statement) stmts.push(doc.Statement);
  }
  const top = props.PolicyDocument;
  if (top) {
    if (Array.isArray(top.Statement)) stmts.push(...top.Statement);
    else if (top.Statement) stmts.push(top.Statement);
  }
  return stmts;
}

function checkManagedPolicies(template) {
  const flags = [];
  for (const [resourceId, resource] of Object.entries(template.Resources || {})) {
    if (resource.Type !== 'AWS::IAM::Role' && resource.Type !== 'AWS::IAM::User') continue;

    const arns = resource.Properties?.ManagedPolicyArns || [];
    for (const arnRef of arns) {
      // ManagedPolicyArns entries are usually plain ARN strings for AWS
      // managed policies, but can be a !Ref or !Sub to a customer-managed
      // policy. Only flag entries we can read as strings — we can't inspect
      // the ARN shape of a resolved reference.
      if (typeof arnRef !== 'string') continue;

      const policyName = arnRef.split('/').pop();
      if (OVERPERMISSIVE_MANAGED_POLICY_PATTERN.test(policyName)) {
        flags.push({
          ruleId: 'IAM_MANAGED_POLICY_OVERPERMISSIVE',
          severity: OVERPERMISSIVE_ALWAYS_HIGH.has(policyName) ? 'high' : 'medium',
          resourceId,
          message: `${resourceId} attaches the managed policy "${policyName}", which grants broader access than most workloads need.`,
          detail: { policyArn: arnRef, policyName },
        });
      }
    }
  }
  return flags;
}

const RULES = [
  {
    id: 'SG_OPEN_SENSITIVE_PORT',
    severity: 'high',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::EC2::SecurityGroup') continue;
        for (const rule of def.Properties?.SecurityGroupIngress || []) {
          const cidr = rule.CidrIp || rule.CidrIpv6;
          if (cidr !== '0.0.0.0/0' && cidr !== '::/0') continue;
          const range = [rule.FromPort, rule.ToPort].filter(Number.isFinite);
          const hits = range.some((p) => SENSITIVE_PORTS.has(p));
          if (hits || range.length === 0) {
            flags.push({
              ruleId: 'SG_OPEN_SENSITIVE_PORT',
              severity: 'high',
              resourceId: id,
              message: `Security group opens port(s) ${range.join('-')} to the public internet.`,
              detail: { cidr, fromPort: rule.FromPort, toPort: rule.ToPort },
            });
          }
        }
      }
      return flags;
    },
  },

  {
    id: 'S3_NO_PUBLIC_ACCESS_BLOCK',
    severity: 'medium',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::S3::Bucket') continue;
        const props = def.Properties || {};
        const b = props.PublicAccessBlockConfiguration;
        const hasBlock = b && b.BlockPublicAcls === true && b.BlockPublicPolicy === true
          && b.IgnorePublicAcls === true && b.RestrictPublicBuckets === true;
        const publicAcl = props.AccessControl && /PublicRead|PublicReadWrite/.test(props.AccessControl);
        if (!hasBlock || publicAcl) {
          flags.push({
            ruleId: 'S3_NO_PUBLIC_ACCESS_BLOCK',
            severity: publicAcl ? 'high' : 'medium',
            resourceId: id,
            message: publicAcl
              ? 'S3 bucket has a public-read ACL.'
              : 'S3 bucket has no PublicAccessBlockConfiguration.',
            detail: { hasPublicAccessBlock: !!hasBlock, accessControl: props.AccessControl || null },
          });
        }
      }
      return flags;
    },
  },

  {
    id: 'IAM_WILDCARD',
    severity: 'high',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::IAM::Role' && def.Type !== 'AWS::IAM::Policy') continue;
        for (const stmt of collectPolicies(def)) {
          const action = toArray(stmt.Action);
          const resource = toArray(stmt.Resource);
          const wildAction = action.includes('*');
          const wildResource = resource.includes('*');
          if (wildAction || wildResource) {
            flags.push({
              ruleId: 'IAM_WILDCARD',
              severity: 'high',
              resourceId: id,
              message: `IAM statement grants ${wildAction ? 'wildcard Action' : ''}${wildAction && wildResource ? ' and ' : ''}${wildResource ? 'wildcard Resource' : ''}.`,
              detail: { action, resource },
            });
          }
        }
      }
      return flags;
    },
  },

  {
    id: 'IAM_WILDCARD_ACTION_ON_SCOPED_RESOURCE',
    severity: 'medium',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::IAM::Role' && def.Type !== 'AWS::IAM::Policy') continue;
        for (const stmt of collectPolicies(def)) {
          const action = toArray(stmt.Action);
          const resource = toArray(stmt.Resource);
          const scopedWildcard = action.some((a) => typeof a === 'string' && a.endsWith(':*'));
          const wildResource = resource.includes('*');
          if (scopedWildcard && !wildResource && resource.length > 0) {
            flags.push({
              ruleId: 'IAM_WILDCARD_ACTION_ON_SCOPED_RESOURCE',
              severity: 'medium',
              resourceId: id,
              message: `IAM statement grants all actions on a specific resource (${action.join(', ')}). Consider narrowing the action list.`,
              detail: { action, resource },
            });
          }
        }
      }
      return flags;
    },
  },
    {
    id: 'IAM_MANAGED_POLICY_OVERPERMISSIVE',
    severity: 'medium',
    run: checkManagedPolicies,
  },
    {
    id: 'RDS_PUBLICLY_ACCESSIBLE',
    severity: 'high',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::RDS::DBInstance') continue;
        if (def.Properties?.PubliclyAccessible === true) {
          flags.push({
            ruleId: 'RDS_PUBLICLY_ACCESSIBLE',
            severity: 'high',
            resourceId: id,
            message: 'RDS instance is publicly accessible from the internet.',
            detail: {},
          });
        }
      }
      return flags;
    },
  },

  {
    id: 'EBS_UNENCRYPTED',
    severity: 'medium',
    run(template) {
      const flags = [];
      for (const [id, def] of Object.entries(template.Resources || {})) {
        if (def.Type !== 'AWS::EC2::Volume') continue;
        if (def.Properties?.Encrypted !== true) {
          flags.push({
            ruleId: 'EBS_UNENCRYPTED',
            severity: 'medium',
            resourceId: id,
            message: 'EBS volume is not encrypted at rest.',
            detail: {},
          });
        }
      }
      return flags;
    },
  },
];

function runRules(template) {
  const flags = [];
  for (const rule of RULES) flags.push(...rule.run(template));
  return flags;
}

module.exports = { runRules, RULES };

if (require.main === module) {
  const path = require('node:path');
  const { loadTemplate } = require('../parser/parse.cjs');
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node rules.cjs <template.yaml>');
    process.exit(1);
  }
  const template = loadTemplate(path.resolve(file));
  console.log(JSON.stringify(runRules(template), null, 2));
}