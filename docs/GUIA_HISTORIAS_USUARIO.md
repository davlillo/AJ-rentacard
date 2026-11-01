# Guía de las 30 historias de usuario

Esta guía explica qué resuelve cada HU, dónde se utiliza y qué resultado se debe comprobar. Está basada en la sección 5 de [Requerimientos y planificación](Requerimientos%20y%20planificación%20del%20sistema%20de%20renta%20de%20carros%20y%20talleres.md). El resultado de las pruebas y las limitaciones de aceptación se registran por separado en [ESTADO_HU.md](ESTADO_HU.md).

## Antes de comenzar

- **Sistema local:** <http://127.0.0.1:3030>. Iniciar sesión con la cuenta local configurada en `.env.local`; no compartir ese archivo ni copiar sus contraseñas a esta guía.
- **Modo operativo:** Supabase. Los datos se guardan en PostgreSQL y se comparten entre sesiones. La demostración del navegador es independiente y no sirve como evidencia de persistencia operativa.
- **Moneda y fechas:** importes en USD; los cortes del negocio usan `America/El_Salvador`. No hay impuestos inventados ni certificación fiscal.
- **Permisos:** los recorridos administrativos pueden realizarse con la cuenta local de gerencia. Recepción y técnicos tienen acceso limitado; ocultar un botón no reemplaza la autorización de la base de datos.
- **Inicio de sesión:** pantalla con identidad visual AJ, adaptación a escritorio/móvil y control para mostrar u ocultar la contraseña. El acceso sigue utilizando Supabase real; solicitar cuentas o recuperación a administración, sin formularios de recuperación simulados.
- **Pruebas:** utilizar registros sintéticos o ejemplos autorizados. No reiniciar ni vaciar la base para repetir un recorrido.

### Cinco conceptos que no se deben confundir

| Concepto | Qué significa | Qué no implica |
| --- | --- | --- |
| Costo | Recurso adquirido o consumido por una operación | No significa que se haya pagado ni cobrado al cliente |
| Precio/presupuesto | Importe comercial propuesto | No es por sí mismo un cargo emitido ni un ingreso cobrado |
| Cargo | Documento que establece una cuenta por cobrar | No es dinero recibido |
| Recibo y aplicación | Dinero recibido y asignación explícita a una deuda | Un recibo sin aplicación no reduce cualquier cargo automáticamente |
| Pago a proveedor | Salida de caja que liquida una adquisición | No genera otra vez el costo de la misma compra |

## Clientes, vehículos y registros iniciales

### HU01 · Encontrar y reutilizar un cliente — RF01

**Para quién y para qué:** recepción busca por teléfono o identificación para no crear otra ficha de la misma persona.

**Uso:** en `/clientes`, buscar antes de registrar. Si se confirma que dos fichas pertenecen a la misma persona, un usuario autorizado realiza la fusión con un motivo y selecciona la ficha que permanecerá activa.

**Comprobar:** teléfonos con distinta puntuación o documentos normalizados muestran coincidencias. La fusión mantiene vehículos, órdenes, reservas y consultas del historial; los contactos anteriores siguen siendo buscables.

**Control:** no se suman saldos ni se reescriben los documentos congelados para fusionar identidades. Una ficha modificada por otra sesión obliga a actualizar antes de fusionar.

### HU02 · Distinguir vehículos propios y de clientes — RF02

**Para quién y para qué:** administración identifica al propietario para interpretar correctamente las operaciones y sus costos.

**Uso:** en `/vehiculos`, registrar la relación `Propio` o `Cliente`. Para un vehículo de cliente, seleccionar su propietario. Consultar su expediente y sus operaciones.

**Comprobar:** el expediente muestra la propiedad correcta, la placa y los trabajos asociados. Las operaciones de otro vehículo no aparecen mezcladas.

**Control:** una placa normalizada no puede registrarse dos veces. Un vehículo de cliente requiere propietario válido; un vehículo propio no tiene un cliente propietario ficticio.

### HU03 · Dar entrada rápida al taller — RF03

**Para quién y para qué:** recepción inicia el seguimiento sin esperar una inspección completa.

**Uso:** desde `/inicio` o `/taller`, realizar una recepción con cliente, vehículo, área y motivo del ingreso.

**Comprobar:** se genera un folio único `OT-…`, con usuario y fecha. Los datos todavía no capturados —como condición, accesorios o fotos— aparecen pendientes. El vehículo queda bloqueado para taller.

