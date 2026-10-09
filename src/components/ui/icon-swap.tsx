import type { ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"

/**
 * An icon that changes state (copy → check, sun → moon): the old one blurs and shrinks away as the new one sharpens in,
 * so it reads as one icon changing rather than two swapping. `id` names the state; a new id plays the swap.
 */
function IconSwap({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="relative inline-flex">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={id}
          className="inline-flex"
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

export { IconSwap }
