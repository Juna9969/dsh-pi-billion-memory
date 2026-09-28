import { redactSecrets, withoutPaths } from '../vendor/extension.js';
export const safeText = text => withoutPaths(redactSecrets(String(text)).text);
