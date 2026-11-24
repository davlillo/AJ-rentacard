export function workshopClientVehicles<T extends {id:string;inRentalFleet?:boolean}>(
  vehicles:readonly T[],
  orders:readonly {vehicleId:string;status:string}[],
):T[]{
  const activeVehicleIds=new Set(orders.filter(order=>order.status!=='Entregado').map(order=>order.vehicleId));
  return vehicles.filter(vehicle=>!vehicle.inRentalFleet&&activeVehicleIds.has(vehicle.id));
}
