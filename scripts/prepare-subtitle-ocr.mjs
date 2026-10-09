import { mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Apple Vision subtitle OCR requires macOS; manual gallery calibration remains available.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? path.join(root, 'vendor/runtime/subtitle-ocr');
await mkdir(path.dirname(output), { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn('swiftc', ['-O', path.join(root, 'scripts/native/subtitle-ocr.swift'), '-o', output], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`swiftc exited ${code}; install the macOS command line build tools.`)));
});
await chmod(output, 0o755);
console.log(`Local Apple Vision OCR ready: ${output}`);
