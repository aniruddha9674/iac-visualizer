import dagre from '@dagrejs/dagre';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 70;

export function layoutGraph(nodes, edges, direction = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 80, ranksep: 160 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positionedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: { ...node.data, label: node.id, type: node.type },
      type: 'resource',
    };
  });

  const positionedEdges = edges.map((edge, i) => ({
    id: `e-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    animated: false,
    style: { stroke: '#94a3b8', strokeWidth: 1.5 },
  }));

  return { nodes: positionedNodes, edges: positionedEdges };
}