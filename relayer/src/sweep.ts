// Returns the MON parked on carrier, customer and device keys to the funder.
import { formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK, funderKey } from './config.js';
import { Sender, balanceOf, fees, refreshFees } from './chain.js';
import { allAccounts } from './keys.js';

async function main() {
  await refreshFees();
  const funder = privateKeyToAccount(funderKey()).address;
  const gas = 21_000n;
  const reserve = gas * fees.maxFee; // what the transfer itself may cost
  let total = 0n;
  for (const [n, { label, account }] of allAccounts().entries()) {
    const balance = await balanceOf(account.address);
    const amount = balance - reserve;
    if (amount <= 0n) continue;
    await new Sender(account, n).send(funder, '0x', gas, `sweep ${label}`, amount);
    total += amount;
  }
  console.log(`${NETWORK.name}: returned ${formatEther(total)} MON to ${funder}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
