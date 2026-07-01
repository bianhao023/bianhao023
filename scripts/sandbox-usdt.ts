/**
 * USDT (TRC20) sandbox / live-read check.
 *
 * Read-only: queries TronGrid for recent incoming USDT transfers to an address.
 * Works against public TronGrid without secrets, so it verifies the real
 * on-chain integration end to end.
 *
 *   USDT_RECEIVING_ADDRESS=<addr> npm run sandbox:usdt
 */
import { loadConfig, CANONICAL_USDT_TRC20 } from '../src/config';
import { FetchHttpClient } from '../src/providers/provider';
import { TronGridClient } from '../src/providers/usdt/usdtTron';
import { fromMinorUnits } from '../src/core/money';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const usdt = cfg.usdt ?? {
    receivingAddress: process.env.USDT_RECEIVING_ADDRESS ?? '',
    contractAddress: process.env.USDT_CONTRACT_ADDRESS ?? CANONICAL_USDT_TRC20,
    apiBase: process.env.USDT_API_BASE ?? 'https://api.trongrid.io',
    apiKey: process.env.USDT_API_KEY,
    minConfirmations: 19,
    uniqueAmountMaxDelta: 9999,
  };
  if (!usdt.receivingAddress) {
    console.error('Set USDT_RECEIVING_ADDRESS to a TRON address to query.');
    process.exit(1);
  }

  console.log(`Querying TRC20 transfers to ${usdt.receivingAddress} on ${usdt.apiBase} ...`);
  const client = new TronGridClient(usdt, new FetchHttpClient());
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
  const transfers = await client.getIncomingTransfers(usdt.receivingAddress, usdt.contractAddress, since);

  console.log(`Found ${transfers.length} incoming transfer(s) in the last 7 days:`);
  for (const t of transfers.slice(0, 10)) {
    console.log(
      `  ${new Date(t.timestampMs).toISOString()}  ${fromMinorUnits(t.valueMicro, 'USDT')} USDT  from ${t.from}  tx=${t.txId}`,
    );
  }
}

main().catch((err) => {
  console.error('sandbox-usdt failed:', err.message);
  process.exit(1);
});
