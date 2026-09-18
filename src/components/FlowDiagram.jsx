import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useViewport,
  MarkerType,
} from '@xyflow/react';
// REQUIRED: without this import, React Flow's node wrappers have no
// position/sizing CSS at all — nodes render with no visible box and pile
// up in DOM order instead of respecting the dagre-computed x/y from
// layout.js. This single line is what was causing "boxes are gone" and
// most of the "everything clustered in one place" symptoms.
import '@xyflow/react/dist/style.css';
import {
  Server,
  Database,
  Network,
  ShieldAlert,
  KeyRound,
  Radio,
  Layers,
  Box,
  TriangleAlert,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import clsx from 'clsx';

// Zoom thresholds that reveal progressively more detail on each node. The
// goal is "the more you zoom in, the more the node tells you" — at a wide
// fit-view glance you get names, and as you commit to reading a subgraph you
// get types, flag counts, then a real property value.
const ZOOM_MINIMAL = 0.5; // below this: name + colored edge only
const ZOOM_DETAIL = 0.9; // above this: flag-count badge, bigger handles
const ZOOM_PROPERTY = 1.3; // above this: a property key=value line

// One category → { color, icon } mapping drives node accent color, the
// minimap, and the icon badge, so the same visual language repeats everywhere
// instead of color and iconography drifting apart.
const CATEGORY_RULES = [
  { test: (t) => t.startsWith('AWS::Lambda::') || t === 'AWS::EC2::Instance', color: 'var(--cat-compute)', Icon: Server },
  { test: (t) => t.startsWith('AWS::S3::'), color: 'var(--cat-storage)', Icon: Database },
  { test: (t) => t.startsWith('AWS::DynamoDB::') || t.startsWith('AWS::RDS::'), color: 'var(--cat-database)', Icon: Database },
  { test: (t) => t.startsWith('AWS::EC2::SecurityGroup'), color: 'var(--cat-security)', Icon: ShieldAlert },
  { test: (t) => t.startsWith('AWS::EC2::'), color: 'var(--cat-networking)', Icon: Network },
  { test: (t) => t.startsWith('AWS::IAM::'), color: 'var(--cat-iam)', Icon: KeyRound },
  { test: (t) => t.startsWith('AWS::SQS::') || t.startsWith('AWS::SNS::'), color: 'var(--cat-messaging)', Icon: Radio },
  { test: (t) => t.startsWith('AWS::CloudFormation::Stack'), color: 'var(--cat-stack)', Icon: Layers },
];

function categoryFor(type = '') {
  const match = CATEGORY_RULES.find((rule) => rule.test(type));
  return match || { color: 'var(--cat-default)', Icon: Box };
}

function ResourceNode({ data }) {
  const { color, Icon } = categoryFor(data.type);
  // Live zoom drives which layers of detail are painted. useViewport() is
  // available here because nodes render inside the ReactFlow provider.
  const { zoom } = useViewport();
  const showType = zoom >= ZOOM_MINIMAL;
  const showIcon = zoom >= ZOOM_MINIMAL;
  const showFlagBadge = zoom > ZOOM_DETAIL && (data.__flagCount || 0) > 0;
  const showProperty = zoom > ZOOM_PROPERTY && Boolean(data.__firstProp);
  const handleSize = zoom > ZOOM_DETAIL ? 11 : 9;

  const isSelected = data.__selected;
  const isDirect = data.__direct;
  const isIndirect = data.__indirect;
  const isDimmed = data.__dimmed;
  const hasFlag = data.__hasFlag;

  const ringColor = isSelected
    ? 'var(--signal)'
    : isDirect
    ? 'var(--risk-direct)'
    : isIndirect
    ? 'var(--risk-indirect)'
    : 'var(--border-hairline)';

  return (
    <div
      className={clsx(
        'iac-node',
        (isSelected || isDirect) && 'radar-pulse',
        isSelected && 'radar-pulse--selected',
        isDirect && 'radar-pulse--direct'
      )}
      style={{
        background: 'var(--bg-surface)',
        border: `1.5px solid ${ringColor}`,
        borderLeft: `4px solid ${color}`,
        boxShadow:
          isSelected || isDirect || isIndirect ? `0 0 0 3px ${ringColor}22` : '0 1px 2px rgba(0,0,0,0.3)',
        opacity: isDimmed ? 0.3 : 1,
      }}
    >
      {hasFlag && showIcon && (
        <div className="iac-node-flag">
          <TriangleAlert size={11} color="#0a0f1c" strokeWidth={2.5} />
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        style={{ background: color, width: handleSize, height: handleSize }}
      />

      <div className="iac-node-body">
        {showIcon && (
          <div className="iac-node-icon" style={{ background: `${color}22`, color }}>
            <Icon size={12} strokeWidth={2.25} />
          </div>
        )}
        <div className="iac-node-text">
          <div className="iac-node-label iac-truncate" style={{ color: 'var(--text-primary)' }} title={data.label}>
            {data.label}
          </div>
          {showType && (
            <div className="iac-node-type iac-truncate" style={{ color: 'var(--text-tertiary)' }} title={data.type}>
              {data.type}
            </div>
          )}
          {showFlagBadge && (
            <div className="iac-node-flagcount" title={`${data.__flagCount} flag(s)`}>
              <TriangleAlert size={9} strokeWidth={2.5} />
              {data.__flagCount}
            </div>
          )}
          {showProperty && (
            <div className="iac-node-prop iac-truncate" title={data.__firstProp}>
              {data.__firstProp}
            </div>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: color, width: handleSize, height: handleSize }}
      />
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
  isFocusMode = false,
  onToggleFocus,
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [rfInstance, setRfInstance] = useState(null);

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
      edges.map((e) => ({
        ...e,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: e.data?.hypothetical ? 'var(--signal)' : '#4b5875',
          width: 16,
          height: 16,
        },
      }))
    );
  }, [edges, setRfEdges]);

  const minimapNodeColor = (n) => categoryFor(n.data?.type || '').color;

  // Re-center the graph whenever the canvas gains or loses the surrounding
  // chrome, so entering/exiting fullscreen actually uses the new space
  // instead of leaving the diagram pinned to its old position.
  useEffect(() => {
    if (!rfInstance) return;
    const id = requestAnimationFrame(() => rfInstance.fitView({ padding: 0.25, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [isFocusMode, rfInstance]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--bg-canvas)' }}>
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
        connectionMode="loose"
        minZoom={0.15}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        onInit={setRfInstance}
      >
        <Background variant={BackgroundVariant.Dots} color="#1c2740" gap={22} size={1.5} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          maskColor="rgba(10,15,28,0.75)"
        />
        <Panel position="top-right">
          <button
            onClick={onToggleFocus}
            className="iac-focus-btn"
            title={isFocusMode ? 'Exit fullscreen' : 'Fill screen with diagram'}
          >
            {isFocusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}