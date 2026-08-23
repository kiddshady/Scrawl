---
name: run-scrawl
description: Lanzar y manejar la app real de Scrawl para verificar un cambio con los ojos — sacar screenshots, elegir herramientas, simular trazos (incluso frenando a mitad de un gesto). Usala siempre que haya que correr/abrir/probar la app, capturar su UI, o confirmar que un cambio funciona en la app de verdad y no solo en el selftest.
---

Scrawl es una app Electron de una sola ventana. Para uso desde un agente se
maneja con el driver REPL de esta carpeta, que la lanza vía Playwright
(`playwright-core`, ya está en devDependencies — alcanza con `npm install`).

Antes de elegir el driver, mirá si alcanza con lo que la app ya trae:

- `npm test` — selftest del motor (85 aserciones), sin ventana visible.
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
| `launch` | abre la app y espera `#sc-app.ready` + 1.2s de asentamiento |
| `ss [nombre]` | captura → `.shots/<nombre>.png` |
| `box` | rectángulo del lienzo `#sc-canvas` |
| `tool <tecla>` | herramienta por atajo: b p m a e l g i h |
| `hover <x> <y>` | mueve el puntero sin apretar |
| `down` / `move <x> <y> [pasos]` / `up` | gesto por partes — permite capturar A MITAD de un trazo, con el botón apretado |
| `stroke <x1> <y1> <x2> <y2>` | gesto completo de una vez |
| `pos` | posición del puntero en coords de documento (`#sc-st-pos`) |
| `click <sel>` / `press <tecla>` / `type <texto>` | DOM click / teclado |
| `text [sel]` / `eval <js>` | leer texto / evaluar en la página |
| `quit` | cierra la app y sale |

## Gotchas (todos pasaron de verdad)

- **`ELECTRON_RUN_AS_NODE` heredado del entorno del agente**: con eso Electron
  arranca como Node pelado y no hay ventana jamás. El driver lo saca del env.
- **Lock de instancia única**: si Scrawl ya está abierto, la copia de prueba se
  cierra en silencio y `launch` da timeout. Cerrar la app real primero
  (`Get-Process electron` para chequear de quién es cada proceso — otros
  proyectos también corren Electron). Mientras el driver corre, un doble clic
  en un `.scrawl` aterriza en la ventana de prueba, porque el lock lo tiene ella.
- **Señal de listo**: `boot()` pone la clase `ready` en `#sc-app`; después
  quedan el fade del splash y el reposicionamiento de la ventana (nace
  off-screen en -20000 y se mueve a los 200ms). El driver ya espera todo eso.
  Las capturas salen bien aunque la ventana esté off-screen: capturan
  contenido, no pantalla.
- **Verificar posiciones con `pos`, no con los píxeles del trazo**: el trazo
  pintado persigue al puntero con retardo (suavizado exponencial), así que el
  anillo del pincel va apenas adelante de la tinta. Es lo esperado.

## Limitaciones

- El mouse sintético de CDP llega con `pressure` fija (la app la fuerza a 1):
  la dinámica de presión **no** se puede validar con el driver. Para eso está
  `npm run shot` (modo demo, presión sintética real) o una tablet de verdad.
