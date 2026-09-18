// cli/lib/format.cjs

const SEVERITY_LABEL = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function formatText({ file, nodeCount, edgeCount, flags, blast, failOn }) {
  const lines = [];

  lines.push(`Template: ${file}`);
  lines.push(`Graph:    ${nodeCount} resources, ${edgeCount} dependencies`);
  lines.push('');

  if (flags.length === 0) {
    lines.push(`✓ No misconfigurations detected. (threshold: ${failOn})`);
  } else {
    const sorted = [...flags].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
    lines.push(`Flags (${flags.length}):`);
    for (const f of sorted) {
      const label = SEVERITY_LABEL[f.severity] || f.severity.toUpperCase();
      lines.push(`  [${label.padEnd(6)}] ${f.resourceId} — ${f.message}`);
    }
    lines.push('');
    lines.push(`Failure threshold: ${failOn}`);
  }

  if (blast) {
    lines.push('');
    lines.push(`Blast radius: ${blast.start}`);
    lines.push('');
    lines.push(`  direct:`);
    if (blast.direct.length === 0) {
      lines.push(`    └─ (none)`);
    } else {
      blast.direct.forEach((id, i) => {
        const branch = i === blast.direct.length - 1 ? '└─' : '├─';
        lines.push(`    ${branch} ${id}`);
      });
    }
    lines.push('');
    lines.push(`  indirect:`);
    if (blast.indirect.length === 0) {
      lines.push(`    └─ (none)`);
    } else {
      blast.indirect.forEach((id, i) => {
        const branch = i === blast.indirect.length - 1 ? '└─' : '├─';
        lines.push(`    ${branch} ${id}`);
      });
    }
    lines.push('');
    lines.push(`  ${blast.total} resource${blast.total === 1 ? '' : 's'} affected total`);
  }

  return lines.join('\n');
}

function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

module.exports = { formatText, formatJson };