# Scrawl

Dibujo con tablet gráfica y anotación de capturas. Reemplazo de Adobe Sketchbook.
Electron 40, sin bundler, sin dependencias más allá de Electron.

```bash
npm start
```

| Comando | Qué hace |
| --- | --- |
| `npm start` | Abre la app |
| `npm run dev` | Abre con DevTools |
| `npm test` | Autotest del motor (44 aserciones, sale con código 1 si algo falla) |
| `npm run shot` | Abre, dibuja trazos de muestra, guarda `.shots/ui.png` y cierra |
| `npm run shot:puck` | Lo mismo, con el puck de navegación abierto sobre el dibujo |
| `npm run icons` | Regenera `build/icon.png` + `.ico` desde la curva de la marca (necesita ImageMagick) |
| `npm run build` | Instalador NSIS + portable en `dist/` |

## Atajos

| | |
| --- | --- |
| `B` `P` `M` `A` `E` | Pincel, lápiz, marcador, aerógrafo, borrador |
| `L` `G` `I` `H` | Línea recta, relleno, cuentagotas, mano |
| `[` `]` | Tamaño del pincel (también `Alt`+rueda) |
| `Alt` (mantener) | Cuentagotas temporal |
| `Espacio` (mantener) | Puck de navegación: arrastrar el núcleo hace zoom, el resto desplaza |
| `Shift`+arrastrar | Línea recta con el pincel actual |
| Dar vuelta el lápiz | Borrador |
| `X` | Alternar con el color anterior |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Deshacer / rehacer |
| `Del` | Vaciar la capa |
| Rueda | Zoom · `Ctrl+0` encajar · `Ctrl+1` al 100% |
| `Tab` | Ocultar los paneles |
| `Ctrl+Shift+N` `Ctrl+J` `Ctrl+E` | Capa nueva, duplicar, aplastar |
| `Ctrl+S` `Ctrl+O` `Ctrl+Shift+E` | Guardar `.scrawl`, abrir, exportar PNG |
| `Ctrl+V` | Pegar una captura del portapapeles como capa nueva |

Sobre un documento vacío, pegar ajusta el lienzo al tamaño exacto de la captura —
anotar una captura tiene que exportar esa captura, no la captura flotando en un
lienzo de otra medida. Con algo ya dibujado el lienzo solo crece, lo justo para que
la imagen entre sin recortarse, y la imagen cae centrada.

Pegar acepta las dos formas en que un capturador deja una captura: los píxeles, o la
ruta del archivo que guardó. ShareX viene configurado de fábrica para lo segundo, y
una app que solo pide bitmap ve el portapapeles vacío justo cuando la captura está
ahí — los chats la pegan igual porque saben leer archivos, así que el síntoma parece
un bug de la app y no una diferencia de formato.

## Estructura

```
main.js              ventana (anti-flash), protocolo scrawl://, diálogos, portapapeles
preload.js           el puente, superficie mínima
renderer/
  index.html         el layout, más el splash inline que mata el FOUC
  css/scrawl.css     design system: tokens, controles propios
  js/app.js          orquestador: qué pasa cuando el stylus se apoya
  js/engine/
    doc.js           documento, capas, composición (caché below + región)
    viewport.js      escala, desplazamiento, dibujado en pantalla
    brush.js         presets, punta pre-renderizada, capa wet, rasterizado
    stroke.js        pointer events, presión, suavizado, curvas
    history.js       undo/redo por bounding box
    fill.js          flood fill por líneas
  js/ui/             icons, controls, tooltips, titlebar, color, layers, brushpanel, puck
  js/dev/selftest.js el autotest
```

## Las cuatro decisiones que explican el resto

**El chrome es gris neutro puro, sin un grado de tinte.** No es minimalismo: en una
app de dibujo cualquier color en la interfaz recalibra el ojo y te miente sobre el
color del lienzo. Un panel apenas azulado hace que tu gris parezca cálido. El único
color de la UI es el ámbar del acento.

**El trazo en curso vive en una capa aparte (el wet) y recién se aplica a la capa al
soltar.** Si se pintara directo con opacidad 40%, cada cruce del trazo consigo mismo
quedaría al 64% y verías manchas oscuras en cada superposición. Con el wet, la
opacidad se aplica una sola vez al trazo entero. El autotest lo verifica comparando
el alpha en el cruce contra el de los brazos.

**El historial guarda el rectángulo que el trazo tocó, no el lienzo.** Un garabato de
200×200 en un documento de 1920×1200 cuesta 160 KB en vez de 9 MB. El límite es de
memoria (512 MB), no de cantidad de pasos: contar pasos no dice nada cuando cincuenta
toques chicos ocupan menos que un relleno.

**El input usa `getCoalescedEvents()`.** La tablet muestrea a 200-300 Hz pero el
navegador entrega `pointermove` una vez por frame. Los puntos intermedios quedan
coalescidos dentro del evento y solo se ven llamando a esa API. Sin eso, un trazo
rápido sale con esquinas visibles porque estás dibujando 1 de cada 4 puntos que la
tablet reportó. Es la razón por la que muchos canvas web se sienten baratos con tablet.

## Verificación

`npm test` prueba el motor sin la interfaz: undo exacto, la capa wet, la respuesta a
la presión, que recomponer una región dé idéntico resultado que recomponer todo,
borrador, flood fill, capas, el round-trip de guardado, la evicción del historial y
que deshacer un pegado devuelva también el tamaño del lienzo.

`npm run shot` es la contraparte visual: abre la app, dibuja una muestra con cada
pincel usando presión variable y guarda un PNG. Un cambio en el rasterizado se
comprueba abriendo ese PNG.

## Pendiente

- Anotación de capturas: atajo global de captura de pantalla, flechas, texto, recorte
- Modal de tamaño de lienzo (el motor ya soporta `doc.resize`)
- Estabilizador de trazo tipo *lazy brush* para líneas largas
- Transformar una selección (mover, escalar, rotar)
- Persistir los ajustes de pincel entre sesiones
- Ícono de la app y empaquetado
