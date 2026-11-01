# Importación controlada de gastos y pagos

> **Ampliación del 30 de octubre:** los cuatro XLSX reales ya están conservados en **Archivos del cliente → Original / Organizado**, con observaciones pendientes y referencias de celda. Este visor/adaptador admite el diario de 707 filas sin tratarlo como una tabla plana de egresos. El flujo explicado debajo corresponde a los importadores tabulares anteriores; no debe usarse para publicar indiscriminadamente los libros reales. Ver [OPERATIONAL_FIT.md](OPERATIONAL_FIT.md).

La importación operativa admite **egresos en USD del libro diario**, en CSV UTF-8 o XLSX. Guarda archivo original, hash SHA-256, hoja, fila, autor, mapeo, decisiones y folios publicados. Nada aparece en caja ni en el expediente antes de confirmar el lote.

El importador del libro diario **no reinterpreta pagos, ingresos, saldos, presupuestos ni inventario como gastos**. Los pagos tienen su propio importador en **Cuentas por cobrar → Importar pagos desde XLSX o CSV** y se publican como recibos reales, con aplicación opcional a documentos existentes.

## Pagos sin duplicación

1. Use columnas `cliente_id`, `fecha`, `monto`, `medio`, `cuenta`, `referencia`, `id_origen`; `documento_id` es opcional. Cliente/documento usan UUID existentes, no nombres ni placas ambiguas.
2. Suba CSV UTF-8 o XLSX, elija hoja y guarde el original. Mapee columnas y conserve el mismo sistema de origen entre libros relacionados.
3. Valide la vista previa persistida. Distinga válidas, rechazadas, duplicadas, ambiguas, conflictos y excluidas. Se requieren fecha ISO e importe positivo con hasta dos decimales.
4. Excluir, vincular un recibo candidato o confirmar un hecho distinto requiere motivo. Un origen compartido con datos cambiados no se sobrescribe.
5. Ingrese el total conciliado de **nuevos** pagos y confirme. El servidor recalcula, rechaza incidencias/cambios y publica recibos/aplicaciones en una sola transacción; nunca parte del lote.

Mismos bytes/hoja recuperan el lote anterior, sin nuevos recibos. Otro archivo con el mismo origen estable se vincula al recibo original. Una coincidencia de cliente/fecha/monto/cuenta exige decisión humana; no elimina pagos automáticamente.

## Recorrido de gastos

1. En **Libro diario → Importar egresos tabulares**, descargue la plantilla o seleccione un archivo preparado con las columnas necesarias.
2. Elija una hoja y prepare el lote privado. Volver a subir los mismos bytes y hoja recupera el mismo lote, incluso si ya fue publicado.
3. Mapee fecha, concepto, importe, categoría, medio, cuenta y destino. Seleccione el formato de fecha y separador decimal de los textos.
4. Valide. La tabla distingue filas válidas, rechazadas, duplicadas, ambiguas y excluidas. Permite revisar las celdas originales de cada fila.
5. Resuelva las incidencias. Una exclusión, un gasto nuevo similar o una vinculación manual requieren motivo. Después, guarde una nueva validación.
6. Compare el total nuevo con el archivo, ingréselo y confirme que revisó destinos y exclusiones. El servidor vuelve a validar y publica el lote en una transacción.
7. Descargue el resultado y compruebe el folio `EG-` en el diario y, cuando corresponda, en el expediente del vehículo.

El historial permite reabrir los últimos 20 lotes. Un lote anterior también se recupera al subir nuevamente su archivo y hoja. Un lote confirmado es inmutable. Cerrar el diálogo no elimina los registros privados ni publica datos.

## Campos

| Campo | Regla |
| --- | --- |
| Fecha | `AAAA-MM-DD`, o `DD/MM/AAAA` si se selecciona ese formato. Una fecha imposible se rechaza. Las fechas nativas de Excel conservan su día de calendario. |
| Monto | Positivo, hasta dos decimales. Texto con punto decimal: `1,234.56`; con coma: `1.234,56`. No se interpreta silenciosamente `1,50` como `150`. |
| Concepto y categoría | Obligatorios. No se infiere si una fila representa presupuesto, consumo o pago. |
| Medio y cuenta | Medio: Efectivo, Transferencia o Tarjeta. Cuenta/caja obligatoria. |
| Destino | Exactamente un folio de orden abierta **o** un centro de costo: `administration`, `workshop`, `rental`. No basta la placa. |
| Identificador de origen | Recomendado: identificador estable de ese hecho en el libro fuente. Debe conservarse al copiarlo a otro cuadro. |
| Sistema de origen | Espacio de identificadores, por ejemplo `daily-ledger`. Debe mantenerse igual en libros que comparten identificadores. No cambiarlo para evadir conflictos. |
| Tipo y moneda | Opcionales cuando todo el archivo es de egresos USD. Si se mapean, solo se aceptan `Egreso` y `USD`. |
| Soporte | Referencia opcional; el archivo original completo queda conservado aparte. |

Límites del piloto: 5 MB de archivo, 30 MB declarados de expansión ZIP, 20 hojas, 500 filas y 50 columnas por hoja. Se rechazan XLS antiguo, XLSM, ZIP64, cifrado, proyectos VBA y encabezados repetidos. Las fórmulas no se ejecutan ni se confía en sus valores almacenados: se señalan para revisión.

## Duplicados y conciliación

- **Mismo archivo y hoja:** mismo lote; no hay segunda publicación.
- **Mismo sistema e identificador de origen:** si los datos coinciden, se vincula el folio existente; si cambian, hay conflicto, no sobrescritura.
- **Sin identificador compartido pero con un gasto similar:** se exige decidir si es un hecho nuevo o el mismo gasto. La vinculación solo acepta folios cuyos datos de negocio coinciden.
- **Misma fecha e importe, pero distinto concepto, cuenta o destino:** no se elimina automáticamente. Fecha más monto no constituye identidad.
- **Identificadores repetidos o líneas iguales dentro de una hoja:** se muestran como incidencias. Deben revisarse, excluirse con motivo o confirmarse como hechos distintos según el caso.
- **Cambio entre vista previa y confirmación:** se rechaza el cierre del lote y se exige validar otra vez. No se publica una parte y se oculta el resto.

Las fuentes adicionales se conservan en las filas y relaciones de origen. Un gasto vinculado no vuelve a generar dinero ni costo. Los importes excluidos y duplicados no forman el **total nuevo a publicar**. Las filas rechazadas nunca se omiten silenciosamente.

## Evidencia y trabajo pendiente

`tests/import-workbook.test.ts` verifica lectura, fechas, fórmulas y límites. `tests/imports-sql.test.ts` y `tests/payment-imports-sql.test.ts` prueban reglas PostgreSQL. `tests/local/business.test.ts` y `tests/local/control.test.ts` prueban Auth/RLS, concurrencia y reintentos contra Supabase. Los recorridos están en `tests/browser/acceptance.py` y `tests/browser/rentals_acceptance.py`; evidencia en `ESTADO_HU.md`.

La nueva revisión de originales conserva los cuatro formatos reales sin perder su primera fila, muestra fórmulas/valores guardados sin ejecutarlos y permite excluir, vincular o publicar hechos verificados con conciliación. Presupuestos completos, alquileres y documentos agrupados se construyen mediante sus operaciones y después se vinculan a las observaciones de origen. La interfaz no inventa una operación completa a partir de una fila ambigua. RF05 más amplio aún requiere plantillas reutilizables adicionales, procesos masivos asíncronos y reversión de lotes con dependencias. No se declara un migrador universal ni aceptación comercial automática.
