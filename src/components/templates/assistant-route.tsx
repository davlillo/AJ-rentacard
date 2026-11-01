'use client';
import {useBusiness} from '@/hooks/use-business';
import {AsistenteScreen} from './asistente-screen';
import {OperationalAssistant} from './operational-assistant';
export function AssistantScreen(){const {source}=useBusiness();return source==='supabase'?<OperationalAssistant/>:<AsistenteScreen/>;}
