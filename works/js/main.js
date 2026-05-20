// Auditable Works — module manifest. Build-time only: this import order is
// the registry/boot order, so init.js (the entry) must come last.

import './state.js';
import './bus.js';
import './workspace.js';
import './layout.js';
import './surfaces.js';
import './works-service.js';
import './menubar.js';
import './tree.js';
import './init.js';
