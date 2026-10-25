import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveState } from './server.mjs';
import { DEFAULT_LIMITS } from './limiter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (!process.argv[2] && !process.env.APPDATA) throw new Error('Provide the TT data root as the first argument on this platform');
const dataRoot = path.resolve(process.argv[2] || path.join(process.env.APPDATA, 'com.tauritavern.client/data'));
if (!fs.existsSync(path.join(dataRoot, 'default-user/settings.json'))) throw new Error('不是 TT 数据根目录');
JSON.parse(fs.readFileSync(path.join(dataRoot, 'default-user/settings.json'), 'utf8').replace(/^\uFEFF/, ''));
const extensionRoot = path.join(dataRoot, 'default-user/extensions/tt-agent-limiter');
const stateFile = path.join(root, 'runtime/state.json');
let state;
if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
else {
    state = { version: 1, port: 19377, adminToken: crypto.randomBytes(32).toString('hex'),
        limits: { ...DEFAULT_LIMITS }, routes: [], recentStarts: [] };
    saveState(stateFile, state);
}
if (fs.existsSync(extensionRoot)) {
    const backup = path.join(root, 'runtime/backups', `extension-${Date.now()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.cpSync(extensionRoot, backup, { recursive: true });
}
fs.mkdirSync(extensionRoot, { recursive: true });
for (const name of ['manifest.json','site-index.js','site-router.js','model.js','style.css']) {
    fs.copyFileSync(path.join(root,'extension',name),path.join(extensionRoot,name));
}
fs.writeFileSync(path.join(extensionRoot,'client-config.json'),JSON.stringify({
    baseUrl:`http://127.0.0.1:${state.port}`,adminToken:state.adminToken,
},null,2));
fs.writeFileSync(path.join(root,'runtime/install.json'),JSON.stringify({dataRoot,extensionRoot,installedAt:new Date().toISOString()},null,2));
console.log('Installed TT Agent Site Limiter 0.2.0');
console.log('Extension: '+extensionRoot);
console.log('Limits: concurrency '+state.limits.concurrency+', RPM '+state.limits.rpm);
console.log('Reload TT to activate the extension.');