**Límite:** marcar un dato como pendiente no equivale a completar una inspección. El registro integral de fotos y sus políticas requieren un alcance adicional.

### HU04 · Registrar un gasto con destino — RF04

**Para quién y para qué:** caja registra un egreso pequeño antes de perder su información.

**Uso:** en `/libro-diario` o desde la orden, registrar concepto, importe, fecha, categoría, medio, cuenta y una operación **o** un centro de costo.

**Comprobar:** aparece el mismo folio `EG-…` en el diario y, si corresponde, en el expediente de la operación. Recargar la página no pierde el registro ni lo duplica.

**Control:** no se permite un gasto sin destino ni con dos destinos. Si se está pagando una compra directa ya registrada, utilizar su pago vinculado en Costos de la orden, no crear otro costo independiente.

## Importación y organización del taller

### HU05 · Importar Excel o CSV con revisión previa — RF05

**Para quién y para qué:** administración evita digitar nuevamente los libros existentes.

**Uso:** importar gastos desde `/libro-diario` y pagos de clientes desde `/cobros`. Seleccionar archivo, hoja, mapeo y sistema de origen; validar, revisar las filas y conciliar el total antes de confirmar.

**Comprobar:** la vista previa distingue filas válidas, rechazadas y duplicadas. Antes de confirmar no existen movimientos publicados. El lote conserva el original y su hash; la publicación es atómica.

**Límite:** archivos XLSX/CSV acotados a 5 MB y 500 filas. Las fórmulas requieren revisión; no se ejecutan macros. Pagos y gastos son importaciones distintas, no signos opuestos del mismo registro.

### HU06 · Repetir una importación sin duplicar — RF05

**Para quién y para qué:** administración puede reabrir o repetir un libro sin registrar nuevamente sus pagos.

**Uso:** conservar el sistema y la clave estable de origen. Resolver las coincidencias ambiguas mediante vínculo a un recibo existente, creación de uno distinto o exclusión, siempre con motivo; después volver a validar.

**Comprobar:** repetir un lote publicado no crea más movimientos. Dos pagos similares dentro del mismo archivo, aunque tengan claves diferentes, requieren revisión antes de publicarse. Un origen existente con datos cambiados produce conflicto.

**Control:** misma fecha e importe no prueban que dos pagos sean el mismo. Para una repetición dentro del archivo, excluir la fila repetida; para dos recibos realmente distintos, justificar la creación. No se fusionan automáticamente por similitud.

### HU07 · Asignar tareas independientes — RF06

**Para quién y para qué:** jefatura de taller conoce qué trabajo falta y quién lo realizará.

**Uso:** en `/taller`, crear tareas de la orden con responsable. El técnico consulta sus asignaciones y actualiza el estado en `/tareas`.

**Comprobar:** cada tarea tiene responsable y estado. Finalizar una no finaliza sus tareas hermanas ni entrega la orden. La reasignación conserva motivo y auditoría.

**Control:** los técnicos solo acceden a sus tareas; no pueden usar este recorrido para consultar caja o toda la ficha del cliente. Un cronómetro abierto debe cerrarse antes de finalizar o reasignar la tarea.

### HU08 · Calcular presupuestos reproducibles — RF07

**Para quién y para qué:** el presupuestador explica el precio a partir de reglas y cantidades conocidas.

**Uso:** en `/presupuestos`, seleccionar revisiones de tarifas, cantidades y política: precio comercial, margen objetivo **o** recargo. Calcular y guardar la versión.

**Comprobar:** las mismas cantidades y revisiones producen el mismo resultado. Crear otra tarifa no modifica un presupuesto anterior. El PDF para el cliente no expone costos internos ni margen.

**Ejemplo:** costo 250 con margen objetivo del 25 % da precio 333.33; con recargo del 25 % da 312.50. Son políticas diferentes y no se aplican juntas. Las tarifas reales deben ser calibradas por el negocio.

### HU09 · Conservar la aprobación y su alcance — RF08

**Para quién y para qué:** administración evita discutir después qué fue autorizado por el cliente.

**Uso:** en `/presupuestos`, registrar la decisión sobre una versión, la persona que responde y la evidencia. Si cambia el alcance, crear una nueva versión completa con motivo.

