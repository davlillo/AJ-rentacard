# AJ · Diseño de interfaz

## Identidad

- Rojo principal: `#E52B40`; degradado de acciones de `#FA3F55` a `#DD243E`.
- Azul de navegación: `#0D1931`; azul de acento: `#3267EC`.
- Fondo: `#F5F6FA`; superficies: blanco; texto: `#17233D`.
- Tipografía: Manrope, pesos 400–800, incluida mediante @fontsource, sin solicitud a Google Fonts.
- Tarjetas: radios de 13–20 px, bordes fríos sutiles y sombras suaves.
- Estados conservan colores semánticos; los gráficos usan rojo y azul.

## Componentes

- `BrandHero`: portada de AJ con render rojo, accesos funcionales a reserva, calendario y flota.
- `AnimatedWorkspace`: GSAP, entradas escalonadas y parallax del carro. `gsap.matchMedia()` limita el movimiento por preferencias; `revert()` limpia al navegar.
- `VehicleArt`: renders locales por categoría, carga diferida en catálogo y expediente. Son ilustraciones, no fotografías del vehículo real.
- El resto conserva Atomic Design, `app/<pantalla>/page.tsx` y `controladores/`.
- Adaptaciones a 1600, 1280, 1100, 800, 600 y 380 px. Navegación móvil desplegable, tablas con desplazamiento horizontal y flota de una columna en móvil.

## Imágenes incluidas

Los cinco archivos en `public/images/` se generaron para esta propuesta con ImageGen. Se incluyen en el proyecto. Son renders PNG con transparencia y sombras suaves; no requieren APIs externas. No son modelos 3D interactivos ni garantizan coincidencia exacta con marca, año, modelo o color de cada registro.

| Archivo | Uso | Dirección del prompt |
| --- | --- | --- |
| `aj-red-suv.png` | Portada | SUV rojo metálico, vista frontal tres cuartos hacia la izquierda, iluminación de estudio y borde azul, transparente, sin logos ni texto. |
| `aj-silver-sedan.png` | Sedanes | Sedán compacto plata de proporciones realistas, tres cuartos, iluminación suave, transparente. |
| `aj-white-suv.png` | SUV | SUV blanco perlado, luces LED y ruedas detalladas, render de estudio transparente. |
| `aj-pickup.png` | Pickups | Pickup doble cabina gris grafito, proporciones de producción, detalles cromados, fondo transparente. |
| `aj-red-hatch.png` | Compactos | Hatchback rojo metálico con techo negro, vista tres cuartos, render realista transparente. |

Prompts completos: `docs/image-prompts.json`. Los PNG originales se conservan sin retoque de contenido.

## GSAP

Documentación primaria utilizada: https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/

Se usan `gsap.from`, `gsap.quickTo` y `matchMedia`, sin animaciones perpetuas. Las vistas se muestran sin JavaScript de animación; no dependen de una clase global `opacity: 0`. La preferencia de movimiento reducido desactiva entradas y parallax. El cambio de ruta revierte los efectos y elimina listeners del puntero.

## Verificación

La entrega se valida con TypeScript, pruebas de reglas de negocio y compilación estática de Next.js. La inspección interactiva de navegador no estuvo disponible en esta sesión. Revisar visualmente escritorio y móvil antes de usar como producto conectado.
