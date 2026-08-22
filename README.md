# Scrawl

Dibujo con tablet gráfica y anotación de capturas. Reemplazo de Adobe Sketchbook.
Electron 40, sin bundler. La única dependencia de runtime es `electron-updater`,
para que las versiones nuevas lleguen solas.

```bash
npm start
```

| Comando | Qué hace |
| --- | --- |
| `npm start` | Abre la app |
| `npm run dev` | Abre con DevTools |
| `npm test` | Autotest del motor (84 aserciones, sale con código 1 si algo falla) |
| `npm run shot` | Abre, dibuja trazos de muestra, guarda `.shots/ui.png` y cierra |
| `npm run shot:puck` | Lo mismo, con el puck de navegación abierto sobre el dibujo |
| `npm run shot:canvas` | Captura el diálogo de tamaño de lienzo abierto |
| `npm run shot:update` | Captura el aviso de actualización con un estado simulado |
| `npm run icons` | Regenera `build/icon.png` + `.ico` desde la curva de la marca (necesita ImageMagick) |
| `npm run build` | Instalador NSIS + portable en `dist/` |
| `npm run release` | Lo mismo, y lo publica como release de GitHub (necesita `GH_TOKEN`) |

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
| `Ctrl+Shift+P` | Exportar PDF |
| `Ctrl+V` | Pegar una captura del portapapeles como capa nueva |
| `Ctrl+Alt+C` | Tamaño del lienzo (también clickeando la medida en la barra de estado) |

## Tamaño de impresión

`Ctrl+Alt+C` abre el diálogo de tamaño de lienzo: papel (A3 a A6, B5, Letter, Legal,
Tabloid), orientación, densidad y qué pasa con lo que ya está dibujado — dónde queda
anclado, o si se escala para entrar entero. Elegir A4 a 300 DPI deja el lienzo en
2480×3508, que es lo que da cualquier otra herramienta.

Lo que hace que la promesa se cumpla no son los píxeles sino los **DPI, que viajan
con el documento**. Un lienzo son dos números: los milímetros de la hoja y cuántos
píxeles entran en cada pulgada. Sin el segundo, una A4 a 300 DPI se exportaría como
una página de 87 cm de ancho — la imagen medida a los 96 DPI de la pantalla — y
habría que reescalarla en el diálogo de impresión, que es justo lo que esto existe
para evitar. Con el papel declarado, la página del PDF sale de la hoja exacta
(595.28 × 841.89 pt para una A4) y no del redondeo de los píxeles.

Con tamaño de impresión puesto, el lienzo deja de moverse solo: pegar una captura ya
no lo redimensiona, la imagen entra escalada sobre la hoja. Y `Ctrl+N` hereda la
medida, porque quien se armó una A4 quiere la siguiente hoja igual.

Achicar el lienzo recorta, pero `Ctrl+Z` devuelve hasta el último píxel: el paso de
historial se queda con los canvas que el redimensionado descartó, así que no cuesta
una sola copia.

Sobre un documento vacío y sin tamaño de impresión, pegar ajusta el lienzo al tamaño
exacto de la captura — anotar una captura tiene que exportar esa captura, no la
captura flotando en un lienzo de otra medida. Con algo ya dibujado el lienzo solo
crece, lo justo para que la imagen entre sin recortarse, y la imagen cae centrada.

Pegar acepta las dos formas en que un capturador deja una captura: los píxeles, o la
ruta del archivo que guardó. ShareX viene configurado de fábrica para lo segundo, y
una app que solo pide bitmap ve el portapapeles vacío justo cuando la captura está
ahí — los chats la pegan igual porque saben leer archivos, así que el síntoma parece
un bug de la app y no una diferencia de formato.

El PDF se escribe a mano, sin librería: una página con una imagen adentro son seis
objetos y una tabla de posiciones, y meter jsPDF sería la primera dependencia de
runtime del proyecto para generar dos pantallas de bytes. La página mide lo que mide
el lienzo a su densidad — lo que se exporta es el dibujo a sangre, no el dibujo
pegado dentro de una hoja con márgenes. Un lienzo sin tamaño de impresión queda en
96 DPI y sale del tamaño al que lo veías al 100%. Los píxeles van sin pérdida
(DEFLATE sobre el RGB crudo, igual que un PNG) y la transparencia viaja como
`/SMask`.

