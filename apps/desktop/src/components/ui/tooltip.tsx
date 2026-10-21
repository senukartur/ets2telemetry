import * as React from 'react';
import {Tooltip as TooltipPrimitive} from 'radix-ui';
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
/** Noninteractive parameter hints; Radix owns hover/focus opening and Escape dismissal. */
export function TooltipContent({children, ...props}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content sideOffset={6} {...props} className="z-50 max-w-sm rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md">
    {children}<TooltipPrimitive.Arrow className="fill-popover" />
  </TooltipPrimitive.Content></TooltipPrimitive.Portal>;
}
