import {readRows} from './business';
import {workshopRpc} from './workshop';

export interface StockItem {id:string;sku:string;name:string;unit:string;quantity:number;stock_value:number;version:number;}
export interface PurchaseOrder {id:string;item_id:string;supplier:string;quantity:number;unit_cost:number;status:string;version:number;}
export interface StockMovement {id:string;item_id:string;order_id:string|null;purchase_id:string|null;reverses_id:string|null;kind:string;quantity:number;unit_cost:number;amount:number;reason:string;}
export type InventoryCommand='item'|'opening'|'consume'|'return'|'request'|'authorize'|'receive';
export async function loadInventory(){
  const [items,purchases,movements]=await Promise.all([readRows<StockItem>('stock_items','*'),readRows<PurchaseOrder>('purchase_orders','*'),readRows<StockMovement>('stock_movements','*')]);
  return{items,purchases,movements};
}
export async function inventoryCommand(command:InventoryCommand,payload:Record<string,unknown>,key:string):Promise<{id:string}>{
  return workshopRpc('execute_inventory_command',{command,payload,idempotency_key:key});
}
