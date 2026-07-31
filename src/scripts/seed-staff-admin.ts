import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';

// MANUAL-ONLY — never invoked from build/start/boot or any migration step
// (confirmed: package.json's build/start scripts don't reference this file
// at all). Run once per environment via `npm run seed:staff-admin`.
//
// The upsert's `update` clause is deliberately empty: re-running this
// script against an environment that already has this row does nothing —
// it will NEVER reset a rotated password back to the default. That's the
// actual safety property here, not just "nobody wired it to run
// automatically" — even a mistaken re-run is a no-op on an existing account.
const ADMIN_EMAIL = 'admin@webspecia.in';
const ADMIN_PASSWORD = 'cognidom';

async function main(): Promise<void> {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const staff = await prisma.staffUser.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, passwordHash, role: 'ADMIN', fullName: 'Webspecia Admin' },
    update: {},
  });

  console.log(`[seed-staff-admin] staff user ready: ${staff.email} (role=${staff.role}, id=${staff.id})`);
  console.log('[seed-staff-admin] ROTATE THIS PASSWORD after initial staff onboarding.');
  console.log('[seed-staff-admin] Re-running this script is safe — it will not reset an existing password.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-staff-admin] FAILED:', err);
    process.exit(1);
  });
