'use strict';
// electron-builder 26.18: use its own static NSIS uninstaller extractor on
// Linux too, to avoid requiring 32-bit Wine to execute a temporary installer.
// Also constrain 7-Zip to one thread and a 16 MiB dictionary on Linux,
// so the Windows payload can be built in low-memory environments.
// This modifies installed build tools only, not the LML app or shipped runtime.
const fs = require('node:fs');
function replaceOnce(file, before, after) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(after)) return;
  if (text.split(before).length !== 2) throw new Error(`Unexpected builder code; refusing to patch ${file}`);
  fs.writeFileSync(file, text.replace(before, after));
}
replaceOnce(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js'),
  'if ((0, macosVersion_1.isMacOsCatalina)()) {',
  'if (process.platform === "linux" || (0, macosVersion_1.isMacOsCatalina)()) {');
replaceOnce(require.resolve('app-builder-lib/out/targets/archive.js'),
  'const args = debug7zArgs("a");',
  'const args = debug7zArgs("a");\n    if (process.platform === "linux") args.push("-mmt=1", "-md=16m");');
console.log('Linux builder: static uninstaller extraction and bounded-memory 7-Zip enabled.');
