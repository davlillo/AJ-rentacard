# Estado de las historias de usuario

> **Actualización del 30 de octubre de 2026:** la validación literal siguiente es la línea base del 22 de octubre, no prueba de adaptación a los Excel reales. La ampliación funcional, decisiones de flota, pliegos completos, documentos agrupados, diario y originales revisables están documentados en [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md). Los originales reales están conservados sin publicación financiera; las ambigüedades continúan pendientes de revisión.

**Los cinco fallos de la revisión fueron corregidos y verificados localmente mediante la migración `20261022002100`.** Aprueban 85 pruebas unitarias/SQL, cuatro suites API, los dos recorridos de HU en navegador, la prueba del login rediseñado, permisos por URL directa, TypeScript y compilación. La migración está aplicada a Supabase local sin resets. Esto no equivale a aceptación del negocio ni preparación para producción. Correo e integración continúan siendo adaptadores locales, no proveedores públicos/fiscales configurados.

Para conocer el propósito, uso, resultado esperado y límites de cada HU, consultar [GUIA_HISTORIAS_USUARIO.md](GUIA_HISTORIAS_USUARIO.md).

Fecha de revisión: 22 de octubre de 2026. Fuente: `Requerimientos y planificación del sistema de renta de carros y talleres.md`, sección 5.

## Criterio de estado

- **Implementada; aceptación pendiente:** código UI/BD y pruebas de reglas presentes; falta probar el recorrido completo contra Supabase.
- **Verificada localmente:** reglas y recorridos técnicos probados; no equivale a aceptación del negocio, certificación fiscal ni preparación para producción.
- **Parcial/demo:** hay una referencia local de UX o cálculo, no una solución operativa aceptada.
- **Pendiente:** falta implementar el criterio verificable. No equivale a que la pantalla esté terminada.
- **Reabierta por revisión:** existe implementación y evidencia anterior, pero un contraejemplo reproducido requiere corrección y nueva aceptación.

## Revisión de las 30 HU

