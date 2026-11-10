import { useEffect, useId, useRef, useState } from 'react';
export function CozySelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listId = useId(),
    root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      className="cozy-select"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        id={id}
        type="button"
        role="combobox"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => {
          setActive(selected);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            if (e.key === 'Escape') {
              setOpen(false);
              return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
              if (open) {
                const option = options[active];
                if (option) onChange(option.value);
              } else setActive(selected);
              setOpen(!open);
              return;
            }
            setOpen(true);
            setActive(
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? options.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        options.length - 1,
                        (open ? active : selected) + (e.key === 'ArrowDown' ? 1 : -1),
                      ),
                    ),
            );
          }
        }}
      >
        <span>{options[selected]?.label}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <ul id={listId} role="listbox">
          {options.map((option, index) => (
            <li
              id={`${listId}-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={active === index ? 'focused' : ''}
              onPointerMove={() => setActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <span aria-hidden="true">✓</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
