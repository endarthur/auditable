// @gcu/dialog — public exports
export { Dialog, dismissAll, openCount } from './dialog.js';
export { confirm, prompt, alert } from './convenience.js';

// Static-method aliases on the Dialog class for the spec's `Dialog.confirm`
// shape. Bare functions remain available for direct import.
import { Dialog as _Dialog } from './dialog.js';
import { confirm as _confirm, prompt as _prompt, alert as _alert } from './convenience.js';
import { dismissAll as _dismissAll } from './dialog.js';
_Dialog.confirm    = _confirm;
_Dialog.prompt     = _prompt;
_Dialog.alert      = _alert;
_Dialog.dismissAll = _dismissAll;
