export function computeBlastRadius(edges, startId) {
  const reverseAdj = new Map();
  for (const { source, target } of edges) {
    if (!reverseAdj.has(target)) reverseAdj.set(target, []);
    reverseAdj.get(target).push(source);
  }

  const depth = new Map([[startId, 0]]);
  const queue = [startId];

  while (queue.length > 0) {
    const current = queue.shift();
    const d = depth.get(current);
    for (const dep of reverseAdj.get(current) || []) {
      if (!depth.has(dep)) {
        depth.set(dep, d + 1);
        queue.push(dep);
      }
    }
  }

  const direct = [];
  const indirect = [];
  const depthById = {};
  for (const [id, d] of depth.entries()) {
    if (id === startId) continue;
    if (d === 1) direct.push(id);
    else indirect.push(id);
    depthById[id] = d;
  }
  return { direct, indirect, total: direct.length + indirect.length, depthById };
}