**Comprobar:** la versión aprobada no se edita. Las condiciones, cantidades y partes anteriores permanecen. Una versión nueva pendiente o rechazada no borra la aprobación previa.

**Control:** aprobar descuentos requiere autorización de gerencia. Una versión nueva no se suma automáticamente como suplemento a todas las anteriores.

### HU10 · Asignar un repuesto inesperado al trabajo correcto — RF09

**Para quién y para qué:** compras registra una adquisición real para la orden que la necesitó.

**Uso:** en `/taller` → **Costos y clasificación**, registrar compra directa con descripción, cantidad, costo unitario, proveedor, factura/línea y fecha. Clasificarla después como incluida, adicional autorizado, interna o absorbida.

**Comprobar:** la compra aparece en la orden y comienza pendiente de disposición comercial. No se genera automáticamente un cargo al cliente ni un pago de caja.

**Pago posterior:** abrir **Pagar compra directa** en ese costo. Se admiten pagos parciales, se muestran folios y saldo, se rechaza el sobrepago y no se crea un segundo costo. Compra 100 más pago 100 conserva costo real 100, no 200. El pago puede realizarse después de entregar la orden.

### HU11 · Medir tiempo activo y conservar correcciones — RF10

**Para quién y para qué:** el técnico compara el trabajo real con lo previsto.

**Uso:** desde una tarea propia en proceso en `/tareas`, iniciar, pausar, reanudar y finalizar el cronómetro. Corregir intervalos cerrados solo con motivo.

**Comprobar:** el tiempo transcurrido durante una pausa no suma al activo. Las correcciones conservan valores anteriores, autor y motivo; no pueden solaparse con otro intervalo del técnico.

**Límite:** las marcas de tiempo son del servidor. Medir horas todavía no valoriza automáticamente mano de obra ni liquida salarios.

### HU12 · Revisar pendientes antes de entregar — RF11

**Para quién y para qué:** administración evita cerrar un trabajo con costos o decisiones sin resolver.

**Uso:** en `/taller`, abrir **Revisar entrega**. Resolver costos pendientes, tareas, alcance y saldo documental; registrar receptor y evidencia.

**Comprobar:** un costo sin disposición bloquea la entrega ordinaria. Una excepción requiere gerencia, responsable y motivo. El acta conserva la lista que se revisó; los ajustes posteriores quedan separados y auditados.

**Control:** ni una excepción permite omitir cronómetros abiertos. Datos incompletos de recepción deben reconocerse como pendientes, no darse por completados automáticamente. Un saldo pendiente requiere la autorización de crédito correspondiente.

## Reservas, salida y devolución

### HU13 · Ver ocupación futura por vehículo — RF12

**Para quién y para qué:** reservas programa alquileres sin ignorar taller o limpieza.

**Uso:** en `/calendario`, consultar filas por placa y barras con fechas, cliente y estado de cobro. Revisar también los bloqueos de taller y limpieza.

**Comprobar:** un borrador no ocupa el vehículo; una confirmación sí. Una devolución deja el vehículo retenido para revisión/limpieza hasta su liberación explícita.

**Control:** finalizar una limpieza cancelada o de otra devolución no elimina esa retención. Una devolución anticipada termina la ocupación física y habilita su limpieza real sin reescribir las fechas ni el precio contractual.

### HU14 · Confirmar sin doble reserva — RF13

**Para quién y para qué:** reservas evita prometer el mismo vehículo a dos clientes en fechas incompatibles.

**Uso:** guardar un borrador y confirmar en `/calendario`. Considerar todo el intervalo y la limpieza posterior.

**Comprobar:** al confirmar dos reservas incompatibles simultáneamente, una tiene éxito y la otra informa conflicto. No se aceptan ambas aunque provengan de sesiones distintas.

**Control:** la exclusión se aplica en PostgreSQL, no solo en el calendario visual. Los intervalos contiguos sin solapamiento son distintos de los intervalos superpuestos.

### HU15 · Guardar lo acordado por WhatsApp — RF13

**Para quién y para qué:** ventas conserva evidencia del acuerdo asociado a una reserva.

**Uso:** abrir la reserva en `/calendario`, ingresar el texto del acuerdo y guardarlo como evidencia.

**Comprobar:** el registro queda ligado a la reserva con fecha y autor; sigue disponible aunque esta se cancele.

