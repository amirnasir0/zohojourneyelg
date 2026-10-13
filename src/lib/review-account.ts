// Single source of truth for the Play/App Store reviewer demo account's
// identity — a hardcoded sentinel, never a real Zoho CRM id (those are
// always purely numeric), so a lookup by this value can never accidentally
// match a real synced contact, now or in the future. Used by:
//  - src/routes/auth.ts (verify-otp's reviewer-login branch, to resolve the
//    demo Contact row — NOT by mobile number, since the reviewer test
//    number can collide with a real customer's number, as it already does
//    for Elgris: see the Contact.isDemo schema comment).
//  - src/scripts/seed-review-account.ts (creates/upserts the row this
//    constant points at).
export const REVIEW_DEMO_ZOHO_CONTACT_ID = 'DEMO-REVIEWER-ACCOUNT';