## Actualizaciones

La app mira los releases de este repo al arrancar y cada seis horas. Si hay una
versión nueva se enciende una pastilla ámbar en la barra de estado y no pasa nada
más: no hay modal que aparezca solo, ni descarga que arranque sin permiso, ni
reinicio de sorpresa. Clickeándola aparecen las notas del release y el botón para
bajarla; una vez bajada se aplica al reiniciar, o sola la próxima vez que cierres
la app. Con un dibujo sin guardar, el diálogo lo dice y ofrece guardar primero.

Publicar una versión es `npm version <x.y.z>`, empujar el tag, y `npm run release`
con `GH_TOKEN` en el entorno. Eso sube los dos ejecutables **y el `latest.yml`**,
que es el archivo que el updater consulta: sin él, las apps instaladas no ven la
versión nueva por más que el release exista.

Conviene crear el release vacío **antes** de publicar:

```bash
gh release create v0.4.0 --draft --title "Scrawl 0.4.0 — lo que trae"
```

No es ceremonia: electron-builder publica un target a la vez y los dos corren a
crear el release, así que sobre el mismo tag pueden quedar dos — uno con los
ejecutables y un borrador suelto con el `.blockmap` adentro. Ese blockmap es lo
que deja bajar solo los pedazos que cambiaron en vez de los 90 MB enteros, así
que perderlo no rompe la actualización, solo la encarece, y por eso se pierde
sin que nadie lo note. Con el release ya existente, los dos targets suben ahí.

Dos límites que conviene tener presentes:

- **El portable no se actualiza solo.** Corre desde una extracción temporal y no
  hay instalación que reemplazar, así que meterle el instalador encima convertiría
  en instalado a alguien que eligió no estarlo. Ahí el aviso llega igual, pero
  lleva a la página del release.
- **Las versiones ya instaladas (≤ 0.3.1) no traen updater**, así que ese salto hay
  que darlo a mano una vez. De ahí en adelante se encadena solo.

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
    paper.js         tamaños de papel, mm ↔ px, reconocimiento del lienzo
    viewport.js      escala, desplazamiento, dibujado en pantalla
    brush.js         presets, punta pre-renderizada, capa wet, rasterizado
    stroke.js        pointer events, presión, suavizado, curvas
    history.js       undo/redo por bounding box
    fill.js          flood fill por líneas
    pdf.js           escritor de PDF de una página (filtro Up + DEFLATE, /SMask)
  js/ui/             icons, controls, tooltips, titlebar, color, layers, brushpanel,
                     puck, modal, canvassize, update
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

Del tamaño de impresión verifica la aritmética contra los números publicados (una A4
a 300 DPI son 2480×3508), que el reconocimiento cierre el círculo — lo que el módulo
genera lo tiene que volver a llamar por su nombre, en las ocho hojas por dos
orientaciones por cuatro densidades — y lo que se rompería en silencio: que deshacer
un lienzo achicado devuelva los píxeles que el recorte tiró, mirando uno que solo
existe si nunca se perdió.

Del PDF verifica las dos cosas que lo romperían en silencio — un archivo que pesa lo
que tiene que pesar y recién no abre en el visor del otro: que cada posición de la
tabla xref caiga justo en su objeto, y que los píxeles vuelvan idénticos después de
descomprimir y deshacer el filtro.

`npm run shot` es la contraparte visual: abre la app, dibuja una muestra con cada
pincel usando presión variable y guarda un PNG. Un cambio en el rasterizado se
comprueba abriendo ese PNG.

## Pendiente

- Firmar el ejecutable: sin firma, Windows SmartScreen avisa en cada instalación
- Anotación de capturas: atajo global de captura de pantalla, flechas, texto, recorte
- Estabilizador de trazo tipo *lazy brush* para líneas largas
- Transformar una selección (mover, escalar, rotar)
- Persistir los ajustes de pincel entre sesiones
- Ícono de la app y empaquetado
