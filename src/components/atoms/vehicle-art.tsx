type VehicleArtProps = { category?: string; color?: string; suv?: boolean; model?: string };
/** Local generated renders are illustrative, not photos of each specific asset. */
export function VehicleArt({ category, color, suv = false, model }: VehicleArtProps) {
  const image = category === 'Pickup' ? 'aj-pickup.png'
    : category === 'SUV' || suv ? 'aj-white-suv.png'
    : color === 'Rojo' || category === 'Compacto' ? 'aj-red-hatch.png'
    : 'aj-silver-sedan.png';
  return <img src={`/images/${image}`} alt={`Render ilustrativo${model ? ` para ${model}` : ' del vehículo'}`} className="vehicle-art" width="1536" height="1024" loading="lazy" decoding="async" />;
}
