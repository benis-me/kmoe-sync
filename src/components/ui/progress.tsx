"use client"

import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  indicatorClassName,
  value,
  active = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string
  /** Show moving hatching while work is in flight. */
  active?: boolean
}) {
  const previous = React.useRef(value)
  const backwards = (value ?? 0) < (previous.current ?? 0)
  React.useEffect(() => { previous.current = value })
  const indeterminate = value == null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        "relative flex h-1.5 w-full items-center overflow-hidden rounded-full bg-foreground/8",
        className
      )}
      {...props}
    >
      {/* 1000ms linear on purpose (as the FAB ring and footer line): it spans the ~1 s poll, so the fill glides instead of stepping. */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "size-full flex-1 rounded-full bg-seal transition-transform duration-1000 ease-linear",
          backwards && "transition-none",
          (active || indeterminate) && "stripes",
          indeterminate && "opacity-40",
          indicatorClassName
        )}
        style={{ transform: `translateX(-${indeterminate ? 0 : 100 - Math.min(100, Math.max(0, value))}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
