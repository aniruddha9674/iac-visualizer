// Turns a flat "HIGH — OPEN_SSH: allows 0.0.0.0/0 on port 22" flag into an
// actual explanation of why it matters, plus a place to learn more. This is
// deliberately pattern-matched against ruleId + message text rather than an
// exact ruleId lookup table, because the frontend doesn't know the precise
// rule identifiers the backend emits — matching on keywords is more
// resilient to that than a lookup that silently misses and shows nothing.

const PATTERNS = [
  {
  test: /ssh|\b22\b|\b3389\b/i,
  why: 'Anyone on the internet can attempt to brute-force or exploit this connection. SSH access should come from a bastion host, VPN, or a specific known IP range — never 0.0.0.0/0.',
  docUrl: 'https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html',
},
  {
    test: /0\.0\.0\.0\/0|wide.?open|all ports|0-65535|any port/i,
    why: 'This resource accepts traffic from any IP address on any port. Scope ingress rules to the specific ports and source ranges your application actually needs.',
    docUrl: 'https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html',
  },
  {
    test: /wildcard|action.*\*|resource.*\*/i,
    why: 'A wildcard IAM action or resource grants far more access than most workloads need. If this role or its credentials are ever compromised, the blast radius of that compromise is the entire account, not just this resource.',
    docUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege',
  },
  {
    test: /public.?read|publicly.?accessible|public.?access/i,
    why: 'This resource is reachable from outside your AWS account by default. Confirm that\'s intentional — accidental public exposure is one of the most common causes of real data breaches.',
    docUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html',
  },
  {
    test: /unencrypted|encryption/i,
    why: 'Data at rest here isn\'t encrypted by default. For anything holding customer or sensitive data, enabling encryption is usually a compliance requirement, not just a best practice.',
    docUrl: 'https://docs.aws.amazon.com/whitepapers/latest/aws-kms-best-practices/data-encryption.html',
  },
];

const FALLBACK = {
  why: 'This deviates from AWS security best practices. Review the resource\'s exposure and permissions to confirm the configuration is intentional.',
  docUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html',
};

export function explainFlag(flag) {
  const haystack = [
    flag.ruleId || '',
    flag.message || '',
    flag.detail?.cidr || '',
    flag.detail?.fromPort ?? '',
    flag.detail?.toPort ?? '',
  ].join(' ');
  const match = PATTERNS.find((p) => p.test.test(haystack));
  return match ? { why: match.why, docUrl: match.docUrl } : FALLBACK;
}