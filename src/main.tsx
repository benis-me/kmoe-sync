import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/app/toaster';
// '@/mock' before '@/router': demo mode rewrites the URL (drops ?mock) when it is imported, before the router reads it.
import { installMock } from '@/mock';
import { queryClient, router } from '@/router';
import '@/styles/app.css';

// Demo mode serves the API in the browser: in place before the first request.
await installMock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
