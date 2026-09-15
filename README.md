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
| `npm test` | Autotest del motor (104 aserciones, sale con código 1 si algo falla) |
| `npm run smoke:selection` | Smoke real de toolbar, arrastre, borrar, undo y deseleccionar |
| `npm run shot` | Abre, dibuja trazos de muestra, guarda `.shots/ui.png` y cierra |
| `npm run shot:puck` | Lo mismo, con el puck de navegación abierto sobre el dibujo |
| `npm run shot:selection` | Lo mismo, con un fragmento seleccionado sobre los trazos |
| `npm run shot:canvas` | Captura el diálogo de tamaño de lienzo abierto |
| `npm run shot:update` | Captura el aviso de actualización con un estado simulado |
| `npm run icons` | Regenera `build/icon.png` + `.ico` desde la curva de la marca (necesita ImageMagick) |
| `npm run build` | Instalador NSIS + portable en `dist/` |
| `npm run release` | Lo mismo, y lo publica como release de GitHub (necesita `GH_TOKEN`) |

## Atajos

| | |
| --- | --- |
| `B` `P` `M` `A` `E` | Pincel, lápiz, marcador, aerógrafo, borrador |
| `L` `G` `I` `S` `H` | Línea recta, relleno, cuentagotas, selección rectangular, mano |
| `[` `]` | Tamaño del pincel (también `Alt`+rueda) |
| `Alt` (mantener) | Cuentagotas temporal |
| `Espacio` (mantener) | Puck de navegación: arrastrar el núcleo hace zoom, el resto desplaza |
| `Shift`+arrastrar | Línea recta con el pincel actual |
| Dar vuelta el lápiz | Borrador |
| `X` | Alternar con el color anterior |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Deshacer / rehacer |
| `Del` | Borrar la selección; sin una selección, vaciar la capa |
| Rueda | Zoom (también `+` `-`, con o sin `Ctrl`) · `Ctrl+0` encajar · `Ctrl+1` al 100% |
| `Tab` | Ocultar los paneles |
| `Ctrl+Shift+N` `Ctrl+J` `Ctrl+E` | Capa nueva, duplicar, aplastar |
| `Ctrl+S` `Ctrl+O` `Ctrl+Shift+E` | Guardar `.scrawl`, abrir, exportar PNG |
| `Ctrl+Shift+P` | Exportar PDF |
| `Ctrl+V` | Pegar una captura del portapapeles, a tamaño real, para acomodarla |
| `Ctrl+C` `Ctrl+X` | Copiar / cortar la selección de la capa activa; sin selección, `Ctrl+C` copia el dibujo entero |
| `Esc` | Deseleccionar |
| `Ctrl+T` `Ctrl+W` | Otra ventana (un segundo dibujo abierto a la vez, con la misma hoja) / cerrar esta — preguntando si hay cambios sin guardar |
| `Ctrl+Shift+C` | Copiar la capa activa, para pegarla como capa en otro dibujo (o en este) |
| `Enter` / `Esc` | Dejar caer la captura que se está acomodando / descartarla |
| Flechas | Empujarla de a un píxel (con `Shift`, de a diez) |
| `Ctrl+Alt+C` | Tamaño del lienzo (también clickeando la medida en la barra de estado) |

## Selección de fragmentos

`S` activa la selección rectangular. Se arrastra una caja sobre el lienzo y las
acciones trabajan únicamente sobre ese rectángulo de la **capa activa**: `Ctrl+C`
lo copia con transparencia, `Ctrl+X` lo copia y lo borra, y `Del` lo borra sin
copiar. Cortar y borrar son pasos de historial normales, así que `Ctrl+Z` devuelve
los píxeles exactos. `Esc` saca la selección.

El fragmento copiado viaja como imagen normal para cualquier otra aplicación y,
entre ventanas de Scrawl, además conserva nombre, opacidad, blend y posición. Al
pegarlo vuelve flotando en una capa nueva para poder moverlo o escalarlo antes de
dejarlo caer. Elegir otra herramienta cierra la selección: no funciona como una
máscara para pintar, su alcance deliberado es copiar, cortar y borrar regiones.

## Tamaño de impresión

