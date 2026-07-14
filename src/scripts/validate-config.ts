import { ZodError } from 'zod';
import { loadTenantConfig } from '../config/loader.js';

const path = process.argv[2];

if (!path) {
  console.error('Usage: validate-config.ts <path-to-tenant-config.json>');
  process.exit(1);
}

try {
  const config = loadTenantConfig(path);
  console.log(`OK: tenant config valid for "${config.tenant.slug}"`);
  process.exit(0);
} catch (err) {
  console.error('Tenant config validation failed:');
  if (err instanceof ZodError) {
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
  } else if (err instanceof Error) {
    console.error(`  - ${err.message}`);
  } else {
    console.error(`  - ${String(err)}`);
  }
  process.exit(1);
}
