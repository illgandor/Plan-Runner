// In-extension self-updater (D-003): stock VS Code won't auto-update a side-loaded
// VSIX, so we poll GitHub Releases ourselves, install a newer .vsix, and offer reload.
// vscode is required LAZILY inside start() so node:test can import semverGt() headless.
// ponytail: each update re-downloads the full ~238MB VSIX (bundled SDK); externalize
// the binary if bandwidth ever matters (deferred in P01-S03 carryover).
const https = require('https');
const fs = require('fs');
const path = require('path');

// True iff a > b for plain x.y.z release versions (no prerelease tags — releases are clean).
function semverGt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// owner/repo from package.json's repository url (S01b Fact: illgandor/Plan-Runner).
function repoSlug(pkg) {
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec((pkg.repository && pkg.repository.url) || '');
  return m ? m[1] : null;
}

function ghGetJson(pathname) {
  return new Promise((resolve, reject) => {
    https.get({ host: 'api.github.com', path: pathname,
      headers: { 'User-Agent': 'plan-runner', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub ${res.statusCode}`)); }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Stream the asset to dest, following GitHub's redirect to the object store.
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, { headers: { 'User-Agent': 'plan-runner' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download ${res.statusCode}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    get(url).on('error', (e) => { fs.unlink(dest, () => reject(e)); });
  });
}

// One check: if the latest release is newer, download+verify the .vsix, install, offer reload.
async function checkAndUpdate(context, vscode) {
  const pkg = require('../package.json');
  const slug = repoSlug(pkg);
  if (!slug) return;
  const rel = await ghGetJson(`/repos/${slug}/releases/latest`);
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!semverGt(latest, pkg.version)) return;
  const asset = (rel.assets || []).find((a) => a.name.endsWith('.vsix'));
  if (!asset) return;
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);
  await download(asset.browser_download_url, dest);
  // installExtension swallows bad-path errors, so validate the download ourselves first.
  const size = fs.statSync(dest).size;
  if (asset.size && size !== asset.size) throw new Error(`size ${size} != ${asset.size}`);
  // Consent before installing (D-032) — decline just skips this cycle; next poll re-offers.
  const consent = await vscode.window.showInformationMessage(`Plan Runner ${latest} downloaded — install now?`, 'Install');
  if (consent !== 'Install') return;
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));
  const pick = await vscode.window.showInformationMessage(`Plan Runner ${latest} installed.`, 'Reload Window');
  if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// Poll on activate then hourly; every error (offline, rate-limit) is a silent no-op.
function start(context) {
  const vscode = require('vscode');
  const run = () => checkAndUpdate(context, vscode).catch(() => {});
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

module.exports = { start, semverGt, checkAndUpdate };
