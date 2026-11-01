# AJ · Rent a Car — interfaz Next.js

## Interfaz operativa actual

El modo Supabase tiene ocho entradas principales: **Inicio, Clientes, Vehículos, Calendario, Taller, Presupuestos, Cargos y cobros y Libro diario**. Inicio muestra el resumen del negocio. Vehículos tiene una única barra: **Toda la flota, Disponibles, Alquilados y Reservados**. Taller reúne mecánica, pintura y tareas.

Los cuatro Excel privados se consultan como datos organizados y paginados en **Archivo original**, dentro de Calendario, Presupuestos, Cargos y cobros y Libro diario. Se conserva la descarga sin modificaciones. Las tablas se convierten en fichas con encabezados en pantallas pequeñas; no requieren desplazamiento horizontal. Presupuestos permite elegir cliente, vehículo y trabajo sin registrar una recepción física previa, con materiales, mano de obra, versiones, aprobación y PDF.

Se conservan sesión y permisos/RLS, expedientes por vehículo y operación, fotos privadas, versiones y aprobación de presupuestos, alquileres abiertos, cobros y aplicaciones, importación conciliada de gastos/pagos y diario sin duplicar caja. Los módulos secundarios siguen disponibles por sus rutas autorizadas; no se eliminaron sus datos ni sus API. Detalles y límites: [`docs/OPERATIONAL_FIT.md`](docs/OPERATIONAL_FIT.md).

**La limpieza autorizada ya se aplicó tras un respaldo completo y un ensayo con rollback.** Se preservaron usuarios, roles, configuración, auditoría y originales. La base contiene **16 clientes, 27 vehículos de flota y un Nissan Rogue 2018 sin placa verificada**, más el presupuesto de Rafael Vargas de **27 partidas por $2.190**. Propiedad, disponibilidad, kilometraje y tarifas no confirmados se muestran como pendientes; pueden completarse con evidencia en la ficha. Los importes históricos de abonos/saldos no se publicaron como caja ni deuda. De las 557 observaciones originales, 54 están vinculadas y 503 pendientes; ninguna se publicó como movimiento financiero.

- Estado por historia y evidencia: [`docs/ESTADO_HU.md`](docs/ESTADO_HU.md).
- Entorno, credenciales locales y validación: [`docs/LOCAL_SUPABASE.md`](docs/LOCAL_SUPABASE.md).
- `npm test` ejecuta también el SQL y las políticas RLS con PostgreSQL embebido (PGlite); no sustituye las pruebas HTTP/Auth/concurrencia de Supabase.
- `node scripts/verify-real-workspace.mjs` verifica las nuevas RPC y sus vínculos en PostgreSQL local con rollback, sin dejar registros de prueba.
- `node scripts/verify-real-api.mjs` comprueba Auth, permisos/endpoints y descarga idéntica de los cuatro originales sin publicar movimientos.
- `.venv\Scripts\python.exe -B tests/browser/usability_acceptance.py` revisa los ocho módulos, originales, paginación y desbordamiento de página/contenedores a 320/390/768/1440 px sin crear registros de negocio.
- Las suites antiguas `test:local`, `test:roles`, `acceptance.py`, `rentals_acceptance.py` y `operational_fit_acceptance.py` generan fixtures: no ejecutarlas contra esta base limpia.

El bloqueo de disco fue resuelto. Supabase AJ funciona en los puertos 55321/55322; las pruebas HTTP/Auth/RLS y de concurrencia pasan contra esa instancia. `.env.local` contiene las credenciales del propietario local, sin claves privadas en el bundle. Studio y Storage no se inician por defecto. **Advertencia:** Docker Desktop publica los puertos en todas las interfaces pese a la opción de red local; usá únicamente una red de confianza y no expongas este entorno de desarrollo públicamente.

Para probar la versión operativa: `npm run local:start`, `npm run local:migrate`, `npm run local:setup` y `npx next dev --hostname 127.0.0.1 --port 3030`. Abrí http://127.0.0.1:3030. La guía de importación está en [`docs/IMPORTACIONES.md`](docs/IMPORTACIONES.md).

## Referencia del prototipo demo

Las secciones siguientes describen únicamente el modo **demo** original, no la interfaz operativa actual. Sus limitaciones de persistencia y seguridad no describen los comandos SQL de Supabase.

Prototipo interactivo de 12 pantallas. Next.js App Router, React, TypeScript, componentes shadcn/ui basados en Radix, Tailwind CSS, Recharts y GSAP. No necesita credenciales para probarlo.

## Ejecutar

Requisitos: Node.js 20.9 o superior y npm. Probado con Node 24.

```bash
npm ci
npm run dev
```

Abrí http://localhost:3000/inicio. Para validar:

```bash
npm run typecheck
npm test
npm run build
```

`next.config.ts` exporta archivos estáticos a `out/` para esta demostración. Para usar Route Handlers, Server Actions o sesiones SSR en la siguiente versión, quitar `output: 'export'` y desplegar Next.js con runtime de servidor. La variante estática también puede usar Supabase Auth en navegador y Edge Functions externas; nunca agregar claves privadas al bundle.

## Rediseño AJ

Identidad roja y azul, navegación azul profundo, degradados, tipografía Manrope local, tarjetas de flota con renders realistas y portada animada. Los recursos visuales están incluidos; no dependen de enlaces externos. GSAP anima entradas escalonadas, la llegada del carro de portada y su respuesta al puntero, con limpieza por ruta y respeto a `prefers-reduced-motion`.

