import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Sparkles, X, MousePointerClick, TriangleAlert, Flame } from 'lucide-react';

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

// First property key=value pair, used by the diagram's deepest zoom level.
function firstPropertyPair(properties) {
  if (!properties || typeof properties !== 'object') return null;
  const key = Object.keys(properties)[0];
  if (!key) return null;
  const value = properties[key];
  if (value === null || value === undefined) return null;
  const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `${key}: ${rendered.length > 28 ? `${rendered.slice(0, 28)}…` : rendered}`;
}

const RESOURCE_DESCRIPTIONS = {
  'AWS::S3::Bucket': 'Object storage with a globally unique name. ~$0.023/GB/month.',
  'AWS::Lambda::Function': 'Serverless compute. Runs on demand, billed per invocation.',
  'AWS::EC2::SecurityGroup': 'Instance-level firewall controlling inbound and outbound traffic.',
  'AWS::EC2::VPC': 'Isolated virtual network where AWS resources run.',
  'AWS::EC2::Subnet': 'A network segment inside a VPC with its own routing boundary.',
  'AWS::EC2::Instance': 'Virtual server with configurable compute, memory, and storage.',
  'AWS::IAM::Role': 'Identity with permissions that AWS services or users can assume.',
  'AWS::IAM::User': 'An IAM identity for a person or application.',
  'AWS::IAM::Policy': 'A document defining allowed or denied AWS actions and resources.',
  'AWS::RDS::DBInstance': 'Managed relational database instance with automated operations.',
  'AWS::EC2::Volume': 'Persistent block storage volume attached to compute resources.',
  'AWS::SQS::Queue': 'Durable message queue that decouples producers from consumers.',
  'AWS::SNS::Topic': 'Pub/sub notification channel that fans messages out to subscribers.',
  'AWS::DynamoDB::Table': 'Managed NoSQL table with single-digit millisecond performance.',
  'AWS::CloudFormation::Stack': 'Nested infrastructure stack managed as one CloudFormation resource.',
  'AWS::Serverless::Function': 'SAM shorthand for a deployable serverless function.',
  'AWS::Serverless::SimpleTable': 'SAM shorthand for a simple DynamoDB table.',
};

