import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

execFileSync(tsc, ['-p', 'tsconfig.client.json'], { cwd: root, stdio: 'inherit' });

const compiled = readFileSync(join(root, 'dist', '.client-tmp', 'index.js'), 'utf8');
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  compiled,
  'return module.exports; } });',
  '',
].join('\n');

writeFileSync(join(root, 'dist', 'client.js'), wrapped, 'utf8');
rmSync(join(root, 'dist', '.client-tmp'), { recursive: true, force: true });