| HU | Estado | Evidencia o trabajo faltante |
| --- | --- | --- |
| HU01 | Verificada localmente | Búsqueda normalizada y alias, rechazo concurrente de duplicados y fusión con versión/motivo. Propiedad, órdenes y reservas conservan relaciones. El libro monetario resuelve identidad canónica sin reescribir instantáneas ni importes históricos. |
| HU02 | Verificada localmente | Propiedad propia/de cliente, FK de propietario, placa normalizada única y expediente por vehículo. Probado con recepción, gasto y cambio de propietario por fusión. No se inventa propietario para el demo antiguo. |
| HU03 | Verificada localmente | Ingreso mínimo, folio único, actor/fechas, bloqueo de vehículo y pendientes explícitos. La ampliación del 30 de octubre agrega inspección inmutable y fotos privadas en el pliego; ver la evidencia y límites de la ampliación por separado. |
| HU04 | Verificada localmente | Gasto con operación o centro exclusivo, decimal USD, categoría/cuenta/medio, auditoría e idempotencia. Diario y expediente leen el mismo folio. Probado en API concurrente y navegador. |
| HU05 | Verificada localmente | Importadores separados de gastos y pagos XLSX/CSV: hoja, mapeo, original/hash, preview persistido, válidas/rechazadas/duplicadas, exclusión con motivo y publicación atómica tras conciliación. No se convierte un pago en gasto. |
| HU06 | Corregida y verificada localmente | Repetir lote/origen estable no publica más movimientos. La vista previa compara también filas normalizadas dentro del archivo y muestra sus números; claves distintas no evitan la revisión. Publicar ambiguos se rechaza; excluir o justificar un recibo distinto requiere motivo y revalidación. |
| HU07 | Verificada localmente | Tareas con responsable obligatorio, estados/versiones, reasignación con motivo y auditoría. SQL, API real y navegador comprueban que finalizar una no cambia la otra ni la orden. Técnicos solo leen/transicionan tareas propias en `/tareas`, sin acceso a caja, clientes ni órdenes completas. |
| HU08 | Verificada localmente | Cálculo decimal de servidor por revisiones de tarifa y cantidades; política/redondeo congelados, margen o recargo excluyentes, PDF versionado sin costos internos. Tarifas reales e impuestos requieren validación; ver `WORKSHOP.md`. |
| HU09 | Verificada localmente | Versiones inmutables con cliente/vehículo/alcance congelados, decisión y evidencia, descuentos autorizados por gerencia. Cambiar alcance crea una revisión completa; una pendiente o rechazada no borra la aprobación previa. |
| HU10 | Corregida y verificada localmente | Compra directa conserva destino y disposición pendiente. Pago parcial explícito desde el costo, con folio EG, saldo, auditoría, idempotencia y rechazo de sobrepago concurrente; no crea otro costo. El gasto genérico con la misma referencia de factura/línea se rechaza para evitar duplicarlo. Navegador paga 35.11 sin alterar el costo real total. |
| HU11 | Verificada localmente | Cronómetro de servidor por tarea/responsable, tramos activos y pausas, límite de un activo por técnico, correcciones versionadas con motivo/autor/auditoría y control de solapamiento. Un timer abierto bloquea finalizar/reasignar su tarea. No genera costo laboral automáticamente. |
| HU12 | Verificada localmente | Checklist transaccional bloquea costos sin disposición/tareas/alcance o cargo pendiente. Excepción exige gerencia, motivo y responsable; timers no se omiten. Acta inmutable, ajustes auditados y saldo documental real, no el campo antiguo `paid`. |
| HU13 | Corregida y verificada localmente | Agenda y exclusión de intervalos presentes. Finalizar un bloqueo inactivo/cancelado se rechaza; una retención de devolución requiere su propia limpieza activa. La devolución anticipada acorta ocupación física e inicia limpieza real sin cambiar fechas/precio de la reserva. Navegador completa su limpieza y comprueba Disponible. |
| HU14 | Verificada localmente | Restricción GiST de exclusión por vehículo/intervalo activo, además del comando autorizado. Confirmaciones incompatibles en conexiones HTTP concurrentes producen un éxito y un conflicto. |
| HU15 | Verificada localmente | Texto de WhatsApp inmutable ligado a reserva con autor y fecha. Se conserva tras cancelación. No se automatizan WhatsApp ni envíos externos. |
| HU16 | Verificada localmente | Extensión conserva tarifa, revalida reserva y limpieza en la misma transacción; ante conflicto no cambia nada y la API/interfaz muestran alternativas. |
| HU17 | Corregida y verificada localmente | Comparación de inspecciones y propuesta sin cobro. La liberación exige limpieza activa asociada a la devolución correcta. Completarla desactiva su intervalo antes de comprobar disponibilidad, evitando que su propio fin posterior a `now()` retenga el vehículo. |
| HU18 | Verificada localmente | Documentos, recibos y aplicaciones separados e inmutables. Cargo 500 menos aplicación 200 muestra 300; idempotencia, historial y límites evitan sobreaplicar o aplicar a otro cliente. |
| HU19 | Verificada localmente | Vencimiento por documento, antigüedad y corte efectivo/registrado. Cancelar no elimina cargos ni aplicaciones; reembolso conserva historial y restaura saldo. |
| HU20 | Verificada localmente | Despacho idempotente baja stock y crea un costo de orden; devolución al costo original restaura stock y revierte costo neto. Recepción y pago no se cuentan como consumo. |
| HU21 | Verificada localmente | Solicitud/autorización y recepción parcial persistidas. Recibir 3 de 5 deja stock 3 y pendiente 2, con obligación al proveedor, sin inventar pago de caja. |
| HU22 | Verificada localmente | Regla versionada y congelada por reserva, elegibilidad explícita y base neta aplicada. Prueba: comisión 20, reembolso ajusta −5, reintento no liquida otro 20. No se declara nómina pagada. |
| HU23 | Corregida y verificada localmente | El PDF nuevo se genera en la base desde la versión inmutable; la API rechaza uploads arbitrarios. Pruebas abren PDF multipágina con parser estricto, verifican hash, caracteres españoles y estabilidad tras nueva versión; navegador descarga el contrato. Originales anteriores conservados; plantilla sencilla WinAnsi, sin certificación legal/fiscal. |
| HU24 | Corregida y verificada localmente | El indicador abre fuentes. Compra directa 100 y sus pagos parciales 60+40 conservan costo 100 y dos movimientos de caja; carreras no sobrepagan. No representa utilidad neta ni agrega valoración laboral/indirectos no aprobados. |
| HU25 | Verificada localmente | Programación, destinatario autorizado, corte/filtros y snapshot persistidos. Worker captura correo real en Mailpit local; segundo ciclo no duplica mensaje. Claim de un solo uso; envío incierto no se reintenta a ciegas. |
| HU26 | Verificada localmente | Asistente de dominio acotado consulta API real con vehículo, operación, corte y fuentes. Desambigua varias operaciones; no inventa costos ni presenta un simulador de respuestas. No es un LLM general. |
| HU27 | Verificada localmente | Instrucción de gasto produce propuesta normalizada persistida con SHA-256/actor/expiración. Confirmación exacta crea una vez el gasto y devuelve folio real; payload cambiado o vencido se rechaza. |
| HU28 | Verificada localmente | Auth/RLS y permisos en cada RPC, incluida frontera del asistente. Sesión real de técnico denegada por URL directa a caja/diario/agente/configuración y API. Gerencia administra roles con auditoría y protección del último owner. No certifica producción ni políticas multisede. |
| HU29 | Corregida y verificada localmente | Conserva separación plan/compromiso/ejecución en SQL/API/navegador. La regresión histórica reconstruye autorización desde auditoría al corte; plan, vínculo, recepción y gasto posteriores se excluyen. Una autorización de hoy no se filtra a ayer incluso si el plan y vínculo ya existían. |
| HU30 | Verificada localmente, adaptador local P2 | Inbox correlaciona origen/ID/hash, reconoce duplicados y rechaza payload cambiado. Error de configuración se recupera y el negocio se ejecuta una vez. No se inventan credenciales fiscales ni proveedor WhatsApp. |

