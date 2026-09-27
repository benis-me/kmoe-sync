import * as React from "react"
import { cn } from "cn"

/**
 * A single highlight that glides to the active sibling (tabs, segmented controls, nav).
 * Place inside a `relative` container whose direct children carry the active state.
 * `axis="x"` only follows the horizontal position and width (underlines).
 */
function Indicator({
  className,
  selector = '[data-state="active"],[data-state="on"],[aria-current="page"]',
  axis = "box",
}: {
  className?: string
  selector?: string
  axis?: "box" | "x"
}) {
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    let frame = 0
    const place = () => {
      const target = parent.querySelector<HTMLElement>(`:scope > :is(${selector})`)
      el.style.opacity = target ? "1" : "0"
      if (!target) return
      // Hidden (display:none section): keep the last placement and drop the glide, so it snaps into place when shown.
      if (!target.offsetWidth) { cancelAnimationFrame(frame); el.removeAttribute("data-ready"); return }
      el.style.width = `${target.offsetWidth}px`
      if (axis === "box") el.style.height = `${target.offsetHeight}px`
      el.style.transform = `translate(${target.offsetLeft}px, ${axis === "box" ? target.offsetTop : 0}px)`
      // Enable the glide only after a real placement, so it never slides in from 0.
      if (!el.hasAttribute("data-ready")) { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => el.setAttribute("data-ready", "")) }
    }
    place()
    const mutations = new MutationObserver(place)
    mutations.observe(parent, { attributes: true, subtree: true, childList: true, attributeFilter: ["data-state", "aria-current"] })
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place)
    if (resize) for (const child of [parent, ...parent.children]) resize.observe(child)
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); resize?.disconnect() }
  }, [selector, axis])
  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="indicator"
      className={cn(
        "pointer-events-none absolute top-0 left-0 opacity-0 data-ready:transition-[transform,width,height,opacity] data-ready:duration-300 data-ready:ease-in-out-strong",
        className
      )}
    />
  )
}

export { Indicator }
