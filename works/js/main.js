// Auditable Works — module manifest. Build-time only: this import order is
// the registry/boot order, so init.js (the entry) must come last.

import './state.js';
import './bus.js';
import './workspace.js';
import './surface-registry.js';
import './layout.js';
import './surfaces.js';
import './works-service.js';
import './tree.js';
import './menubar.js';
import './init.js';
