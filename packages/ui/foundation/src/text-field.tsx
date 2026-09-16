'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';
import styles from './controls.module.css';

type FieldMetadata = { label: string; description?: string; error?: string };
export type TextFieldProps = ComponentProps<'input'> & FieldMetadata;
export type TextAreaFieldProps = ComponentProps<'textarea'> & FieldMetadata;

function FieldFrame({
  id,
  label,
  description,
  error,
  children,
}: FieldMetadata & { id: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children}
      {description ? (
        <p id={`${id}-description`} className={styles.description}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(
  id: string,
  description: string | undefined,
  error: string | undefined,
  external: string | undefined,
) {
  return (
    [external, description ? `${id}-description` : undefined, error ? `${id}-error` : undefined]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

export function TextField({
  label,
  description,
  error,
  id,
  className,
  'aria-describedby': externalDescription,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <FieldFrame
      id={fieldId}
      label={label}
      {...(description ? { description } : {})}
      {...(error ? { error } : {})}
    >
      <input
        {...props}
        id={fieldId}
        className={[styles.input, className].filter(Boolean).join(' ')}
        aria-describedby={describedBy(fieldId, description, error, externalDescription)}
        aria-invalid={error ? true : props['aria-invalid']}
      />
    </FieldFrame>
  );
}

export function TextAreaField({
  label,
  description,
  error,
  id,
  className,
  'aria-describedby': externalDescription,
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <FieldFrame
      id={fieldId}
      label={label}
      {...(description ? { description } : {})}
      {...(error ? { error } : {})}
    >
      <textarea
        {...props}
        id={fieldId}
        className={[styles.input, styles.textarea, className].filter(Boolean).join(' ')}
        aria-describedby={describedBy(fieldId, description, error, externalDescription)}
        aria-invalid={error ? true : props['aria-invalid']}
      />
    </FieldFrame>
  );
}
