---
name: run-scrawl
description: Lanzar y manejar la app real de Scrawl para verificar un cambio con los ojos — sacar screenshots, elegir herramientas, simular trazos (incluso frenando a mitad de un gesto). Usala siempre que haya que correr/abrir/probar la app, capturar su UI, o confirmar que un cambio funciona en la app de verdad y no solo en el selftest.
---

Scrawl es una app Electron; cada documento vive en su propia ventana (`Ctrl+T`
abre otra). Para uso desde un agente se maneja con el driver REPL de esta
carpeta, que la lanza vía Playwright (`playwright-core`, ya está en
devDependencies — alcanza con `npm install`).

Antes de elegir el driver, mirá si alcanza con lo que la app ya trae:

- `npm test` — selftest del motor (94 aserciones), sin ventana visible.
- `npm run shot` / `shot:puck` / `shot:canvas` / `shot:update` — capturas de
  estados fijos, sin Playwright. El modo `demo` dibuja trazos sintéticos **con
  presión variable**, cosa que el driver no puede hacer (ver Limitaciones).

El driver es para lo que eso no cubre: interactuar — clickear, elegir
herramienta, trazar, mirar el resultado.

## Correr

Por pipe (scripteado, ideal para agentes):

```bash
printf "launch\nbox\ntool m\nstroke 400 300 800 600\nss trazo\nquit\n" | node .claude/skills/run-scrawl/driver.mjs
```

Interactivo: `node .claude/skills/run-scrawl/driver.mjs` y escribir comandos.

Las capturas caen en `.shots/` (gitignoreado). Coordenadas en px CSS de la
ventana; `box` imprime el rectángulo del lienzo para apuntar adentro.

## Comandos

| comando | qué hace |
|---|---|
| `launch [ruta.scrawl]` | abre la app y espera `#sc-app.ready` + 1.2s de asentamiento; con una ruta, abre ese dibujo (la única forma de tener un documento CON ruta sin el diálogo nativo) |
| `ss [nombre]` | captura → `.shots/<nombre>.png` |
| `box` | rectángulo del lienzo `#sc-canvas` |
| `wins` / `win <n>` | lista las ventanas abiertas / apunta los demás comandos a la n-ésima (0 = la primera; espera su `ready`) |
| `wait <ms>` | pausa — para dejar que un modal termine de cerrarse antes de seguir tecleando |
| `tool <tecla>` | herramienta por atajo: b p m a e l g i h |
| `hover <x> <y>` | mueve el puntero sin apretar |
| `down` / `move <x> <y> [pasos]` / `up` | gesto por partes — permite capturar A MITAD de un trazo, con el botón apretado |
| `stroke <x1> <y1> <x2> <y2>` | gesto completo de una vez |
| `pos` | posición del puntero en coords de documento (`#sc-st-pos`) |
| `click <sel>` / `press <tecla>` / `type <texto>` | DOM click / teclado |
| `text [sel]` / `eval <js>` | leer texto / evaluar en la página |
| `evalmain <js>` | evaluar en el proceso principal, con `app`, `BrowserWindow`, `Menu`, `clipboard` a mano — `BrowserWindow.getAllWindows()[0].close()` es el camino de Alt+F4 y la barra de tareas |
| `quit` | cierra la app y sale |

## Gotchas (todos pasaron de verdad)

- **`ELECTRON_RUN_AS_NODE` heredado del entorno del agente**: con eso Electron
  arranca como Node pelado y no hay ventana jamás. El driver lo saca del env.
- **Lock de instancia única**: el lock de Electron se deriva de la carpeta
  `userData`, así que el driver le da a la copia de prueba una propia
  (`SCRAWL_USER_DATA`, que `main.js` honra) y convive con la app instalada
  aunque esté abierta. Antes había que cerrar la app real, y un doble clic en
  un `.scrawl` aterrizaba en la ventana de prueba; ahora cada una tiene su lock.
  Si `launch` da timeout igual, `Get-Process electron,Scrawl` dice quién corre.
- **Varias ventanas**: `press Control+T` abre otra; `win 1` apunta el driver a
  ella. Cambiar de ventana en el driver NO le da el foco en el sistema — las
  teclas llegan igual por CDP — así que una captura de la ventana que quedó
  tapada puede mostrar un toast viejo: con la ventana ocluida Chromium frena
  sus timers y el toast no se va hasta que vuelva al frente. No es un bug de la
  app. La ventana nueva sale en cascada (+40,+40) sobre la que la abrió, con su
  mismo tamaño, o maximizada si aquella lo estaba.
- **Teclear justo después de cerrar un modal**: el velo tarda en irse y se come
  el atajo o el trazo. Un `wait 400` después de `Apply` lo resuelve.
- **Los aceleradores nativos no se pueden probar con `press`**: el teclado de
  CDP entra directo a la página y se saltea la tabla de aceleradores del menú.
  Por eso `press Control+r` nunca recargó ni con el menú por defecto puesto — la
  prueba de que ya no hay menú es `evalmain Menu.getApplicationMenu() === null`.
  Fuera de `--dev` la app no tiene menú de aplicación.
- **Cerrar una ventana sucia pregunta**: `press Control+w` o un `close()` desde
  `evalmain` abren el modal "Unsaved changes" en vez de cerrar. Los botones son
  `.sc-modal .sc-btn--danger` (Don't save), `.sc-btn--ghost` (Cancel) y
  `.sc-btn--primary` (Save). Con la última ventana cerrada la app termina y los
  comandos siguientes fallan con "Target page ... has been closed": es la señal
  de que cerró, no un error.
- **Los diálogos nativos de archivo no se manejan**: para probar guardar,
  `launch` con una ruta; ahí Ctrl+S y el "Save" del cierre escriben en silencio.
- **`quit` destruye las ventanas antes de cerrar**: `app.close()` es un
  `app.quit()`, y con una ventana sucia el guard lo frena — la pregunta queda
  abierta y el driver se cuelga esperando. Por eso `quit` hace `destroy()`
  primero. Si un script se cuelga en `quit`, es esto.
- **`grep` sobre la salida del driver la bufferiza**: por pipe no es TTY, así que
  no se ve nada hasta que termina. Con `grep --line-buffered` (o sin grep) la
  salida va llegando.
- **Señal de listo**: `boot()` pone la clase `ready` en `#sc-app`; después
  quedan el fade del splash y el reposicionamiento de la ventana (nace
  off-screen en -20000 y se mueve a los 200ms). El driver ya espera todo eso.
  Las capturas salen bien aunque la ventana esté off-screen: capturan
  contenido, no pantalla.
- **El portapapeles es el del sistema**: copiar una capa desde la copia de
  prueba pisa lo que el usuario tuviera copiado, igual que en la app real.
- **Verificar posiciones con `pos`, no con los píxeles del trazo**: el trazo
  pintado persigue al puntero con retardo (suavizado exponencial), así que el
  anillo del pincel va apenas adelante de la tinta. Es lo esperado.

## Limitaciones

- El mouse sintético de CDP llega con `pressure` fija (la app la fuerza a 1):
  la dinámica de presión **no** se puede validar con el driver. Para eso está
  `npm run shot` (modo demo, presión sintética real) o una tablet de verdad.
