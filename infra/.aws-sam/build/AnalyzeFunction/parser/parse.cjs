// backend/parser/parse.cjs
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// --- CloudFormation intrinsic function tags ---
// Standard YAML has no idea what !Ref / !GetAtt are. We define each tag
// and tell js-yaml how to convert it into its JSON equivalent, which is
// what CloudFormation itself uses internally.
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

const { CLOUDFORMATION_SCHEMA } = require('js-yaml-cloudformation-schema');
const CFN_SCHEMA = CLOUDFORMATION_SCHEMA;

// --- Template parsing ---
function parseTemplate(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const template = yaml.load(raw, { schema: CFN_SCHEMA });

  const resources = template.Resources || {};
  const resourceIds = new Set(Object.keys(resources));
  const nodes = [];
  const edges = [];

  // 1. Every resource becomes a node.
  for (const [id, def] of Object.entries(resources)) {
    nodes.push({
      id,
      type: def.Type,
      properties: def.Properties || {},
    });
  }

  // 2. For each resource, walk its properties and collect resource references.
  for (const [id, def] of Object.entries(resources)) {
    const targets = new Map();
    collectRefs(def, resourceIds, targets);
    targets.delete(id);
    for (const [target, path] of targets.entries()) {
      edges.push({
        source: id,
        target,
        relationship: 'references',
        path: path || 'Properties',
      });
    }
  }

  return { nodes, edges };
}

// --- Reference collection ---
// Walks any value (object, array, scalar) and adds names of resources it
// references into `out`. Only names that actually exist in the template's
// Resources section count — this filters out pseudo-parameters
// (AWS::Region etc.), parameters, conditions, and outputs.
function collectRefs(value, resourceIds, out, path = '') {
  if (value == null) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = path ? `${path}[${i}]` : `[${i}]`;
      collectRefs(value[i], resourceIds, out, p);
    }
    return;
  }

  if (typeof value !== 'object') return;

  if (typeof value.Ref === 'string' && resourceIds.has(value.Ref)) {
    if (!out.has(value.Ref)) out.set(value.Ref, path);
  }
  if (value['Fn::GetAtt'] != null) {
    const ga = value['Fn::GetAtt'];
    let name;
    if (Array.isArray(ga)) name = ga[0];
    else if (typeof ga === 'string') name = ga.split('.')[0];
    if (typeof name === 'string' && resourceIds.has(name)) {
      if (!out.has(name)) out.set(name, path);
    }
  }
  if (value['Fn::Sub'] != null) {
    const sub = Array.isArray(value['Fn::Sub']) ? value['Fn::Sub'][0] : value['Fn::Sub'];
    if (typeof sub === 'string') {
      const re = /\$\{([A-Za-z0-9:_]+)(\.[A-Za-z0-9._]+)?\}/g;
      let m;
      while ((m = re.exec(sub)) !== null) {
        if (resourceIds.has(m[1]) && !out.has(m[1])) {
          out.set(m[1], path);
        }
      }
    }
  }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    collectRefs(v, resourceIds, out, p);
  }
}

function loadTemplate(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw, { schema: CFN_SCHEMA });
}

module.exports = { parseTemplate, loadTemplate };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node parse.cjs <template.yaml>');
    process.exit(1);
  }
  const result = parseTemplate(path.resolve(file));
  console.log(JSON.stringify(result, null, 2));
}