import { generateKeyPair } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const generateKeyPairAsync = promisify(generateKeyPair);

const outDir = process.argv[2] ?? './keys';
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(`${outDir}/jwt-private.pem`, privateKey, { mode: 0o600 });
writeFileSync(`${outDir}/jwt-public.pem`, publicKey);

console.log(`RS256 keypair written to ${outDir}/jwt-private.pem and ${outDir}/jwt-public.pem`);
