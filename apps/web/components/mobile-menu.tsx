'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import * as React from 'react';

export function MobileMenu({
  title,
  children,
}: {
  title: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="mobile-menu-button" type="button" aria-label="Open navigation menu">
          <Menu size={21} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="mobile-menu-overlay" />
        <Dialog.Content className="mobile-menu-panel" aria-describedby={undefined}>
          <div className="mobile-menu-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="mobile-menu-close"
                type="button"
                aria-label="Close navigation menu"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          {children(close)}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
