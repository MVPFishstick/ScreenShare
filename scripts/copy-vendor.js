// Copies third-party browser bundles into src/renderer/vendor so the same
// renderer folder works inside Electron and as the hosted web app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(
  path.join(root, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'),
  path.join(vendorDir, 'peerjs.min.js'),
);
console.log('vendor: copied peerjs.min.js');
