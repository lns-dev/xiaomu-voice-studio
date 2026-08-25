function detectBuildChannel({ isPackaged, version }) {
  const value = String(version || '');
  if (!isPackaged || /(?:^|[-.])debug(?:[-.]|$)/i.test(value)) return 'debug';
  if (/(?:^|[-.])(?:alpha|beta|rc)(?:[-.]|$)/i.test(value)) return 'alpha';
  return 'release';
}

module.exports = { detectBuildChannel };
