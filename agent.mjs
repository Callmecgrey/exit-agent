#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const required = [
  'NOXSERVER_API_BASE',
  'EXIT_SLUG',
  'EXIT_AGENT_TOKEN',
  'WG_INTERFACE',
  'WG_CONFIG_PATH',
  'WG_PRIVATE_KEY_PATH',
  'EXIT_WG_ADDRESS',
  'EXIT_WG_LISTEN_PORT'
];

for (const key of required) {
  if (!process.env[key]?.trim()) {
    console.error(`[exit-agent] Missing required env: ${key}`);
    process.exit(1);
  }
}

const config = {
  apiBase: process.env.NOXSERVER_API_BASE.trim().replace(/\/+$/, ''),
  exitSlug: process.env.EXIT_SLUG.trim(),
  exitAgentToken: process.env.EXIT_AGENT_TOKEN.trim(),
  wgInterface: process.env.WG_INTERFACE.trim(),
  wgConfigPath: process.env.WG_CONFIG_PATH.trim(),
  wgPrivateKeyPath: process.env.WG_PRIVATE_KEY_PATH.trim(),
  exitWgAddress: process.env.EXIT_WG_ADDRESS.trim(),
  exitWgListenPort: String(process.env.EXIT_WG_LISTEN_PORT || '').trim(),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  statePath: (process.env.EXIT_AGENT_STATE_PATH || '/var/lib/noxguard-exit-agent/state.json').trim(),
  postUp: (process.env.EXIT_WG_POST_UP || '').trim(),
  postDown: (process.env.EXIT_WG_POST_DOWN || '').trim()
};

let running = true;
let lastAppliedVersion = 0;
let lastRenderedHash = '';

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha(value) {
  const out = spawnSync('shasum', ['-a', '256'], { input: value, encoding: 'utf8' }).stdout || '';
  const hash = out.trim().split(' ')[0];
  return hash || value;
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-nox-exit-token': config.exitAgentToken,
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      json && typeof json === 'object' && 'message' in json
        ? String(json.message || 'Request failed')
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return json;
}

function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function readPrivateKey() {
  return readFileSync(config.wgPrivateKeyPath, 'utf8').trim();
}

function renderConfig(desiredState) {
  const peers = Array.isArray(desiredState?.peers) ? desiredState.peers : [];

  const peerBlocks = peers
    .filter((peer) => peer && peer.publicKey && peer.tunnelAddress)
    .sort((a, b) => String(a.deviceId || '').localeCompare(String(b.deviceId || '')))
    .map((peer) => {
      const deviceId = String(peer.deviceId || 'unknown');
      return ['[Peer]', `# ${deviceId}`, `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.tunnelAddress}`, ''].join('\n');
    })
    .join('\n');

  const lines = [
    '[Interface]',
    `PrivateKey = ${readPrivateKey()}`,
    `Address = ${config.exitWgAddress}`,
    `ListenPort = ${config.exitWgListenPort}`,
    'SaveConfig = false'
  ];

  if (config.postUp) lines.push(`PostUp = ${config.postUp}`);
  if (config.postDown) lines.push(`PostDown = ${config.postDown}`);

  return `${lines.join('\n')}\n\n${peerBlocks}`.trim() + '\n';
}

function interfaceExists() {
  const result = spawnSync('ip', ['link', 'show', 'dev', config.wgInterface], { encoding: 'utf8' });
  return result.status === 0;
}

function writeConfig(contents) {
  ensureParentDir(config.wgConfigPath);
  const tmp = `${config.wgConfigPath}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, config.wgConfigPath);
}

function applyConfig() {
  if (!interfaceExists()) {
    const up = spawnSync('wg-quick', ['up', config.wgConfigPath], { encoding: 'utf8' });
    if (up.status !== 0) {
      throw new Error(up.stderr || up.stdout || 'wg-quick up failed');
    }
    return;
  }

  const sync = spawnSync(
    'bash',
    ['-lc', `wg-quick strip '${config.wgConfigPath}' | wg syncconf '${config.wgInterface}' /dev/stdin`],
    { encoding: 'utf8' }
  );
  if (sync.status !== 0) {
    throw new Error(sync.stderr || sync.stdout || 'wg syncconf failed');
  }
}

function saveState(version, configHash) {
  ensureParentDir(config.statePath);
  writeFileSync(
    config.statePath,
    JSON.stringify(
      {
        exitSlug: config.exitSlug,
        lastAppliedVersion: version,
        lastRenderedHash: configHash,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

function loadState() {
  if (!existsSync(config.statePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(config.statePath, 'utf8'));
    lastAppliedVersion = Number(parsed.lastAppliedVersion || 0);
    lastRenderedHash = String(parsed.lastRenderedHash || '');
  } catch {
    rmSync(config.statePath, { force: true });
  }
}

async function reportHealthy(desiredState, renderedHash) {
  const desiredVersion = Number(desiredState?.sync?.desiredConfigVersion || 0);
  const peers = Array.isArray(desiredState?.peers) ? desiredState.peers : [];

  await requestJson(`/vpn/agent/exits/${config.exitSlug}/report`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'healthy',
      currentPeerCount: peers.length,
      appliedConfigVersion: desiredVersion,
      appliedAt: new Date().toISOString(),
      lastError: ''
    })
  });

  lastAppliedVersion = desiredVersion;
  lastRenderedHash = renderedHash;
  saveState(lastAppliedVersion, lastRenderedHash);
}

async function reportError(message) {
  try {
    await requestJson(`/vpn/agent/exits/${config.exitSlug}/report`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'degraded',
        appliedConfigVersion: lastAppliedVersion,
        appliedAt: new Date().toISOString(),
        lastError: String(message).slice(0, 1000)
      })
    });
  } catch (e) {
    console.error('[exit-agent] Failed to report error:', e instanceof Error ? e.message : String(e));
  }
}

async function reconcileOnce() {
  const desiredState = await requestJson(`/vpn/agent/exits/${config.exitSlug}/desired-state`, { method: 'GET' });

  const rendered = renderConfig(desiredState);
  const renderedHash = sha(rendered);
  const desiredVersion = Number(desiredState?.sync?.desiredConfigVersion || 0);

  const requiresApply =
    desiredVersion !== lastAppliedVersion ||
    renderedHash !== lastRenderedHash ||
    !existsSync(config.wgConfigPath);

  if (!requiresApply) {
    const peers = Array.isArray(desiredState?.peers) ? desiredState.peers : [];
    await requestJson(`/vpn/agent/exits/${config.exitSlug}/report`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'healthy',
        currentPeerCount: peers.length,
        appliedConfigVersion: lastAppliedVersion,
        appliedAt: new Date().toISOString(),
        lastError: ''
      })
    });
    return;
  }

  writeConfig(rendered);
  applyConfig();
  await reportHealthy(desiredState, renderedHash);
}

async function main() {
  loadState();
  console.log(`[exit-agent] Starting reconcile loop for exit ${config.exitSlug}`);

  while (running) {
    try {
      await reconcileOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[exit-agent] Reconcile failed: ${msg}`);
      await reportError(msg);
    }

    if (!running) break;
    await sleep(config.pollIntervalMs);
  }

  console.log('[exit-agent] Stopped');
}

await main();
