'use client';
import Link from 'next/link';
import { ArrowUpRight, CalendarDays, CircleCheck, MoveUpRight } from 'lucide-react';
import { useBusiness } from '@/hooks/use-business';
export function BrandHero() {
  const { data, open } = useBusiness();
  const available = data.vehicles.filter(v => v.status === 'Disponible').length;
  return <section className="aj-hero">
    <div className="hero-noise" aria-hidden="true" />
    <div className="hero-copy">
      <div className="hero-eyebrow"><span /> EL CONTROL TE MUEVE</div>
      <h2>Tu negocio.<br /><em>A toda marcha.</em></h2>
      <p>Cada reserva, cada carro, cada detalle.<br />Toda la operación de AJ, en tus manos.</p>
      <div className="hero-actions">
        <button className="hero-primary" onClick={() => open('reserva')}>Crear una reserva <ArrowUpRight size={17} /></button>
        <Link href="/vehiculos">Explorar flota <MoveUpRight size={16} /></Link>
      </div>
      <div className="hero-availability"><CircleCheck size={14} /><strong>{available} vehículos disponibles</strong><span>Listos para salir</span></div>
    </div>
    <div className="hero-stage">
      <div className="hero-ring" aria-hidden="true" />
      <span className="hero-watermark" aria-hidden="true">AJ</span>
      <div className="hero-speed-line" aria-hidden="true" />
      <img className="hero-car" src="/images/aj-red-suv.png" alt="Render de un SUV rojo con acabado metálico" width="1536" height="1024" fetchPriority="high" />
      <Link href="/calendario" className="hero-floating-label"><span className="hero-label-icon"><CalendarDays size={17} /></span><span><small>TU PRÓXIMO MOVIMIENTO</small><strong>Calendario de reservas</strong></span><ArrowUpRight size={17} /></Link>
      <span className="hero-caption">AJ RENT A CAR <i /> DRIVE YOUR BUSINESS</span>
    </div>
  </section>;
}
