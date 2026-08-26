const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const executable = path.join(projectRoot, 'dist', 'voice-studio-release', 'win-unpacked', 'XiaoMuVoiceStudio.exe');
if (!fs.existsSync(executable)) throw new Error(`缺少已打包主程序：${executable}`);

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomu-packaged-smoke-'));
const smokeRoot = path.join(evidenceRoot, 'smoke');
fs.mkdirSync(smokeRoot, { recursive: true });

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--smoke'], {
      windowsHide: true,
      shell: false,
      stdio: 'inherit',
      env: { ...process.env, XIAOMU_SMOKE_USER_DATA: evidenceRoot }
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('已打包程序冒烟测试超过 120 秒'));
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`已打包程序异常退出：${code ?? signal}`));
      resolve();
    });
  });
}

(async () => {
  await runSmoke();
  const reportPath = path.join(smokeRoot, 'voice-studio.json');
  assert.equal(fs.existsSync(reportPath), true, '冒烟报告未生成');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.title, '小沐音色工坊');
  assert.equal(report.pageCount, 6);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.errorsAfterReload, []);
  assert.equal(report.compatibilityFeedback?.hoverChanged, true);
  assert.equal(report.compatibilityFeedback?.pressedChanged, true);
  assert.equal(report.responsiveCloneControlsRight, true);
  assert.equal(report.responsiveControlsContained, true);
  assert.equal(report.storageStatusLoaded, true);
  console.log(`已打包程序冒烟测试通过：${evidenceRoot}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
