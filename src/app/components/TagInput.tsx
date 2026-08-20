import { useState } from "react";
import type { KeyboardEvent } from "react";

interface TagInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  helperText?: string;
  placeholder?: string;
}

export function TagInput({
  label,
  values,
  onChange,
  helperText,
  placeholder,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  function commitDraft() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft("");
      return;
    }
    if (!values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setDraft("");
  }

  function removeAt(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      e.preventDefault();
      removeAt(values.length - 1);
    }
  }

  const inputId = `tag-input-${label.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <div className="tag-input-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="tag-input-chips">
        {values.map((value, index) => (
          <span className="chip" key={`${value}-${index}`}>
            {value}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${value}`}
              onClick={() => removeAt(index)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          type="text"
          value={draft}
          placeholder={placeholder ?? "Type and press Enter"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitDraft}
        />
      </div>
      {helperText && <p className="field-helper">{helperText}</p>}
    </div>
  );
}
