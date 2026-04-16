/**
 * Email verification utilities
 * Validates format, MX records, and common disposable email patterns
 */

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamail.net',
  'guerrillamail.org', 'spam4.me', 'trashmail.com', 'fakeinbox.com',
  'maildrop.cc', 'dispostable.com', 'mailnull.com', 'spamgourmet.com',
  'trashmail.at', 'trashmail.io', 'trashmail.me', 'trashmail.net'
]);

const KNOWN_VALID_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'proton.me', 'zoho.com', 'yandex.com', 'mail.com',
  // Spanish providers
  'telefonica.es', 'movistar.es', 'orange.es', 'vodafone.es', 'jazztel.es',
  // Generic business
  'empresa.com', 'business.com'
]);

/**
 * Validates email format using RFC 5322 simplified regex
 */
export function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return regex.test(email.trim().toLowerCase());
}

/**
 * Check if email domain is from a disposable provider
 */
export function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return DISPOSABLE_DOMAINS.has(domain);
}

/**
 * Score email confidence (0-100)
 */
export function getEmailConfidenceScore(email, businessName = '') {
  if (!isValidEmailFormat(email)) return 0;

  let score = 50; // Base score
  const [localPart, domain] = email.toLowerCase().split('@');

  // Disposable = 0
  if (isDisposableEmail(email)) return 0;

  // Known providers boost
  if (KNOWN_VALID_PROVIDERS.has(domain)) score += 15;

  // Business email (custom domain) = higher confidence
  if (!KNOWN_VALID_PROVIDERS.has(domain) && domain.split('.').length >= 2) score += 25;

  // Local part quality
  if (localPart.includes('info') || localPart.includes('contact') ||
      localPart.includes('hello') || localPart.includes('admin') ||
      localPart.includes('hola') || localPart.includes('contacto')) {
    score += 10; // Generic business emails are usually valid
  }

  // If domain matches business name (rough check)
  if (businessName) {
    const cleanBusiness = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanDomain = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
    if (cleanDomain.includes(cleanBusiness.substring(0, 5)) ||
        cleanBusiness.includes(cleanDomain.substring(0, 5))) {
      score += 15;
    }
  }

  // Penalize suspicious patterns
  if (/[0-9]{5,}/.test(localPart)) score -= 10; // Too many numbers
  if (localPart.length < 3) score -= 15;
  if (localPart.length > 50) score -= 10;

  return Math.min(100, Math.max(0, score));
}

/**
 * Extract emails from raw HTML/text content
 */
export function extractEmailsFromText(text) {
  if (!text) return [];
  const emailRegex = /\b[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}\b/g;
  const found = text.match(emailRegex) || [];

  // Deduplicate and filter
  return [...new Set(found)]
    .map(e => e.toLowerCase().trim())
    .filter(e => isValidEmailFormat(e) && !isDisposableEmail(e));
}

/**
 * Decode obfuscated emails (common anti-scraping technique)
 * Handles: [at], (at), [dot], (dot), " at ", " dot "
 */
export function decodeObfuscatedEmail(text) {
  if (!text) return null;
  return text
    .replace(/\s*\[at\]\s*/gi, '@')
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s*\(dot\)\s*/gi, '.')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .trim();
}
