import * as React from 'react';
import {Dialog as SheetPrimitive} from 'radix-ui';
import {X} from 'lucide-react';
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;
/** Radix owns focus trapping, Escape, modal semantics and focus restoration to the trigger. */
export function SheetContent({children}: {children: React.ReactNode}) {
  return <SheetPrimitive.Portal><SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
    <SheetPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-[470px] max-w-full flex-col gap-4 overflow-y-auto border-l bg-background p-6 text-foreground shadow-lg">
      {children}<SheetPrimitive.Close aria-label="Close checklist" className="absolute right-4 top-4 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" aria-hidden="true" /></SheetPrimitive.Close>
    </SheetPrimitive.Content></SheetPrimitive.Portal>;
}
