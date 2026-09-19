import { useEffect, useMemo, useRef, useState } from 'react';
// This was missing entirely — iac-visualizer.css defines every .iac-node,
// .iac-focus-btn, .iac-console, etc. class the app relies on, but nothing
// was importing it, so none of that styling (including node borders and
// backgrounds) ever reached the page.
import './styles/iac-visualizer.css';
// Two-page layout, left insights sidebar and the more readable right rail.
// Imported AFTER the base stylesheet so its rules win.
import './styles/iac-pages.css';
import TemplateInput from './components/TemplateInput.jsx';
import FlowDiagram from './components/FlowDiagram.jsx';
import { layoutGraph } from './lib/layout.js';
import { computeBlastRadius } from './lib/blastRadius.js';
import { explainFlag } from './lib/ruleExplanations.js';
import {
  Sparkles,
  X,
  MousePointerClick,
  TriangleAlert,
  Flame,
  ArrowDown,
  ArrowUp,
  Coins,
  ShieldAlert,
  SlidersHorizontal,
  Lightbulb,
  Network,
  ChevronDown,
  ChevronUp,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';

const API_URL =
  import.meta.env.VITE_API_URL || 'https://j04hh0pkgd.execute-api.us-east-1.amazonaws.com';

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

// One-line explanations shown on the sample cards on the landing page.
const SAMPLE_BLURBS = {
  'VPC + EC2': 'A network with public and private subnets, two security groups and two servers.',
  'S3 + Lambda': 'A storage bucket, a serverless function and the IAM role that connects them.',
  'Nested Stack': 'A parent stack that pulls in child stacks and passes outputs between them.',
};

// What you get after clicking Visualize — shown at the bottom of the landing page.
const FEATURES = [
  {
    icon: Network,
    title: 'Dependency graph',
    body: 'Every reference between resources becomes a link, so you can see how things really connect.',
  },
  {
    icon: ShieldAlert,
    title: 'Misconfiguration flags',
    body: 'Catch risky settings such as open ports or broad permissions before they reach production.',
  },
  {
    icon: Flame,
    title: 'Blast radius and cost',
    body: 'Select a resource to see everything that depends on it and how much of your bill sits behind it.',
  },
  {
    icon: Sparkles,
    title: 'AI summary',
    body: 'Get a plain-English summary of what your template builds and what deserves a second look.',
  },
];

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
  'AWS::CloudFormation::Stack':
    'Nested infrastructure stack managed as one CloudFormation resource.',
  'AWS::Serverless::Function': 'SAM shorthand for a deployable serverless function.',
  'AWS::Serverless::SimpleTable': 'SAM shorthand for a simple DynamoDB table.',
};

