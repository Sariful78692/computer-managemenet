const fs = require('fs');
const path = require('path');

const root = __dirname;
const output = path.join(root, 'dist');
const frontendOutput = path.join(output, 'frontend');
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const backendFiles = fs.readdirSync(backend).filter(function (fileName) {
  return fileName.endsWith('.gs');
});
if (!backendFiles.length) {
  throw new Error('No Apps Script backend files were found in backend/.');
}

const backendOrder = ['Config.gs', 'Database.gs', 'Auth.gs', 'DriveManager.gs', 'Finance.gs', 'Code.gs'];
const orderedBackendFiles = backendOrder.filter(function (fileName) {
  return backendFiles.indexOf(fileName) !== -1;
});
if (orderedBackendFiles.length !== backendFiles.length) {
  throw new Error('Add every backend .gs file to backendOrder in build.js before building the single-file Apps Script bundle.');
}
const combinedBackend = orderedBackendFiles.map(function (fileName) {
  return [
    '/** Source: backend/' + fileName + ' */',
    fs.readFileSync(path.join(backend, fileName), 'utf8').trim()
  ].join('\n\n');
}).join('\n\n');
fs.writeFileSync(path.join(output, 'Code.gs'), combinedBackend + '\n');

if (fs.existsSync(path.join(root, 'appsscript.json'))) {
  fs.copyFileSync(path.join(root, 'appsscript.json'), path.join(output, 'appsscript.json'));
} else {
  throw new Error('The Apps Script manifest is missing: appsscript.json');
}
fs.mkdirSync(path.join(frontendOutput, 'css'), { recursive: true });
fs.mkdirSync(path.join(frontendOutput, 'js'), { recursive: true });
fs.copyFileSync(path.join(frontend, 'html', 'index.html'), path.join(frontendOutput, 'index.html'));
fs.copyFileSync(path.join(frontend, 'css', 'styles.css'), path.join(frontendOutput, 'css', 'styles.css'));
fs.copyFileSync(path.join(frontend, 'js', 'app.js'), path.join(frontendOutput, 'js', 'app.js'));
fs.copyFileSync(path.join(frontend, 'js', 'modules.js'), path.join(frontendOutput, 'js', 'modules.js'));

console.log('Built one Apps Script API file (dist/Code.gs) and Vercel frontend (dist/frontend/).');
