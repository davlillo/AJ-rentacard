# Nueva carga en la base habitual

La aplicación en **http://127.0.0.1:3030** usa la conexión existente de `.env.local`: API **55321**, base **`postgres`**, contenedor **`supabase_db_aj-rentacar`**. Los registros operativos anteriores fueron reemplazados por autorización el 5 de noviembre de 2026; no se creó otra cuenta ni se cambió su contraseña.

## Abrir y verificar

```powershell
npx next dev --hostname 127.0.0.1 --port 3030
npm run local:replace -- verify
```

Ingrese con la cuenta habitual. No ejecute nuevamente la preparación ni los importadores anteriores: la carga ya está persistida y abrir la aplicación no la restaura.

## Contenido inicial

| Vehículo | Placa | Estado |
| --- | --- | --- |
| Toyota Corolla | P101-001 | Disponible |
| Hyundai Accent | P101-002 | Disponible |
| Kia Rio | P101-003 | Disponible |
| Nissan Versa | P101-004 | Alquilado |
| Suzuki Swift | P101-005 | Reservado |
| Nissan Sentra | P101-006 | Taller: Mecánica |
| Ford Escape | P101-007 | Taller: Pintura |

Los cinco vehículos de flota tienen un alquiler devuelto. Corolla, Accent y Rio también tienen un mantenimiento interno entregado, con recepción, costos, presupuesto, tareas y entrega. Sentra tiene una revisión de presupuesto de $600 aprobada, con $200 aplicados y $400 de saldo. Escape tiene una revisión de $850 pendiente de aprobación y un anticipo de $100. Versa tiene $100 pendientes; Swift tiene un anticipo de $60.

La carga tiene cargos por $1.353, recibos por $1.013, saldo por cobrar de $500 y anticipos disponibles de $160. En **Libro diario**, seleccione **Hoy** y **Caja principal**: entradas $1.013, gastos $535 y movimiento neto $478; con la apertura de $1.000, la caja final es $1.478. Un comprobante de $180 se distribuye en $75, $65 y $40 entre tres folios, sin duplicar la salida de caja. Presupuesto, cargo, aplicación de recibo y gasto conservan sus identidades separadas.

Las fechas se fijaron al preparar la carga, en la zona horaria de El Salvador. La disponibilidad y la mora evolucionan con el reloj; las fechas exactas están en el manifiesto privado. Las imágenes son referencias generadas desde los recursos locales, sin modificar los originales.

## Protección y reanudación

- Se conservaron usuarios e identidades, roles, configuración, auditoría anterior y los cuatro Excel, tanto en disco como en la base. Los hashes de identidad excluyen únicamente las marcas de tiempo que cambian al iniciar sesión.
- Se retiraron 54 vínculos hacia los registros anteriores. Sus observaciones quedaron excluidas, con motivo y auditoría; los archivos y metadatos originales no se borraron.
- La limpieza usa una lista explícita de 58 tablas operativas, `CONTINUE IDENTITY RESTRICT`, comprobación de hashes y un ensayo transaccional con rollback. No borra esquemas, no desactiva triggers ni modifica otros proyectos.
- El respaldo se validó por checksum y lectura completa de sus entradas antes de aplicar la limpieza. El plan, respaldo, diario y verificaciones están en **`test-results/local-workspace/`**; contienen información privada y no deben publicarse.

`scripts/replace-local-records.mjs` acepta `prepare`, `inspect`, `rehearse`, `apply` y `verify`. `apply` exige `--confirm-local-replacement`, respaldo intacto y ensayo aprobado. El marcador de auditoría evita repetir la limpieza; el diario y las claves idempotentes permiten continuar una carga interrumpida. No elimine estos archivos para reintentar ni use `prepare` sobre una carga ya preparada.

Los modos `verify` y la aceptación de navegador comparan el conjunto inicial; una operación posterior legítima puede cambiar sus importes o cantidades. Un resultado distinto no autoriza a restaurar ni descartar esos cambios.

## Aceptación de navegador

Con la aplicación de `3030` activa:

```powershell
.venv\Scripts\python.exe -X utf8 -B tests/browser/local_workspace_acceptance.py
```

Comprueba las ocho pantallas en cuatro anchos, los cuatro filtros de flota, el Gantt, los siete expedientes, los cinco folios y las descargas de presupuesto PDF, contrato PDF, CSV e imagen privada. Bloquea conexiones fuera de esta aplicación y su API. No registra movimientos de negocio; descargar un PDF puede guardar su archivo privado.
