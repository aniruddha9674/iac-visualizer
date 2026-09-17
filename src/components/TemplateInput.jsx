export default function TemplateInput({ value, onChange, onSubmit, loading }) {
  return (
    <div style={{ padding: 16, borderBottom: '1px solid #e2e8f0', background: 'white' }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste a CloudFormation template here (YAML or JSON)"
        style={{
          width: '100%',
          height: 120,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          padding: 8,
          border: '1px solid #cbd5e1',
          borderRadius: 6,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSubmit}
          disabled={loading || !value.trim()}
          style={{
            padding: '8px 16px',
            background: loading ? '#94a3b8' : '#0f172a',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {loading ? 'Parsing...' : 'Visualize'}
        </button>
      </div>
    </div>
  );
}