export default function App() {
  const [yaml, setYaml] = useState(SAMPLES['VPC + EC2']);
  const [loading, setLoading] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(true);
  const [error, setError] = useState(null);
  const [rawGraph, setRawGraph] = useState({ nodes: [], edges: [] });
  const [flags, setFlags] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [hideIam, setHideIam] = useState(false);
  const [cost, setCost] = useState(null);
  const [hypotheticalEdges, setHypotheticalEdges] = useState([]);
  const [dragHint, setDragHint] = useState('');
  const [deletedNodes, setDeletedNodes] = useState([]);
  const [sandboxToast, setSandboxToast] = useState(null);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [costExpanded, setCostExpanded] = useState(false);
  const [risksExpanded, setRisksExpanded] = useState(false);
  const [lastParsedYaml, setLastParsedYaml] = useState(null);
  const [sampleName, setSampleName] = useState('VPC + EC2');

  // AI Assistant conversation — one source of truth for summary + Q&A.
  const [aiMessages, setAiMessages] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [showCleared, setShowCleared] = useState(false);

  const hasParsedRef = useRef(false);
  const railRef = useRef(null);
  const aiScrollRef = useRef(null);

  const hasGraph = rawGraph.nodes.length > 0;
  const hasAssistant = aiMessages.some((m) => m.role === 'assistant');
  const unchanged = lastParsedYaml !== null && yaml === lastParsedYaml;

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
      if (!res.ok) {
        const parseError = new Error(data.error || `HTTP ${res.status}`);
        parseError.context = data.context;
        throw parseError;
      }
      setRawGraph({ nodes: data.nodes, edges: data.edges });
      setFlags(data.flags || []);
      setCost(data.cost || null);
      setHypotheticalEdges([]);
      setDeletedNodes([]);
      setDragHint('');
      setLastParsedYaml(yaml);
      // Collapse the input only on the very first successful parse.
      if (!hasParsedRef.current) {
        hasParsedRef.current = true;
        setInputExpanded(false);
      }
      // New parse resets the conversation thread.
      setAiMessages([]);
      setShowCleared(true);
      setTimeout(() => setShowCleared(false), 2000);
    } catch (err) {
      setError({ message: err.message, context: err.context });
    } finally {
      setLoading(false);
    }
  }

  async function generateSummary() {
    if (!hasGraph) return;
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: 'system', text: 'Generating summary…' }]);
    try {
      const res = await fetch(`${API_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: rawGraph.nodes.map((n) => ({ id: n.id, type: n.type })),
          flags,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAiMessages((prev) => [
        ...prev,
        { role: 'assistant', text: data.summary || 'No summary generated.' },
      ]);
    } catch (err) {
      setAiMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `Summary unavailable: ${err.message}` },
      ]);
    } finally {
      setAiLoading(false);
    }
  }

  async function askQuestion() {
    const question = aiInput.trim();
    if (!question || !hasGraph || aiLoading) return;
    setAiMessages((prev) => [...prev, { role: 'user', text: question }]);
    setAiInput('');
    setAiLoading(true);
    try {
      const res = await fetch(`${API_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          nodes: rawGraph.nodes.map((n) => ({ id: n.id, type: n.type })),
          edges: rawGraph.edges,
          flags,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAiMessages((prev) => [
        ...prev,
        { role: 'assistant', text: data.answer || 'No answer generated.' },
      ]);
    } catch (err) {
      setAiMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `Couldn't answer that: ${err.message}` },
      ]);
    } finally {
      setAiLoading(false);
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
    if (params?.nodeId) setDragHint(params.nodeId);
  }

  function handleConnectEnd() {
    setDragHint('');
  }

  useEffect(() => {
    if (selectedId && deletedNodes.includes(selectedId)) {
      setSelectedId(null);
    }
  }, [deletedNodes, selectedId]);

  // Global Escape: cancel drag, exit focus mode. Input collapse is handled
  // locally by TemplateInput while its textarea has focus.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (isFocusMode) {
        setIsFocusMode(false);
        return;
      }
      if (dragHint) setDragHint('');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFocusMode, dragHint]);

  // Keep the AI thread pinned to the newest message.
  useEffect(() => {
    if (aiScrollRef.current) {
      aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
    }
  }, [aiMessages, aiLoading]);

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
    if (!selectedId) return { direct: [], indirect: [], total: 0, depthById: {} };
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
      data: {
        ...n.data,
        __hasFlag: flagsByResource.has(n.id),
        __flagCount: (flagsByResource.get(n.id) || []).length,
        __firstProp: firstPropertyPair(n.properties),
      },
      style: blast.depthById[n.id]
        ? { ...n.style, '--hop-depth': blast.depthById[n.id] }
        : n.style,
    }));
  }, [layouted.nodes, flagsByResource, blast.depthById]);

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

  const sandboxActive = hypotheticalEdges.length > 0 || deletedNodes.length > 0;
  const errorMessage = typeof error === 'string' ? error : error?.message;
  const lastAssistant = [...aiMessages].reverse().find((m) => m.role === 'assistant');

  // Zone 4 priority: error > drag > sandbox > summary > tip.
  const statusKind = errorMessage
    ? 'error'
    : dragHint
      ? 'drag'
      : sandboxActive
        ? 'sandbox'
        : lastAssistant
          ? 'summary'
          : hasGraph
            ? 'tip'
            : null;

  const statusMessage = {
    error: errorMessage,
    drag: `From ${dragHint} — release on another resource to add a hypothetical edge`,
    sandbox: sandboxToast
      ? sandboxToast
      : `Sandbox: ${hypotheticalEdges.length} hypothetical edge${
          hypotheticalEdges.length === 1 ? '' : 's'
        } · ${deletedNodes.length} simulated deletion${deletedNodes.length === 1 ? '' : 's'}`,
    summary: lastAssistant?.text || '',
    tip: 'Tip: Drag from the right dot of one resource to the left dot of another to simulate a new dependency.',
  }[statusKind];

  const statusExpandable =
    statusKind === 'error'
      ? Boolean(errorMessage && errorMessage.length > 120) || Boolean(error?.context)
      : false;

  const visualizeDisabled = loading || !yaml.trim() || (!inputExpanded && unchanged);
  const visualizeTitle =
    !inputExpanded && unchanged && !loading ? 'No template changes' : undefined;

  const blastPct =
    filteredGraph.nodes.length > 0
      ? Math.round((blast.total / filteredGraph.nodes.length) * 100)
      : 0;
  const flaggedInBlast = selectedId
    ? [...blast.direct, ...blast.indirect].filter((id) => flagsByResource.has(id)).length
    : 0;

  function scrollRailIntoView() {
    railRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return (
    <div className="iac-app">
      {!isFocusMode && (
        <>
          {/* ---------- Zone 1: header ---------- */}
          <header className="iac-header">
            <div className="iac-header-left">
              <div className="iac-header-title">IaC Visualizer</div>
              <div className="iac-header-sub">
                CloudFormation / SAM → dependency graph + misconfiguration flags
              </div>
            </div>
            <div className="iac-header-right">
              <span className="iac-samples-label">Load sample:</span>
              {Object.keys(SAMPLES).map((k) => (
                <button
                  key={k}
                  className="iac-chip"
                  onClick={() => {
                    setYaml(SAMPLES[k]);
                    setSampleName(k);
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
          </header>

          {/* ---------- Zone 2: input ---------- */}
          <TemplateInput
            value={yaml}
            onChange={setYaml}
            expanded={inputExpanded}
            onExpand={() => setInputExpanded(true)}
            onCollapse={() => setInputExpanded(false)}
            fileName={sampleName ? `${sampleName}.yaml` : 'template.yaml'}
            showSubmitButton={!hasGraph}
            onSubmit={handleSubmit}
            loading={loading}
            hasGraph={hasGraph}
          />

          {/* ---------- Zone 3: action bar ---------- */}
          {hasGraph && (
            <div className="iac-actionbar">
              <button
                type="button"
                className="iac-btn iac-btn--primary"
                onClick={handleSubmit}
                disabled={visualizeDisabled}
                title={visualizeTitle}
              >
                {loading ? (
                  <>
                    <span className="iac-spinner" aria-hidden="true" />
                    Parsing…
                  </>
                ) : (
                  'Visualize'
                )}
              </button>

              <button
                type="button"
                className="iac-btn iac-btn--ai"
                onClick={generateSummary}
                disabled={!hasGraph || aiLoading}
              >
                ✨ Generate AI Summary
              </button>

              <div className="iac-actionbar-spacer" />

              <label className="iac-toggle">
                <input
                  type="checkbox"
                  checked={hideIam}
                  onChange={(e) => setHideIam(e.target.checked)}
                />
                Hide IAM resources
              </label>
            </div>
          )}

          {/* ---------- Zone 4: status strip ---------- */}
          {statusKind && (
            <div className={`iac-status iac-status--${statusKind === 'drag' || statusKind === 'sandbox' ? 'warn' : statusKind}`}>
              {statusKind === 'error' && <TriangleAlert size={13} aria-hidden="true" />}
              <span className="iac-status-text" title={statusMessage}>
                {statusMessage}
              </span>
              {statusKind === 'error' && statusExpandable && (
                <button
                  type="button"
                  className="iac-status-action"
                  onClick={() => setErrorExpanded((v) => !v)}
                >
                  {errorExpanded ? '▲' : '▼'}
                </button>
              )}
              {statusKind === 'sandbox' && (
                <button
                  type="button"
                  className="iac-status-action"
                  onClick={() => {
                    setHypotheticalEdges([]);
                    setDeletedNodes([]);
                  }}
                >
                  Reset
                </button>
              )}
              {statusKind === 'summary' && (
                <button type="button" className="iac-status-action" onClick={scrollRailIntoView}>
                  View in chat
                </button>
              )}
            </div>
          )}

          {statusKind === 'error' && errorExpanded && error?.context && (
            <div className="iac-status-error-detail">
              Line {error.context.line}, column {error.context.column}
              {'\n'}
              {error.context.snippet}
              {'\n'}
              {error.context.pointer}
            </div>
          )}

          {/* ---------- cost + top risks, side by side (40px) ---------- */}
          {hasGraph && (cost?.total > 0 || topRisks.length > 0) && (
            <>
              <div className="iac-lower-row">
                {cost?.total > 0 ? (
                  <button
                    type="button"
                    className="iac-lower-half"
                    onClick={() => setCostExpanded((v) => !v)}
                  >
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>
                        ~${cost.total.toFixed(2)}/mo
                      </strong>
                      {cost.unknownCount > 0 && (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {' '}
                          · {cost.unknownCount} not costed
                        </span>
                      )}
                    </span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      breakdown {costExpanded ? '▲' : '▼'}
                    </span>
                  </button>
                ) : (
                  <div className="iac-lower-half" />
                )}

                {topRisks.length > 0 ? (
                  <button
                    type="button"
                    className="iac-lower-half"
                    onClick={() => setRisksExpanded((v) => !v)}
                  >
                    <span>
                      🔥 <strong style={{ color: 'var(--text-primary)' }}>{topRisks.length}</strong>{' '}
                      highest-impact issue{topRisks.length === 1 ? '' : 's'}
                    </span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {risksExpanded ? '▲' : '▼'}
                    </span>
                  </button>
                ) : (
                  <div className="iac-lower-half" />
                )}
              </div>

              {costExpanded && cost?.breakdown?.length > 0 && (
                <div className="iac-lower-expanded">
                  {cost.breakdown.map((b) => (
                    <div key={b.id}>
                      • <strong style={{ color: 'var(--text-secondary)' }}>{b.id}</strong> ({b.type}
                      ): ~${b.monthly.toFixed(2)}/mo
                    </div>
                  ))}
                </div>
              )}

              {risksExpanded && topRisks.length > 0 && (
                <div className="iac-lower-expanded">
                  {topRisks.map((r, i) => (
                    <button
                      key={`${r.resourceId}-${r.ruleId}-${i}`}
                      onClick={() => setSelectedId(r.resourceId)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        padding: '3px 0',
                        cursor: 'pointer',
                        color: 'var(--text-secondary)',
                        fontSize: 11,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background:
                            r.severity === 'high'
                              ? 'rgba(239,68,68,0.2)'
                              : 'rgba(217,119,6,0.2)',
                          color: r.severity === 'high' ? '#fca5a5' : '#fbbf24',
                          flexShrink: 0,
                        }}
                      >
                        {r.severity.toUpperCase()}
                      </span>
                      <strong style={{ color: 'var(--text-primary)' }}>{r.resourceId}</strong>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        — {r.blastTotal} resource{r.blastTotal !== 1 ? 's' : ''} downstream
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ---------- Zone 6 (diagram) + Zone 5 (right rail) ---------- */}
      <div className="iac-main">
        <div className={isFocusMode ? 'iac-focus' : 'iac-canvas'}>
          {decoratedNodes.length === 0 ? (
            <div className="iac-empty">Paste a template and click Visualize to see the diagram.</div>
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

        {!isFocusMode && (
          <aside className="iac-rail" ref={railRef}>
            {/* ---------- AI Assistant ---------- */}
            <section className="iac-rail-panel iac-rail-panel--ai">
              <div className="iac-panel-head">
                <span className="iac-panel-head-left">
                  <Sparkles size={13} aria-hidden="true" />
                  AI Assistant
                </span>
                {aiMessages.length > 0 && (
                  <button
                    type="button"
                    className="iac-panel-head-action"
                    onClick={() => setAiMessages([])}
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="iac-ai-scroll" ref={aiScrollRef}>
                {aiMessages.length === 0 && !showCleared ? (
                  <div className="iac-ai-empty">
                    <Sparkles size={22} aria-hidden="true" />
                    <div className="iac-ai-empty-title">Ask about this template</div>
                    <div className="iac-ai-empty-body">
                      Generate a summary or ask a question about the graph. Answers are grounded in
                      the parsed template — no invented resources.
                    </div>
                  </div>
                ) : (
                  <>
                    {showCleared && <div className="iac-ai-system">Conversation cleared</div>}
                    {aiMessages.map((m, i) =>
                      m.role === 'system' ? (
                        <div key={i} className="iac-ai-system">
                          {m.text}
                        </div>
                      ) : m.role === 'user' ? (
                        <div key={i} className="iac-ai-user">
                          {m.text}
                        </div>
                      ) : (
                        <div key={i} className="iac-ai-assistant">
                          {m.text}
                        </div>
                      )
                    )}
                    {aiLoading && <div className="iac-ai-system">Thinking…</div>}
                  </>
                )}
              </div>

              <div className="iac-ai-input">
                {!hasGraph ? (
                  <input type="text" placeholder="Load a template first" disabled />
                ) : !hasAssistant ? (
                  <button
                    type="button"
                    style={{ width: '100%' }}
                    onClick={generateSummary}
                    disabled={aiLoading}
                  >
                    ✨ Generate Summary
                  </button>
                ) : (
                  <>
                    <input
                      type="text"
                      value={aiInput}
                      onChange={(e) => setAiInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') askQuestion();
                      }}
                      placeholder="Ask a question…"
                      disabled={aiLoading}
                    />
                    <button type="button" onClick={askQuestion} disabled={!aiInput.trim() || aiLoading}>
                      Ask
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* ---------- Inspector ---------- */}
            <section className="iac-rail-panel iac-rail-panel--inspector">
              <div className="iac-panel-head">
                <span className="iac-panel-head-left">
                  {selectedNode ? (
                    <>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{selectedNode.id}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 400 }}>
                        {selectedNode.type}
                      </span>
                    </>
                  ) : (
                    'Inspector'
                  )}
                </span>
                {selectedNode && (
                  <button
                    type="button"
                    className="iac-panel-head-action"
                    onClick={() => setSelectedId(null)}
                    aria-label="Close inspector"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              {!selectedNode ? (
                <div className="iac-inspector-empty">
                  <MousePointerClick size={20} aria-hidden="true" />
                  <div>Click any resource in the diagram to inspect it</div>
                </div>
              ) : (
                <>
                  <div className="iac-inspector-scroll">
                    {/* Blast radius headline */}
                    <div className="iac-inspector-section">
                      <div className="iac-blast-total">
                        <span className="iac-blast-count">{blastPct}%</span>
                        <span className="iac-blast-caption">of infrastructure affected</span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                        {blast.total} of {filteredGraph.nodes.length} resources ·{' '}
                        {blast.direct.length} direct, {blast.indirect.length} indirect
                      </div>
                      {blastCost !== null && (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24' }}>
                          <strong>~${blastCost.toFixed(2)}/mo</strong> across affected resources
                        </div>
                      )}
                      {flaggedInBlast > 0 && (
                        <div className="iac-flag-pill">
                          <Flame size={10} aria-hidden="true" />
                          {flaggedInBlast} resource{flaggedInBlast === 1 ? '' : 's'} in this blast
                          radius have unresolved flags
                        </div>
                      )}
                    </div>

                    {/* References */}
                    {outgoingDeps.length > 0 && (
                      <div className="iac-inspector-section">
                        <div className="iac-inspector-label">REFERENCES</div>
                        {outgoingDeps.map((e) => (
                          <div key={e.target} className="iac-ref-row">
                            <button
                              type="button"
                              className="iac-ref-link"
                              onClick={() => setSelectedId(e.target)}
                            >
                              {e.target}
                            </button>
                            <span className="iac-ref-path">
                              — {e.path || e.relationship || 'references'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Flags */}
                    {selectedFlags.length > 0 && (
                      <div className="iac-inspector-section">
                        <div className="iac-inspector-label">FLAGS</div>
                        {selectedFlags.map((f, i) => {
                          const { why, docUrl } = explainFlag(f);
                          return (
                            <div
                              key={i}
                              className={`iac-flag-card iac-flag-card--${
                                f.severity === 'high' ? 'high' : 'medium'
                              }`}
                            >
                              <div
                                className={`iac-flag-meta iac-flag-meta--${
                                  f.severity === 'high' ? 'high' : 'medium'
                                }`}
                              >
                                {f.severity.toUpperCase()} — {f.ruleId}
                              </div>
                              <div className="iac-flag-msg">{f.message}</div>
                              <div className="iac-flag-why">
                                <strong style={{ color: 'var(--text-secondary)' }}>
                                  Why this matters:{' '}
                                </strong>
                                {why}{' '}
                                <a
                                  href={docUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ color: 'var(--signal)' }}
                                >
                                  Learn more →
                                </a>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Properties */}
                    <div className="iac-inspector-section">
                      <div className="iac-inspector-label">PROPERTIES</div>
                      {RESOURCE_DESCRIPTIONS[selectedNode.type] && (
                        <div
                          style={{
                            marginBottom: 8,
                            fontSize: 10.5,
                            lineHeight: 1.4,
                            color: 'var(--text-secondary)',
                            fontStyle: 'italic',
                          }}
                        >
                          {RESOURCE_DESCRIPTIONS[selectedNode.type]}
                        </div>
                      )}
                      <details className="iac-inspector-properties">
                        <summary
                          style={{
                            cursor: 'pointer',
                            fontSize: 10,
                            color: 'var(--text-tertiary)',
                          }}
                        >
                          Raw properties
                        </summary>
                        <pre>{JSON.stringify(selectedNode.properties, null, 2)}</pre>
                      </details>
                    </div>
                  </div>

                  {/* Sticky bottom */}
                  <div className="iac-inspector-footer">
                    <button
                      type="button"
                      className="iac-btn iac-btn--danger"
                      onClick={() => {
                        if (!selectedId) return;
                        setDeletedNodes((prev) =>
                          prev.includes(selectedId) ? prev : [...prev, selectedId]
                        );
                      }}
                    >
                      Simulate delete this resource
                    </button>
                  </div>
                </>
              )}
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}