**Límite:** este recorrido guarda texto. No implica conexión con WhatsApp, envío automático de mensajes ni un proveedor de firma. El criterio permite texto o archivo; aquí se implementa texto.

### HU16 · Extender verificando compromisos — RF14

**Para quién y para qué:** recepción atiende una extensión sin perjudicar otra reserva.

**Uso:** abrir una reserva confirmada en `/calendario`, proponer un fin posterior y justificar el cambio.

**Comprobar:** si la extensión o su limpieza colisionan con otro compromiso, no cambia la reserva y se muestran vehículos alternativos. Si es válida, se conserva la tarifa y se recalcula la duración según la política guardada.

**Control:** no se fuerza la disponibilidad ni se mueve la reserva del siguiente cliente automáticamente. Si cambia el alcance contractual, corresponde generar su nueva versión.

### HU17 · Comparar salida y retorno sin cobrar automáticamente — RF14

**Para quién y para qué:** recepción documenta diferencias antes de acordar extras con el cliente.

**Uso:** en la reserva, registrar salida y devolución con kilometraje, combustible, condición, accesorios y evidencia. Revisar las propuestas de extras resultantes.

**Comprobar:** una diferencia genera propuesta, no recibo ni cobro. La inspección anterior permanece congelada. El kilometraje no puede disminuir.

**Control:** la devolución conserva una retención física de disponibilidad. Solo la limpieza activa asociada a la devolución correspondiente puede liberarla. Un conflicto de limpieza no debe borrar el hecho de que el vehículo volvió; requiere resolución operativa.

## Cobros, almacén y compras

### HU18 · Aplicar un abono a una deuda — RF15

**Para quién y para qué:** caja conoce el saldo real y la aplicación de cada recibo.

**Uso:** en `/cobros`, emitir el cargo con vencimiento, registrar el recibo del cliente y aplicarlo explícitamente al documento correspondiente.

**Comprobar:** cargo 500 menos aplicación 200 muestra saldo 300 y conserva el historial. Repetir la misma solicitud no vuelve a aplicar el dinero.

**Control:** no se puede aplicar más saldo que el disponible ni aplicar un pago a la deuda de otro cliente. Precio de reserva, cargo, recibo y aplicación siguen siendo registros distintos.

### HU19 · Consultar antigüedad y conservar deuda al cancelar — RF15

**Para quién y para qué:** administración prioriza la cobranza según vencimiento y fecha de corte.

**Uso:** en `/cobros`, consultar documentos y saldos al corte. Registrar ajustes, créditos o reembolsos por sus recorridos explícitos, con motivo.

**Comprobar:** la antigüedad utiliza el vencimiento del documento, no la fecha de reserva. Cancelar la reserva no elimina sus cargos ni los pagos. Un corte anterior excluye movimientos registrados posteriormente.

**Control:** reembolsar dinero no equivale a borrar un cargo. La devolución y su reversión de aplicación conservan el historial y pueden restaurar saldo pendiente.

### HU20 · Despachar piezas y revertir devoluciones — RF16

**Para quién y para qué:** almacén controla consumo real y su destino en el taller.

**Uso:** en `/inventario`, seleccionar artículo, orden, cantidad y motivo de despacho. Si se devuelve material, referenciar el despacho original.

**Comprobar:** el despacho reduce stock y crea una sola imputación de costo. La devolución repone cantidad y reduce ese costo al valor original; repetir una solicitud no duplica el movimiento.

**Control:** recibir existencias no significa consumirlas. La valoración usa la política registrada; devolver no inventa el precio de reposición actual.

### HU21 · Recibir parcialmente una compra — RF17

**Para quién y para qué:** compras conoce lo recibido y lo que falta entregar al proveedor.

**Uso:** en `/inventario`, crear solicitud, obtener autorización de gerencia y registrar cada recepción con cantidad y motivo/documento.

**Comprobar:** solicitar 5 y recibir 3 aumenta stock en 3 y deja 2 pendientes. La recepción conserva la obligación con el proveedor y no puede superar la cantidad pendiente.

**Control:** una solicitud no autorizada no puede recibirse. Recibir genera existencias y obligación, no un pago de caja ni un costo de vehículo antes de consumirlas.

## Contratos, comisiones e información gerencial

### HU22 · Calcular comisiones con reglas versionadas — RF18

**Para quién y para qué:** gerencia aplica una política uniforme y explicable al vendedor.

