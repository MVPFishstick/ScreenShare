// Builds the installable web app (PWA) into dist-web/ for static hosting.
const fs = require('fs');
const path = require('path');

require('./copy-vendor');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist-web');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('web: built', path.relative(root, out));
