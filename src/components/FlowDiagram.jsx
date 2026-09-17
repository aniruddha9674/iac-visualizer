import { useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react';

const CATEGORY_COLORS = {
  'AWS::Lambda::Function': '#f59e0b',
  'AWS::S3::Bucket': '#3b82f6',
  'AWS::DynamoDB::Table': '#8b5cf6',
  'AWS::EC2::Instance': '#10b981',
  'AWS::EC2::VPC': '#6b7280',
  'AWS::EC2::Subnet': '#9ca3af',
  'AWS::EC2::SecurityGroup': '#ef4444',
  'AWS::IAM::Role': '#eab308',
  'AWS::IAM::Policy': '#eab308',
  'AWS::SQS::Queue': '#14b8a6',
  'AWS::SNS::Topic': '#ec4899',
  'AWS::CloudFormation::Stack': '#64748b',
};

function colorForType(type) {
  if (!type) return '#94a3b8';
  if (CATEGORY_COLORS[type]) return CATEGORY_COLORS[type];
  if (type.startsWith('AWS::IAM::')) return '#eab308';
  if (type.startsWith('AWS::EC2::')) return '#6b7280';
  return '#94a3b8';
}

function ResourceNode({ data, id }) {
  const color = colorForType(data.type);
  const isSelected = data.__selected;
  const isDirect = data.__direct;
  const isIndirect = data.__indirect;
  const isDimmed = data.__dimmed;
  const hasFlag = data.__hasFlag;

  let border = `2px solid ${color}`;
  let boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
  let opacity = 1;

  if (isSelected) {
    border = '3px solid #0f172a';
    boxShadow = '0 0 0 4px rgba(15,23,42,0.12)';
  } else if (isDirect) {
    border = '3px solid #ef4444';
    boxShadow = '0 0 0 4px rgba(239,68,68,0.15)';
  } else if (isIndirect) {
    border = '3px solid #f97316';
    boxShadow = '0 0 0 4px rgba(249,115,22,0.12)';
  }

  if (isDimmed) opacity = 0.35;

  return (
    <div
      style={{
        background: 'white',
        border,
        borderLeft: `6px solid ${color}`,
        borderRadius: 8,
        padding: '8px 12px',
        width: 180,
        boxShadow,
        opacity,
        fontFamily: 'system-ui, sans-serif',
        cursor: 'grab',
        transition: 'box-shadow 120ms, opacity 120ms',
        position: 'relative',
      }}
    >
      {hasFlag && (
        <div
          style={{
            position: 'absolute',
            top: -8,
            right: -8,
            background: '#dc2626',
            color: 'white',
            fontSize: 10,
            fontWeight: 700,
            borderRadius: 10,
            padding: '1px 6px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
        >
          ⚠
        </div>
      )}
      <Handle type="target" position={Position.Left} style={{ background: color }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>{data.label}</div>
      <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{data.type}</div>
      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

const nodeTypes = { resource: ResourceNode };

export default function FlowDiagram({
  nodes,
  edges,
  selectedId,
  onNodeClick,
  onConnect,
  onConnectStart,
  onConnectEnd,
  directIds = [],
  indirectIds = [],
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  const directSet = useMemo(() => new Set(directIds), [directIds]);
  const indirectSet = useMemo(() => new Set(indirectIds), [indirectIds]);
  const inSelectionMode = !!selectedId;

  useEffect(() => {
    setRfNodes(
      nodes.map((n) => {
        const inSet = n.id === selectedId || directSet.has(n.id) || indirectSet.has(n.id);
        return {
          ...n,
          data: {
            ...n.data,
            __selected: n.id === selectedId,
            __direct: directSet.has(n.id),
            __indirect: indirectSet.has(n.id),
            __dimmed: inSelectionMode && !inSet,
          },
        };
      })
    );
  }, [nodes, selectedId, directSet, indirectSet, inSelectionMode, setRfNodes]);

  useEffect(() => {
    setRfEdges(
      edges.map((e) => {
        const isHypo = e.data?.hypothetical === true;
        return {
          ...e,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isHypo ? '#f59e0b' : '#94a3b8',
          },
        };
      })
    );
  }, [edges, setRfEdges]);

  return (
    <div style={{ width: '100%', height: '100%', background: '#f8fafc' }}>
           <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
        onPaneClick={() => onNodeClick?.(null)}
        onConnect={(params) => onConnect?.(params)}
        onConnectStart={(_, params) => onConnectStart?.(params)}
        onConnectEnd={() => onConnectEnd?.()}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e2e8f0" gap={20} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}