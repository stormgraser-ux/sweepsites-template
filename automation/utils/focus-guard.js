'use strict';

/**
 * Focus-guard — prevents Chrome from stealing focus during automation runs.
 *
 * Originally used PowerShell on WSL to restore foreground window.
 * On native Linux with Hyprland, focus stealing is managed by the compositor
 * (windowrules can suppress focus changes). This module is a no-op on Linux.
 */

async function startFocusGuard() {
  console.log('[focus-guard] Native Linux — compositor manages focus, skipping');
}

function stopFocusGuard() {
  // no-op on native Linux
}

module.exports = { startFocusGuard, stopFocusGuard };
