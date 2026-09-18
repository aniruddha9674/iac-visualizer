import dagre from '@dagrejs/dagre';

const NODE_HEIGHT = 68;
const MIN_NODE_WIDTH = 180;
const MAX_NODE_WIDTH = 260;

// Roughly estimate a node's on-screen width from its label + type, so long
// resource names (e.g. "ProductionDatabaseReplicaSecurityGroup") don't get
// clipped and short ones don't waste canvas space.
export function estimateNodeWidth(node) {
  const label = node.id || '';
  const typeLabel = (node.type || '').split('::').pop() || '';
  const longest = Math.max(label.length, typeLabel.length);
  const estimate = 96 + longest * 6.2;
  return Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, Math.round(estimate)));
}

// Dagre spacing that opens up as the graph grows, so dense templates don't
// collapse into an unreadable knot. Small templates stay tight and centered.
function spacingFor(nodeCount) {
  if (nodeCount <= 8) return { nodesep: 70, ranksep: 140 };
  if (nodeCount <= 20) return { nodesep: 90, ranksep: 170 };
  if (nodeCount <= 40) return { nodesep: 110, ranksep: 210 };
  return { nodesep: 130, ranksep: 250 };
}

export function layoutGraph(nodes, edges, direction = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));

  const { nodesep, ranksep } = spacingFor(nodes.length);
  g.setGraph({ rankdir: direction, nodesep, ranksep, marginx: 40, marginy: 40 });

  const widths = new Map();
  for (const node of nodes) {
    const width = estimateNodeWidth(node);
    widths.set(node.id, width);
    g.setNode(node.id, { width, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positionedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    const width = widths.get(node.id) ?? MIN_NODE_WIDTH;
    return {
      ...node,
      position: { x: pos.x - width / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: { ...node.data, label: node.id, type: node.type, width },
      style: { width },
      type: 'resource',
    };
  });

  const positionedEdges = edges.map((edge, i) => {
    const isHypo = edge.hypothetical === true;
    return {
      id: `e-${i}-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: isHypo,
      className: isHypo ? 'iac-hypothetical' : undefined,
      style: isHypo
        ? { stroke: 'var(--signal)', strokeWidth: 2, strokeDasharray: '5,5' }
        : undefined,
      data: { hypothetical: isHypo },
    };
  });

  return { nodes: positionedNodes, edges: positionedEdges };
}