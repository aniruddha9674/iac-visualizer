import { motion } from 'framer-motion';

export default function TemplateInput({ value, onChange, onSubmit, loading }) {
  const lineCount = value.trim() ? value.trim().split('\n').length : 0;

  return (
    <div className="iac-console-wrap">
      <div className="iac-console">
        <div className="iac-console-bar">
          <span className="iac-console-dot" />
          <span className="iac-console-dot" />
          <span className="iac-console-dot" />
          <span className="iac-console-filename">template.yaml</span>
        </div>

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste a CloudFormation template here (YAML or JSON)"
          spellCheck={false}
        />
      </div>

      <div className="iac-console-footer">
        <motion.button
          onClick={onSubmit}
          disabled={loading || !value.trim()}
          whileTap={{ scale: 0.97 }}
          className="iac-btn iac-btn-primary"
        >
          {loading ? 'Parsing\u2026' : 'Visualize'}
        </motion.button>
        <span className="iac-meta">{lineCount ? `${lineCount} lines` : 'No template loaded'}</span>
      </div>
    </div>
  );
}