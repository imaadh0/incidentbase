'use client';

import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import * as React from 'react';

export type SelectOption = { value: string; label: string };

type Props = {
  options: SelectOption[];
  label: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  triggerContent?: React.ReactNode;
  onValueChange?: (value: string) => void;
};

export function SelectControl({
  options,
  label,
  name,
  value,
  defaultValue,
  placeholder,
  disabled,
  required,
  className,
  triggerContent,
  onValueChange,
}: Props) {
  return (
    <Select.Root
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(required === undefined ? {} : { required })}
    >
      <Select.Trigger
        className={`select-trigger${className ? ` ${className}` : ''}`}
        aria-label={label}
      >
        {triggerContent ?? <Select.Value placeholder={placeholder ?? 'Select an option'} />}
        <Select.Icon className="select-icon">
          <ChevronDown size={16} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.ScrollUpButton className="select-scroll-button">
            <ChevronUp size={15} />
          </Select.ScrollUpButton>
          <Select.Viewport className="select-viewport">
            {options.map((option) => (
              <Select.Item className="select-item" key={option.value} value={option.value}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="select-check">
                  <Check size={15} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll-button">
            <ChevronDown size={15} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
