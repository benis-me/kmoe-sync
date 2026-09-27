import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

/** On/off for settings that apply at once. The off track keeps >= 3:1 against the card. */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-muted-foreground/70 p-0.5 transition-[background-color,box-shadow] duration-200 ease-out-strong outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-seal",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 rounded-full bg-card shadow-soft transition-transform duration-200 ease-out-strong data-[state=checked]:translate-x-4 dark:bg-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
