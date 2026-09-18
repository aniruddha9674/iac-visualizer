// backend/parser/blast-radius.cjs
const path = require('node:path');

function buildReverseAdjacency(edges) {
  const reverseAdj = new Map();
  for (const { source, target } of edges) {
    if (!reverseAdj.has(target)) reverseAdj.set(target, []);
    reverseAdj.get(target).push(source);
  }
  return reverseAdj;
}

function computeBlastRadius(graph, startId) {
  const reverseAdj = buildReverseAdjacency(graph.edges);
  const visited = new Set([startId]);
  const queue = [startId];
  const depth = new Map([[startId, 0]]);

  while (queue.length > 0) {
    const current = queue.shift();
    const currentDepth = depth.get(current);
    for (const dep of reverseAdj.get(current) || []) {
      if (!visited.has(dep)) {
        visited.add(dep);
        depth.set(dep, currentDepth + 1);
        queue.push(dep);
      }
    }
  }

  const direct = [];
  const indirect = [];
  for (const [id, d] of depth.entries()) {
    if (id === startId) continue;
    if (d === 1) direct.push(id);
    else indirect.push(id);
  }

  return { start: startId, direct, indirect, total: direct.length + indirect.length };
}

module.exports = { computeBlastRadius };

if (require.main === module) {
  const { parseTemplate } = require('./parse.cjs');
  const file = process.argv[2];
  const startId = process.argv[3];
  if (!file || !startId) {
    console.error('usage: node blast-radius.cjs <template.yaml> <startNodeId>');
    process.exit(1);
  }
  const graph = parseTemplate(path.resolve(file));
  const result = computeBlastRadius(graph, startId);
  console.log(JSON.stringify(result, null, 2));
}