## Evidencia automatizada de esta entrega

- `tests/clientes.test.ts`: búsquedas y alias conservados.
- `tests/operational-sql.test.ts`: SQL real en PGlite; migración/rollback/reaplicación, coincidencias, versiones de fusión, conservación de relaciones, propiedad, folios, recepción, destino de gastos, precisión, idempotencia, auditoría y denegación por rol.
- `tests/import-workbook.test.ts` y `tests/imports-sql.test.ts`: archivos, fechas sin desplazamiento horario, fórmulas, mapeo, conciliación, ambiguos, fuentes repetidas y publicación atómica.
- `tests/tasks-sql.test.ts`: asignaciones, permisos, reasignación auditada y finalización independiente.
- `tests/estimates-sql.test.ts` y `tests/pdf-documents.test.ts`: cálculo reproducible, revisiones de tarifa, autorización inmutable, PDF paginado con fuente local y exclusión de costos internos.
- `tests/workshop-costs-sql.test.ts`, `tests/task-timers-sql.test.ts`, `tests/workshop-delivery-sql.test.ts` y `tests/workshop-migrations.test.ts`: destino/clasificación, pausas/correcciones, bloqueos/excepción, ajustes tardíos y recuperación segura de migraciones sin datos.
- `tests/local/business.test.ts`: **aprobado contra Supabase real** para HTTP/Auth/RLS, fusión, selectores, concurrencia, importación entre archivos, tareas, cotizaciones, PDF/hash, costos y tiempos; entrega concurrente idempotente con revisión congelada.
- `tests/browser/acceptance.py`: **aprobado** para HU01–HU04, importación/repetición/ambiguos, tareas y HU08–HU12: cálculo, aprobación/PDF, compra/clasificación, pausas/corrección y bloqueo ordinario/entrega por excepción; escritorio/móvil, recarga y ausencia de errores de ejecución. Evidencias ignoradas en `test-results/`.
- `tests/negocio.test.ts`: conserva las pruebas del prototipo; no certifican saldos ni reservas de producción.
- `tests/reservations-sql.test.ts`, `tests/rental-inspections-sql.test.ts`, `tests/billing-sql.test.ts`: intervalos, extensiones, inspecciones y saldo/antigüedad documental.
- `tests/inventory-sql.test.ts`, `tests/management-sql.test.ts`, `tests/control-automation-sql.test.ts`, `tests/payment-imports-sql.test.ts`: consumo/devolución, recepción parcial, comisiones/contratos/fuentes, permisos/propuestas, outbox, presupuesto, recuperación de eventos e importación de pagos.
- `tests/operations-migrations.test.ts`: aplicar → rollback seguro sin datos → reaplicar; rechazo al existir datos.
- `tests/local/rentals.test.ts` y `tests/local/control.test.ts`: APIs reales, carreras de confirmación/publicación, RLS, Money/stock y captura Mailpit deduplicada.
- `tests/browser/rentals_acceptance.py`: recorrido operativo de HU13–HU30 e importación/repetición de pagos, con contratos/PDF, reportes/correo, asistente, presupuesto e inbox.
- `npm run test:roles`: navegador con técnico sintético real; caja/diario/asistente/configuración denegados por URL directa y tareas permitidas. Credenciales nunca se imprimen.
- `tests/review/regressions.test.ts`: los cinco contraejemplos originales ahora aprueban en PostgreSQL aislado. Incluye decisión explícita de pagos similares, pago vinculado/reintento/sobrepago, rechazo de bloqueos ajenos e inactivos y liberación válida, PDF multipágina/hash y presupuesto histórico. Forma parte de `npm test`; no son errores esperados ni pruebas omitidas.
- `tests/local/review.test.ts`: aprobado contra Supabase real para similitudes internas, pagos concurrentes y límite de saldo, PDF generado/rechazo de uploads y liberación de devolución anticipada.
- `tests/browser/login_acceptance.py`: login con identidad AJ revisado a 1440, 768, 390 y 320 px, sin desbordamiento horizontal; mostrar/ocultar contraseña, rechazo de credenciales inválidas y acceso real aprobados. Capturas en `test-results/login-*.png`, tomadas antes de ingresar credenciales. No modifica permisos ni añade recuperación de contraseña ficticia.

