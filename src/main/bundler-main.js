'use strict';
/**
 * bundler-main.js — Electron entry for the RelinkBundler.
 *
 * A separate tool from the Relinker. The Relinker only rewrites paths and runs
 * anywhere, including the browser build. This one drives the LMMS binary to
 * produce self-contained bundles, so it must be a desktop app.
 *
 * Run with:  npm run start:bundler
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerBundlerIpc } = require('./bundler-ipc');

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 900,
    minWidth: 880,
    minHeight: 660,
    title: 'LMMS RelinkBundler',
    backgroundColor: '#0f1712',
    webPreferences: {
      preload: path.join(__dirname, 'bundler-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'bundler.html'));
  return win;
}

app.whenReady().then(() => {
  registerBundlerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
