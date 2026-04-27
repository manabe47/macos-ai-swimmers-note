const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const APP_NAME = 'MacOS-AI-swimmers-note';
const NODE_BIN = process.env.SWIMMERS_NOTE_NODE_BIN || 'node';
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'data');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const tester = net.createServer();
    tester.unref();
    tester.on('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const address = tester.address();
      const port = typeof address === 'object' && address ? address.port : 3002;
      tester.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', (error) => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(tryConnect, 250);
      });
    };

    tryConnect();
  });
}

function findPreferredBrowser() {
  const candidates = [
    '/Applications/Google Chrome.app',
    '/Applications/Google Chrome Canary.app',
    '/Applications/Brave Browser.app',
    '/Applications/Microsoft Edge.app'
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function openWindow(url) {
  const browserApp = findPreferredBrowser();
  if (browserApp) {
    return spawnSync('open', ['-a', browserApp, '--args', `--app=${url}`], { stdio: 'inherit' });
  }
  return spawnSync('open', [url], { stdio: 'inherit' });
}

async function main() {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const serverScript = path.join(__dirname, 'server.js');

  const serverProcess = spawn(NODE_BIN, [serverScript], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      SWIMMERS_NOTE_DATA_DIR: DATA_DIR
    },
    stdio: 'inherit'
  });

  let quitting = false;
  const shutdown = () => {
    if (quitting) return;
    quitting = true;
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  serverProcess.on('exit', (code) => {
    if (!quitting && code !== 0) {
      process.exitCode = code || 1;
    }
  });

  await waitForServer(url, 15000);
  console.log(`Opening ${url}`);
  const result = openWindow(url);
  if (result.status && result.status !== 0) {
    throw new Error(`Failed to open app window (exit ${result.status})`);
  }
}

main().catch((error) => {
  console.error('Failed to launch MacOS-AI-swimmers-note', error);
  process.exit(1);
});
