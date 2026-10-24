import * as React from 'react';
import {cn} from 'cn';
import {Slider as SliderPrimitive} from 'radix-ui';

/** Pending saves block Radix input while retaining the thumb's focusability; read-only stays fully disabled. */
export function Slider({className, labelId, descriptionId, thumbId, value, disabled, pending = false, ...props}:
  React.ComponentProps<typeof SliderPrimitive.Root> & {labelId: string; descriptionId?: string; thumbId: string; pending?: boolean}) {
  return <SliderPrimitive.Root className={cn('relative flex min-h-8 w-full touch-none select-none items-center data-disabled:opacity-50', className)}
    value={value} disabled={disabled || pending} {...props}>
    <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-input">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb id={thumbId} aria-labelledby={labelId} aria-describedby={descriptionId} aria-disabled={disabled || pending} aria-busy={pending || undefined}
      {...(pending && !disabled ? {tabIndex: 0} : {})}
      aria-valuetext={`${value?.[0]}%`}
      className="block size-5 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:pointer-events-none" />
  </SliderPrimitive.Root>;
}
