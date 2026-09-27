import { useState } from 'react';
import { cn } from 'cn';

/** 3:4 book cover over screentone; the title's first character stands in until (or unless) the image loads.
 *  No referrer: Bangumi covers are external images. */
export function Cover({ src, title, className }: { src: string | null; title: string; className?: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The hairline sits on ::after so it draws over the image: neutral black or white at 10%, never a tint of the surface.
  return <div className={cn('@container relative aspect-[3/4] shrink-0 overflow-hidden rounded-lg bg-muted shadow-soft after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:outline after:-outline-offset-1 after:outline-black/10 dark:after:outline-white/10', className)}>
    <div aria-hidden className="absolute inset-0 grid place-items-center tone">
      <span className="text-[40cqw] leading-none font-semibold text-muted-foreground/60">{Array.from(title.trim())[0] ?? ''}</span>
    </div>
    {src && failed !== src && <img
      key={src} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onLoad={() => setLoaded(src)} onError={() => setFailed(src)}
      className={cn('absolute inset-0 size-full object-cover transition-opacity duration-300 ease-out-strong', loaded === src ? 'opacity-100' : 'opacity-0')}
    />}
  </div>;
}
