import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Web-layer suites added by the UI elaboration increments. Mirrors the
// registration runner's spawn-per-file model so a hang or crash in one suite
// can't take the others' reporting down with it.
const TEST_FILES = [
  'shadow-login.test.ts',
  'admin-guard.test.ts',
];

async function runFile(file: string): Promise<{ file: string; passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const filePath = path.join(__dirname, file);
    const proc = spawn('npx', ['tsx', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => resolve({ file, passed: code === 0, output }));
  });
}

async function main() {
  console.log('Running web suites...\n');
  let allPassed = 0;
  let allFailed = 0;

  for (const file of TEST_FILES) {
    const result = await runFile(file);
    if (result.passed) {
      console.log(`✓ ${file}`);
      allPassed++;
    } else {
      console.log(`✗ ${file}`);
      console.log(result.output);
      allFailed++;
    }
  }

  console.log(`\n=== Web summary: ${allPassed} test files passed, ${allFailed} test files failed ===`);
  if (allFailed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
