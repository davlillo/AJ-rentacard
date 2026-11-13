# Demostración operativa aislada de AJ

**Referencia histórica del entorno separado.** La carga actual está en la base habitual `postgres`, API `55321`, aplicación **http://127.0.0.1:3030**. Consulte [`LOCAL_WORKSPACE.md`](LOCAL_WORKSPACE.md). Los verificadores de esta página comparan el inventario anterior al reemplazo autorizado y ya no corresponden al estado actual; no ejecute sus restauraciones o fixtures para recuperar la carga habitual.

Abra **http://127.0.0.1:3040** y seleccione **Ingresar**. Hay siete vehículos ficticios con operaciones persistentes, imágenes ilustrativas, presupuestos versionados y dinero conectado entre expedientes, Cobros y Libro diario. No se utilizan respuestas simuladas de API. La interfaz no muestra carteles de entorno ni un recorrido de presentación.

## Preparar y abrir

Requiere las dependencias de npm instaladas, Docker Desktop y el PostgreSQL local de AJ existente. La primera preparación necesita Python con **Pillow 10.1 o superior**; se detecta primero `.venv` y después Python del sistema. Los renders se generan automáticamente desde `public/images/`, sin descargarlos ni modificar los originales.

```powershell
npm run showcase:setup
npm run showcase:dev
```

La preparación puede retomarse después de un fallo: conserva las claves idempotentes y los resultados confirmados. Una carga completa se reutiliza; no se vuelve a insertar al iniciar el servidor. `showcase:dev` no restaura los cambios realizados durante una presentación.

El botón de acceso obtiene una sesión del propietario **de la demo**, sin mostrar su contraseña. No sirve para ingresar al entorno original. No publique este servidor ni sus credenciales.

## Recorrido sugerido

| Pantalla | Qué comprobar |
| --- | --- |
| Inicio | 3 disponibles de 5; 1 alquilado, 1 reservado; 2 trabajos de taller; $500 por cobrar. |
| Vehículos | Corolla, Accent y Rio disponibles; Versa alquilado; Swift reservado. Cada uno tiene expediente e historial de un alquiler devuelto. |
| Calendario | Mensual y Gantt comparten búsqueda, vehículos y navegación. Las barras abren la operación; el Gantt usa semanas en celular y permite mostrar vehículos sin compromisos. |
| Taller | Sentra en Mecánica y Escape en Pintura. Seleccione **Entregados** para ver los tres mantenimientos internos históricos de la flota. |
| Presupuestos | Sentra: versión inicial $520 y revisión $600 aprobada. Escape: $700 → $850, todavía en borrador. Las versiones reemplazan el alcance completo, no se suman. |
| Cargos y cobros | Sentra: cargo $600, $200 aplicados, saldo $400 vencido. Versa activo: cargo $180, $80 aplicados, saldo $100. Escape y Swift tienen anticipos sin deuda inventada. |
| Libro diario | Seleccione **Hoy** y **Caja DEMO**: entradas $1.013, salidas $535 y saldo final $1.478. Busque «Un comprobante de materiales»: una salida de $180 repartida en $75 + $65 + $40 entre tres folios. |

Los tres folios internos tienen presupuestos de costo, tareas finalizadas, recepción y entrega completas. No generan una venta a AJ. Los siete vehículos incluyen imágenes privadas rotuladas **DEMO / ilustración de referencia**: no son fotografías ni evidencia real.

El escenario incluye un borrador de reserva de preparación que no bloquea disponibilidad. Los cinco alquileres históricos se terminaron por devolución anticipada mediante la operación real del sistema; no se cambió su etiqueta por SQL.

## Importes iniciales

| Concepto | USD |
| --- | ---: |
| Cargos emitidos | 1.353 |
| Recibos de clientes | 1.013 |
| Abonos aplicados | 853 |
| Anticipos todavía sin aplicar | 160 |
| Saldo por cobrar | 500 |
| Salidas de caja | 535 |
| Movimiento neto | 478 |
| Apertura ficticia de Caja DEMO | 1.000 |
| Saldo final de Caja DEMO | 1.478 |

