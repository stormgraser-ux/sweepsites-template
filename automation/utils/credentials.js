/**
 * Site Credentials via GPG-encrypted `pass` store
 *
 * Passwords stored at: pass sweepsites/sites/<siteId>
 *
 * Configure your default email and any per-site username overrides below.
 */

'use strict';

const { execFileSync } = require('child_process');

// Sites that use a username instead of email for login.
// Add your own overrides here: { siteId: 'YourUsername' }
const USERNAME_OVERRIDES = {
  // example: 'MyUsername',
};

const DEFAULT_EMAIL = process.env.SWEEPSITES_EMAIL || 'your-email@gmail.com';

/**
 * Get credentials for a site from the GPG-encrypted pass store.
 * @param {string} siteId - The site identifier (e.g. 'chumba', 'wow-vegas')
 * @returns {{ email: string, password: string }}
 */
function getCredentials(siteId) {
  let password;
  try {
    password = execFileSync('pass', [`sweepsites/sites/${siteId}`], {
      encoding: 'utf8',
      timeout: 5000,
    }).split('\n')[0].trim();
  } catch (err) {
    throw new Error(`No credentials in pass store for "${siteId}" — run: pass insert sweepsites/sites/${siteId}`);
  }

  return {
    email: USERNAME_OVERRIDES[siteId] || DEFAULT_EMAIL,
    password,
  };
}

module.exports = { getCredentials, DEFAULT_EMAIL };
