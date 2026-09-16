import type { ComponentProps } from 'react';
import styles from './controls.module.css';

export type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger';
  density?: 'standard' | 'quick-log';
};

export function Button({
  variant = 'primary',
  density = 'standard',
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-density={density}
    />
  );
}
