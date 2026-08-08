'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpc } = require('./ipc');

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    title: 'LMMS Path Relinker',
    backgroundColor: '#14161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The renderer handles untrusted project data, so it gets no Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// This application never loads remote content; block navigation outright.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
