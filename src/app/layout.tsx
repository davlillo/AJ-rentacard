import type { Metadata } from "next";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "./globals.css";
import "./operations.css";
import { AppShell } from "@/components/templates/app-shell";
import { OperationalRouteGate } from "@/components/templates/operational-route-gate";
export const metadata:Metadata={title:"AJ · Renta y taller",icons:{icon:"/aj-icon.svg"},description:"Tu flota, tus talleres y tus números. Un solo lugar para mover tu negocio."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="es"><body><AppShell><OperationalRouteGate>{children}</OperationalRouteGate></AppShell></body></html>;}
