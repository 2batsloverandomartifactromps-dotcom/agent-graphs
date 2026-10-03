/**
 * Hand-written shadcn-style primitives on `radix-ui`, styled with the mockup classes
 * (docs/ui.md §6; the shadcn registry is not reachable from cloud sessions).
 */

import { X } from 'lucide-react';
import { Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useState } from 'react';
import { cn } from '../lib/utils';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'success' | 'danger' | 'danger-soft';
  size?: 'md' | 'sm' | 'xs';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('btn', variant !== 'default' && variant, size !== 'md' && size, className)}
      {...rest}
    />
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; bordered?: boolean }
>(function IconButton({ label, bordered, className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn('icon-btn', bordered && 'bordered', className)}
      {...rest}
    />
  );
});

export function Tip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  if (!content) return <>{children}</>;
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className="tooltip" side={side} sideOffset={6}>
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="overlay-scrim" />
        <D.Content
          className={cn('dialog', wide && 'wide')}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="dialog-h">
            <D.Title asChild>
              <h2>{title}</h2>
            </D.Title>
            <D.Close asChild>
              <IconButton label="Close" className="ml-auto" style={{ width: 26, height: 26 }}>
                <X size={14} />
              </IconButton>
            </D.Close>
          </div>
          {description ? (
            <D.Description asChild>
              <div className="dialog-d">{description}</div>
            </D.Description>
          ) : (
            <D.Description className="sr-only">
              {typeof title === 'string' ? title : 'Dialog'}
            </D.Description>
          )}
          {children && <div className="dialog-b">{children}</div>}
          {footer && <div className="dialog-f">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/**
 * Confirmation with an optional reason field. Destructive actions (cancel, fail, skip) require
 * a reason, which is stored in the event (docs/ui.md §7).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  reason,
  reasonLabel = 'Reason',
  destructive,
  number,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  reason?: 'required' | 'optional';
  reasonLabel?: string;
  destructive?: boolean;
  number?: { label: string; default: number; min?: number };
  onConfirm: (values: { reason: string; number: number }) => Promise<unknown> | undefined;
}) {
  const [text, setText] = useState('');
  const [num, setNum] = useState(String(number?.default ?? 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (reason === 'required' && !text.trim()) {
      setError(`${reasonLabel} is required.`);
      return;
    }
    const n = Number(num);
    if (number && (!Number.isInteger(n) || n < (number.min ?? 1))) {
      setError(`${number.label} must be a whole number ≥ ${number.min ?? 1}.`);
      return;
    }
    setBusy(true);
    try {
      await onConfirm({ reason: text.trim(), number: n });
      setText('');
      setError(undefined);
      onOpenChange(false);
    } catch {
      // the caller toasts the server error
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(undefined);
        onOpenChange(o);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={submit} disabled={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {number && (
        <div className="field" style={{ marginTop: 0 }}>
          <label htmlFor="confirm-number">{number.label}</label>
          <input
            id="confirm-number"
            className="input"
            type="number"
            min={number.min ?? 1}
            value={num}
            onChange={(e) => setNum(e.target.value)}
          />
        </div>
      )}
      {reason && (
        <div className="field" style={number ? undefined : { marginTop: 0 }}>
          <label htmlFor="confirm-reason">
            {reasonLabel} {reason === 'optional' && <span className="muted">(optional)</span>}
          </label>
          <textarea
            id="confirm-reason"
            className="textarea prose"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Stored in the event log"
            // biome-ignore lint/a11y/noAutofocus: dialogs focus their first field
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
        </div>
      )}
      {error && <div className="form-err">{error}</div>}
    </Modal>
  );
}

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
}) {
  return (
    <DM.Portal>
      <DM.Content className="menu" align={align} sideOffset={6}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DM.Item
      className={cn('menu-item', danger && 'danger')}
      onSelect={onSelect}
      disabled={disabled}
    >
      {children}
    </DM.Item>
  );
}

export function MenuSeparator() {
  return <DM.Separator className="menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="menu-label">{children}</DM.Label>;
}

export function Pop({
  trigger,
  children,
  open,
  onOpenChange,
  width = 340,
  side = 'bottom',
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  width?: number;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <P.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          className="popover"
          sideOffset={6}
          side={side}
          style={{ width }}
          collisionPadding={12}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** Segmented control (mockup `.seg`). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset className="seg" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div>
        {icon}
        <h4>{title}</h4>
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={cn('skeleton', className)} style={style} />;
}
