import { useEffect, useMemo, useState } from 'react';
// This was missing entirely — iac-visualizer.css defines every .iac-node,
// .iac-focus-btn, .iac-console, etc. class the app relies on, but nothing
// was importing it, so none of that styling (including node borders and
// backgrounds) ever reached the page.
import './styles/iac-visualizer.css';
import TemplateInput from './components/TemplateInput.jsx';
import FlowDiagram from './components/FlowDiagram.jsx';
import { layoutGraph } from './lib/layout.js';
import { computeBlastRadius } from './lib/blastRadius.js';
import { explainFlag } from './lib/ruleExplanations.js';

const API_URL = import.meta.env.VITE_API_URL || 'https://j04hh0pkgd.execute-api.us-east-1.amazonaws.com';

const SAMPLES = {
  'VPC + EC2': `AWSTemplateFormatVersion: '2010-09-09'
Description: VPC with subnets, security groups, and instances

Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      EnableDnsSupport: true

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.1.0/24
      AvailabilityZone: !Select [0, !GetAZs '']

  PrivateSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.2.0/24
      AvailabilityZone: !Select [1, !GetAZs '']

  WebSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Allow HTTP
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0

  SSHSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Allow SSH
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 22
          ToPort: 22
          CidrIp: 0.0.0.0/0

  WebServer:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.micro
      ImageId: ami-0abcdef1234567890
      SubnetId: !Ref PublicSubnet
      SecurityGroupIds:
        - !Ref WebSecurityGroup
        - !Ref SSHSecurityGroup

  DatabaseServer:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.micro
      ImageId: ami-0abcdef1234567890
      SubnetId: !Ref PrivateSubnet
      SecurityGroupIds:
        - !Ref SSHSecurityGroup
`,

  'S3 + Lambda': `AWSTemplateFormatVersion: '2010-09-09'
Description: S3 bucket with a Lambda and IAM role

Resources:
  DataBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${AWS::StackName}-data'

  ProcessFunction:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs20.x
      Handler: index.handler
      Role: !GetAtt ProcessRole.Arn
      Code:
        ZipFile: |
          exports.handler = async () => ({ statusCode: 200 });
      Environment:
        Variables:
          BUCKET_NAME: !Ref DataBucket

  ProcessRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      Policies:
        - PolicyName: S3Read
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: [s3:GetObject]
                Resource: !Sub '\${DataBucket.Arn}/*'
`,

  'Nested Stack': `AWSTemplateFormatVersion: '2010-09-09'
Description: Parent stack referencing child stack outputs

Resources:
  NetworkStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://s3.amazonaws.com/example/network.yaml

  AppStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://s3.amazonaws.com/example/app.yaml
      Parameters:
        VpcId: !GetAtt NetworkStack.Outputs.VpcId

  LoggingBucket:
    Type: AWS::S3::Bucket
`,
};

