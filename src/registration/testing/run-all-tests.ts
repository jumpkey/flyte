import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_FILES = [
  'increment-1.test.ts',
  'increment-3.test.ts',
  'increment-4.test.ts',
  'increment-5.test.ts',
  'increment-6.test.ts',
  'increment-7.test.ts',
  'increment-8.test.ts',
  'increment-9.test.ts',
  'increment-10.test.ts',
  'increment-11.test.ts',
  'increment-13.test.ts',
  'review-fixes.test.ts',
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

    proc.on('close', (code) => {
      resolve({ file, passed: code === 0, output });
    });
  });
}

async function main() {
  console.log('Running all registration tests...\n');
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

  console.log(`\n=== Summary: ${allPassed} test files passed, ${allFailed} test files failed ===`);
  if (allFailed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
