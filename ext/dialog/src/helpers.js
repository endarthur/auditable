// @gcu/dialog — pure helpers. Zero DOM, exported for tests.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

// Selector used by getFocusable; exported so consumers can extend if needed.
export function focusableSelector() { return FOCUSABLE_SELECTOR; }

// Z-index arithmetic for the dialog stack. base + N*2 gives:
//   stackIdx 0 → backdrop=base+0, dialog=base+1
//   stackIdx 1 → backdrop=base+2, dialog=base+3
// Each new dialog covers the previous because its backdrop's z is above the
// previous dialog's z. Closing the top reveals the next one.
export function backdropZ(base, stackIdx) { return base + stackIdx * 2; }
export function dialogZ(base, stackIdx)   { return base + stackIdx * 2 + 1; }

// Validation helper for the prompt convenience API. Wraps a consumer-provided
// validator with the empty-allowed rule:
//   - validator returns string | null (error message or no error)
//   - empty string is valid iff validator("") returns null
// Returns { valid, error } where error is null when valid.
export function validateValue(value, validator) {
  if (typeof validator === 'function') {
    const result = validator(value);
    if (typeof result === 'string') {
      return { valid: false, error: result };
    }
    return { valid: true, error: null };
  }
  // No validator: empty is invalid by default to mirror native prompt() UX.
  if (!value || !value.trim || !value.trim()) {
    return { valid: false, error: null };
  }
  return { valid: true, error: null };
}
