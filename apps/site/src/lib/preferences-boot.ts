import { sitePreferences } from './preferences';

// Side-effect module for every public page (imported by BaseLayout). Creating
// the controller applies the stored state, rewrites the New! link with the
// non-sensitive preference fragment and installs the cross-tab/bcache sync.
sitePreferences();