Un presupuesto no es un cargo. Un costo no es otro pago de caja. Aplicar un recibo existente no registra un segundo ingreso. Los $160 de anticipos corresponden a Escape ($100) y Swift ($60).

**Las fechas se fijan en la primera carga**, no al abrir cada página. Esta instalación se preparó el **5 de noviembre de 2026**, con zona horaria de El Salvador. Los estados temporales y la mora evolucionan con el reloj; consulte las fechas en `test-results/showcase/manifest.json`. Una apertura posterior al comienzo del período no permite conciliar el saldo inicial de ese período: use **Hoy** o una fecha desde la apertura.

## Aislamiento y archivos privados

- Base fija **`aj_showcase`**, dentro del motor PostgreSQL existente; comparte recursos del motor, no las tablas ni los usuarios de Auth del entorno original.
- Auth y PostgREST propios, secreto JWT propio y gateway `127.0.0.1:56321`. Los servicios auxiliares usan `56324` y `56323`; la aplicación usa `3040`. Los puertos nuevos están ligados a loopback.
- Sesión del navegador `sb-aj-showcase-auth-token` y salida de Next separada en `test-results/.next-showcase`.
- La base original se consulta en transacciones de solo lectura para comprobar hashes de sus 62 tablas públicas/identidades Auth y de `.env.local` y cuatro Excel. No se copian sus datos a la demo ni se ejecutan sus suites antiguas de fixtures.
- `.env.showcase.local` y **todo `test-results/showcase/` son privados**: contienen contraseñas, claves, diario de preparación y respaldo. Están ignorados por Git. No los adjunte a issues ni los publique.

Las migraciones de la aplicación se aplican solo en la base marcada de la demo. No hay una opción para cambiar el nombre de la base de destino por una URL de producción.

## Verificar y recuperar

```powershell
npm run showcase:verify
```

Comprueba el escenario inicial, lectura autenticada de tareas, cargos, anticipos, caja, denegación anónima e integridad del entorno original. Si se hicieron operaciones de presentación, puede fallar la comparación inicial: eso no significa que se hayan perdido los cambios. `showcase:dev` permite abrir esa demo modificada sin reiniciarla.

**La siguiente orden descarta únicamente los cambios posteriores al respaldo de la demo**:

```powershell
npm run showcase:restore
```

Exige el marcador de `aj_showcase`, las etiquetas de sus contenedores y el hash del archivo. Detiene únicamente `aj_showcase_auth` y `aj_showcase_rest`; restaura en una sola transacción y verifica nuevamente el entorno original. No borra una base ni detiene PostgreSQL u otros proyectos. Después de restaurar, vuelva a entrar a la demo si el navegador conserva una sesión anterior.

Los errores sanitizados quedan en `test-results/showcase/last-error.txt`. No elimine `journal.json`, `private.json` o los archivos del respaldo para reintentar. Si falta Python/Pillow, prepare esa dependencia y vuelva a ejecutar `showcase:setup`.

## Pruebas de aceptación

Con `showcase:dev` activo y Playwright/Chromium instalados:

```powershell
.venv\Scripts\python.exe -X utf8 -B tests/browser/showcase_acceptance.py
```

Comprueba las ocho pantallas en 320/390/768/1440 px, los filtros de flota, el Gantt, siete expedientes, cinco folios, formularios, contratos, presupuestos y cuatro descargas. Bloquea conexiones fuera de la demo. No registra movimientos de negocio; la generación de PDF sí puede guardar su archivo privado.

La prueba transaccional **modifica la demo y restaura su respaldo al terminar**. Ejecútela solo cuando no haya cambios de presentación que quiera conservar:

```powershell
.venv\Scripts\python.exe -X utf8 -B tests/browser/showcase_transactions.py --confirm-showcase-only
```

Revisa y aprueba un presupuesto de $900, aplica el anticipo existente de $100 sin nuevo ingreso, registra un cobro de $25 y un gasto de $15, confirma una reserva y comprueba el borde del Gantt. Finalmente restaura el escenario y verifica los hashes originales.

En equipos con memoria limitada, cierre el servidor de esta demo mientras ejecuta las regresiones aisladas y use una sola instancia de PGlite por vez:

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts tests/review/*.test.ts
```
