'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* Superficie minima y explicita: el renderer no ve ipcRenderer ni require, solo
 * estas funciones. Todo lo que toca disco o portapapeles pasa por aca. */
contextBridge.exposeInMainWorld('scrawl', {
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    // el titlebar propio necesita seguir el estado para cambiar su icono
    onState: (fn) => {
      const handler = (_e, state) => fn(state);
      ipcRenderer.on('window:state', handler);
      return () => ipcRenderer.off('window:state', handler);
    },
  },

  file: {
    exportPNG: (data, suggestedName) =>
      ipcRenderer.invoke('file:export-png', { data, suggestedName }),
    exportPDF: (data, suggestedName) =>
      ipcRenderer.invoke('file:export-pdf', { data, suggestedName }),
    saveDoc: (json, suggestedName, path) =>
      ipcRenderer.invoke('file:save-doc', { json, suggestedName, path }),
    openDoc: () => ipcRenderer.invoke('file:open-doc'),
    openImage: () => ipcRenderer.invoke('file:open-image'),
    // un .scrawl abierto desde el explorador de Windows llega por aca
    onOpenFile: (fn) => {
      const handler = (_e, data) => fn(data);
      ipcRenderer.on('file:open-external', handler);
      return () => ipcRenderer.off('file:open-external', handler);
    },
  },

  clip: {
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),
    writeImage: (data) => ipcRenderer.invoke('clipboard:write-image', { data }),
  },

  update: {
    // el estado actual, para cuando el renderer monta despues del primer chequeo
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.send('update:download'),
    install: () => ipcRenderer.send('update:install'),
    openPage: () => ipcRenderer.send('update:page'),
    onState: (fn) => {
      const handler = (_e, state) => fn(state);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.off('update:state', handler);
    },
  },
});
