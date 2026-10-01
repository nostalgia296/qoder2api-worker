import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist');
fs.mkdirSync(OUT, { recursive: true });

const modules = ['src/wasm/wasm-b64.js', 'src/wasm/glue.js', 'src/crypto.js', 'src/qoder.js', 'src/login.js', 'src/checkin.js'];

let out = '';
for (const rel of modules) {
  let src = fs.readFileSync(path.join(HERE, rel), 'utf8');
  src = src
    .replace(/^import[^\n]*;?[^\S\n]*$/gm, '')
    .replace(/^export (?=(const|let|var|function|class))/gm, '');
  out += src.trim() + '\n';
}

const index = fs.readFileSync(path.join(HERE, 'src/index.js'), 'utf8')
  .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '');
out += index.trim() + '\n';

const outFile = path.join(OUT, '_worker.js');
fs.writeFileSync(outFile, out);
console.log('built:', outFile, `${(out.length / 1024).toFixed(0)} KB`);
