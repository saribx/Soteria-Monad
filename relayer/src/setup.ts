// One-time setup per network, safe to re-run: deploys the contracts (unless
// already deployed), mints demo euros, funds the carrier's liability pool and
// tops up every key with just enough MON. Nothing here runs on its own.
import { writeFileSync } from 'node:fs';
import { formatEther, maxUint256, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEMO, NETWORK, SPEND_CAP_MON, funderKey } from './config.js';
import { DEPLOYMENTS_FILE, readDeployments } from './deployments.js';
import { RAIL, Sender, TEUR, balanceOf, budget, call, deploy, refreshFees, rpc, setRailAddress } from './chain.js';
import { deviceIds, deviceAccount, roleAccount, type Role } from './keys.js';

// MON each key should hold. Devices send ~6 readings a minute at rest and one a
// second during an incident; storm devices send ~30 readings in total.
const TARGET_MON: Record<string, string> = {
  carrier: '0.6',
  customer: '0.3',
  device: '0.9',
  // one storm run: seconds × 1 Hz readings at the excursion gas limit, 102 gwei, +30 % (STORM_MON overrides, 0 skips)
  storm: process.env.STORM_MON ?? (DEMO.storm.seconds * DEMO.escalated_hz * 67_000 * 102e9 * 1.3 / 1e18).toFixed(3),
};

async function main() {
  const funder = new Sender(privateKeyToAccount(funderKey()), 0);
  await refreshFees();
  const startBalance = await balanceOf(funder.address);
  console.log(`network   ${NETWORK.name} (chain ${NETWORK.chainId})`);
  console.log(`funder    ${funder.address}  ${formatEther(startBalance)} MON`);
  console.log(`spend cap ${SPEND_CAP_MON} MON for this script`);

  const chainId = Number(BigInt(await rpc.call<Hex>('eth_chainId', [])));
  if (chainId !== NETWORK.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${NETWORK.chainId}`);

  // ---- contracts
  const deployments = readDeployments();
  let dep = deployments[NETWORK.name];
  const hasCode = async (a?: Address) => !!a && (await rpc.call<Hex>('eth_getCode', [a, 'latest'])) !== '0x';
  if (!dep || !(await hasCode(dep.rail)) || process.argv.includes('--redeploy')) {
    const teur = await deploy(funder, TEUR, [], 'deploy TEUR');
    const rail = await deploy(funder, RAIL, [teur], 'deploy SoteriaRail');
    const block = Number(BigInt(await rpc.call<Hex>('eth_blockNumber', [])));
    dep = { rail, teur, chainId, deployedAt: new Date().toISOString(), block };
    deployments[NETWORK.name] = dep;
    writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2) + '\n');
    console.log(`deployed  SoteriaRail ${rail}\n          TEUR        ${teur}`);
  } else {
    console.log(`reusing   SoteriaRail ${dep.rail}`);
  }
  setRailAddress(dep.rail);

  // ---- MON for every key (only the difference to the target is sent)
  const targets: { label: string; address: Address; want: bigint }[] = [
    { label: 'carrier', address: roleAccount('carrier').address, want: parseEther(TARGET_MON.carrier) },
    ...(['customer_s1', 'customer_s3', 'customer_storm'] as Role[]).map(r => ({
      label: r,
      address: roleAccount(r).address,
      want: parseEther(TARGET_MON.customer),
    })),
    ...deviceIds().map(d => ({
      label: d.key,
      address: deviceAccount(d.key).address,
      want: parseEther(d.caseId === 'storm' ? TARGET_MON.storm : TARGET_MON.device),
    })),
  ];
  let topped = 0n;
  for (const t of targets) {
    const have = await balanceOf(t.address);
    if (have >= t.want) continue;
    const amount = t.want - have;
    await funder.send(t.address, '0x', 21_000n, `fund ${t.label}`, amount);
    topped += amount;
  }
  console.log(`funded    ${formatEther(topped)} MON across ${targets.length} keys`);

  // ---- demo euros, bond allowance and liability pool
  const carrier = new Sender(roleAccount('carrier'), 0);
  const teurBalance = await readUint(dep.teur, TEUR, 'balanceOf', [carrier.address]);
  if (teurBalance < parseEther('10000000')) {
    await call(funder, dep.teur, TEUR.abi, 'mint', [carrier.address, parseEther('100000000')], 'mint tEUR to carrier');
  }
  const allowance = await readUint(dep.teur, TEUR, 'allowance', [carrier.address, dep.rail]);
  if (allowance < parseEther('1000000000')) {
    await call(carrier, dep.teur, TEUR.abi, 'approve', [dep.rail, maxUint256], 'carrier approves bonds');
  }
  const pool = await readUint(dep.rail, RAIL, 'poolEur', [carrier.address]);
  if (pool < 1_000_000n) {
    await call(carrier, dep.rail, RAIL.abi, 'fundPool', [5_000_000], 'fund liability pool');
  }

  const endBalance = await balanceOf(funder.address);
  console.log(`done      funder now ${formatEther(endBalance)} MON (gas spent ${budget.snapshot().spentMon.toFixed(4)} MON)`);
}

async function readUint(to: Address, art: typeof RAIL, functionName: string, args: unknown[]): Promise<bigint> {
  const { encodeFunctionData, decodeFunctionResult } = await import('viem');
  const data = encodeFunctionData({ abi: art.abi, functionName, args });
  const result = await rpc.call<Hex>('eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi: art.abi, functionName, data: result }) as bigint;
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
