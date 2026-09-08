const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electron = fs.readFileSync(path.join(root, 'clients', 'electron', 'main.js'), 'utf8');
const webview = fs.readFileSync(path.join(root, 'clients', 'webview2', 'Program.cs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');

assert.match(electron, /findFreePort/);
assert.match(electron, /LOCAL_MODEL_GATEWAY_FORCE_SETTINGS: 'true'/);
assert.match(electron, /LOCAL_MODEL_GATEWAY_FORCE_PORT: String\(gatewayPort\)/);
assert.match(electron, /gatewayProcess\.once\('error'/);
assert.match(electron, /ELECTRON_RUN_AS_NODE: '1'/);
assert.doesNotMatch(electron, /const PORT = 8787/);
assert.match(webview, /FindFreePortAsync/);
assert.match(webview, /LOCAL_MODEL_GATEWAY_FORCE_SETTINGS/);
assert.match(webview, /LOCAL_MODEL_GATEWAY_FORCE_PORT/);
assert.match(webview, /EnableRaisingEvents/);
assert.doesNotMatch(webview, /const int Port = 8787/);
assert.match(config, /LOCAL_MODEL_GATEWAY_FORCE_SETTINGS/);
assert.match(workflow, /gateway\/src\/server\.js/);
assert.match(workflow, /gateway\/public\/index\.html/);
console.log('desktop client tests passed');