**La app abre en A4 vertical a 300 DPI**, o sea 2480×3508. El default es imprimible
a propósito: un lienzo de pantalla obliga a acordarse de cambiarlo *antes* de
dibujar, y el que se olvida se entera al final, que es el peor momento posible. Al
revés no pasa nada — si lo que estabas haciendo no era para papel, el tamaño de más
no molesta.

`Ctrl+Alt+C` abre el diálogo de tamaño de lienzo: papel (A3 a A6, B5, Letter, Legal,
Tabloid), orientación, densidad y qué pasa con lo que ya está dibujado — dónde queda
anclado, o si se escala para entrar entero.

Lo que hace que la promesa se cumpla no son los píxeles sino los **DPI, que viajan
con el documento**. Un lienzo son dos números: los milímetros de la hoja y cuántos
píxeles entran en cada pulgada. Sin el segundo, una A4 a 300 DPI se exportaría como
una página de 87 cm de ancho — la imagen medida a los 96 DPI de la pantalla — y
habría que reescalarla en el diálogo de impresión, que es justo lo que esto existe
para evitar. Con el papel declarado, la página del PDF sale de la hoja exacta
(595.28 × 841.89 pt para una A4) y no del redondeo de los píxeles.

Achicar el lienzo recorta, pero `Ctrl+Z` devuelve hasta el último píxel: el paso de
historial se queda con los canvas que el redimensionado descartó, así que no cuesta
una sola copia. Y `Ctrl+N` hereda la medida, porque quien se armó una A4 quiere la
siguiente hoja igual.

**La captura entra a tamaño real y se acomoda antes de aterrizar.** Pegar no toca
el lienzo: la imagen queda flotando encima, 1:1 en píxeles del documento, con una
caja de cuatro tiradores. Se arrastra a donde vaya, se escala desde las esquinas —
siempre proporcional, una captura estirada es una captura arruinada — y recién
entonces `Enter` la deja caer en una capa nueva. `Esc` la descarta sin dejar rastro,
y `Ctrl+Z` deshace el aterrizaje. La barrita que cuelga de la caja dice cuánto mide y
a qué escala quedó; tocando ese número vuelve al 100%.

Lo que sobresale del lienzo se dibuja apagado mientras se acomoda: es exactamente lo
que se va a perder al soltar, y verlo es la única forma de decidir el encuadre. Si la
caja no entra en la ventana, la vista se aleja sola hasta que entre — sus tiradores
son el único control para achicarla, y fuera de pantalla no sirven.

"A tamaño real" es 1:1 en píxeles del **documento**, no en milímetros. Un lienzo de
impresión tiene más píxeles por pulgada que la pantalla, así que igualar el tamaño
físico obligaría a agrandar la captura tres veces — justo el remuestreo que esto
existe para no hacer. Entra sin tocar un píxel y de ahí la escala la elige la mano.

Antes de esto el lienzo se acomodaba a la imagen: sobre un documento intacto, pegar
lo dejaba midiendo la captura exacta. Resolvía un solo caso — abrir la app para
anotar una captura y exportar esa captura — y el resto del tiempo secuestraba la
hoja: quien se armó una A4 para meter dos capturas adentro se encontraba con que la
primera se llevaba puesto el documento, sin forma de correrla ni de achicarla
después. Ahora la A4 sigue siendo una A4, con su densidad y su etiqueta intactas, y
la captura es un objeto adentro de la hoja.

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

## Dos dibujos a la vez

`Ctrl+T` abre **otra ventana**, con su propio dibujo, su historial y su vista. No
son pestañas dentro de una ventana a propósito: dos ventanas se pueden poner una
al lado de la otra — la referencia en una, el trabajo en la otra — y cada una es
un `app.js` entero corriendo aparte, así que el motor de dibujo no se enteró del
cambio. La nueva hereda la hoja de la que la abrió, igual que `Ctrl+N`, y si esa
estaba maximizada, la nueva también: quien trabaja a pantalla completa con la
tableta quiere la segunda hoja igual. El nombre del documento va al título de la
ventana, que la app no muestra pero `Alt+Tab` y la barra de tareas sí.

Entre las dos se pasa por el portapapeles. Sin una selección, `Ctrl+C` sigue
copiando el dibujo aplastado, como siempre; **`Ctrl+Shift+C` copia solo la capa
activa**, y al
pegarla con el `Ctrl+V` de siempre vuelve como capa: con su nombre, su opacidad,
su blend, y **en el mismo punto del lienzo** del que salió si las dos hojas miden
lo mismo (si no, se centra en lo que se está viendo, como cualquier pegado).
Flota igual que una captura, así que antes de soltarla se la puede correr o
escalar — que de paso es la forma de mover un dibujo dentro de la misma hoja:
copiar la capa, pegar, arrastrar, `Enter`.

