'use client';
import {cloneElement, useId, useRef, useState} from 'react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {useBusiness} from '@/hooks/use-business';
import {customerMatches} from '@/controladores/clientes';
import type {BusinessCommand} from '@/lib/supabase/business';

const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/El_Salvador'}).format(new Date());
function Field({label, children}: {label: string; children: React.ReactElement<{'aria-labelledby'?: string}>}) {
  const id = useId();
  return <label className="form-field"><span id={id}>{label}</span>{cloneElement(children, {'aria-labelledby': id})}</label>;
}

export function OperationalDialog() {
  const {data, modal, command, close, toast} = useBusiness();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [document, setDocument] = useState('');
  const [ownership, setOwnership] = useState('Por confirmar');
  const [internalJob,setInternalJob]=useState(false);
  const [destination, setDestination] = useState(modal.id?.startsWith('vehicle:')?'vehicle':
    modal.id?.startsWith('reservation:')?'reservation':modal.id ? 'operation' : 'center');
  const request = useRef<{body: string; key: string} | null>(null);
  const sending = useRef(false);
  const matches = customerMatches(data.customers, phone, document);
  const titles: Record<string, string> = {
    cliente: 'Nuevo cliente', vehiculo: 'Registrar vehículo', orden: 'Recepción rápida', gasto: 'Registrar gasto',
  };
  const customerSelect = (name: string) => <Field label={name === 'ownerCustomerId' ? 'Propietario' : 'Cliente'}>
    <select required name={name} defaultValue=""><option value="" disabled>Seleccionar cliente</option>
      {data.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
    </select>
  </Field>;

  return <Dialog open onOpenChange={open => !open && !busy && close()}>
    <DialogContent><DialogTitle className="text-2xl font-semibold">{titles[modal.kind!]}</DialogTitle>
      <DialogDescription className="text-sm text-muted-foreground mt-1">
        {modal.kind==='orden'?'Registre la recepción del vehículo y complete después su inspección.':'Complete los datos conocidos. Los campos opcionales pueden quedar vacíos.'}
      </DialogDescription>
      <form className="operation-form" onSubmit={async event => {
        event.preventDefault();
        if (sending.current) return;
        const fields = new FormData(event.currentTarget);
        const text = (name: string) => String(fields.get(name) ?? '').trim();
        let name: BusinessCommand;
        let payload: Record<string, unknown>;
        if (modal.kind === 'cliente') {
          name = 'create_customer';
          payload = {name: text('name'), phone, document, email: text('email'), type: text('type')};
        } else if (modal.kind === 'vehiculo') {
          name = 'create_vehicle';
          payload = {plate: text('plate'), vin: text('vin'), brand: text('brand'), model: text('model'),
            year: Number(text('year')), category: text('category'), color: text('color'),
            daily: Number(text('daily')), km: Number(text('km')), ownership,initialStatus:'Por confirmar',
            unverifiedFields:[...['plate','color','daily','km'].filter(field=>!text(field)),
              ...(ownership==='Por confirmar'?['ownership']:[]),'status'],
            ownerCustomerId: ownership === 'Cliente' ? text('ownerCustomerId') : null,
            inRentalFleet:fields.has('inRentalFleet'),registeredHolder:text('registeredHolder'),commercialLine:text('commercialLine')};
        } else if (modal.kind === 'orden') {
          name = 'receive_vehicle';
          payload = {customerId: internalJob?null:text('customerId'),internalJob, vehicleId: text('vehicleId'), service: text('service'),
            area: text('area'), due: text('due') || null};
        } else {
          name = 'record_expense';
          payload = {concept: text('concept'), category: text('category'), amount: text('amount'),
            date: text('date'), method: text('method'), account: text('account'), support: text('support'),
            operationId: destination === 'operation' ? text('operationId') : null,
            costCenterId: destination === 'center' ? text('costCenterId') : null,
            vehicleId:destination==='vehicle'?text('vehicleId'):null,
            reservationId:destination==='reservation'?text('reservationId'):null};
        }
        const body = JSON.stringify({name, payload});
        // Retain the key after a lost response; a changed form is a different proposal.
        if (request.current?.body !== body) request.current = {body, key: crypto.randomUUID()};
        sending.current = true; setBusy(true); setError('');
        try {
          await command(name, payload, request.current.key);
          toast('Registro guardado.'); close();
        } catch (error) {setError((error as Error).message);}
        finally {sending.current = false; setBusy(false);}
      }}>
        <fieldset disabled={busy} className="contents">
          {modal.kind === 'cliente' && <>
            <Field label="Nombre o razón social"><input name="name" required maxLength={200}/></Field>
            <Field label="Teléfono (opcional)"><input name="phone" type="tel" value={phone}
              onChange={event => setPhone(event.target.value)}/></Field>
            <Field label="DUI / NIT"><input name="document" value={document}
              onChange={event => setDocument(event.target.value)}/></Field>
            <Field label="Correo electrónico"><input name="email" type="email"/></Field>
            <Field label="Tipo"><select name="type"><option>Personal</option><option>Empresa</option></select></Field>
            {matches.length > 0 && <section className="inline-note" aria-label="Coincidencias de clientes">
              <strong>Ya hay coincidencias. Reutilizá la ficha existente:</strong>
              {matches.map(customer => <p key={customer.id}>{customer.name} · {customer.phone} · {customer.document}</p>)}
              <Button type="button" variant="outline" onClick={close}>Volver al directorio</Button>
            </section>}
          </>}
          {modal.kind === 'vehiculo' && <>
            <Field label="Placa (si se conoce)"><input name="plate"/></Field>
            <Field label="VIN (opcional)"><input name="vin"/></Field>
            <div className="form-grid">
              <Field label="Marca"><input name="brand" required/></Field>
              <Field label="Modelo"><input name="model" required/></Field>
            </div>
            <div className="form-grid">
              <Field label="Año"><input name="year" type="number" min={1900} max={2100} required/></Field>
              <Field label="Kilometraje (si se conoce)"><input name="km" type="number" min={0} step={1}/></Field>
            </div>
            <Field label="Categoría"><select name="category"><option>Sedán</option><option>SUV</option>
              <option>Pickup</option><option>Compacto</option></select></Field>
            <Field label="Color (opcional)"><input name="color"/></Field>
            <Field label="Tarifa diaria de renta (opcional)"><input name="daily" type="number" min={0} step="0.01"/></Field>
            <p className="field-hint">Kilometraje, tarifa y estado quedan pendientes hasta verificarlos. Registrar el vehículo no significa recibirlo ni declararlo disponible.</p>
            <Field label="Relación"><select value={ownership} onChange={event => setOwnership(event.target.value)}>
              <option>Propio</option><option>Cliente</option><option>Por confirmar</option></select></Field>
            {ownership === 'Cliente' && customerSelect('ownerCustomerId')}
            <label className="inline-note"><input name="inRentalFleet" type="checkbox"/> Incluir explícitamente en la flota de alquiler</label>
            <Field label="Titular registral (opcional)"><input name="registeredHolder"/></Field>
            <Field label="Línea comercial de renta (opcional)"><input name="commercialLine"/></Field>
          </>}
          {modal.kind === 'orden' && <>
            <label className="inline-note"><input type="checkbox" checked={internalJob} onChange={e=>setInternalJob(e.target.checked)}/>
              Mantenimiento interno de flota (sin venta al negocio)</label>
            {!internalJob&&customerSelect('customerId')}
            <Field label="Vehículo"><select key={String(internalJob)} required name="vehicleId" defaultValue={modal.id??''}>
              <option value="" disabled>Seleccionar vehículo disponible</option>
              {data.vehicles.filter(vehicle => vehicle.status === 'Disponible'&&(!internalJob||vehicle.inRentalFleet)&&
                !data.orders.some(order=>order.vehicleId===vehicle.id&&order.status!=='Entregado')).map(vehicle =>
                <option key={vehicle.id} value={vehicle.id}>{vehicle.plate} · {vehicle.brand} {vehicle.model}</option>)}
            </select></Field>
            <Field label="Motivo del ingreso"><textarea name="service" required maxLength={2000}/></Field>
            <Field label="Área"><select name="area"><option>Mecánica</option><option>Pintura</option></select></Field>
            <Field label="Fecha objetivo (opcional)"><input name="due" type="date"/></Field>
            <p className="inline-note">Si el vehículo ya tiene un presupuesto, complete su recepción en el expediente del trabajo.
              Los vehículos sin estado confirmado se revisan primero en su ficha.</p>
          </>}
          {modal.kind === 'gasto' && <>
            <Field label="Concepto"><input name="concept" required maxLength={2000}/></Field>
            <div className="form-grid">
              <Field label="Importe (USD)"><input name="amount" type="number" min="0.01" step="0.01" required/></Field>
              <Field label="Fecha efectiva"><input name="date" type="date" defaultValue={today()} required/></Field>
            </div>
            <Field label="Categoría"><input name="category" required/></Field>
            <Field label="Destino"><select value={destination} onChange={event => setDestination(event.target.value)}>
              <option value="operation">Ingreso de taller</option><option value="reservation">Alquiler / reserva</option>
              <option value="vehicle">Vehículo (gasto general)</option><option value="center">Centro de costo</option></select></Field>
            {destination === 'operation' ? <Field label="Operación"><select name="operationId" required defaultValue={modal.id ?? ''}>
              <option value="" disabled>Seleccionar orden</option>
              {data.orders.filter(order => order.status !== 'Entregado').map(order => <option key={order.id} value={order.id}>
                {order.id} · {data.vehicles.find(vehicle => vehicle.id === order.vehicleId)?.plate}
              </option>)}
            </select></Field> : destination==='vehicle'?<Field label="Vehículo del gasto"><select name="vehicleId" required defaultValue={modal.id?.replace('vehicle:','')??''}>
              <option value="" disabled>Seleccionar vehículo</option>{data.vehicles.map(vehicle=><option key={vehicle.id} value={vehicle.id}>{vehicle.plate}</option>)}
            </select></Field>:destination==='reservation'?<Field label="Alquiler del gasto"><select name="reservationId" required defaultValue={modal.id?.replace('reservation:','')??''}>
              <option value="" disabled>Seleccionar alquiler</option>{(data.reservationHistory??[]).map(r=><option key={r.id} value={r.id}>
                {data.vehicles.find(v=>v.id===r.vehicleId)?.plate} · {r.start} · {r.status}</option>)}
            </select></Field>:<Field label="Centro de costo"><select name="costCenterId">
              <option value="administration">Administración</option><option value="workshop">Taller</option>
              <option value="rental">Renta</option></select></Field>}
            <Field label="Medio de pago"><select name="method"><option>Efectivo</option>
              <option>Transferencia</option><option>Tarjeta</option></select></Field>
            <Field label="Cuenta o caja"><input name="account" required/></Field>
            <Field label="Referencia del soporte (opcional)"><input name="support"/></Field>
          </>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="form-footer"><Button type="button" variant="outline" onClick={close}>Cancelar</Button>
            <Button type="submit" disabled={busy || (modal.kind === 'cliente' && matches.length > 0)}>
              {busy ? 'Guardando…' : 'Guardar registro'}
            </Button></div>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}