**Uso:** en `/reportes`, crear una revisión de regla con tasa y vigencia; decidir la elegibilidad de los cargos; seleccionar reserva, regla y corte para calcular el ajuste.

**Comprobar:** la regla aplicada queda congelada. Un reembolso reduce la base y produce un ajuste, no otra liquidación completa. Ejemplo de prueba: comisión inicial 20 y ajuste posterior −5.

**Límite:** se calcula sobre aplicaciones netas elegibles según la política indicada. No equivale a nómina desembolsada ni convierte automáticamente depósitos o garantías en ventas comisionables.

### HU23 · Generar un contrato que conserve su versión — RF19

**Para quién y para qué:** recepción reutiliza datos sin perder las condiciones acordadas.

**Uso:** abrir reserva en `/calendario` → **Contratos versionados y aceptación**. Escribir condiciones completas y motivo; guardar versión, descargar PDF y registrar firmante/evidencia.

**Comprobar:** cambiar o fusionar la ficha del cliente no cambia el PDF anterior. Partes, vehículo, intervalo, precio y condiciones salen de la instantánea de esa versión. Una nueva negociación crea otra revisión.

**Control:** los PDF nuevos se generan en la base a partir de la versión congelada; se rechazan cargas arbitrarias de PDF. Se conserva original/hash. La plantilla es paginada y sencilla, admite texto latino y rechaza expresamente caracteres no representables en WinAnsi, en lugar de sustituir términos silenciosamente. Los originales previos no se reemplazan.

**Límite:** guardar evidencia de aceptación no certifica una firma electrónica ni la validez legal de las cláusulas; el negocio debe proporcionar y aprobar sus términos.

### HU24 · Explicar la contribución directa por vehículo — RF20

**Para quién y para qué:** el dueño entiende de dónde proviene el resultado por carro.

**Uso:** en `/reportes`, seleccionar vehículo y rango; calcular contribución y abrir las fuentes de ingresos y costos.

**Comprobar:** se muestran identificadores de documentos y costos que forman el total. Pagar una compra directa por su vínculo no aumenta nuevamente el costo. Los cobros no se suman otra vez como ingresos facturados.

**Límite:** el indicador es cargos emitidos menos créditos y costos directos, bajo `billed-direct-contribution-v1`. No es utilidad neta, flujo de caja ni rentabilidad completa: faltan políticas aprobadas de valoración laboral e indirectos.

### HU25 · Preparar y recibir reportes periódicos sin duplicados — RF20/RF21

**Para quién y para qué:** el dueño revisa la operación sin preparar manualmente cada envío.

**Uso:** en `/configuracion`, guardar programación, destinatario autorizado, filtros y corte. Mantener activo `npm run local:reports`. Consultar capturas en <http://127.0.0.1:55324>.

**Comprobar:** el reporte conserva filtros, corte e instantánea. Repetir el ciclo no produce otro correo para el mismo trabajo. La autorización del destinatario se comprueba antes de reclamar el envío.

**Límite:** Mailpit captura correo local; no se envía correo público. Un envío incierto no se reintenta a ciegas: primero debe reconciliarse con el buzón para evitar duplicación.

### HU26 · Consultar costos con referencias mediante el asistente — RF22

**Para quién y para qué:** el dueño evita reconstruir costos manualmente entre varias pantallas.

**Uso:** en `/asistente`, consultar con la placa y, cuando sea necesario, el folio. Ejemplo: `¿Cuánto costó el vehículo P123 en OT-7?`.

**Comprobar:** la respuesta identifica vehículo, operación, corte y registros fuente. Si hay varias operaciones posibles, solicita precisar la consulta en lugar de mezclar sus costos.

**Límite:** es un asistente de dominio con instrucciones acotadas y consultas reales, no un LLM de conversación general. No inventa datos ni incorpora costos futuros o todavía no valorados.

### HU27 · Confirmar un gasto propuesto por el asistente — RF22

**Para quién y para qué:** caja reduce pasos sin perder el control del registro.

**Uso:** en `/asistente`, escribir por ejemplo `gasto de 35.10 en OT-7 por aceite`. Revisar importe, destino y datos propuestos; confirmar exactamente esa propuesta.

**Comprobar:** antes de confirmar no existe el gasto. La confirmación persiste una vez y devuelve el folio `EG-…`. Repetirla devuelve el mismo resultado.