Va recortada a lo pintado, no la hoja entera. Un garabato de 300×200 en una A4
viaja como un PNG de 300×200 y no como uno de 2480×3508 casi vacío, y la caja con
la que se acomoda abraza el dibujo en vez de medir todo el lienzo. El recorte
viaja con la capa para que el aterrizaje sea exacto. Una capa vacía no se copia:
la app lo dice y deja el portapapeles como estaba.

Cómo viaja es lo único no obvio. Electron no deja poner un formato propio junto
a una imagen en el portapapeles — cada escritura lo vacía — así que la capa se
escribe de dos formas **a la vez**: la imagen de siempre, para que cualquier
otra app la pegue como un PNG con transparencia, y un HTML con un `<img>` que
lleva ese mismo PNG adentro más la marca de la capa en un atributo. Al pegar,
Scrawl mira primero si el HTML trae su marca; si no, sigue el camino de siempre,
que no cambió: el HTML que deja un navegador al copiar una foto no la tiene. Los
píxeles se leen del HTML y no del bitmap del sistema, así que llegan los bytes
exactos que salieron. Un texto plano con el JSON habría sido más simple, pero
aparecería como basura en cualquier campo de texto donde uno pegara después.

Lo que un `.scrawl` abierto desde el explorador hace con varias ventanas es lo
mismo que hacía con una: entra en la última que tuvo foco, reemplazando el
dibujo que hubiera ahí. Y reiniciar para actualizar cierra todas, así que si
otra ventana tiene trabajo sin guardar, la app no reinicia y lo dice.

## Cerrar sin perder nada

Cerrar una ventana con un dibujo sin guardar **pregunta**: *Save*, *Don't save*
o *Cancel*. Vale para todos los caminos — la X de la barra, `Alt+F4`, `Ctrl+W`,
la barra de tareas, reiniciar para actualizar — porque el que frena es el
proceso principal, que es el único que los ve todos; la ventana solo pone el
diálogo y contesta. Un dibujo limpio se cierra sin preguntar, como siempre. En
el diálogo *Don't save* va apartado a la izquierda, lejos de *Save*: descartar
un dibujo no puede estar a un píxel de guardarlo. `Enter` guarda, `Esc` cancela,
y si el diálogo de archivo se cancela la ventana se queda abierta.

Lo que motivó esto fue el miedo a cerrar la app por accidente durante un
parcial, y al mirar por dónde se podía cerrar apareció algo peor. La ventana no
tiene frame, así que nunca se vio un menú, pero **el menú por defecto de
Electron existía igual** y sus aceleradores llegaban: `Ctrl+R` recargaba la
página — el dibujo entero, sin undo ni aviso —, `Ctrl+W` cerraba sin preguntar,
`Ctrl+M` minimizaba, `F11` pantalla completa, `Ctrl+Shift+I` DevTools. Y
`Ctrl+Plus` / `Ctrl+Minus` hacían zoom de la **interfaz**, no del lienzo;
Chromium se lo acuerda por origen entre sesiones y `Ctrl+0` no lo revertía
porque la app lo usa para encajar el lienzo, así que un toque accidental dejaba
la UI agrandada para siempre. Ese menú ya no está (salvo con `--dev`, donde
recargar y abrir DevTools sirven), el zoom de página se fuerza a 1 al cargar por
si ya había quedado pegado, y lo que la app quiere de esas teclas lo maneja
ella: `Ctrl+W` cierra pasando por la pregunta, `Ctrl+Plus` / `Ctrl+Minus` hacen
zoom del lienzo igual que `+` / `-`.

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
main.js              ventanas (anti-flash, cascada), protocolo scrawl://, diálogos, portapapeles
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
                     puck, modal, canvassize, update, placebar, closeguard
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
borrador, flood fill, capas, el round-trip de guardado, la evicción del historial,
que deshacer un pegado devuelva también el tamaño del lienzo, y que el recorte con
el que viaja una capa copiada sea exacto — que no se coma el último píxel ni tome
por vacío uno apenas visible.

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
