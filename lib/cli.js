export const VERSION = '0.1.0';
export async function main(argv) {
  if (argv[0] === '--version') { process.stdout.write(VERSION + '\n'); return 0; }
  return 2;
}
