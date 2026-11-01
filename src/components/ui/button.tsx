import * as React from 'react';
import {Slot} from '@radix-ui/react-slot';
import {cva,type VariantProps} from 'class-variance-authority';
import {cn} from '@/lib/utils';
const buttonVariants=cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',{variants:{variant:{default:'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs',outline:'border border-input bg-white hover:bg-muted text-foreground',ghost:'hover:bg-muted text-muted-foreground',destructive:'bg-red-600 text-white hover:bg-red-700'},size:{default:'h-10 px-4',sm:'h-8 px-3 text-xs',icon:'h-9 w-9'}},defaultVariants:{variant:'default',size:'default'}});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>,VariantProps<typeof buttonVariants>{asChild?:boolean;}
const Button=React.forwardRef<HTMLButtonElement,ButtonProps>(({className,variant,size,asChild=false,...props},ref)=>{const Comp=asChild?Slot:'button';return <Comp className={cn(buttonVariants({variant,size,className}))} ref={ref} {...props}/>;});Button.displayName='Button';export {Button,buttonVariants};
