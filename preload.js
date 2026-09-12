'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* La medida que hereda una ventana abierta desde otra ({ w, h, dpi, paper }), o
 * null en la primera. Llega por la linea de comandos del renderer y no por IPC
 * porque el documento se crea apenas carga app.js, antes de que una respuesta
 * asincronica pudiera llegar. */
const SEED_ARG = process.argv.find((a) => a.startsWith('--scrawl-seed='));
let seed = null;
if (SEED_ARG) {
  try { seed = JSON.parse(SEED_ARG.slice('--scrawl-seed='.length)); } catch { seed = null; }
}

/* Superficie minima y explicita: el renderer no ve ipcRenderer ni require, solo
 * estas funciones. Todo lo que toca disco o portapapeles pasa por aca. */
contextBridge.exposeInMainWorld('scrawl', {
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    // otro documento en otra ventana, con la medida que se le pase
    newWindow: (seedFor) => ipcRenderer.send('window:new', seedFor),
    seed,
    /* Cerrar con cambios sin guardar: el principal frena el cierre y pregunta
     * por aca; la ventana contesta con confirmClose cuando guardo o descarto. */
    onConfirmClose: (fn) => {
      const handler = () => fn();
      ipcRenderer.on('window:confirm-close', handler);
      return () => ipcRenderer.off('window:confirm-close', handler);
    },
    confirmClose: () => ipcRenderer.send('window:close-confirmed'),
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
    // si hay trabajo sin guardar: el principal lo mira antes de reiniciar la app
    reportDirty: (on) => ipcRenderer.send('doc:dirty', !!on),
    // un .scrawl abierto desde el explorador de Windows llega por aca
    onOpenFile: (fn) => {
      const handler = (_e, data) => fn(data);
      ipcRenderer.on('file:open-external', handler);
      return () => ipcRenderer.off('file:open-external', handler);
    },
  },

  clip: {
    // { data, path?, layer? } — layer viene cuando lo copiado fue una capa de Scrawl
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),
    writeImage: (data) => ipcRenderer.invoke('clipboard:write-image', { data }),
    // una capa: sus pixeles como PNG mas la marca que la describe
    writeLayer: (data, meta) => ipcRenderer.invoke('clipboard:write-layer', { data, meta }),
  },

  update: {
    // el estado actual, para cuando el renderer monta despues del primer chequeo
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.send('update:download'),
    // contesta { ok, reason }: con otra ventana sin guardar, no reinicia
    install: () => ipcRenderer.invoke('update:install'),
    openPage: () => ipcRenderer.send('update:page'),
    onState: (fn) => {
      const handler = (_e, state) => fn(state);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.off('update:state', handler);
    },
  },
});
