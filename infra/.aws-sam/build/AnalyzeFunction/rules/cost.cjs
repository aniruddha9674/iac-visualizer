// backend/rules/cost.cjs
//
// Rough monthly cost heuristic. Not a bill. Uses flat per-resource estimates
// at low-traffic assumptions — enough to answer "what does this template
// cost to run" without pretending to be accurate.

const BASE_COST = {
  'AWS::EC2::Instance': 8.0,          // t3.micro running 24/7
  'AWS::EC2::Volume': 0.80,           // 10GB gp3 baseline
  'AWS::RDS::DBInstance': 15.0,       // db.t3.micro
  'AWS::S3::Bucket': 0.25,            // 10GB storage
  'AWS::DynamoDB::Table': 1.25,       // on-demand, ~1M ops
  'AWS::Lambda::Function': 0.20,      // ~1M invocations
  'AWS::ApiGateway::RestApi': 3.50,
  'AWS::ApiGatewayV2::Api': 1.00,
  'AWS::SQS::Queue': 0.40,
  'AWS::SNS::Topic': 0.50,
  'AWS::CloudFront::Distribution': 1.00,
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 16.0,
  'AWS::CloudFormation::Stack': 0,
  'AWS::IAM::Role': 0,
  'AWS::IAM::Policy': 0,
  'AWS::EC2::SecurityGroup': 0,
  'AWS::EC2::Subnet': 0,
  'AWS::EC2::VPC': 0,
  'AWS::EC2::InternetGateway': 0,
  'AWS::EC2::RouteTable': 0,
};

function estimateCost(template) {
  const resources = template.Resources || {};
  const breakdown = [];
  let total = 0;
  let unknownCount = 0;

  for (const [id, def] of Object.entries(resources)) {
    const cost = BASE_COST[def.Type];
    if (cost == null) {
      unknownCount++;
      continue;
    }
    if (cost === 0) continue;
    breakdown.push({ id, type: def.Type, monthly: cost });
    total += cost;
  }

  breakdown.sort((a, b) => b.monthly - a.monthly);

  return {
    total: Math.round(total * 100) / 100,
    breakdown,
    unknownCount,
  };
}

module.exports = { estimateCost };