**Control:** la propuesta queda ligada al usuario, hash y vencimiento de 15 minutos. Cambiar el contenido o confirmar una propuesta vencida se rechaza. El asistente no evita los permisos de caja ni la regla de pago vinculado de compras.

### HU28 · Restringir acceso incluso por URL y API — RF23

**Para quién y para qué:** el dueño protege información financiera y acciones administrativas.

**Uso:** gerencia administra roles en `/configuracion`. Iniciar sesión con una cuenta técnica para comprobar los límites reales.

**Comprobar:** el técnico usa `/tareas` para sus asignaciones, pero no puede leer caja, diario, asistente financiero o configuración mediante URL directa ni invocando sus API.

**Control:** Supabase Auth, RLS y comprobaciones en cada comando aplican la autorización en el servidor. La administración de roles queda auditada y no permite dejar al sistema sin su último dueño. La preparación para producción requiere además endurecimiento de despliegue.

### HU29 · Comparar presupuesto, compromiso y ejecución — RF24

**Para quién y para qué:** gerencia controla un plan de gasto sin sumar varias veces la misma adquisición.

**Uso:** en `/configuracion`, crear el plan con período e importe. Vincular explícitamente compras y gastos. Consultar al corte elegido.

**Comprobar:** las cantidades autorizadas no recibidas son compromiso; las obligaciones por recepción son ejecución. El pago de esa compra no vuelve a ejecutar el mismo importe. Un plan 100 con compromiso 20 y ejecución 30 deja disponible 50.

**Control:** los cortes usan el estado auditado y las fechas de registro y vinculación. Una compra autorizada o vinculada hoy no aparece retrospectivamente comprometida ayer. Los gastos independientes se consideran dentro del período del plan.

**Límite:** es un módulo ampliado propuesto, con asignación explícita; no clasifica todo el historial automáticamente ni sustituye una contabilidad general.

### HU30 · Recuperar eventos externos sin repetir el negocio — RF25

**Para quién y para qué:** administración evita recapturar registros y conserva errores recuperables.

**Uso:** en `/configuracion`, ingresar un evento en el buzón de integración con origen e identificador externo. Procesarlo y revisar resultado o error. Después de resolver la configuración que causó el error, volver a procesar.

**Comprobar:** el mismo origen/ID y contenido se reconoce como repetido y devuelve el resultado original. Cambiar el contenido bajo el mismo ID produce conflicto. Un error recuperable no deja una operación parcial ni duplica la operación al reintentar.

**Límite:** es un adaptador local autorizado de gastos, no un webhook público, integración fiscal o conexión de WhatsApp ya contratada. Se necesitan proveedor, credenciales y alcance acordados para conexiones externas reales.

## Cómo comprobar la entrega técnica

```powershell
npm test
npm run test:local
npm run typecheck
npm run build
```

Con la aplicación en el puerto 3030:

```powershell
.venv\Scripts\python.exe tests/browser/acceptance.py
.venv\Scripts\python.exe tests/browser/rentals_acceptance.py
.venv\Scripts\python.exe tests/browser/login_acceptance.py
npm run test:roles
```

`npm test` incluye los contraejemplos de revisión de `tests/review/`. Las pruebas conservan registros sintéticos; no realizan resets. Aprobar pruebas técnicas no reemplaza la aceptación con libros reales, tarifas, términos contractuales y políticas del negocio.

## Arranque local y límites de operación

Con Docker Desktop activo y las dependencias instaladas:

```powershell
npm run local:start
npm run local:migrate
npx next dev --hostname 127.0.0.1 --port 3030
```

En otra terminal:

```powershell
npm run local:reports
```

No es necesario ejecutar `local:setup` si `.env.local` y la cuenta ya existen. No publicar credenciales ni ejecutar `db reset`, eliminar volúmenes o aplicar rollbacks sobre esta base utilizada.

**Advertencia:** Docker Desktop puede publicar los puertos de Supabase en todas las interfaces aunque la aplicación use `127.0.0.1`. Restringir exposición, respaldos y controles antes de utilizar información sensible o pasar a producción. Ver [LOCAL_SUPABASE.md](LOCAL_SUPABASE.md), [OPERATIONS.md](OPERATIONS.md), [WORKSHOP.md](WORKSHOP.md) e [IMPORTACIONES.md](IMPORTACIONES.md).