Los carros son renders rasterizados con apariencia 3D y efecto de profundidad; no son modelos GLB giratorios ni fotos de los vehículos registrados. Hay cinco recursos: SUV rojo de portada, sedán plata, SUV blanco, pickup gris y compacto rojo. El catálogo usa ilustraciones por categoría. Ver `docs/DISENO_AJ.md` para tokens, componentes y recursos.

## Pantallas

| Ruta | Experiencia |
| --- | --- |
| `/inicio` | KPIs, ingresos/egresos, flota, movimientos y pendientes |
| `/calendario` | Timeline semanal por carro, semana anterior/siguiente, vista lista, detalle de reservas |
| `/vehiculos` | Catálogo filtrable, nueva unidad, expediente con historial y egresos |
| `/taller` | Kanban por etapa, entrada, egresos, tiempo y avance de órdenes |
| `/presupuestos` | Listado, cálculo de líneas, costo/precio/margen, borrador y aprobación demo |
| `/libro-diario` | Filtros por fecha/tipo/área, registrar egreso, exportación e importación CSV/XLSX |
| `/clientes` | Directorio, registro y detalle con operaciones y saldo |
| `/cobros` | Saldos, vencidos y abonos conectados con el diario |
| `/inventario` | Existencias, mínimos, nuevos artículos y reposición demo |
| `/reportes` | Gráficos, resumen y exportaciones CSV |
| `/asistente` | Simulador determinista con fuentes y formularios de acción |
| `/configuracion` | Preferencias locales, estado de conexiones y restauración de datos |

La raíz muestra el inicio. Ctrl/Cmd+K abre la búsqueda global. Datos ficticios con corte fijo al 20 de octubre de 2026. Se guardan en localStorage por navegador; podés restaurarlos desde Configuración.

## Organización solicitada

```text
src/
  app/
    layout.tsx
    page.tsx
    inicio/page.tsx
    calendario/page.tsx
    vehiculos/page.tsx
    taller/page.tsx
    presupuestos/page.tsx
    libro-diario/page.tsx
    clientes/page.tsx
    cobros/page.tsx
    inventario/page.tsx
    reportes/page.tsx
    asistente/page.tsx
    configuracion/page.tsx
  components/
    ui/            # Primitivas shadcn: Button, Dialog; extensión con CLI
    atoms/         # Badge, VehicleArt
    molecules/     # PageHeading, StatCard
    organisms/     # Tablas, gráficos, formularios, importación, expediente
    templates/     # Shell y composición de cada pantalla
  controladores/   # Funciones puras reutilizables, cálculos, reservas, pagos, reportes
  datos/           # Fixture de demostración
  hooks/           # Estado y persistencia local de la demo
  lib/supabase/    # Constructor del cliente preparado, aún no conectado
  types/           # Entidades compartidas
```

Los `page.tsx` solo componen la pantalla. Atomic Design clasifica componentes por responsabilidad; no impone crear envoltorios para cada etiqueta HTML. Las primitivas shadcn se conservan en `ui/` y los átomos de negocio en `atoms/`. `components.json` está configurado para agregar componentes oficiales con la CLI de shadcn.

## Recorridos que funcionan

1. Crear reserva: fechas y vehículo se validan; anticipo crea un ingreso. Un cruce rechaza la reserva.
2. Registrar egreso: aparece en diario, dashboard y expediente del vehículo por su operación.
3. Abonar: reduce cartera, actualiza pago del alquiler/orden y genera un movimiento del diario.
4. Crear presupuesto: líneas, costo/precio unitario, cantidad y descuento recalculan margen. Aprobar actualiza precio de la orden.
5. Taller: nueva orden, registrar horas, registrar egreso y mover etapas.
6. Excel: primera hoja con columnas de la plantilla, vista previa, errores y coincidencias exactas antes de publicar. Descargar plantilla desde el diálogo. Solo importar archivos propios/de confianza en este prototipo.
7. Buscar clientes/vehículos, filtrar tablas y descargar CSV. Los CSV se escapan para reducir fórmulas en hojas de cálculo.
8. Asistente: respuestas predefinidas recalculadas con los datos locales y con referencias. No es un LLM real.

## Qué todavía debe integrarse

La maqueta no incluye autenticación real, RLS aplicado, persistencia compartida, transacciones SQL, carga de fotos, firma, contratos, comisiones, cierre con aprobación, compras contables, WhatsApp ni emisión fiscal. “Marcar enviado” no manda un mensaje. La reposición es un ajuste visual de stock; no es una compra. La entrega y devolución simplificadas solo cambian estados; la versión operativa debe validar inspección, saldo autorizado y conflictos al cambiar fechas. Los egresos de una orden no son su costo completo mientras falten horas costeadas y consumos. Todos los valores se expresan antes de impuestos cuando corresponda.

La importación actual es por plantilla fija, no un migrador universal de sus Excel: no recalcula fórmulas, no resuelve automáticamente clientes ni operaciones y usa coincidencias exactas para omitir filas. No implementa idempotencia/concurrencia de producción. Confirmar una aprobación en la demo no es evidencia legal de aceptación.

El cliente Supabase en `lib/supabase/client.ts` está preparado, pero ninguna pantalla lo activa. Agregar variables no cambia automáticamente la persistencia. Ver `docs/ARQUITECTURA_V1.md` para la migración y los contratos necesarios.

## Validación

Incluye pruebas de cálculo, cruces, intervalos contiguos, pago idempotente de demo, sobrepago y anticipo. Typecheck y build validan rutas y componentes. La sesión de creación no dispuso de herramienta de navegador para inspección visual ni pruebas de clics; esa parte queda pendiente. Recomendado: escritorio 1440×900 y móvil 390×844, navegación completa y recorridos anteriores.
