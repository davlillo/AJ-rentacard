export type VehicleStatus = 'Disponible'|'Alquilado'|'En taller'|'Por confirmar';
export interface Vehicle { id:string; plate:string; brand:string; model:string; year:number; category:string; color:string; daily:number; km:number; status:VehicleStatus; ownership?:'Propio'|'Cliente'|'Por confirmar';ownerCustomerId?:string|null;vin?:string|null;version?:number;inRentalFleet?:boolean;registeredHolder?:string;commercialLine?:string;primaryPhotoId?:string;unverified_fields?:string[]; }
export interface Customer {id:string;name:string;email:string;phone:string;type:'Personal'|'Empresa';document:string;version?:number;aliases?:{phone:string;document:string;name:string}[];}
export interface Rental {id:string;vehicleId:string;customerId:string;start:string;end:string;total:number;paid:number;status:'Confirmada'|'En curso'|'Finalizada'|'Cancelada';}
export interface WorkOrder {id:string;vehicleId:string;customerId:string|null;area:'Mecánica'|'Pintura';service:string;technician:string;status:'Presupuesto'|'Diagnóstico'|'En proceso'|'Control de calidad'|'Entregado';hours:number;estimate:number;paid:number;due:string;pendingFields?:string[];occurredAt?:string;createdAt?:string;createdBy?:string;version?:number;internalJob?:boolean;}
export interface Movement {id:string;date:string;concept:string;amount:number;type:'Ingreso'|'Egreso';area:'Renta'|'Taller'|'Administración';method:string;operation:string;category?:string;account?:string;currency?:string;support?:string;createdAt?:string;createdBy?:string;}
export interface Item {id:string;name:string;sku:string;category:string;stock:number;min:number;cost:number;}
export interface EstimateLine {description:string;quantity:number;cost:number;price:number;}
export interface Estimate {id:string;orderId:string;customerId:string|null;lines:EstimateLine[];discount:number;status:'Borrador'|'Enviado'|'Aprobado';}
export interface WorkshopTask {id:string;orderId:string;description:string;assignedTo:string;assigneeLabel:string;status:'Pendiente'|'En proceso'|'Finalizada';version:number;createdAt:string;}
export interface ReservationHistory {id:string;vehicleId:string;customerId:string;start:string;end:string;status:string;rentalState:string;folioNumber?:number;}
export interface BusinessData {vehicles:Vehicle[];customers:Customer[];rentals:Rental[];orders:WorkOrder[];movements:Movement[];items:Item[];estimates:Estimate[];tasks?:WorkshopTask[];reservationHistory?:ReservationHistory[];}
export type ModalKind = 'reserva'|'cliente'|'gasto'|'orden'|'presupuesto'|'pago'|'inventario'|'importar'|'tiempo'|'vehiculo'|null;
export interface ModalState {kind:ModalKind;id?:string;}
