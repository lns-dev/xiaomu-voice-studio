const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function exists(candidate) {
  try { return Boolean(candidate) && fs.existsSync(candidate); } catch { return false; }
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter(Boolean).map((value) => path.resolve(value)).filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pythonFromRoot(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  if (/python(?:\.exe)?$/i.test(path.basename(resolved))) return resolved;
  const options = [
    path.join(resolved, 'python.exe'),
    path.join(resolved, 'Scripts', 'python.exe'),
    path.join(resolved, '.venv', 'Scripts', 'python.exe')
  ];
  return options.find(exists) || options[0];
}

function loadState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      selectedPython: typeof parsed?.selectedPython === 'string' ? path.resolve(parsed.selectedPython) : null,
      manualRoots: uniquePaths(Array.isArray(parsed?.manualRoots) ? parsed.manualRoots : [])
    };
  } catch {
    return { selectedPython: null, manualRoots: [] };
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, statePath);
}

function createRuntimeLocations(options) {
  const {
    isPackaged,
    programRoot,
    dataRoot,
    userDataRoot,
    localAppData = process.env.LOCALAPPDATA,
    pathValue = process.env.PATH || '',
    developmentCandidates = []
  } = options;
  const statePath = path.join(userDataRoot, 'runtime-locations.json');
  let state = loadState(statePath);
  let cachedProbe = null;

  const managedRuntimeRoot = path.join(dataRoot, 'runtime', 'core');
  const bundledRuntimeRoot = path.join(programRoot, 'runtime', 'core');
  const engineRoot = path.join(dataRoot, 'engines');
  const toolRoot = path.join(dataRoot, 'tools');

  function candidates() {
    const pathCandidates = pathValue.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, 'python.exe'));
    const roots = [
      state.selectedPython,
      ...state.manualRoots.map(pythonFromRoot),
      pythonFromRoot(managedRuntimeRoot),
      pythonFromRoot(bundledRuntimeRoot),
      pythonFromRoot(process.env.VIRTUAL_ENV),
      pythonFromRoot(process.env.CONDA_PREFIX),
      localAppData && path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      ...pathCandidates,
      ...(!isPackaged ? developmentCandidates.map(pythonFromRoot) : [])
    ];
    return uniquePaths(roots).filter(exists);
  }

  function selectedPython() {
    const available = candidates();
    if (state.selectedPython && exists(state.selectedPython)) return path.resolve(state.selectedPython);
    return available[0] || null;
  }

  function sourceFor(python) {
    if (!python) return '未检测到';
    if (path.resolve(python).toLowerCase() === path.resolve(pythonFromRoot(managedRuntimeRoot)).toLowerCase()) return '软件管理';
    if (path.resolve(python).toLowerCase() === path.resolve(pythonFromRoot(bundledRuntimeRoot)).toLowerCase()) return '安装包内置';
    if (state.manualRoots.some((root) => path.resolve(python).toLowerCase() === path.resolve(pythonFromRoot(root)).toLowerCase())) return '手动添加';
    return '自动检测';
  }

  function summary() {
    const python = selectedPython();
    return {
      ready: Boolean(python),
      compatible: cachedProbe?.python === python ? Boolean(cachedProbe.compatible) : null,
      checkingRequired: Boolean(python) && cachedProbe?.python !== python,
      python,
      source: sourceFor(python),
      candidates: candidates(),
      managedRuntimeRoot,
      engineRoot,
      toolRoot,
      dataRoot
    };
  }

  async function probe(force = false) {
    const python = selectedPython();
    if (!python) return { ...summary(), compatible: false, error: '未检测到 Python 运行环境' };
    if (!force && cachedProbe?.python === python) return { ...summary(), ...cachedProbe };
    const script = [
      'import json,platform,sys',
      'result={"pythonVersion":platform.python_version(),"architecture":platform.architecture()[0]}',
      'try:',
      ' import torch,torchaudio',
      ' result.update(torchVersion=torch.__version__,torchaudioVersion=torchaudio.__version__,cudaAvailable=torch.cuda.is_available())',
      ' result["compatible"]=(sys.version_info[:2]==(3,11) and str(torch.__version__).startswith("2.8.0") and str(torchaudio.__version__).startswith("2.8.0") and bool(result["cudaAvailable"]))',
      'except Exception as exc:',
      ' result.update(compatible=False,error=str(exc))',
      'print(json.dumps(result,ensure_ascii=False))'
    ].join('\n');
    const result = await new Promise((resolve) => {
      execFile(python, ['-c', script], { windowsHide: true, timeout: 45000, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) return resolve({ compatible: false, error: String(stderr || error.message).trim().slice(-500) });
        try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); }
        catch { resolve({ compatible: false, error: '运行环境返回了无法识别的检测结果' }); }
      });
    });
    cachedProbe = { python, ...result, checkedAt: new Date().toISOString() };
    return { ...summary(), ...cachedProbe };
  }

  function add(candidate) {
    const python = pythonFromRoot(candidate);
    if (!exists(python)) throw new Error('所选目录中没有找到 python.exe');
    const root = /python(?:\.exe)?$/i.test(path.basename(path.resolve(candidate))) ? path.dirname(path.resolve(candidate)) : path.resolve(candidate);
    state.manualRoots = uniquePaths([root, ...state.manualRoots]);
    state.selectedPython = path.resolve(python);
    cachedProbe = null;
    saveState(statePath, state);
    return summary();
  }

  function select(python) {
    const resolved = path.resolve(python);
    if (!exists(resolved)) throw new Error('运行环境不存在');
    state.selectedPython = resolved;
    cachedProbe = null;
    saveState(statePath, state);
    return summary();
  }

  return { summary, probe, add, select, candidates, selectedPython, engineRoot, toolRoot, managedRuntimeRoot };
}

module.exports = { createRuntimeLocations, pythonFromRoot, uniquePaths };
