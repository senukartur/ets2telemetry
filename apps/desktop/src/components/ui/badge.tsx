import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit max-w-full shrink-0 items-center justify-center gap-[5px] overflow-hidden rounded-[4px] border px-[7px] py-0 text-xs leading-4 font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-[13px]! [&>svg]:shrink-0 [&>svg]:stroke-[1.8]",
  {
    variants: {
      variant: {
        ok: "badge-ok",
        warn: "badge-warn",
        error: "badge-error",
        neutral: "badge-neutral",
        info: "badge-info",
        ets2: "badge-ets2",
        ats: "badge-ats",
        later: "badge-neutral border-dashed",
        default: "badge-neutral",
        secondary: "badge-neutral",
        destructive: "badge-error",
        outline: "badge-neutral",
        ghost: "badge-neutral",
        link: "badge-info underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
