'use client';
import {useEffect,useRef,useState} from 'react';
import {useBusiness} from '@/hooks/use-business';
import {PageHeading} from '@/components/molecules/page-heading';
import {Button} from '@/components/ui/button';
import {money} from '@/controladores/finanzas';
import {InventarioScreen} from './inventario-screen';
import {inventoryCommand,loadInventory,type InventoryCommand,type StockItem,type PurchaseOrder,type StockMovement} from '@/lib/supabase/inventory';
import {AdaptiveTable} from '@/components/organisms/adaptive-table';

export function InventoryScreen(){const {source}=useBusiness();return source==='supabase'?<InventoryWorkspace/>:<InventarioScreen/>;}
function InventoryWorkspace(){
  const {data,can,toast}=useBusiness();const [items,setItems]=useState<StockItem[]>([]);const [purchases,setPurchases]=useState<PurchaseOrder[]>([]);
  const [movements,setMovements]=useState<StockMovement[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const sending=useRef(false);const attempt=useRef<{body:string;key:string}|null>(null);
  async function reload(){const result=await loadInventory();setItems(result.items);setPurchases(result.purchases);setMovements(result.movements);}
  useEffect(()=>{void reload().catch(error=>setError(error.message));},[]);
  async function submit(command:InventoryCommand,payload:Record<string,unknown>,form?:HTMLFormElement){
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    const body=JSON.stringify({command,payload});if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    try{await inventoryCommand(command,payload,attempt.current.key);await reload();form?.reset();attempt.current=null;toast('Inventario actualizado con trazabilidad. Recibir no equivale a consumir ni pagar.');}
    catch(error){setError((error as Error).message);}finally{sending.current=false;setBusy(false);}
  }
  const received=(purchaseId:string)=>movements.filter(m=>m.purchase_id===purchaseId).reduce((sum,m)=>sum+Number(m.quantity),0);
  return <><PageHeading eyebrow="ALMACÉN / COMPRAS AUTORIZADAS" title="Inventario y compras"
    description="Recepciones parciales, consumo por orden y devoluciones al costo original. Valoración: promedio ponderado móvil."/>
    <p className="info-strip">Recibir una compra incrementa inventario y obligación con proveedor, no costo del vehículo ni pago de caja.
      El consumo carga la orden una sola vez; la devolución reduce su costo neto.</p>
    {can('expenses.write')&&<div className="grid gap-5 xl:grid-cols-2 mb-5">
      <details className="panel p-5"><summary>Crear artículo</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        void submit('item',Object.fromEntries(['sku','name','unit'].map(key=>[key,String(f.get(key))])),form);
      }}><label className="form-field"><span>SKU del artículo</span><input name="sku" required/></label>
        <label className="form-field"><span>Nombre del artículo</span><input name="name" required/></label>
        <label className="form-field"><span>Unidad del artículo</span><input name="unit" required defaultValue="unidad"/></label><Button type="submit" disabled={busy}>Guardar artículo</Button>
      </form></details>
      <details className="panel p-5"><summary>Solicitar compra o registrar apertura</summary><form className="operation-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const f=new FormData(form);
        void submit(String(f.get('command')) as InventoryCommand,Object.fromEntries(['itemId','quantity','unitCost','supplier','reason'].map(key=>[key,String(f.get(key))])),form);
      }}><label className="form-field"><span>Tipo de entrada</span><select aria-label="Tipo de entrada" name="command"><option value="request">Solicitar compra</option><option value="opening">Existencia inicial documentada</option></select></label>
        <label className="form-field"><span>Artículo de entrada</span><select aria-label="Artículo de entrada" name="itemId" required>{items.map(i=><option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}</select></label>
        <label className="form-field"><span>Cantidad solicitada o inicial</span><input name="quantity" type="number" min="0.0001" step="0.0001" required/></label>
        <label className="form-field"><span>Costo unitario de entrada (USD)</span><input name="unitCost" type="number" min="0.0001" step="0.0001" required/></label>
        <label className="form-field"><span>Proveedor de entrada</span><input name="supplier" required/></label>
        <label className="form-field"><span>Motivo de entrada</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Guardar solicitud o apertura</Button>
      </form></details>
    </div>}
    <section className="panel"><div className="table-scroll"><AdaptiveTable><thead><tr><th>Artículo</th><th>Existencia</th><th>Valor / promedio</th><th>Despacho</th></tr></thead><tbody>
      {items.map(item=><tr key={item.id}><td><strong>{item.sku} · {item.name}</strong><small>{item.id}</small></td><td>{item.quantity} {item.unit}</td>
        <td>{money(item.stock_value)} / {money(item.quantity>0?item.stock_value/item.quantity:0)}</td><td>{can('expenses.write')&&<details><summary>Despachar a orden</summary>
          <form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void submit('consume',{itemId:item.id,orderId:String(f.get('orderId')),quantity:String(f.get('quantity')),reason:String(f.get('reason'))});}}>
            <label className="form-field"><span>Orden destino de {item.sku}</span><select aria-label={`Orden destino de ${item.sku}`} name="orderId" required>{data.orders.filter(o=>o.status!=='Entregado').map(o=><option key={o.id} value={o.id}>{o.id} · {o.service}</option>)}</select></label>
            <label className="form-field"><span>Cantidad a despachar de {item.sku}</span><input name="quantity" type="number" min="0.0001" step="0.0001" required/></label>
            <label className="form-field"><span>Motivo de despacho de {item.sku}</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Confirmar despacho</Button>
          </form></details>}</td></tr>)}
    </tbody></AdaptiveTable></div></section>
    <section className="panel mt-5"><div className="p-5"><h2 className="font-semibold">Compras y cantidades pendientes</h2></div><div className="table-scroll"><AdaptiveTable><thead><tr><th>Compra / proveedor</th><th>Solicitado / recibido / pendiente</th><th>Estado</th><th>Recepción</th></tr></thead>
      <tbody>{purchases.map(p=><tr key={p.id}><td><strong>{p.supplier}</strong><small>{items.find(i=>i.id===p.item_id)?.name} · {p.id}</small></td>
        <td>{p.quantity} / {received(p.id)} / <strong>{Number(p.quantity)-received(p.id)}</strong></td><td>{p.status}</td><td>
          {can('expenses.write')&&p.status==='Solicitada'&&<Button disabled={busy} onClick={()=>{void submit('authorize',{purchaseId:p.id,expectedVersion:p.version,reason:'Compra revisada y autorizada por gerencia'});}}>Autorizar compra</Button>}
          {can('expenses.write')&&p.status==='Autorizada'&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);
            void submit('receive',{purchaseId:p.id,expectedVersion:p.version,quantity:String(f.get('quantity')),reason:String(f.get('reason'))});
          }}><label className="form-field"><span>Cantidad recibida de {p.id}</span><input name="quantity" type="number" min="0.0001" step="0.0001" required/></label>
            <label className="form-field"><span>Documento y motivo de recepción</span><input name="reason" required/></label><Button type="submit" disabled={busy}>Registrar recepción parcial</Button>
          </form>}
        </td></tr>)}</tbody></AdaptiveTable></div></section>
    <details className="panel p-5 mt-5"><summary>Historial de movimientos y devoluciones</summary>{movements.map(m=><article key={m.id} className="inline-note mt-3"><p>{m.kind} · {m.quantity} · {money(m.amount)} · {m.order_id??m.purchase_id??'Apertura'}</p><small>{m.id} · {m.reason}</small>
      {can('expenses.write')&&m.kind==='Consumo'&&<form className="operation-form" onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void submit('return',{dispatchId:m.id,quantity:String(f.get('quantity')),reason:String(f.get('reason'))});}}>
        <label className="form-field"><span>Cantidad a devolver de {m.id}</span><input name="quantity" type="number" min="0.0001" step="0.0001" required/></label>
        <label className="form-field"><span>Motivo de devolución a almacén</span><input name="reason" required/></label><Button variant="outline" type="submit" disabled={busy}>Devolver al costo de origen</Button>
      </form>}
    </article>)}</details>
    {error&&<p className="form-error mt-4" role="alert">{error}</p>}
  </>;
}