export default function App() {
  const [yaml, setYaml] = useState(SAMPLES['VPC + EC2']);
  const [loading, setLoading] = useState(false);
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

  // AI summary messages (summary text plus loading and error notes).
  const [aiMessages, setAiMessages] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [showCleared, setShowCleared] = useState(false);
  const [aiCollapsed, setAiCollapsed] = useState(false);

  // Sidebar visibility. The normal view and the full-screen diagram each keep
  // their own state: in full screen the sidebars start closed and float over
  // the diagram as drawers, so they stay reachable while zoomed in.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [focusLeftOpen, setFocusLeftOpen] = useState(false);
  const [focusRightOpen, setFocusRightOpen] = useState(false);

  const aiPanelRef = useRef(null);
  const aiScrollRef = useRef(null);
  const landingRef = useRef(null);
  const vizRef = useRef(null);

  const hasGraph = rawGraph.nodes.length > 0;
  const unchanged = lastParsedYaml !== null && yaml === lastParsedYaml;

  const leftShown = isFocusMode ? focusLeftOpen : leftOpen;
  const rightShown = isFocusMode ? focusRightOpen : rightOpen;

  function toggleLeft() {
    if (isFocusMode) setFocusLeftOpen((v) => !v);
    else setLeftOpen((v) => !v);
  }

  function toggleRight() {
    if (isFocusMode) setFocusRightOpen((v) => !v);
    else setRightOpen((v) => !v);
  }

  // ---------- page navigation ----------
  function scrollToDiagram() {
    vizRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scrollToEditor() {
    landingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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
      // New parse resets the conversation thread.
      setAiMessages([]);
      setShowCleared(true);
      setTimeout(() => setShowCleared(false), 2000);
      // Take the person to the diagram once it has had a moment to render.
      setTimeout(scrollToDiagram, 80);
    } catch (err) {
      setError({ message: err.message, context: err.context });
    } finally {
      setLoading(false);
    }
  }

  // Landing-page button: if nothing changed, just jump down instead of re-parsing.
  function handleLandingSubmit() {
    if (hasGraph && unchanged) {
      scrollToDiagram();
      return;
    }
    handleSubmit();
  }

  async function generateSummary() {
    if (!hasGraph) return;
    setAiLoading(true);
    setAiCollapsed(false);
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
  }, [aiMessages, aiLoading, aiCollapsed]);

  const filteredGraph = useMemo(() => {
    const activeNodes = rawGraph.nodes.filter((n) => !deletedNodes.includes(n.id));
    const activeNodeIds = new Set(activeNodes.map((n) => n.id));
    const mergedEdges = [...rawGraph.edges, ...hypotheticalEdges].filter(
      (e) => activeNodeIds.has(e.source) && activeNodeIds.has(e.target),
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
      style: blast.depthById[n.id] ? { ...n.style, '--hop-depth': blast.depthById[n.id] } : n.style,
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

  // Status strip. Errors show on the landing page (that's where Visualize is
  // clicked); drag / sandbox / summary show above the diagram.
  // Diagram-page priority: drag > sandbox > summary. The summary peek only
  // appears while the AI conversation is collapsed.
  const vizStatusKind = dragHint
    ? 'drag'
    : sandboxActive
      ? 'sandbox'
      : aiCollapsed && lastAssistant
        ? 'summary'
        : null;

  const statusMessages = {
    error: errorMessage,
    drag: `From ${dragHint} — release on another resource to add a hypothetical edge`,
    sandbox: sandboxToast
      ? sandboxToast
      : `Sandbox: ${hypotheticalEdges.length} hypothetical edge${
          hypotheticalEdges.length === 1 ? '' : 's'
        } · ${deletedNodes.length} simulated deletion${deletedNodes.length === 1 ? '' : 's'}`,
    summary: lastAssistant?.text || '',
  };

  const errorExpandable =
    Boolean(errorMessage && errorMessage.length > 120) || Boolean(error?.context);

  const visualizeDisabled = loading || !yaml.trim() || unchanged;
  const visualizeTitle = unchanged && !loading ? 'No template changes' : undefined;

  const blastPct =
    filteredGraph.nodes.length > 0
      ? Math.round((blast.total / filteredGraph.nodes.length) * 100)
      : 0;
  const flaggedInBlast = selectedId
    ? [...blast.direct, ...blast.indirect].filter((id) => flagsByResource.has(id)).length
    : 0;

  function showSummary() {
    setAiCollapsed(false);
    aiPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderStatus(kind) {
    if (!kind) return null;
    const message = statusMessages[kind];
    return (
      <div
        className={`iac-status iac-status--${kind === 'drag' || kind === 'sandbox' ? 'warn' : kind}`}
      >
        {kind === 'error' && <TriangleAlert size={15} aria-hidden="true" />}
        <span className="iac-status-text" title={message}>
          {message}
        </span>
        {kind === 'error' && errorExpandable && (
          <button
            type="button"
            className="iac-status-action"
            onClick={() => setErrorExpanded((v) => !v)}
          >
            {errorExpanded ? '▲' : '▼'}
          </button>
        )}
        {kind === 'sandbox' && (
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
        {kind === 'summary' && (
          <button type="button" className="iac-status-action" onClick={showSummary}>
            View summary
          </button>
        )}
      </div>
    );
  }

  const ctaLabel = loading
    ? 'Parsing…'
    : hasGraph && unchanged
      ? 'View diagram'
      : hasGraph
        ? 'Update diagram'
        : 'Visualize architecture';

  return (
    <div className={`iac-app iac-app--paged${isFocusMode ? ' iac-app--focus' : ''}`}>
      {/* =====================================================
          PAGE 1 — landing: brand, samples, template input
          ===================================================== */}
      <section className="iac-page iac-page--landing" ref={landingRef}>
        <header className="iac-nav">
          <div className="iac-brand">IaC Visualizer</div>
          <div className="iac-brand-sub">CloudFormation and SAM templates, made visible</div>
        </header>

        <div className="iac-hero">
          <h1>See how your infrastructure fits together before you deploy it</h1>
          <p>
            Paste a CloudFormation or SAM template and get a live dependency graph, misconfiguration
            flags, a monthly cost estimate and an AI walkthrough in a few seconds.
          </p>
        </div>

        <div className="iac-samples">
          <div className="iac-samples-title">Not sure where to start? Load a sample</div>
          <div className="iac-sample-grid">
            {Object.keys(SAMPLES).map((k) => (
              <button
                key={k}
                type="button"
                className="iac-sample-card"
                aria-pressed={sampleName === k}
                onClick={() => {
                  setYaml(SAMPLES[k]);
                  setSampleName(k);
                }}
              >
                <span className="iac-sample-name">{k}</span>
                <span className="iac-sample-blurb">{SAMPLE_BLURBS[k]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="iac-input-wrap">
          <TemplateInput
            value={yaml}
            onChange={setYaml}
            expanded={true}
            onExpand={() => {}}
            onCollapse={() => {}}
            fileName={sampleName ? `${sampleName}.yaml` : 'template.yaml'}
            showSubmitButton={false}
            onSubmit={handleLandingSubmit}
            loading={loading}
            hasGraph={hasGraph}
          />

          {errorMessage && (
            <div className="iac-landing-error">
              {renderStatus('error')}
              {errorExpanded && error?.context && (
                <div className="iac-status-error-detail">
                  Line {error.context.line}, column {error.context.column}
                  {'\n'}
                  {error.context.snippet}
                  {'\n'}
                  {error.context.pointer}
                </div>
              )}
              <div className="iac-landing-error-hint">
                Fix the template above, then select Update diagram to try again.
              </div>
            </div>
          )}

          <div className="iac-cta-row">
            <button
              type="button"
              className="iac-btn iac-btn--primary iac-btn--lg"
              onClick={handleLandingSubmit}
              disabled={loading || !yaml.trim()}
            >
              {loading ? (
                <>
                  <span className="iac-spinner" aria-hidden="true" />
                  {ctaLabel}
                </>
              ) : (
                <>
                  {ctaLabel}
                  <ArrowDown size={16} aria-hidden="true" />
                </>
              )}
            </button>
            <span className="iac-cta-hint">
              Read-only analysis. Nothing is deployed to your AWS account.
            </span>
          </div>
        </div>

        <div className="iac-features">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="iac-feature">
              <Icon size={18} aria-hidden="true" />
              <div className="iac-feature-title">{title}</div>
              <div className="iac-feature-body">{body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* =====================================================
          PAGE 2 — visualizer: sidebar | diagram | right rail
          ===================================================== */}
      <section className="iac-page iac-page--viz" ref={vizRef}>
        {!isFocusMode && (
          <div className="iac-viz-bar">
            <div className="iac-viz-bar-title">
              <h2>Architecture diagram</h2>
              <p>
                {hasGraph
                  ? `${filteredGraph.nodes.length} resource${
                      filteredGraph.nodes.length === 1 ? '' : 's'
                    } and ${filteredGraph.edges.length} dependenc${
                      filteredGraph.edges.length === 1 ? 'y' : 'ies'
                    }. Select any resource to inspect it.`
                  : 'Your template will be drawn here as soon as you visualize it.'}
              </p>
            </div>

            <div className="iac-viz-bar-actions">
              <button type="button" className="iac-btn iac-btn--ghost" onClick={scrollToEditor}>
                <ArrowUp size={15} aria-hidden="true" />
                Edit template
              </button>

              {hasGraph && (
                <>
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
                      'Update diagram'
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {!isFocusMode && vizStatusKind && (
          <div className="iac-viz-status">{renderStatus(vizStatusKind)}</div>
        )}

        {/* ---------- AI Assistant: sits above the diagram ---------- */}
        {!isFocusMode && (
          <section className="iac-ai-bar" ref={aiPanelRef} aria-label="AI Assistant">
            <div className="iac-ai-bar-row">
              <span className="iac-ai-bar-title">
                <Sparkles size={16} aria-hidden="true" />
                AI Assistant
              </span>

              <div className="iac-ai-bar-main">
                <p className="iac-ai-bar-hint">
                  {hasGraph
                    ? 'Get a plain-English summary of what this template builds and what to watch out for, based only on your parsed template.'
                    : 'Visualize a template first, then generate a plain-English summary of it here.'}
                </p>
              </div>

              <div className="iac-ai-bar-actions">
                <button
                  type="button"
                  className="iac-btn iac-btn--ai"
                  onClick={generateSummary}
                  disabled={!hasGraph || aiLoading}
                >
                  Summarize this template
                </button>
                {aiMessages.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="iac-panel-head-action"
                      onClick={() => setAiMessages([])}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="iac-panel-head-action"
                      onClick={() => setAiCollapsed((v) => !v)}
                      aria-expanded={!aiCollapsed}
                    >
                      {aiCollapsed ? 'Show summary' : 'Hide summary'}
                      {aiCollapsed ? (
                        <ChevronDown size={15} aria-hidden="true" />
                      ) : (
                        <ChevronUp size={15} aria-hidden="true" />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>

            {!aiCollapsed && (aiMessages.length > 0 || showCleared) && (
              <div className="iac-ai-scroll" ref={aiScrollRef}>
                {showCleared && <div className="iac-ai-system">Summary cleared</div>}
                {aiMessages.map((m, i) =>
                  m.role === 'system' ? (
                    <div key={i} className="iac-ai-system">
                      {m.text}
                    </div>
                  ) : (
                    <div key={i} className="iac-ai-assistant">
                      {m.text}
                    </div>
                  ),
                )}
                {aiLoading && <div className="iac-ai-system">Thinking…</div>}
              </div>
            )}
          </section>
        )}

        <div
          className={`iac-viz-body${leftShown ? '' : ' iac-viz-body--left-closed'}${
            rightShown ? '' : ' iac-viz-body--right-closed'
          }`}
        >
          {/* ---------- Left sidebar: cost, risks, view options, tip ---------- */}
          <aside
            className={`iac-sidebar${leftShown ? '' : ' iac-sidebar--closed'}`}
            aria-label="Template insights"
          >
            {!leftShown && (
              <button
                type="button"
                className="iac-side-tab iac-side-tab--left"
                onClick={toggleLeft}
                aria-label="Show insights sidebar"
                title="Show insights sidebar"
              >
                <PanelLeftOpen size={17} aria-hidden="true" />
                <span>Insights</span>
              </button>
            )}
            {leftShown && (
              <div className="iac-side-head">
                <span>Insights</span>
                <button
                  type="button"
                  className="iac-panel-head-action"
                  onClick={toggleLeft}
                  aria-label="Hide insights sidebar"
                  title="Hide sidebar"
                >
                  <PanelLeftClose size={16} aria-hidden="true" />
                </button>
              </div>
            )}
            {leftShown && (
              <div className="iac-side-scroll">
                {!hasGraph ? (
                  <section className="iac-side-card">
                    <div className="iac-side-card-head">
                      <Lightbulb size={16} aria-hidden="true" />
                      Nothing to show yet
                    </div>
                    <p className="iac-side-text">
                      Once you visualize a template, this panel shows its estimated monthly cost,
                      the issues most worth fixing first, and controls for tidying the diagram.
                    </p>
                  </section>
                ) : (
                  <>
                    {/* Cost */}
                    <section className="iac-side-card">
                      <div className="iac-side-card-head">
                        <Coins size={16} aria-hidden="true" />
                        Estimated cost
                      </div>
                      {cost?.total > 0 ? (
                        <>
                          <div className="iac-side-big">
                            ~${cost.total.toFixed(2)}
                            <span>/mo</span>
                          </div>
                          <p className="iac-side-text">
                            A rough monthly figure for the resources we can price.
                            {cost.unknownCount > 0 &&
                              ` ${cost.unknownCount} resource${
                                cost.unknownCount === 1 ? ' is' : 's are'
                              } not costed.`}
                          </p>
                          <button
                            type="button"
                            className="iac-side-toggle"
                            onClick={() => setCostExpanded((v) => !v)}
                            aria-expanded={costExpanded}
                          >
                            {costExpanded ? 'Hide breakdown' : 'Show breakdown'}
                            {costExpanded ? (
                              <ChevronUp size={15} aria-hidden="true" />
                            ) : (
                              <ChevronDown size={15} aria-hidden="true" />
                            )}
                          </button>
                          {costExpanded && cost?.breakdown?.length > 0 && (
                            <ul className="iac-side-list">
                              {cost.breakdown.map((b) => (
                                <li key={b.id}>
                                  <div className="iac-side-list-main">
                                    <strong>{b.id}</strong>
                                    <span>~${b.monthly.toFixed(2)}/mo</span>
                                  </div>
                                  <div className="iac-side-list-sub">{b.type}</div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <p className="iac-side-text">
                          No cost estimate is available for the resources in this template.
                        </p>
                      )}
                    </section>

                    {/* Top risks */}
                    <section className="iac-side-card">
                      <div className="iac-side-card-head">
                        <Flame size={16} aria-hidden="true" />
                        Highest-impact issues
                      </div>
                      {topRisks.length > 0 ? (
                        <>
                          <div className="iac-side-big">{topRisks.length}</div>
                          <p className="iac-side-text">
                            Issue{topRisks.length === 1 ? '' : 's'} worth fixing first, ranked by
                            severity and by how many resources sit downstream.
                          </p>
                          <button
                            type="button"
                            className="iac-side-toggle"
                            onClick={() => setRisksExpanded((v) => !v)}
                            aria-expanded={risksExpanded}
                          >
                            {risksExpanded ? 'Hide issues' : 'Show issues'}
                            {risksExpanded ? (
                              <ChevronUp size={15} aria-hidden="true" />
                            ) : (
                              <ChevronDown size={15} aria-hidden="true" />
                            )}
                          </button>
                          {risksExpanded && (
                            <ul className="iac-side-list">
                              {topRisks.map((r, i) => (
                                <li key={`${r.resourceId}-${r.ruleId}-${i}`}>
                                  <button
                                    type="button"
                                    className="iac-risk-item"
                                    onClick={() => setSelectedId(r.resourceId)}
                                  >
                                    <span className="iac-risk-top">
                                      <span
                                        className={`iac-sev iac-sev--${
                                          r.severity === 'high' ? 'high' : 'medium'
                                        }`}
                                      >
                                        {r.severity.toUpperCase()}
                                      </span>
                                      <strong>{r.resourceId}</strong>
                                    </span>
                                    {r.message && <span className="iac-risk-msg">{r.message}</span>}
                                    <span className="iac-risk-meta">
                                      {r.blastTotal} resource{r.blastTotal !== 1 ? 's' : ''}{' '}
                                      downstream
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <p className="iac-side-text">
                          None of the built-in rules flagged this template.
                        </p>
                      )}
                    </section>

                    {/* View options */}
                    <section className="iac-side-card">
                      <div className="iac-side-card-head">
                        <SlidersHorizontal size={16} aria-hidden="true" />
                        View options
                      </div>
                      <label className="iac-side-switch">
                        <input
                          type="checkbox"
                          checked={hideIam}
                          onChange={(e) => setHideIam(e.target.checked)}
                        />
                        <span className="iac-switch-track" aria-hidden="true" />
                        <span className="iac-switch-copy">
                          <strong>Hide IAM resources</strong>
                          <small>Remove roles and policies to make the graph easier to scan.</small>
                        </span>
                      </label>
                    </section>

                    {/* Tip */}
                    <section className="iac-side-card iac-side-card--tip">
                      <div className="iac-side-card-head">
                        <Lightbulb size={16} aria-hidden="true" />
                        Try the sandbox
                      </div>
                      <p className="iac-side-text">
                        Tip: Drag from the right dot of one resource to the left dot of another to
                        simulate a new dependency.
                      </p>
                      <p className="iac-side-text">
                        To see what breaks without a resource, select it and choose “Simulate
                        delete” in the inspector. Nothing you do here changes your template.
                      </p>
                    </section>
                  </>
                )}
              </div>
            )}
          </aside>

          {/* ---------- Diagram ---------- */}
          <div className={`iac-viz-stage${isFocusMode ? ' iac-viz-stage--focus' : ''}`}>
            <div className={isFocusMode ? 'iac-focus' : 'iac-canvas'}>
              {decoratedNodes.length === 0 ? (
                <div className="iac-empty">
                  <Network size={30} aria-hidden="true" />
                  <div className="iac-empty-title">
                    {hasGraph ? 'Every resource is hidden right now' : 'No diagram yet'}
                  </div>
                  <div className="iac-empty-body">
                    {hasGraph
                      ? 'Turn off “Hide IAM resources” or reset the sandbox to bring resources back into view.'
                      : 'Paste a CloudFormation or SAM template above and select Visualize architecture. The graph will appear here.'}
                  </div>
                  {!hasGraph && (
                    <button
                      type="button"
                      className="iac-btn iac-btn--ghost"
                      onClick={scrollToEditor}
                    >
                      <ArrowUp size={15} aria-hidden="true" />
                      Go to the template
                    </button>
                  )}
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
          </div>

          {/* ---------- Right rail: inspector ---------- */}
          <aside
            className={`iac-rail${rightShown ? '' : ' iac-rail--closed'}`}
            aria-label="Resource inspector"
          >
            {!rightShown && (
              <button
                type="button"
                className="iac-side-tab iac-side-tab--right"
                onClick={toggleRight}
                aria-label="Show inspector sidebar"
                title="Show inspector sidebar"
              >
                <PanelRightOpen size={17} aria-hidden="true" />
                <span>Inspector</span>
              </button>
            )}
            {rightShown && (
              <section className="iac-rail-panel iac-rail-panel--inspector">
                <div className="iac-panel-head">
                  <span className="iac-panel-head-left">
                    {selectedNode ? (
                      <>
                        <span className="iac-inspector-id">{selectedNode.id}</span>
                        <span className="iac-inspector-type">{selectedNode.type}</span>
                      </>
                    ) : (
                      'Inspector'
                    )}
                  </span>
                  <span className="iac-panel-head-right">
                    {selectedNode && (
                      <button
                        type="button"
                        className="iac-panel-head-action"
                        onClick={() => setSelectedId(null)}
                        aria-label="Clear selection"
                        title="Clear selection"
                      >
                        <X size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="iac-panel-head-action"
                      onClick={toggleRight}
                      aria-label="Hide inspector sidebar"
                      title="Hide sidebar"
                    >
                      <PanelRightClose size={16} aria-hidden="true" />
                    </button>
                  </span>
                </div>

                {!selectedNode ? (
                  <div className="iac-inspector-empty">
                    <MousePointerClick size={24} aria-hidden="true" />
                    <div>
                      Select a resource in the diagram to see its blast radius, dependencies, flags
                      and raw properties.
                    </div>
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
                        <div className="iac-blast-detail">
                          {blast.total} of {filteredGraph.nodes.length} resources ·{' '}
                          {blast.direct.length} direct, {blast.indirect.length} indirect
                        </div>
                        {blastCost !== null && (
                          <div className="iac-blast-cost">
                            <strong>~${blastCost.toFixed(2)}/mo</strong> across affected resources
                          </div>
                        )}
                        {flaggedInBlast > 0 && (
                          <div className="iac-flag-pill">
                            <Flame size={13} aria-hidden="true" />
                            {flaggedInBlast} resource{flaggedInBlast === 1 ? '' : 's'} in this blast
                            radius have unresolved flags
                          </div>
                        )}
                      </div>

                      {/* References */}
                      {outgoingDeps.length > 0 && (
                        <div className="iac-inspector-section">
                          <div className="iac-inspector-label">References</div>
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
                          <div className="iac-inspector-label">Flags</div>
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
                                  <strong className="iac-flag-why-title">Why this matters: </strong>
                                  {why}{' '}
                                  <a
                                    href={docUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="iac-flag-link"
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
                        <div className="iac-inspector-label">Properties</div>
                        {RESOURCE_DESCRIPTIONS[selectedNode.type] && (
                          <div className="iac-resource-desc">
                            {RESOURCE_DESCRIPTIONS[selectedNode.type]}
                          </div>
                        )}
                        <details className="iac-inspector-properties">
                          <summary>Raw properties</summary>
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
                            prev.includes(selectedId) ? prev : [...prev, selectedId],
                          );
                        }}
                      >
                        Simulate delete this resource
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}