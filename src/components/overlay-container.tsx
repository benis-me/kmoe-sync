import { createContext, useContext } from 'react';

// Extension overlays must remain inside the styled ShadowRoot.
export const OverlayContainer = createContext<HTMLElement | undefined>(undefined);
export const useOverlayContainer = () => useContext(OverlayContainer);
