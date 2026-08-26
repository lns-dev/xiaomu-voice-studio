function detectBuildChannel({ isPackaged, version }) {
  const value = String(version || '');
  if (!isPackaged || /(?:^|[-.])debug(?:[-.]|$)/i.test(value)) return 'debug';
  if (/(?:^|[-.])alpha(?:[-.]|$)/i.test(value)) return 'alpha';
  if (/(?:^|[-.])(?:beta|rc)(?:[-.]|$)/i.test(value)) return 'beta';
  return 'release';
}

module.exports = { detectBuildChannel };
