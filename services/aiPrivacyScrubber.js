/**
 * services/aiPrivacyScrubber.js
 *
 * Feature #4 Phase 5: Production AI Provider Integration & Safety Guardrails
 *
 * Sanitizes sensitive Personally Identifiable Information (PII) like phone numbers
 * and personal email addresses before Ground Truth contracts are transmitted to cloud AI providers.
 *
 * Golden Rule: Never mutate the original in-memory Ground Truth contract object.
 */

'use strict';

const PHONE_REGEX = /\+?\d{9,15}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

class AIPrivacyScrubber {
  /**
   * Creates a sanitized deep clone of an AI Ground Truth payload.
   *
   * @param {Object} groundTruthContract - Original Ground Truth contract
   * @returns {Object} Sanitized Ground Truth contract clone
   */
  scrub(groundTruthContract) {
    if (!groundTruthContract || typeof groundTruthContract !== 'object') {
      return groundTruthContract;
    }

    try {
      const cloned = JSON.parse(JSON.stringify(groundTruthContract));
      this._sanitizeObject(cloned);
      return cloned;
    } catch {
      return groundTruthContract;
    }
  }

  /**
   * Recursively sanitizes string fields inside an object.
   * @private
   */
  _sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return;

    for (const key of Object.keys(obj)) {
      const val = obj[key];

      if (typeof val === 'string') {
        // Redact phone numbers and emails in driver or raw identity fields
        if (key === 'driver' || key === 'driverName' || key === 'rawEmailText' || key === 'identity' || key === 'untrustedData') {
          obj[key] = this.scrubText(val);
        } else if (EMAIL_REGEX.test(val) || PHONE_REGEX.test(val)) {
          obj[key] = this.scrubText(val);
        }
      } else if (typeof val === 'object' && val !== null) {
        this._sanitizeObject(val);
      }
    }
  }

  /**
   * Scrubs PII from a text string.
   *
   * @param {string} text - Raw input text
   * @returns {string} Sanitized text with redacted PII
   */
  scrubText(text) {
    if (typeof text !== 'string' || !text) return text;
    let result = text.replace(EMAIL_REGEX, '[REDACTED_EMAIL]');
    result = result.replace(PHONE_REGEX, '[REDACTED_PHONE]');
    return result;
  }
}

module.exports = AIPrivacyScrubber;
