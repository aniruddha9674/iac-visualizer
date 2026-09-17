// backend/handlers/api.cjs
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const yaml = require('js-yaml');
const { parseTemplate, loadTemplate } = require('../parser/parse.cjs');
const { computeBlastRadius } = require('../parser/blast-radius.cjs');
const { runRules } = require('../rules/rules.cjs');
const { estimateCost } = require('../rules/cost.cjs');

// CloudFormation intrinsic tag schema — duplicated from parse.cjs so we can
// parse templates that arrive in the request body (not from disk).
const cfnTags = [
  new yaml.Type('!Ref',       { kind: 'scalar',   construct: (d) => ({ Ref: d }) }),
  new yaml.Type('!GetAtt',    { kind: 'scalar',   construct: (d) => ({ 'Fn::GetAtt': String(d).split('.') }) }),
  new yaml.Type('!Sub',       { kind: 'scalar',   construct: (d) => ({ 'Fn::Sub': d }) }),
  new yaml.Type('!Join',      { kind: 'sequence', construct: (d) => ({ 'Fn::Join': d }) }),
  new yaml.Type('!Select',    { kind: 'sequence', construct: (d) => ({ 'Fn::Select': d }) }),
  new yaml.Type('!GetAZs',    { kind: 'scalar',   construct: (d) => ({ 'Fn::GetAZs': d }) }),
  new yaml.Type('!ImportValue',{ kind: 'scalar',  construct: (d) => ({ 'Fn::ImportValue': d }) }),
  new yaml.Type('!If',        { kind: 'sequence', construct: (d) => ({ 'Fn::If': d }) }),
  new yaml.Type('!Equals',    { kind: 'sequence', construct: (d) => ({ 'Fn::Equals': d }) }),
  new yaml.Type('!Not',       { kind: 'sequence', construct: (d) => ({ 'Fn::Not': d }) }),
  new yaml.Type('!And',       { kind: 'sequence', construct: (d) => ({ 'Fn::And': d }) }),
  new yaml.Type('!Or',        { kind: 'sequence', construct: (d) => ({ 'Fn::Or': d }) }),
  new yaml.Type('!Base64',    { kind: 'scalar',   construct: (d) => ({ 'Fn::Base64': d }) }),
  new yaml.Type('!Cidr',      { kind: 'sequence', construct: (d) => ({ 'Fn::Cidr': d }) }),
  new yaml.Type('!Split',     { kind: 'sequence', construct: (d) => ({ 'Fn::Split': d }) }),
  new yaml.Type('!FindInMap', { kind: 'sequence', construct: (d) => ({ 'Fn::FindInMap': d }) }),
];
const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(cfnTags);

function parseTemplateFromString(yamlText) {
  const template = yaml.load(yamlText, { schema: CFN_SCHEMA });
  const resources = template.Resources || {};
  const resourceIds = new Set(Object.keys(resources));
  const nodes = [];
  const edges = [];

  for (const [id, def] of Object.entries(resources)) {
    nodes.push({ id, type: def.Type, properties: def.Properties || {} });
  }

  // Reuse the collectRefs logic by writing the parsed template to a temp file
  // and calling parseTemplate? No — that's wasteful. Instead, expose the walker.
  // For now, delegate to parseTemplate on a temp file. Simple and correct.
  return { template, nodes, edges };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // CORS preflight
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const { template: yamlText } = JSON.parse(body);

    if (!yamlText || typeof yamlText !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing "template" field in request body' }) };
    }

    // Write to a temp file so we can reuse parseTemplate's disk-based loader.
    const tmp = path.join(os.tmpdir(), `tmpl-${Date.now()}.yaml`);
    fs.writeFileSync(tmp, yamlText, 'utf8');

    const graph = parseTemplate(tmp);
    const template = loadTemplate(tmp);
    fs.unlinkSync(tmp);

    const flags = runRules(template);

        return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        nodes: graph.nodes,
        edges: graph.edges,
        flags,
        cost: estimateCost(template),
      }),
    };
  } catch (err) {
    console.error('parse error:', err);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: err.message || 'Failed to parse template' }),
    };
  }
};