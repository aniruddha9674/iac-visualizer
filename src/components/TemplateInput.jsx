import { useEffect, useRef } from 'react';
import { FileText, ChevronDown } from 'lucide-react';

// Zone 2 — template input. One component, two states:
//   collapsed: a 40px bar (file icon + template/sample name + chevron)
//   expanded:  a 100px monospace textarea
// The Visualize button normally lives in the action bar (Zone 3); it only
// renders here as a fallback before the first graph exists, so there is
// always a way to run the first parse.
export default function TemplateInput({
  value,
  onChange,
  onExpand,
  onCollapse,
  expanded,
  fileName = 'template.yaml',
  showSubmitButton = false,
  onSubmit,
  loading = false,
  hasGraph = false,
}) {
  const textareaRef = useRef(null);
  const lineCount = value.trim() ? value.trim().split('\n').length : 0;

  // Focus the textarea as soon as the input expands, per Zone 2 behavior.
  useEffect(() => {
    if (expanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [expanded]);

  if (!expanded) {
    return (
      <button
        type="button"
        className="iac-input-collapsed"
        onClick={onExpand}
        aria-label="Expand template editor"
      >
        <span className="iac-input-collapsed-left">
          <FileText size={13} aria-hidden="true" />
          <span>{fileName}</span>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="iac-input-expanded">
      <div className="iac-console">
        <div className="iac-console-bar">
          <span className="iac-console-dot" />
          <span className="iac-console-dot" />
          <span className="iac-console-dot" />
          <span className="iac-console-filename">{fileName}</span>
        </div>

        <textarea
          ref={textareaRef}
          className="iac-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Escape collapses the editor back to the bar, but only once a
            // graph exists — collapsing with no graph would hide the only
            // Visualize button on the page.
            if (e.key === 'Escape' && hasGraph) {
              e.preventDefault();
              onCollapse?.();
            }
          }}
          placeholder="Paste a CloudFormation template here (YAML or JSON)"
          spellCheck={false}
        />
      </div>

      {showSubmitButton && (
        <div className="iac-console-footer">
          <button
            type="button"
            onClick={onSubmit}
            disabled={loading || !value.trim()}
            className="iac-btn iac-btn-primary"
          >
            {loading ? 'Parsing\u2026' : 'Visualize'}
          </button>
          <span className="iac-meta">{lineCount ? `${lineCount} lines` : 'No template loaded'}</span>
        </div>
      )}
    </div>
  );
}