export default function App() {
  const [yaml, setYaml] = useState(SAMPLES['VPC + EC2']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rawGraph, setRawGraph] = useState({ nodes: [], edges: [] });
  const [flags, setFlags] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [hideIam, setHideIam] = useState(false);
  const [cost, setCost] = useState(null);
  const [hypotheticalEdges, setHypotheticalEdges] = useState([]);
  const [dragHint, setDragHint] = useState('');
  const [deletedNodes, setDeletedNodes] = useState([]);
  const [sandboxToast, setSandboxToast] = useState(null);
  const [isFocusMode, setIsFocusMode] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    setSelectedId(null);
    try {
      const res = await fetch(`${API_URL}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: yaml }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setRawGraph({ nodes: data.nodes, edges: data.edges });
      setFlags(data.flags || []);
      setCost(data.cost || null);
      setHypotheticalEdges([]);
      setDeletedNodes([]);
      setDragHint('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function generateSummary() {
    if (rawGraph.nodes.length === 0) return;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary('');
    try {
      const res = await fetch(`${API_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: rawGraph.nodes.map((n) => ({ id: n.id, type: n.type })),
          flags: flags,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSummary(data.summary || '');
    } catch (err) {
      setSummaryError(err.message);
    } finally {
      setSummaryLoading(false);
    }
  }

  function handleConnect({ source, target }) {
    if (!source || !target || source === target) {
      setSandboxToast('Cannot connect a resource to itself');
      setTimeout(() => setSandboxToast(null), 2000);
      return;
    }
    const existsReal = rawGraph.edges.some((e) => e.source === source && e.target === target);
    const existsHypo = hypotheticalEdges.some((e) => e.source === source && e.target === target);
    if (existsReal || existsHypo) {
      setSandboxToast('That dependency already exists');
      setTimeout(() => setSandboxToast(null), 2000);
      return;
    }
    setHypotheticalEdges((prev) => [...prev, { source, target, hypothetical: true }]);
  }

  function handleConnectStart(params) {
    if (params?.nodeId) {
      const node = rawGraph.nodes.find((n) => n.id === params.nodeId);
      setDragHint(`From ${params.nodeId}${node ? ` (${node.type.split('::').pop()})` : ''}`);
    }
  }

  function handleConnectEnd() {
    setDragHint('');
  }

  useEffect(() => {
    if (selectedId && deletedNodes.includes(selectedId)) {
      setSelectedId(null);
    }
  }, [deletedNodes, selectedId]);

  useEffect(() => {
    if (!isFocusMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') setIsFocusMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFocusMode]);

  const filteredGraph = useMemo(() => {
    const activeNodes = rawGraph.nodes.filter((n) => !deletedNodes.includes(n.id));
    const activeNodeIds = new Set(activeNodes.map((n) => n.id));
    const mergedEdges = [...rawGraph.edges, ...hypotheticalEdges].filter(
      (e) => activeNodeIds.has(e.source) && activeNodeIds.has(e.target)
    );

    if (!hideIam) return { nodes: activeNodes, edges: mergedEdges };

    const isIam = (type) => typeof type === 'string' && type.startsWith('AWS::IAM::');
    const iamIds = new Set(activeNodes.filter((n) => isIam(n.type)).map((n) => n.id));
    return {
      nodes: activeNodes.filter((n) => !isIam(n.type)),
      edges: mergedEdges.filter((e) => !iamIds.has(e.source) && !iamIds.has(e.target)),
    };
  }, [rawGraph, hypotheticalEdges, hideIam, deletedNodes]);

  const layouted = useMemo(() => {
    if (filteredGraph.nodes.length === 0) return { nodes: [], edges: [] };
    return layoutGraph(filteredGraph.nodes, filteredGraph.edges);
  }, [filteredGraph]);

  const blast = useMemo(() => {
    if (!selectedId) return { direct: [], indirect: [], total: 0 };
    return computeBlastRadius(filteredGraph.edges, selectedId);
  }, [selectedId, filteredGraph.edges]);

  const outgoingDeps = useMemo(() => {
  if (!selectedId) return [];
  return filteredGraph.edges.filter((e) => e.source === selectedId);
}, [selectedId, filteredGraph.edges]);

  const flagsByResource = useMemo(() => {
    const m = new Map();
    for (const f of flags) {
      if (!m.has(f.resourceId)) m.set(f.resourceId, []);
      m.get(f.resourceId).push(f);
    }
    return m;
  }, [flags]);

  const decoratedNodes = useMemo(() => {
    return layouted.nodes.map((n) => ({
      ...n,
      data: { ...n.data, __hasFlag: flagsByResource.has(n.id) },
    }));
  }, [layouted.nodes, flagsByResource]);

  const selectedNode = selectedId ? rawGraph.nodes.find((n) => n.id === selectedId) : null;
  const selectedFlags = selectedId ? flagsByResource.get(selectedId) || [] : [];

  // Nobody else joins "how bad is this flag" with "how much does it touch" —
  // severity alone doesn't tell you which fix to prioritize first. Score =
  // severity weight + how many resources are downstream of the flagged one,
  // so a high-severity flag on a load-bearing resource always outranks the
  // same severity on an isolated one.
  const topRisks = useMemo(() => {
    if (flags.length === 0) return [];
    const severityWeight = { high: 2, medium: 1, low: 0 };
    return flags
      .map((f) => {
        const radius = computeBlastRadius(filteredGraph.edges, f.resourceId);
        return {
          ...f,
          blastTotal: radius.total,
          score: (severityWeight[f.severity] ?? 0) * 100 + radius.total,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [flags, filteredGraph.edges]);

  // Dollar exposure behind the current selection — "3 resources affected"
  // and "$41/mo affected" are different questions, and only one of them
  // gets a budget conversation started.
  const blastCost = useMemo(() => {
    if (!selectedId || !cost?.breakdown?.length) return null;
    const affectedIds = new Set([...blast.direct, ...blast.indirect]);
    const total = cost.breakdown
      .filter((b) => affectedIds.has(b.id))
      .reduce((sum, b) => sum + b.monthly, 0);
    return total > 0 ? total : null;
  }, [selectedId, blast, cost]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        // was height: '100vh'. A fixed height forced every status bar
        // (sandbox toast, cost panel, summary, drag hint, tip banner) to
        // eat into the canvas's share of the viewport, squeezing the
        // graph shorter and shorter until it felt cramped. minHeight lets
        // the page grow and scroll instead, while the canvas keeps its
        // own floor below.
        minHeight: '100vh',
        margin: 0,
        background: 'var(--bg-canvas, #0a0f1c)',
        color: 'var(--text-primary, #e2e8f0)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {sandboxToast && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            background: 'var(--bg-surface, #131a2b)',
            color: 'var(--text-primary, #e2e8f0)',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--border-hairline, #1f2a44)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 9999,
          }}
        >
          {sandboxToast}
        </div>
      )}

      {!isFocusMode && (
        <>
          <div
            style={{
              padding: '12px 16px',
              background: 'var(--bg-surface, #131a2b)',
              borderBottom: '1px solid var(--border-hairline, #1f2a44)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>
              IaC Visualizer
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary, #7a88a8)', marginTop: 2 }}>
              CloudFormation / SAM → dependency graph + misconfiguration flags
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--text-tertiary, #7a88a8)',
                  alignSelf: 'center',
                  marginRight: 4,
                }}
              >
                Load sample:
              </span>
              {Object.keys(SAMPLES).map((k) => (
                <button
                  key={k}
                  onClick={() => setYaml(SAMPLES[k])}
                  style={{
                    fontSize: 11,
                    padding: '3px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--border-hairline, #1f2a44)',
                    background: 'transparent',
                    color: 'var(--text-secondary, #b6c2d9)',
                    cursor: 'pointer',
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <TemplateInput value={yaml} onChange={setYaml} onSubmit={handleSubmit} loading={loading} />

          {rawGraph.nodes.length > 0 && (
            <div
              style={{
                padding: '10px 16px',
                background: 'var(--bg-surface, #131a2b)',
                borderBottom: '1px solid var(--border-hairline, #1f2a44)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <button
                onClick={generateSummary}
                disabled={summaryLoading}
                style={{
                  padding: '6px 14px',
                  background: summaryLoading ? '#4b5875' : 'var(--signal, #6366f1)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: summaryLoading ? 'wait' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {summaryLoading ? 'Analyzing...' : '✨ Generate AI Summary'}
              </button>

              <label
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary, #b6c2d9)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <input
                  type="checkbox"
                  checked={hideIam}
                  onChange={(e) => setHideIam(e.target.checked)}
                />
                Hide IAM resources
              </label>
            </div>
          )}

          {summaryError && (
            <div
              style={{
                padding: '8px 16px',
                fontSize: 12,
                color: '#fca5a5',
                background: 'rgba(185,28,28,0.15)',
                borderBottom: '1px solid rgba(185,28,28,0.3)',
              }}
            >
              {summaryError}
            </div>
          )}

          {summary && (
            <div
              style={{
                padding: '12px 16px',
                background: 'rgba(99,102,241,0.1)',
                borderBottom: '1px solid rgba(99,102,241,0.3)',
                fontSize: 13,
                color: 'var(--text-secondary, #b6c2d9)',
                lineHeight: 1.5,
              }}
            >
              {summary}
            </div>
          )}

          {(hypotheticalEdges.length > 0 || deletedNodes.length > 0) && (
            <div
              style={{
                padding: '6px 16px',
                background: 'rgba(217,119,6,0.12)',
                borderBottom: '1px solid rgba(217,119,6,0.3)',
                fontSize: 12,
                color: '#fbbf24',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>
                <strong>Sandbox mode:</strong>{' '}
                {hypotheticalEdges.length > 0 && (
                  <>
                    {hypotheticalEdges.length} hypothetical edge
                    {hypotheticalEdges.length > 1 ? 's' : ''} added
                  </>
                )}
                {hypotheticalEdges.length > 0 && deletedNodes.length > 0 && ' · '}
                {deletedNodes.length > 0 && (
                  <>
                    {deletedNodes.length} resource{deletedNodes.length > 1 ? 's' : ''} simulated deleted
                  </>
                )}
              </span>
              <button
                onClick={() => {
                  setHypotheticalEdges([]);
                  setDeletedNodes([]);
                }}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  border: '1px solid rgba(251,191,36,0.5)',
                  background: 'transparent',
                  color: '#fbbf24',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Reset sandbox
              </button>
            </div>
          )}

          {cost && cost.total > 0 && (
            <div
              style={{
                padding: '10px 16px',
                background: 'var(--bg-surface, #131a2b)',
                borderBottom: '1px solid var(--border-hairline, #1f2a44)',
                fontSize: 12,
                color: 'var(--text-secondary, #b6c2d9)',
              }}
            >
              <span style={{ fontWeight: 700 }}>Estimated cost:</span>{' '}
              <span style={{ fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>
                ~${cost.total.toFixed(2)}/month
              </span>
              <span style={{ color: 'var(--text-tertiary, #7a88a8)', marginLeft: 8 }}>
                (rough heuristic, not a bill)
              </span>
              {cost.unknownCount > 0 && (
                <span style={{ color: 'var(--text-tertiary, #7a88a8)', marginLeft: 8 }}>
                  · {cost.unknownCount} resource type{cost.unknownCount > 1 ? 's' : ''} not costed
                </span>
              )}
              {cost.breakdown.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      color: 'var(--text-secondary, #b6c2d9)',
                      fontSize: 11,
                    }}
                  >
                    Breakdown ({cost.breakdown.length} resource
                    {cost.breakdown.length > 1 ? 's' : ''})
                  </summary>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: 'var(--text-tertiary, #7a88a8)',
                      paddingLeft: 8,
                    }}
                  >
                    {cost.breakdown.map((b) => (
                      <div key={b.id}>
                        • <strong style={{ color: 'var(--text-secondary, #b6c2d9)' }}>{b.id}</strong>{' '}
                        ({b.type}): ~${b.monthly.toFixed(2)}/mo
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {error && (
            <div
              style={{
                padding: 12,
                background: 'rgba(185,28,28,0.15)',
                color: '#fca5a5',
                fontSize: 12,
                borderBottom: '1px solid rgba(185,28,28,0.3)',
              }}
            >
              {error}
            </div>
          )}

          {dragHint && (
            <div
              style={{
                padding: '6px 16px',
                background: 'rgba(217,119,6,0.15)',
                borderBottom: '1px solid rgba(217,119,6,0.4)',
                fontSize: 12,
                color: '#fbbf24',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>🔗</span>
              <span>
                <strong>{dragHint}</strong> — release on another resource to add a hypothetical edge
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#fcd34d' }}>
                Meaning: "source depends on target" → target changes affect source
              </span>
            </div>
          )}

          {topRisks.length > 0 && (
            <div
              style={{
                padding: '10px 16px',
                background: 'rgba(239,68,68,0.08)',
                borderBottom: '1px solid rgba(239,68,68,0.25)',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--text-primary, #e2e8f0)', marginBottom: 6 }}>
                🔥 Highest-impact issues
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {topRisks.map((r, i) => (
                  <button
                    key={`${r.resourceId}-${r.ruleId}-${i}`}
                    onClick={() => setSelectedId(r.resourceId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      padding: '3px 0',
                      cursor: 'pointer',
                      color: 'var(--text-secondary, #b6c2d9)',
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: r.severity === 'high' ? 'rgba(239,68,68,0.2)' : 'rgba(217,119,6,0.2)',
                        color: r.severity === 'high' ? '#fca5a5' : '#fbbf24',
                        flexShrink: 0,
                      }}
                    >
                      {r.severity.toUpperCase()}
                    </span>
                    <strong style={{ color: 'var(--text-primary, #e2e8f0)' }}>{r.resourceId}</strong>
                    <span style={{ color: 'var(--text-tertiary, #7a88a8)' }}>
                      — {r.blastTotal} resource{r.blastTotal !== 1 ? 's' : ''} downstream
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {rawGraph.nodes.length > 0 &&
            hypotheticalEdges.length === 0 &&
            deletedNodes.length === 0 && (
              <div
                style={{
                  padding: '6px 16px',
                  background: 'rgba(56,189,248,0.1)',
                  borderBottom: '1px solid rgba(56,189,248,0.25)',
                  fontSize: 11,
                  color: '#7dd3fc',
                }}
              >
                💡 <strong>Tip:</strong> Drag from the right dot of one resource to the left dot of
                another to simulate a new dependency. The blast radius updates live.
              </div>
            )}
        </>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          style={
            isFocusMode
              ? {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 50,
                  background: 'var(--bg-canvas, #0a0f1c)',
                }
              : {
                  flex: 1,
                  // Real floor instead of "whatever's left after the status
                  // bars above". Previously flex:1 inside a fixed 100vh
                  // shell meant the canvas could get squeezed down to a
                  // sliver when several banners stacked up at once.
                  minHeight: 640,
                }
          }
        >
          {decoratedNodes.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: 'center',
                color: 'var(--text-tertiary, #7a88a8)',
                fontSize: 13,
              }}
            >
              Paste a template and click Visualize to see the diagram.
            </div>
          ) : (
            <FlowDiagram
              nodes={decoratedNodes}
              edges={layouted.edges}
              selectedId={selectedId}
              directIds={blast.direct}
              indirectIds={blast.indirect}
              onNodeClick={setSelectedId}
              onConnect={handleConnect}
              onConnectStart={handleConnectStart}
              onConnectEnd={handleConnectEnd}
              isFocusMode={isFocusMode}
              onToggleFocus={() => setIsFocusMode((f) => !f)}
            />
          )}
        </div>

        {!isFocusMode && selectedNode && (
          <div
            style={{
              width: 340,
              borderLeft: '1px solid var(--border-hairline, #1f2a44)',
              background: 'var(--bg-surface, #131a2b)',
              padding: 16,
              overflowY: 'auto',
              fontSize: 12,
              color: 'var(--text-primary, #e2e8f0)',
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>
              {selectedNode.id}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary, #7a88a8)', marginTop: 2 }}>
              {selectedNode.type}
            </div>
            {outgoingDeps.length > 0 && (
  <div style={{ marginTop: 16 }}>
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--text-primary, #e2e8f0)',
        marginBottom: 6,
      }}
    >
      REFERENCES
    </div>
    <div
      style={{
        background: 'var(--bg-canvas, #0a0f1c)',
        padding: 10,
        borderRadius: 6,
        border: '1px solid var(--border-hairline, #1f2a44)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-tertiary, #7a88a8)',
          marginBottom: 6,
        }}
      >
        {outgoingDeps.length} resource{outgoingDeps.length !== 1 ? 's' : ''} this depends on
      </div>
      {outgoingDeps.map((e) => (
        <div key={e.target} style={{ marginBottom: 3, fontSize: 11 }}>
          <button
            onClick={() => setSelectedId(e.target)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--text-secondary, #b6c2d9)',
              fontFamily: 'inherit',
              fontSize: 11,
              textDecoration: 'underline',
              textDecorationStyle: 'dotted',
              textUnderlineOffset: 3,
            }}
          >
            {e.target}
          </button>
          {e.path && (
            <span style={{ color: 'var(--text-tertiary, #7a88a8)', marginLeft: 8 }}>
              — <code style={{ fontSize: 9 }}>{e.path}</code>
            </span>
          )}
        </div>
      ))}
    </div>
  </div>
)}

            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text-primary, #e2e8f0)',
                  marginBottom: 6,
                }}
              >
                BLAST RADIUS
              </div>
              <div
                style={{
                  background: 'var(--bg-canvas, #0a0f1c)',
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid var(--border-hairline, #1f2a44)',
                }}
              >
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #e2e8f0)' }}>
                  {blast.total}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary, #7a88a8)' }}>
                  resources affected if this changes
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary, #b6c2d9)' }}>
                  <div>
                    <strong>{blast.direct.length}</strong> direct
                  </div>
                  <div>
                    <strong>{blast.indirect.length}</strong> indirect
                  </div>
                  {blastCost !== null && (
                    <div style={{ marginTop: 4, color: '#fbbf24' }}>
                      <strong>~${blastCost.toFixed(2)}/mo</strong> across affected resources
                    </div>
                  )}
                </div>
                {blast.direct.length > 0 && (
  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-tertiary, #7a88a8)' }}>
    <div style={{ fontWeight: 600, marginBottom: 3 }}>Direct:</div>
    {blast.direct.map((id) => {
      const edge = filteredGraph.edges.find(
        (e) => e.source === id && e.target === selectedId
      );
      return (
        <div key={id} style={{ marginLeft: 8, marginBottom: 2 }}>
          <span style={{ color: 'var(--text-secondary, #b6c2d9)' }}>{id}</span>
          {edge?.path && (
  <span style={{ color: 'var(--text-tertiary, #7a88a8)', marginLeft: 8 }}>
    {' — '}
    <code style={{ fontSize: 9 }}>{edge.path}</code>
  </span>
)}
        </div>
      );
    })}
  </div>
)}
                {blast.indirect.length > 0 && (
  <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-tertiary, #7a88a8)' }}>
    <div style={{ fontWeight: 600, marginBottom: 3 }}>Indirect:</div>
    {blast.indirect.map((id) => {
      // Find an edge from an immediate dependent to this node
      const via = filteredGraph.edges.find(
        (e) => e.target === id &&
          (blast.direct.includes(e.source) || selectedId === e.source)
      );
      return (
        <div key={id} style={{ marginLeft: 8, marginBottom: 2 }}>
          <span style={{ color: 'var(--text-secondary, #b6c2d9)' }}>{id}</span>
          {via && (
            <span style={{ color: 'var(--text-tertiary, #7a88a8)', marginLeft: 8 }}>
              {' — via '}
              <code style={{ fontSize: 9 }}>{via.source}</code>
            </span>
          )}
        </div>
      );
    })}
  </div>
)} 
                {(hypotheticalEdges.length > 0 || deletedNodes.length > 0) && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: 6,
                      background: 'rgba(217,119,6,0.15)',
                      borderRadius: 4,
                      fontSize: 10,
                      color: '#fbbf24',
                    }}
                  >
                    Includes sandbox modifications
                    {hypotheticalEdges.length > 0 &&
                      ` · ${hypotheticalEdges.length} hypothetical edge${
                        hypotheticalEdges.length > 1 ? 's' : ''
                      }`}
                    {deletedNodes.length > 0 &&
                      ` · ${deletedNodes.length} simulated deletion${
                        deletedNodes.length > 1 ? 's' : ''
                      }`}
                  </div>
                )}
              </div>
            </div>

            {selectedFlags.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-primary, #e2e8f0)',
                    marginBottom: 6,
                  }}
                >
                  FLAGS
                </div>
                {selectedFlags.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      background: f.severity === 'high' ? 'rgba(239,68,68,0.12)' : 'rgba(217,119,6,0.12)',
                      border: `1px solid ${
                        f.severity === 'high' ? 'rgba(239,68,68,0.4)' : 'rgba(217,119,6,0.4)'
                      }`,
                      borderRadius: 6,
                      padding: 10,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: f.severity === 'high' ? '#fca5a5' : '#fbbf24',
                      }}
                    >
                      {f.severity.toUpperCase()} — {f.ruleId}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-secondary, #b6c2d9)',
                        marginTop: 4,
                      }}
                    >
                      {f.message}
                    </div>
                    {(() => {
                      const { why, docUrl } = explainFlag(f);
                      return (
                        <div
                          style={{
                            marginTop: 6,
                            paddingTop: 6,
                            borderTop: '1px solid rgba(255,255,255,0.08)',
                            fontSize: 10.5,
                            color: 'var(--text-tertiary, #7a88a8)',
                            lineHeight: 1.5,
                          }}
                        >
                          <strong style={{ color: 'var(--text-secondary, #b6c2d9)' }}>Why this matters: </strong>
                          {why}{' '}
                          <a
                            href={docUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--signal, #6366f1)' }}
                          >
                            Learn more →
                          </a>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text-primary, #e2e8f0)',
                  marginBottom: 6,
                }}
              >
                PROPERTIES
              </div>
              <pre
                style={{
                  background: 'var(--bg-canvas, #0a0f1c)',
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid var(--border-hairline, #1f2a44)',
                  fontSize: 10,
                  overflowX: 'auto',
                  margin: 0,
                  color: 'var(--text-secondary, #b6c2d9)',
                  maxHeight: 300,
                }}
              >
                {JSON.stringify(selectedNode.properties, null, 2)}
              </pre>
            </div>

            <div
              style={{
                marginTop: 16,
                paddingTop: 16,
                borderTop: '1px solid var(--border-hairline, #1f2a44)',
              }}
            >
              <button
                onClick={() => {
                  if (!selectedId) return;
                  setDeletedNodes((prev) =>
                    prev.includes(selectedId) ? prev : [...prev, selectedId]
                  );
                }}
                style={{
                  width: '100%',
                  padding: '6px 12px',
                  background: 'rgba(239,68,68,0.12)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239,68,68,0.4)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Simulate delete this resource
              </button>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-tertiary, #7a88a8)',
                  marginTop: 6,
                  textAlign: 'center', 
                }}
              >
                Shows what would break. Template unchanged.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}