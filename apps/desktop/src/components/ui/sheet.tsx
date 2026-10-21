import * as React from 'react';
import {Dialog as SheetPrimitive} from 'radix-ui';
import {X} from 'lucide-react';
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;
/** Modal checklist: Radix traps focus, closes on Escape and restores the trigger. */
export function SheetContent({children, closeLabel}: {children: React.ReactNode; closeLabel: string}) {
  return <SheetPrimitive.Portal><SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
    <SheetPrimitive.Content data-testid="hard-mode-drawer" className="fixed inset-y-0 right-0 z-50 flex w-[470px] max-w-full flex-col gap-4 overflow-y-auto border-l bg-background p-6 text-foreground shadow-lg">
      {children}<SheetPrimitive.Close aria-label={closeLabel} className="absolute right-4 top-4 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" aria-hidden="true" /></SheetPrimitive.Close>
    </SheetPrimitive.Content></SheetPrimitive.Portal>;
}