## Validación técnica y siguiente paso

Resultado histórico de la corrección del 22 de octubre: **85 pruebas unitarias/SQL, cuatro suites API, ambos recorridos de HU en navegador de escritorio/móvil, login en cuatro tamaños, permisos de técnico por URL directa, TypeScript y compilación aprobados**. Los recorridos de HU y de permisos se repitieron después del rediseño del login. La auditoría de dependencias de producción de esa fecha no sustituye una auditoría integral actual. Las migraciones de esa línea base terminan en `20261022002100`; la ampliación posterior y su evidencia están en `OPERATIONAL_FIT.md`. El worker requiere su arranque explícito; no se presume activo después de un reinicio. Estos resultados no son certificación del negocio o de producción.

1. Aceptación del negocio con Excel reales, tarifas, reglas comerciales, términos de contratos y políticas de reconocimiento/valoración; ver `OPERATIONS.md`.
2. Mantener los cinco contraejemplos dentro de la prueba habitual; no excluirlos para obtener un resultado verde. Repetir la regresión después de futuros cambios, sin resetear datos.
3. Validar las ampliaciones de RF del 30 de octubre con el negocio. Valoración laboral/indirectos, plantillas adicionales, nómina pagada, garantías y políticas multisede siguen requiriendo políticas y alcance acordados.
4. Configurar proveedores externos reales solo cuando se acuerden credenciales y alcance. Correo actual es captura local; integración actual es adaptador autorizado, no servicio fiscal público.
5. Restringir publicación de puertos, respaldos y controles de despliegue antes de datos sensibles o producción. No ejecutar rollbacks ni resets sobre esta base usada.
