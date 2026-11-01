'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { gsap } from 'gsap';
/** Scoped animations revert on navigation and respect reduced motion. */
export function AnimatedWorkspace({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const elements = root.current?.querySelectorAll('.page-heading, .aj-hero, .stat-card, .dashboard-charts > .panel, .vehicle-card, .kanban-column, .report-card');
      if (elements?.length) gsap.from(elements, { y: 22, opacity: 0, duration: .65, stagger: .055, ease: 'power3.out', clearProps: 'all' });
      const car = root.current?.querySelector('.hero-car');
      if (car) gsap.from(car, { x: 65, y: 16, scale: .94, opacity: 0, duration: 1.25, delay: .12, ease: 'power3.out', clearProps: 'all' });
      const line = root.current?.querySelector('.hero-speed-line');
      if (line) gsap.from(line, { scaleX: 0, transformOrigin: 'left center', duration: 1.2, delay: .45, ease: 'power3.out' });
    }, root);
    media.add('(prefers-reduced-motion: no-preference) and (pointer: fine)', () => {
      const stage = root.current?.querySelector<HTMLElement>('.hero-stage');
      const car = stage?.querySelector<HTMLElement>('.hero-car');
      if (!stage || !car) return;
      const moveX = gsap.quickTo(car, 'x', { duration: .8, ease: 'power3.out' });
      const moveY = gsap.quickTo(car, 'y', { duration: .8, ease: 'power3.out' });
      const rotate = gsap.quickTo(car, 'rotationY', { duration: .8, ease: 'power3.out' });
      const move = (event: PointerEvent) => {
        const box = stage.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - .5;
        const y = (event.clientY - box.top) / box.height - .5;
        moveX(x * 16); moveY(y * 10); rotate(x * 5);
      };
      const leave = () => { moveX(0); moveY(0); rotate(0); };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerleave', leave);
      return () => { stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerleave', leave); };
    }, root);
    return () => media.revert();
  }, [pathname]);
  return <div ref={root} className="page-motion">{children}</div>;
}
