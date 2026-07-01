/** Application and API version metadata. */

/** Human app/release version (keep in sync with package.json on release). */
export const APP_VERSION = '1.0.0';

/** Current API major version. Clients should target `/api` (this version). */
export const API_VERSION = 'v1';

/** API versions the server currently serves. */
export const SUPPORTED_API_VERSIONS = ['v1'] as const;
