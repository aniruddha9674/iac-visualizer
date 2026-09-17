import { useMemo, useState } from 'react';
import TemplateInput from './components/TemplateInput.jsx';
import FlowDiagram from './components/FlowDiagram.jsx';
import { layoutGraph } from './lib/layout.js';
import { computeBlastRadius } from './lib/blastRadius.js';

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
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    console.log('edges from API:', data.edges);
console.log('DataBucket blast:', computeBlastRadius(data.edges, 'DataBucket'));
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
const filteredGraph = useMemo(() => {
  if (!hideIam) return rawGraph;
  const isIam = (type) => typeof type === 'string' && type.startsWith('AWS::IAM::');
  const iamIds = new Set(rawGraph.nodes.filter((n) => isIam(n.type)).map((n) => n.id));
  return {
    nodes: rawGraph.nodes.filter((n) => !isIam(n.type)),
    edges: rawGraph.edges.filter((e) => !iamIds.has(e.source) && !iamIds.has(e.target)),
  };
}, [rawGraph, hideIam]);

const layouted = useMemo(() => {
  if (filteredGraph.nodes.length === 0) return { nodes: [], edges: [] };
  return layoutGraph(filteredGraph.nodes, filteredGraph.edges);
}, [filteredGraph]);

const blast = useMemo(() => {
  if (!selectedId) return { direct: [], indirect: [], total: 0 };
  return computeBlastRadius(filteredGraph.edges, selectedId);
}, [selectedId, filteredGraph.edges]);

  const flagsByResource = useMemo(() => {
    const m = new Map();
    for (const f of flags) {
      if (!m.has(f.resourceId)) m.set(f.resourceId, []);
      m.get(f.resourceId).push(f);
    }
    return m;
  }, [flags]);

  // decorate nodes with a flag indicator
  const decoratedNodes = useMemo(() => {
    return layouted.nodes.map((n) => ({
      ...n,
      data: { ...n.data, __hasFlag: flagsByResource.has(n.id) },
    }));
  }, [layouted.nodes, flagsByResource]);

  const selectedNode = selectedId ? rawGraph.nodes.find((n) => n.id === selectedId) : null;
  const selectedFlags = selectedId ? flagsByResource.get(selectedId) || [] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', margin: 0 }}>
     <div style={{ padding: '12px 16px', background: '#0f172a', color: 'white' }}>
  <div style={{ fontSize: 15, fontWeight: 700 }}>IaC Visualizer</div>
  <div style={{ fontSize: 11, color: '#94a3b8' }}>
    CloudFormation / SAM → dependency graph + misconfiguration flags
  </div>
  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
    <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center', marginRight: 4 }}>
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
          border: '1px solid #334155',
          background: 'transparent',
          color: '#cbd5e1',
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
  <div style={{ padding: '10px 16px', background: 'white', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 12 }}>
    <button
      onClick={generateSummary}
      disabled={summaryLoading}
      style={{
        padding: '6px 14px',
        background: summaryLoading ? '#94a3b8' : '#7c3aed',
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

    <label style={{ fontSize: 12, color: '#334155', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
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
  <div style={{ padding: '8px 16px', fontSize: 12, color: '#b91c1c', background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
    {summaryError}
  </div>
)}

{summary && (
  <div
    style={{
      padding: '12px 16px',
      background: '#faf5ff',
      borderBottom: '1px solid #e9d5ff',
      fontSize: 13,
      color: '#3b0764',
      lineHeight: 1.5,
    }}
  >
    {summary}
  </div>
)}

{cost && cost.total > 0 && (
  <div
    style={{
      padding: '10px 16px',
      background: '#f8fafc',
      borderBottom: '1px solid #e2e8f0',
      fontSize: 12,
      color: '#334155',
    }}
  >
    <span style={{ fontWeight: 700 }}>Estimated cost:</span>{' '}
    <span style={{ fontWeight: 700, color: '#0f172a' }}>
      ~${cost.total.toFixed(2)}/month
    </span>
    <span style={{ color: '#64748b', marginLeft: 8 }}>
      (rough heuristic, not a bill)
    </span>
    {cost.unknownCount > 0 && (
      <span style={{ color: '#94a3b8', marginLeft: 8 }}>
        · {cost.unknownCount} resource type{cost.unknownCount > 1 ? 's' : ''} not costed
      </span>
    )}
    {cost.breakdown.length > 0 && (
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', color: '#475569', fontSize: 11 }}>
          Breakdown ({cost.breakdown.length} resource{cost.breakdown.length > 1 ? 's' : ''})
        </summary>
        <div style={{ marginTop: 6, fontSize: 11, color: '#475569', paddingLeft: 8 }}>
          {cost.breakdown.map((b) => (
            <div key={b.id}>
              • <strong>{b.id}</strong> ({b.type}): ~${b.monthly.toFixed(2)}/mo
            </div>
          ))}
        </div>
      </details>
    )}
  </div>
)}
      {error && (
        <div style={{ padding: 12, background: '#fef2f2', color: '#b91c1c', fontSize: 12, borderBottom: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          {decoratedNodes.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
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
            />
          )}
        </div>

        {selectedNode && (
          <div
            style={{
              width: 340,
              borderLeft: '1px solid #e2e8f0',
              background: 'white',
              padding: 16,
              overflowY: 'auto',
              fontSize: 12,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{selectedNode.id}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{selectedNode.type}</div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                BLAST RADIUS
              </div>
              <div style={{ background: '#f8fafc', padding: 10, borderRadius: 6 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{blast.total}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  resources affected if this changes
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: '#334155' }}>
                  <div><strong>{blast.direct.length}</strong> direct</div>
                  <div><strong>{blast.indirect.length}</strong> indirect</div>
                </div>
                {blast.direct.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 10, color: '#64748b' }}>
                    Direct: {blast.direct.join(', ')}
                  </div>
                )}
                {blast.indirect.length > 0 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: '#64748b' }}>
                    Indirect: {blast.indirect.join(', ')}
                  </div>
                )}
              </div>
            </div>

            {selectedFlags.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                  FLAGS
                </div>
                {selectedFlags.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      background: f.severity === 'high' ? '#fef2f2' : '#fffbeb',
                      border: `1px solid ${f.severity === 'high' ? '#fecaca' : '#fde68a'}`,
                      borderRadius: 6,
                      padding: 10,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: f.severity === 'high' ? '#b91c1c' : '#92400e' }}>
                      {f.severity.toUpperCase()} — {f.ruleId}
                    </div>
                    <div style={{ fontSize: 11, color: '#334155', marginTop: 4 }}>{f.message}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                PROPERTIES
              </div>
              <pre
                style={{
                  background: '#f8fafc',
                  padding: 10,
                  borderRadius: 6,
                  fontSize: 10,
                  overflowX: 'auto',
                  margin: 0,
                  color: '#334155',
                  maxHeight: 300,
                }}
              >
                {JSON.stringify(selectedNode.properties, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}